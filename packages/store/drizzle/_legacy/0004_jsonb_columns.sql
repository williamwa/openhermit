-- Promote all per-table _json (TEXT) columns to real jsonb and drop
-- the _json suffix. agents.config_json / security_json are
-- intentionally left as TEXT (full agent config/policy documents
-- managed via a different lifecycle).

-- sessions.metadata_json → metadata
ALTER TABLE sessions
  ALTER COLUMN metadata_json DROP DEFAULT,
  ALTER COLUMN metadata_json TYPE jsonb USING metadata_json::jsonb,
  ALTER COLUMN metadata_json SET DEFAULT '{}'::jsonb;
ALTER TABLE sessions RENAME COLUMN metadata_json TO metadata;

-- session_events.payload_json → payload
ALTER TABLE session_events
  ALTER COLUMN payload_json TYPE jsonb USING payload_json::jsonb;
ALTER TABLE session_events RENAME COLUMN payload_json TO payload;

-- memories.metadata_json → metadata
ALTER TABLE memories
  ALTER COLUMN metadata_json DROP DEFAULT,
  ALTER COLUMN metadata_json TYPE jsonb USING metadata_json::jsonb,
  ALTER COLUMN metadata_json SET DEFAULT '{}'::jsonb;
ALTER TABLE memories RENAME COLUMN metadata_json TO metadata;

-- containers.metadata_json → metadata
ALTER TABLE containers
  ALTER COLUMN metadata_json TYPE jsonb USING metadata_json::jsonb;
ALTER TABLE containers RENAME COLUMN metadata_json TO metadata;

-- skills.metadata_json → metadata
ALTER TABLE skills
  ALTER COLUMN metadata_json DROP DEFAULT,
  ALTER COLUMN metadata_json TYPE jsonb USING metadata_json::jsonb,
  ALTER COLUMN metadata_json SET DEFAULT '{}'::jsonb;
ALTER TABLE skills RENAME COLUMN metadata_json TO metadata;

-- mcp_servers.headers_json → headers, mcp_servers.metadata_json → metadata
ALTER TABLE mcp_servers
  ALTER COLUMN headers_json DROP DEFAULT,
  ALTER COLUMN headers_json TYPE jsonb USING headers_json::jsonb,
  ALTER COLUMN headers_json SET DEFAULT '{}'::jsonb,
  ALTER COLUMN metadata_json DROP DEFAULT,
  ALTER COLUMN metadata_json TYPE jsonb USING metadata_json::jsonb,
  ALTER COLUMN metadata_json SET DEFAULT '{}'::jsonb;
ALTER TABLE mcp_servers RENAME COLUMN headers_json TO headers;
ALTER TABLE mcp_servers RENAME COLUMN metadata_json TO metadata;

-- schedules.delivery_json → delivery, schedules.policy_json → policy
ALTER TABLE schedules
  ALTER COLUMN delivery_json DROP DEFAULT,
  ALTER COLUMN delivery_json TYPE jsonb USING delivery_json::jsonb,
  ALTER COLUMN delivery_json SET DEFAULT '"silent"'::jsonb,
  ALTER COLUMN policy_json DROP DEFAULT,
  ALTER COLUMN policy_json TYPE jsonb USING policy_json::jsonb,
  ALTER COLUMN policy_json SET DEFAULT '{}'::jsonb;
ALTER TABLE schedules RENAME COLUMN delivery_json TO delivery;
ALTER TABLE schedules RENAME COLUMN policy_json TO policy;
