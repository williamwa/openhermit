CREATE TABLE "agent_channels" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"namespace" text NOT NULL,
	"label" text,
	"token_prefix" text NOT NULL,
	"token_ciphertext" text NOT NULL,
	"created_by" text,
	"created_at" text NOT NULL,
	"last_used_at" text,
	"revoked_at" text
);
--> statement-breakpoint
CREATE INDEX "idx_agent_channels_agent" ON "agent_channels" USING btree ("agent_id");