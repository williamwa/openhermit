-- Sandbox status is now lifecycle-only ('pending' | 'active' | 'deleted'),
-- not live runtime state. Existing rows that were ever materialized are
-- considered 'active'; the new default for fresh rows is 'pending'.
ALTER TABLE "sandboxes" ALTER COLUMN "status" SET DEFAULT 'pending';
--> statement-breakpoint
UPDATE "sandboxes"
SET "status" = 'active'
WHERE "status" IN ('provisioning', 'running', 'paused', 'stopped', 'gone');
