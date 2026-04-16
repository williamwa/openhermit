-- CreateTable
CREATE TABLE "meta" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,

    CONSTRAINT "meta_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "sessions" (
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

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("agent_id","session_id")
);

-- CreateTable
CREATE TABLE "session_events" (
    "id" SERIAL NOT NULL,
    "agent_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "ts" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload_json" TEXT NOT NULL,
    "content" TEXT,
    "user_id" TEXT,

    CONSTRAINT "session_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memories" (
    "agent_id" TEXT NOT NULL,
    "memory_key" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "metadata_json" TEXT NOT NULL DEFAULT '{}',
    "created_at" TEXT NOT NULL DEFAULT '',
    "updated_at" TEXT NOT NULL,

    CONSTRAINT "memories_pkey" PRIMARY KEY ("agent_id","memory_key")
);

-- CreateTable
CREATE TABLE "containers" (
    "agent_id" TEXT NOT NULL,
    "container_name" TEXT NOT NULL,
    "container_type" TEXT NOT NULL,
    "image" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "description" TEXT,
    "metadata_json" TEXT NOT NULL,
    "updated_at" TEXT NOT NULL,

    CONSTRAINT "containers_pkey" PRIMARY KEY ("agent_id","container_name")
);

-- CreateTable
CREATE TABLE "instructions" (
    "agent_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "updated_at" TEXT NOT NULL,

    CONSTRAINT "instructions_pkey" PRIMARY KEY ("agent_id","key")
);

-- CreateTable
CREATE TABLE "users" (
    "agent_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "name" TEXT,
    "merged_into" TEXT,
    "created_at" TEXT NOT NULL,
    "updated_at" TEXT NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("agent_id","user_id")
);

-- CreateTable
CREATE TABLE "user_identities" (
    "agent_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "channel_user_id" TEXT NOT NULL,
    "created_at" TEXT NOT NULL,

    CONSTRAINT "user_identities_pkey" PRIMARY KEY ("agent_id","channel","channel_user_id")
);

-- CreateIndex
CREATE INDEX "idx_sessions_agent" ON "sessions"("agent_id", "last_activity_at" DESC);

-- CreateIndex
CREATE INDEX "idx_session_events_agent_session" ON "session_events"("agent_id", "session_id", "ts" DESC);

-- CreateIndex
CREATE INDEX "idx_session_events_type" ON "session_events"("agent_id", "session_id", "event_type", "id" DESC);

-- CreateIndex
CREATE INDEX "idx_memories_agent" ON "memories"("agent_id", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "idx_containers_agent" ON "containers"("agent_id", "container_name");

-- CreateIndex
CREATE INDEX "idx_users_agent" ON "users"("agent_id", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "idx_user_identities_user" ON "user_identities"("agent_id", "user_id");

-- AddForeignKey
ALTER TABLE "session_events" ADD CONSTRAINT "session_events_agent_id_session_id_fkey" FOREIGN KEY ("agent_id", "session_id") REFERENCES "sessions"("agent_id", "session_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_agent_id_user_id_fkey" FOREIGN KEY ("agent_id", "user_id") REFERENCES "users"("agent_id", "user_id") ON DELETE CASCADE ON UPDATE CASCADE;
