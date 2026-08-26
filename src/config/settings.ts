/**
 * Runtime configuration: wrangler vars are the defaults, D1 rows override them.
 *
 * This is what lets the provider and model be changed from the UI without a
 * redeploy. Secrets follow the opposite precedence -- a `wrangler secret put`
 * value wins over anything stored in D1, because it is the more secure home.
 */

import { type Encrypted, decryptSecret, encryptSecret, hintOf } from "./crypto";

export const SECRET_NAMES = ["MODEL_API_KEY", "SEARCH_API_KEY", "X_BEARER_TOKEN"] as const;
export type SecretName = (typeof SECRET_NAMES)[number];

export function isSecretName(value: string): value is SecretName {
  return (SECRET_NAMES as readonly string[]).includes(value);
}

/** Editable settings, and the wrangler var each one falls back to. */
export const SETTING_KEYS = [
  "MODEL_PROVIDER",
  "MODEL_ID",
  "MODEL_BASE_URL",
  "MODEL_JSON_MODE",
  "SEARCH_PROVIDER",
  "MAX_POST_CHARS",
] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

export function isSettingKey(value: string): value is SettingKey {
  return (SETTING_KEYS as readonly string[]).includes(value);
}

export interface ResolvedConfig {
  modelProvider: string;
  modelId: string;
  modelBaseUrl: string;
  modelJsonMode: string;
  searchProvider: string;
  maxPostChars: number;

  modelApiKey: string;
  searchApiKey: string;
  xBearerToken: string;

  /** Where each secret came from, for display. Never includes the value. */
  secretSources: Record<SecretName, "env" | "stored" | "none">;
  /** Names of stored secrets that failed to decrypt (usually a rotated APP_PASSWORD). */
  undecryptable: SecretName[];
  /** Which settings are overridden in D1 rather than coming from wrangler vars. */
  overridden: SettingKey[];
  /** True when APP_PASSWORD is set, which is what makes UI-stored keys possible. */
  canStoreSecrets: boolean;
  ai?: Ai;
}

interface SecretRow extends Encrypted {
  name: string;
  hint: string;
}

export async function resolveConfig(env: Env, db: D1Database): Promise<ResolvedConfig> {
  const [settingsResult, secretsResult] = await Promise.all([
    db.prepare("SELECT key, value FROM settings").all<{ key: string; value: string }>(),
    db.prepare("SELECT name, ciphertext, iv, salt, hint FROM secrets").all<SecretRow>(),
  ]);

  const stored = new Map((settingsResult.results ?? []).map((r) => [r.key, r.value]));
  const overridden = SETTING_KEYS.filter((k) => (stored.get(k) ?? "").trim() !== "");

  const setting = (key: SettingKey, fallback: string): string => {
    const value = stored.get(key)?.trim();
    return value || fallback;
  };

  const passphrase = env.APP_PASSWORD?.trim() ?? "";
  const secretRows = new Map((secretsResult.results ?? []).map((r) => [r.name, r]));

  const secretSources = {} as Record<SecretName, "env" | "stored" | "none">;
  const undecryptable: SecretName[] = [];
  const values = {} as Record<SecretName, string>;

  for (const name of SECRET_NAMES) {
    const fromEnv = (env[name] as string | undefined)?.trim() ?? "";
    if (fromEnv) {
      values[name] = fromEnv;
      secretSources[name] = "env";
      continue;
    }

    const row = secretRows.get(name);
    if (row) {
      const plaintext = await decryptSecret(row, passphrase);
      if (plaintext) {
        values[name] = plaintext;
        secretSources[name] = "stored";
        continue;
      }
      undecryptable.push(name);
    }

    values[name] = "";
    secretSources[name] = "none";
  }

  return {
    modelProvider: setting("MODEL_PROVIDER", env.MODEL_PROVIDER || "mock").toLowerCase(),
    modelId: setting("MODEL_ID", env.MODEL_ID || ""),
    modelBaseUrl: setting("MODEL_BASE_URL", env.MODEL_BASE_URL || ""),
    modelJsonMode: setting("MODEL_JSON_MODE", env.MODEL_JSON_MODE || "schema"),
    searchProvider: setting("SEARCH_PROVIDER", env.SEARCH_PROVIDER || "none").toLowerCase(),
    maxPostChars: Number(setting("MAX_POST_CHARS", env.MAX_POST_CHARS || "280")) || 280,

    modelApiKey: values.MODEL_API_KEY,
    searchApiKey: values.SEARCH_API_KEY,
    xBearerToken: values.X_BEARER_TOKEN,

    secretSources,
    undecryptable,
    overridden,
    canStoreSecrets: Boolean(passphrase),
    ai: env.AI,
  };
}

/** Writes a setting, or clears the override when the value is blank. */
export async function putSetting(
  db: D1Database,
  key: SettingKey,
  value: string,
): Promise<void> {
  const trimmed = value.trim();
  if (!trimmed) {
    await db.prepare("DELETE FROM settings WHERE key = ?").bind(key).run();
    return;
  }
  await db
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(key, trimmed)
    .run();
}

export async function putSecret(
  db: D1Database,
  env: Env,
  name: SecretName,
  plaintext: string,
): Promise<void> {
  const encrypted = await encryptSecret(plaintext.trim(), env.APP_PASSWORD?.trim() ?? "");
  await db
    .prepare(
      `INSERT INTO secrets (name, ciphertext, iv, salt, hint, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(name) DO UPDATE SET
         ciphertext = excluded.ciphertext, iv = excluded.iv, salt = excluded.salt,
         hint = excluded.hint, updated_at = excluded.updated_at`,
    )
    .bind(name, encrypted.ciphertext, encrypted.iv, encrypted.salt, hintOf(plaintext))
    .run();
}

export async function deleteSecret(db: D1Database, name: SecretName): Promise<void> {
  await db.prepare("DELETE FROM secrets WHERE name = ?").bind(name).run();
}

/** Masked view of stored secrets, safe to send to the browser. */
export async function secretHints(
  db: D1Database,
): Promise<Record<string, { hint: string; updatedAt: string }>> {
  const { results } = await db
    .prepare("SELECT name, hint, updated_at FROM secrets")
    .all<{ name: string; hint: string; updated_at: string }>();

  const out: Record<string, { hint: string; updatedAt: string }> = {};
  for (const row of results ?? []) out[row.name] = { hint: row.hint, updatedAt: row.updated_at };
  return out;
}
