-- Move canonical agent config / security policy into the agents table.
-- The legacy config.json / security.json files are no longer the source of
-- truth once these columns are populated; a one-shot CLI migration command
-- backfills existing rows from disk.

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS config_json TEXT,
  ADD COLUMN IF NOT EXISTS security_json TEXT;
