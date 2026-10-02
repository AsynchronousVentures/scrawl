-- Slugs are navigation metadata. Backfill without changing heads, history,
-- lifecycle counters, timestamps, membership grants or public approvals.
BEGIN;

ALTER TABLE "Space" ADD COLUMN "slug" VARCHAR(80);
ALTER TABLE "Document" ADD COLUMN "slug" VARCHAR(80);
CREATE UNIQUE INDEX "Space_slug_key" ON "Space"("slug");
CREATE UNIQUE INDEX "Document_spaceId_slug_key" ON "Document"("spaceId", "slug");

-- Temporary migration-only helper, matching src/core/slugs.ts. No extension required.
CREATE FUNCTION pg_temp.scrawl_slug(value TEXT, fallback TEXT) RETURNS TEXT
LANGUAGE SQL IMMUTABLE AS $$
  SELECT COALESCE(NULLIF(rtrim(left(trim(BOTH '-' FROM regexp_replace(
    lower(regexp_replace(normalize(value, NFKD), U&'[\0300-\036f]', '', 'g')),
    '[^a-z0-9]+', '-', 'g')), 64), '-'), ''), fallback)
$$;

DO $$
DECLARE
  item RECORD;
  base TEXT;
  candidate TEXT;
  suffix INTEGER;
BEGIN
  -- Resolve collisions against every previously assigned slug, including names
  -- that already end in a numeric suffix. Ordering makes backfill repeatable.
  FOR item IN SELECT "id", "name" FROM "Space" ORDER BY "createdAt", "id" LOOP
    base := pg_temp.scrawl_slug(item."name", 'space');
    candidate := base;
    suffix := 2;
    WHILE EXISTS (SELECT 1 FROM "Space" WHERE "slug" = candidate) LOOP
      candidate := base || '-' || suffix;
      suffix := suffix + 1;
    END LOOP;
    UPDATE "Space" SET "slug" = candidate WHERE "id" = item."id";
  END LOOP;

  FOR item IN
    SELECT d."id", d."spaceId", r."title" FROM "Document" d
    JOIN "DocumentRevision" r ON r."documentId" = d."id" AND r."revisionNumber" = d."currentRevisionNumber"
    ORDER BY d."createdAt", d."id"
  LOOP
    base := pg_temp.scrawl_slug(item."title", 'document');
    candidate := base;
    suffix := 2;
    WHILE EXISTS (SELECT 1 FROM "Document" WHERE "spaceId" = item."spaceId" AND "slug" = candidate) LOOP
      candidate := base || '-' || suffix;
      suffix := suffix + 1;
    END LOOP;
    UPDATE "Document" SET "slug" = candidate WHERE "id" = item."id";
  END LOOP;
END $$;

ALTER TABLE "Space" ALTER COLUMN "slug" SET NOT NULL;
ALTER TABLE "Document" ALTER COLUMN "slug" SET NOT NULL;
ALTER TABLE "Space" ADD CONSTRAINT "Space_slug_format" CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$');
ALTER TABLE "Document" ADD CONSTRAINT "Document_slug_format" CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$');
COMMIT;
