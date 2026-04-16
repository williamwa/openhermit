-- CreateTable
CREATE TABLE "agents" (
    "agent_id" TEXT NOT NULL,
    "name" TEXT,
    "config_dir" TEXT NOT NULL,
    "workspace_dir" TEXT NOT NULL,
    "created_at" TEXT NOT NULL,
    "updated_at" TEXT NOT NULL,

    CONSTRAINT "agents_pkey" PRIMARY KEY ("agent_id")
);
