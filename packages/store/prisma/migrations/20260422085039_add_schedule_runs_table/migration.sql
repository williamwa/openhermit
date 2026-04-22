-- CreateTable
CREATE TABLE "schedule_runs" (
    "id" SERIAL NOT NULL,
    "agent_id" TEXT NOT NULL,
    "schedule_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "session_id" TEXT,
    "prompt" TEXT NOT NULL,
    "started_at" TEXT NOT NULL,
    "finished_at" TEXT,
    "duration_ms" INTEGER,
    "error" TEXT,

    CONSTRAINT "schedule_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_schedule_runs_schedule" ON "schedule_runs"("agent_id", "schedule_id", "started_at" DESC);

-- AddForeignKey
ALTER TABLE "schedule_runs" ADD CONSTRAINT "schedule_runs_agent_id_schedule_id_fkey" FOREIGN KEY ("agent_id", "schedule_id") REFERENCES "schedules"("agent_id", "schedule_id") ON DELETE CASCADE ON UPDATE CASCADE;
