-- Soft-deleted rows (status='deleted') should not block re-creation of an
-- alias. Convert the unique index on (agent_id, alias) to a partial index
-- that ignores soft-deleted rows.
DROP INDEX IF EXISTS "uq_sandboxes_agent_alias";
CREATE UNIQUE INDEX "uq_sandboxes_agent_alias_active"
  ON "sandboxes" ("agent_id", "alias")
  WHERE "status" <> 'deleted';
