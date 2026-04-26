-- Promote sessions.user_ids_json (TEXT) to a real jsonb column named
-- user_ids. Adds a GIN index so the WHERE user_ids @> '["userId"]'
-- filter used by listSessions(callerUserId) is index-backed instead
-- of a sequential scan + JS filter.

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS user_ids jsonb;

UPDATE sessions
   SET user_ids = COALESCE(user_ids_json, '[]')::jsonb
 WHERE user_ids IS NULL;

ALTER TABLE sessions
  ALTER COLUMN user_ids SET NOT NULL,
  ALTER COLUMN user_ids SET DEFAULT '[]'::jsonb;

ALTER TABLE sessions
  DROP COLUMN IF EXISTS user_ids_json;

CREATE INDEX IF NOT EXISTS idx_sessions_user_ids_gin
  ON sessions USING gin (user_ids);
