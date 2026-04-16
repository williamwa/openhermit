-- tsvector generated column (auto-maintained by PostgreSQL on INSERT/UPDATE)
ALTER TABLE "memories" ADD COLUMN "content_tsv" tsvector
  GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;

CREATE INDEX "memories_fts_idx" ON "memories" USING GIN("content_tsv");
