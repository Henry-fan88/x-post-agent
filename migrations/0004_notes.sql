-- Knowledge distilled from sources the user asked the agent to learn from.
--
-- The fifth kind of memory, and the first that is about *what the user knows*
-- rather than *how they write*. An essay or a news piece leaves facts,
-- positions and vocabulary behind, and those belong in later drafts on the same
-- topic -- but a fact must never be mistaken for a style rule, which is why it
-- gets its own table instead of another row in `preferences`.
--
-- Notes are retrieved by topic overlap, so `topics` carries the same
-- comma-separated shape as `samples.topics`.

CREATE TABLE IF NOT EXISTS notes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      TEXT NOT NULL DEFAULT 'default',
  note         TEXT NOT NULL,
  topics       TEXT NOT NULL DEFAULT '',
  source_url   TEXT NOT NULL DEFAULT '',
  source_title TEXT NOT NULL DEFAULT '',
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notes_active ON notes(user_id, active, created_at DESC);
