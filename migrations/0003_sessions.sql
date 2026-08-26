-- Sessions: one post idea, worked on over several turns.
--
-- A draft row is one agent turn. Grouping them under a session is what lets the
-- user keep refining ("make it shorter", "try a thread") instead of starting
-- over, and gives the sidebar something to list.

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL DEFAULT 'default',
  title      TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(user_id, updated_at DESC);

-- Drafts created before sessions existed keep a NULL session_id. They stay in
-- the table and still accept feedback by id, but they belong to no session, so
-- the sidebar does not list them.
ALTER TABLE drafts ADD COLUMN session_id TEXT;
CREATE INDEX IF NOT EXISTS idx_drafts_session ON drafts(session_id, created_at ASC);
