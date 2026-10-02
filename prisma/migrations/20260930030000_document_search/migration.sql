-- Search is rebuildable derived state. PostgreSQL backfills existing snapshots
-- and derives new values without changing authored content or revision metadata.
ALTER TABLE "DocumentRevision" ADD COLUMN "searchVector" TSVECTOR
  GENERATED ALWAYS AS (
    setweight(to_tsvector('simple'::regconfig, "title"), 'A') ||
    setweight(to_tsvector('simple'::regconfig, "plainText"), 'B')
  ) STORED;

CREATE INDEX "DocumentRevision_searchVector_idx"
  ON "DocumentRevision" USING GIN ("searchVector");
