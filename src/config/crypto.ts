/**
 * Encryption for API keys stored in D1.
 *
 * The key is derived from APP_PASSWORD with PBKDF2, so the ciphertext in the
 * database is useless on its own -- an attacker needs the Worker's secret too.
 * A fresh salt and IV per record means identical keys don't produce identical
 * ciphertext.
 *
 * This protects against a leaked database, not against someone who already has
 * the Worker's secrets. `wrangler secret put` remains the stronger option.
 */

const PBKDF2_ITERATIONS = 100_000;

export class NoPassphraseError extends Error {
  constructor() {
    super(
      "Set APP_PASSWORD before storing API keys here (npx wrangler secret put APP_PASSWORD). " +
        "It is the encryption key for stored secrets.",
    );
    this.name = "NoPassphraseError";
  }
}

function toB64(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromB64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export interface Encrypted {
  ciphertext: string;
  iv: string;
  salt: string;
}

export async function encryptSecret(plaintext: string, passphrase: string): Promise<Encrypted> {
  if (!passphrase) throw new NoPassphraseError();

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);

  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    new TextEncoder().encode(plaintext),
  );

  return { ciphertext: toB64(ciphertext), iv: toB64(iv), salt: toB64(salt) };
}

/**
 * Returns null rather than throwing when the passphrase no longer matches --
 * that happens legitimately when APP_PASSWORD is rotated, and the caller should
 * fall back to the env secret and ask the user to re-enter, not blow up.
 */
export async function decryptSecret(
  record: Encrypted,
  passphrase: string,
): Promise<string | null> {
  if (!passphrase) return null;
  try {
    const key = await deriveKey(passphrase, fromB64(record.salt));
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromB64(record.iv) as BufferSource },
      key,
      fromB64(record.ciphertext) as BufferSource,
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    return null;
  }
}

/** Last four characters, for showing which key is stored without revealing it. */
export function hintOf(secret: string): string {
  const trimmed = secret.trim();
  return trimmed.length <= 4 ? "****" : `…${trimmed.slice(-4)}`;
}
