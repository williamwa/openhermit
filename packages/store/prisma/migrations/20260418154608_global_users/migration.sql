/*
  Warnings:

  - You are about to drop the column `content_tsv` on the `memories` table. All the data in the column will be lost.
  - The primary key for the `user_identities` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `agent_id` on the `user_identities` table. All the data in the column will be lost.
  - The primary key for the `users` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `agent_id` on the `users` table. All the data in the column will be lost.
  - You are about to drop the column `role` on the `users` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "user_identities" DROP CONSTRAINT "user_identities_agent_id_user_id_fkey";

-- DropIndex
DROP INDEX "memories_fts_idx";

-- DropIndex
DROP INDEX "idx_user_identities_user";

-- DropIndex
DROP INDEX "idx_users_agent";

-- AlterTable
ALTER TABLE "memories" DROP COLUMN "content_tsv";

-- AlterTable
ALTER TABLE "user_identities" DROP CONSTRAINT "user_identities_pkey",
DROP COLUMN "agent_id",
ADD CONSTRAINT "user_identities_pkey" PRIMARY KEY ("channel", "channel_user_id");

-- AlterTable
ALTER TABLE "users" DROP CONSTRAINT "users_pkey",
DROP COLUMN "agent_id",
DROP COLUMN "role",
ADD CONSTRAINT "users_pkey" PRIMARY KEY ("user_id");

-- CreateTable
CREATE TABLE "user_agents" (
    "user_id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "created_at" TEXT NOT NULL,

    CONSTRAINT "user_agents_pkey" PRIMARY KEY ("user_id","agent_id")
);

-- CreateIndex
CREATE INDEX "idx_user_agents_agent" ON "user_agents"("agent_id");

-- CreateIndex
CREATE INDEX "idx_user_identities_user" ON "user_identities"("user_id");

-- CreateIndex
CREATE INDEX "idx_users_updated" ON "users"("updated_at" DESC);

-- AddForeignKey
ALTER TABLE "user_agents" ADD CONSTRAINT "user_agents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_agents" ADD CONSTRAINT "user_agents_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("agent_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;
