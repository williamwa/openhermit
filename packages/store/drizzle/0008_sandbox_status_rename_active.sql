-- Rename sandbox lifecycle value 'active' → 'provisioned' for clarity.
-- 'provisioned' contrasts cleanly with 'pending' (un-provisioned) and
-- doesn't carry any "running right now" connotation.
UPDATE "sandboxes" SET "status" = 'provisioned' WHERE "status" = 'active';
