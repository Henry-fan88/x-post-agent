-- Agent memory.
-- Single-user app for now: every row carries user_id, defaulting to 'default',
-- so multi-user is a matter of populating it rather than reshaping tables.

-- The evolving model of how you write. One row per user.
CREATE TABLE IF NOT EXISTS style_profile (
  user_id      TEXT PRIMARY KEY,
  handle       TEXT,
  bio          TEXT,
  profile_json TEXT NOT NULL,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Real posts in your voice. The few-shot corpus the drafter imitates.
CREATE TABLE IF NOT EXISTS samples (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL DEFAULT 'default',
  text       TEXT NOT NULL,
  format     TEXT,
  topics     TEXT NOT NULL DEFAULT '',
  source     TEXT NOT NULL DEFAULT 'pasted',   -- pasted | imported | accepted_draft
  engagement INTEGER NOT NULL DEFAULT 0,       -- optional: rank better exemplars higher
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_samples_user_format ON samples(user_id, format);
CREATE INDEX IF NOT EXISTS idx_samples_created ON samples(user_id, created_at DESC);

-- Atomic, human-readable rules. Injected into the prompt verbatim.
-- scope is 'global', 'format:<format_id>' or 'topic:<topic>'.
CREATE TABLE IF NOT EXISTS preferences (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL DEFAULT 'default',
  rule       TEXT NOT NULL,
  scope      TEXT NOT NULL DEFAULT 'global',
  weight     REAL NOT NULL DEFAULT 1.0,
  source     TEXT NOT NULL DEFAULT 'user',     -- user | inferred
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_prefs_active ON preferences(user_id, active, weight DESC);

-- Everything the agent has produced, and what you did with it.
CREATE TABLE IF NOT EXISTS drafts (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL DEFAULT 'default',
  input         TEXT NOT NULL,
  input_kind    TEXT NOT NULL DEFAULT 'idea',  -- idea | link | x_post | mixed
  format        TEXT NOT NULL,
  variants_json TEXT NOT NULL,
  context_json  TEXT NOT NULL DEFAULT '{}',
  rationale     TEXT NOT NULL DEFAULT '',
  verdict       TEXT,                          -- NULL | posted | edited | rejected
  final_text    TEXT,
  note          TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_drafts_created ON drafts(user_id, created_at DESC);

-- Drives format variety: recently-used formats get penalised, formats you
-- actually post get rewarded.
CREATE TABLE IF NOT EXISTS format_stats (
  user_id      TEXT NOT NULL DEFAULT 'default',
  format       TEXT NOT NULL,
  used         INTEGER NOT NULL DEFAULT 0,
  accepted     INTEGER NOT NULL DEFAULT 0,
  rejected     INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  PRIMARY KEY (user_id, format)
);
