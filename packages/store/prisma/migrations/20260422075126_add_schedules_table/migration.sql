-- CreateTable
CREATE TABLE "schedules" (
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

    CONSTRAINT "schedules_pkey" PRIMARY KEY ("agent_id","schedule_id")
);

-- CreateIndex
CREATE INDEX "idx_schedules_agent_status" ON "schedules"("agent_id", "status");

-- CreateIndex
CREATE INDEX "idx_schedules_next_run" ON "schedules"("agent_id", "next_run_at");
