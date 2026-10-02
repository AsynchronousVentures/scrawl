-- SPDX-License-Identifier: AGPL-3.0-only
-- Existing documents remain roots; no content, revision or version is rewritten.
ALTER TABLE "Document" ADD COLUMN "parentDocumentId" UUID;
CREATE UNIQUE INDEX "Document_id_spaceId_key" ON "Document"("id", "spaceId");
CREATE INDEX "Document_spaceId_parentDocumentId_archivedAt_id_idx" ON "Document"("spaceId", "parentDocumentId", "archivedAt", "id");
ALTER TABLE "Document" ADD CONSTRAINT "Document_parentDocumentId_spaceId_fkey"
  FOREIGN KEY ("parentDocumentId", "spaceId") REFERENCES "Document"("id", "spaceId")
  ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "Document" ADD CONSTRAINT "Document_not_own_parent_check"
  CHECK ("parentDocumentId" IS NULL OR "parentDocumentId" <> "id");
