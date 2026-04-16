-- Add session type column (direct or group)
ALTER TABLE "sessions" ADD COLUMN "type" TEXT NOT NULL DEFAULT 'direct';
