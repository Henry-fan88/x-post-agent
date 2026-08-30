-- Whether a turn produced a post or a reply, and what it was replying to.
--
-- Carried on the row rather than dug out of context_json because two things
-- need it after the fact: reopening a session has to rebuild the right X intent
-- link for each draft, and a follow-up turn ("make it shorter") has to know it
-- is still refining a reply. Losing that is how an X-link session silently
-- turns back into a standalone post.
--
-- Existing rows are posts: replies did not exist before this migration.

ALTER TABLE drafts ADD COLUMN output_type TEXT NOT NULL DEFAULT 'post';  -- post | reply
ALTER TABLE drafts ADD COLUMN in_reply_to_id TEXT;                       -- NULL for a post
