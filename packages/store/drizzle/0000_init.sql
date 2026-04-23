-- Consolidated schema: all tables as of v0.2.0

CREATE TABLE IF NOT EXISTS "meta" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS "agents" (
    "agent_id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT,
    "config_dir" TEXT NOT NULL,
    "workspace_dir" TEXT NOT NULL,
    "created_at" TEXT NOT NULL,
    "updated_at" TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS "sessions" (
    "agent_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "source_kind" TEXT NOT NULL,
    "source_platform" TEXT,
    "interactive" INTEGER NOT NULL,
    "created_at" TEXT NOT NULL,
    "last_activity_at" TEXT NOT NULL,
    "description" TEXT,
    "description_source" TEXT,
    "message_count" INTEGER NOT NULL DEFAULT 0,
    "completed_turn_count" INTEGER NOT NULL DEFAULT 0,
    "last_message_preview" TEXT,
    "working_memory" TEXT,
    "working_memory_updated_at" TEXT,
    "metadata_json" TEXT NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'idle',
    "type" TEXT NOT NULL DEFAULT 'direct',
    "user_ids_json" TEXT NOT NULL DEFAULT '[]',
    PRIMARY KEY ("agent_id", "session_id")
);

CREATE TABLE IF NOT EXISTS "session_events" (
    "id" SERIAL PRIMARY KEY,
    "agent_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "ts" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload_json" TEXT NOT NULL,
    "content" TEXT,
    "user_id" TEXT,
    FOREIGN KEY ("agent_id", "session_id") REFERENCES "sessions"("agent_id", "session_id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "memories" (
    "agent_id" TEXT NOT NULL,
    "memory_key" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "metadata_json" TEXT NOT NULL DEFAULT '{}',
    "created_at" TEXT NOT NULL DEFAULT '',
    "updated_at" TEXT NOT NULL,
    PRIMARY KEY ("agent_id", "memory_key")
);

CREATE TABLE IF NOT EXISTS "containers" (
    "agent_id" TEXT NOT NULL,
    "container_name" TEXT NOT NULL,
    "container_type" TEXT NOT NULL,
    "image" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "description" TEXT,
    "metadata_json" TEXT NOT NULL,
    "updated_at" TEXT NOT NULL,
    PRIMARY KEY ("agent_id", "container_name")
);

CREATE TABLE IF NOT EXISTS "instructions" (
    "agent_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "updated_at" TEXT NOT NULL,
    PRIMARY KEY ("agent_id", "key")
);

CREATE TABLE IF NOT EXISTS "users" (
    "user_id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT,
    "merged_into" TEXT,
    "created_at" TEXT NOT NULL,
    "updated_at" TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS "user_agents" (
    "user_id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "created_at" TEXT NOT NULL,
    PRIMARY KEY ("user_id", "agent_id"),
    FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE,
    FOREIGN KEY ("agent_id") REFERENCES "agents"("agent_id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "user_identities" (
    "user_id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "channel_user_id" TEXT NOT NULL,
    "created_at" TEXT NOT NULL,
    PRIMARY KEY ("channel", "channel_user_id"),
    FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "skills" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "metadata_json" TEXT NOT NULL DEFAULT '{}',
    "created_at" TEXT NOT NULL,
    "updated_at" TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS "agent_skills" (
    "agent_id" TEXT NOT NULL,
    "skill_id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TEXT NOT NULL,
    PRIMARY KEY ("agent_id", "skill_id"),
    FOREIGN KEY ("skill_id") REFERENCES "skills"("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "schedules" (
    "agent_id" TEXT NOT NULL,
    "schedule_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "cron_expression" TEXT,
    "run_at" TEXT,
    "prompt" TEXT NOT NULL,
    "session_mode" TEXT NOT NULL DEFAULT 'dedicated',
    "delivery_json" TEXT NOT NULL DEFAULT '"silent"',
    "policy_json" TEXT NOT NULL DEFAULT '{}',
    "created_by" TEXT,
    "created_at" TEXT NOT NULL,
    "updated_at" TEXT NOT NULL,
    "last_run_at" TEXT,
    "next_run_at" TEXT,
    "run_count" INTEGER NOT NULL DEFAULT 0,
    "consecutive_errors" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    PRIMARY KEY ("agent_id", "schedule_id")
);

CREATE TABLE IF NOT EXISTS "schedule_runs" (
    "id" SERIAL PRIMARY KEY,
    "agent_id" TEXT NOT NULL,
    "schedule_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "session_id" TEXT,
    "prompt" TEXT NOT NULL,
    "started_at" TEXT NOT NULL,
    "finished_at" TEXT,
    "duration_ms" INTEGER,
    "error" TEXT,
    FOREIGN KEY ("agent_id", "schedule_id") REFERENCES "schedules"("agent_id", "schedule_id") ON DELETE CASCADE
);

-- Indexes
CREATE INDEX IF NOT EXISTS "idx_sessions_agent" ON "sessions"("agent_id", "last_activity_at" DESC);
CREATE INDEX IF NOT EXISTS "idx_session_events_agent_session" ON "session_events"("agent_id", "session_id", "ts" DESC);
CREATE INDEX IF NOT EXISTS "idx_session_events_type" ON "session_events"("agent_id", "session_id", "event_type", "id" DESC);
CREATE INDEX IF NOT EXISTS "idx_memories_agent" ON "memories"("agent_id", "updated_at" DESC);
CREATE INDEX IF NOT EXISTS "idx_containers_agent" ON "containers"("agent_id", "container_name");
CREATE INDEX IF NOT EXISTS "idx_users_updated" ON "users"("updated_at" DESC);
CREATE INDEX IF NOT EXISTS "idx_user_agents_agent" ON "user_agents"("agent_id");
CREATE INDEX IF NOT EXISTS "idx_user_identities_user" ON "user_identities"("user_id");
CREATE INDEX IF NOT EXISTS "idx_agent_skills_agent" ON "agent_skills"("agent_id");
CREATE INDEX IF NOT EXISTS "idx_schedules_agent_status" ON "schedules"("agent_id", "status");
CREATE INDEX IF NOT EXISTS "idx_schedules_next_run" ON "schedules"("agent_id", "next_run_at");
CREATE INDEX IF NOT EXISTS "idx_schedule_runs_schedule" ON "schedule_runs"("agent_id", "schedule_id", "started_at" DESC);

-- Full-text search on memories (if not exists)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'memories' AND column_name = 'content_tsv'
  ) THEN
    ALTER TABLE "memories" ADD COLUMN "content_tsv" tsvector
      GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;
    CREATE INDEX "idx_memories_fts" ON "memories" USING gin("content_tsv");
  END IF;
END $$;
