CREATE TABLE "agent_mcp_servers" (
	"agent_id" text NOT NULL,
	"mcp_server_id" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "agent_mcp_servers_agent_id_mcp_server_id_pk" PRIMARY KEY("agent_id","mcp_server_id")
);
--> statement-breakpoint
CREATE TABLE "agent_skills" (
	"agent_id" text NOT NULL,
	"skill_id" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "agent_skills_agent_id_skill_id_pk" PRIMARY KEY("agent_id","skill_id")
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"agent_id" text PRIMARY KEY NOT NULL,
	"name" text,
	"config_dir" text NOT NULL,
	"workspace_dir" text NOT NULL,
	"config_json" text,
	"security_json" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "containers" (
	"agent_id" text NOT NULL,
	"container_name" text NOT NULL,
	"container_type" text NOT NULL,
	"image" text NOT NULL,
	"status" text NOT NULL,
	"description" text,
	"metadata" jsonb NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "containers_agent_id_container_name_pk" PRIMARY KEY("agent_id","container_name")
);
--> statement-breakpoint
CREATE TABLE "instructions" (
	"agent_id" text NOT NULL,
	"key" text NOT NULL,
	"content" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "instructions_agent_id_key_pk" PRIMARY KEY("agent_id","key")
);
--> statement-breakpoint
CREATE TABLE "mcp_servers" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"url" text NOT NULL,
	"headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memories" (
	"agent_id" text NOT NULL,
	"memory_key" text NOT NULL,
	"content" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" text DEFAULT '' NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "memories_agent_id_memory_key_pk" PRIMARY KEY("agent_id","memory_key")
);
--> statement-breakpoint
CREATE TABLE "meta" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedule_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"schedule_id" text NOT NULL,
	"status" text NOT NULL,
	"session_id" text,
	"prompt" text NOT NULL,
	"started_at" text NOT NULL,
	"finished_at" text,
	"duration_ms" integer,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "schedules" (
	"agent_id" text NOT NULL,
	"schedule_id" text NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"cron_expression" text,
	"run_at" text,
	"prompt" text NOT NULL,
	"session_mode" text DEFAULT 'dedicated' NOT NULL,
	"delivery" jsonb DEFAULT '{"kind":"silent"}'::jsonb NOT NULL,
	"policy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"last_run_at" text,
	"next_run_at" text,
	"run_count" integer DEFAULT 0 NOT NULL,
	"consecutive_errors" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	CONSTRAINT "schedules_agent_id_schedule_id_pk" PRIMARY KEY("agent_id","schedule_id")
);
--> statement-breakpoint
CREATE TABLE "session_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"session_id" text NOT NULL,
	"ts" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"content" text,
	"user_id" text
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"agent_id" text NOT NULL,
	"session_id" text NOT NULL,
	"source_kind" text NOT NULL,
	"source_platform" text,
	"interactive" integer NOT NULL,
	"created_at" text NOT NULL,
	"last_activity_at" text NOT NULL,
	"description" text,
	"description_source" text,
	"message_count" integer DEFAULT 0 NOT NULL,
	"completed_turn_count" integer DEFAULT 0 NOT NULL,
	"last_message_preview" text,
	"working_memory" text,
	"working_memory_updated_at" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'idle' NOT NULL,
	"type" text DEFAULT 'direct' NOT NULL,
	"user_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "sessions_agent_id_session_id_pk" PRIMARY KEY("agent_id","session_id")
);
--> statement-breakpoint
CREATE TABLE "skills" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"path" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_agents" (
	"user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"role" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "user_agents_user_id_agent_id_pk" PRIMARY KEY("user_id","agent_id")
);
--> statement-breakpoint
CREATE TABLE "user_identities" (
	"user_id" text NOT NULL,
	"channel" text NOT NULL,
	"channel_user_id" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "user_identities_channel_channel_user_id_pk" PRIMARY KEY("channel","channel_user_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"user_id" text PRIMARY KEY NOT NULL,
	"name" text,
	"merged_into" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_agent_mcp_servers_agent" ON "agent_mcp_servers" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "idx_agent_skills_agent" ON "agent_skills" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "idx_containers_agent" ON "containers" USING btree ("agent_id","container_name");--> statement-breakpoint
CREATE INDEX "idx_memories_agent" ON "memories" USING btree ("agent_id","updated_at");--> statement-breakpoint
CREATE INDEX "idx_schedule_runs_schedule" ON "schedule_runs" USING btree ("agent_id","schedule_id","started_at");--> statement-breakpoint
CREATE INDEX "idx_schedules_agent_status" ON "schedules" USING btree ("agent_id","status");--> statement-breakpoint
CREATE INDEX "idx_schedules_next_run" ON "schedules" USING btree ("agent_id","next_run_at");--> statement-breakpoint
CREATE INDEX "idx_session_events_agent_session" ON "session_events" USING btree ("agent_id","session_id","ts");--> statement-breakpoint
CREATE INDEX "idx_session_events_type" ON "session_events" USING btree ("agent_id","session_id","event_type","id");--> statement-breakpoint
CREATE INDEX "idx_sessions_agent" ON "sessions" USING btree ("agent_id","last_activity_at");--> statement-breakpoint
CREATE INDEX "idx_user_agents_agent" ON "user_agents" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "idx_user_identities_user" ON "user_identities" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_users_updated" ON "users" USING btree ("updated_at");