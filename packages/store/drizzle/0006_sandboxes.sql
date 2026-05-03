CREATE TABLE "sandboxes" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"alias" text NOT NULL,
	"type" text NOT NULL,
	"external_id" text,
	"status" text DEFAULT 'stopped' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"runtime_state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"last_seen_at" text
);
--> statement-breakpoint
CREATE INDEX "idx_sandboxes_agent" ON "sandboxes" USING btree ("agent_id");
--> statement-breakpoint
CREATE INDEX "idx_sandboxes_agent_alias" ON "sandboxes" USING btree ("agent_id","alias");
--> statement-breakpoint
CREATE INDEX "idx_sandboxes_type_external" ON "sandboxes" USING btree ("type","external_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sandboxes_agent_alias" ON "sandboxes" USING btree ("agent_id","alias");
--> statement-breakpoint
DROP TABLE IF EXISTS "containers";
