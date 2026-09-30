-- Native BlockNote snapshots retain their producing library version. Legacy
-- rows remain readable by the explicit preservation operator during migration;
-- the application accepts only native payloads, without a runtime dual parser.
ALTER TABLE "DocumentRevision" ADD COLUMN "contentEditorVersion" TEXT;
ALTER TABLE "DocumentRevision" DROP CONSTRAINT "DocumentRevision_format_check";
ALTER TABLE "DocumentRevision" ADD CONSTRAINT "DocumentRevision_format_check" CHECK (
  ("contentFormat" = 'prosemirror-json' AND "contentSchemaVersion" = 1 AND "contentEditorVersion" IS NULL)
  OR
  ("contentFormat" = 'blocknote-json' AND "contentSchemaVersion" = 1
    AND "contentEditorVersion" IS NOT NULL AND "contentEditorVersion" = '0.55.0'
    AND jsonb_typeof("body") = 'array')
);
