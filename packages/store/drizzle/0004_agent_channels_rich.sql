-- Add the new columns nullable / with defaults so existing external-channel
-- rows survive the upgrade.
ALTER TABLE "agent_channels" ADD COLUMN "kind" text;--> statement-breakpoint
ALTER TABLE "agent_channels" ADD COLUMN "channel_type" text;--> statement-breakpoint
ALTER TABLE "agent_channels" ADD COLUMN "enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_channels" ADD COLUMN "config" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_channels" ADD COLUMN "updated_at" text;--> statement-breakpoint

-- Backfill: pre-existing rows are all owner-registered externals.
UPDATE "agent_channels" SET "kind" = 'external' WHERE "kind" IS NULL;--> statement-breakpoint
UPDATE "agent_channels" SET "channel_type" = "namespace" WHERE "channel_type" IS NULL;--> statement-breakpoint
UPDATE "agent_channels" SET "updated_at" = "created_at" WHERE "updated_at" IS NULL;--> statement-breakpoint

-- Tighten the constraints now that every row has values.
ALTER TABLE "agent_channels" ALTER COLUMN "kind" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_channels" ALTER COLUMN "channel_type" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_channels" ALTER COLUMN "updated_at" SET NOT NULL;
