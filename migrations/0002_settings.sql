-- Runtime configuration, editable from the UI.
--
-- Everything here overrides the matching var in wrangler.jsonc, so the deployed
-- vars become defaults rather than the only way to change provider or model.

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- API keys entered through the UI.
--
-- Encrypted at rest with AES-GCM under a key derived from APP_PASSWORD, so a
-- dump of this table is not enough to use them. Plaintext is never returned by
-- the API -- `hint` (the last four characters) is all the UI ever sees.
--
-- A key set with `wrangler secret put` is still the more secure option and
-- takes precedence over anything stored here.
CREATE TABLE IF NOT EXISTS secrets (
  name       TEXT PRIMARY KEY,   -- MODEL_API_KEY | SEARCH_API_KEY | X_BEARER_TOKEN
  ciphertext TEXT NOT NULL,      -- base64
  iv         TEXT NOT NULL,      -- base64
  salt       TEXT NOT NULL,      -- base64
  hint       TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
