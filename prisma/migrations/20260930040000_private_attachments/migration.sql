-- SPDX-License-Identifier: AGPL-3.0-only
-- Immutable document-owned bytes remain private and retained by revision history.
CREATE UNIQUE INDEX "DocumentRevision_id_documentId_key" ON "DocumentRevision"("id", "documentId");
CREATE TABLE "Attachment" (
 "id" UUID PRIMARY KEY, "documentId" UUID NOT NULL REFERENCES "Document"("id") ON DELETE RESTRICT,
 "name" VARCHAR(200) NOT NULL, "mimeType" VARCHAR(100) NOT NULL, "size" INTEGER NOT NULL CHECK ("size" BETWEEN 1 AND 10485760),
 "sha256" VARCHAR(64) NOT NULL, "createdBy" TEXT NOT NULL REFERENCES "user"("id") ON DELETE RESTRICT,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE ("id", "documentId")
);
CREATE INDEX "Attachment_documentId_idx" ON "Attachment"("documentId");
CREATE TABLE "RevisionAttachment" (
 "revisionId" UUID NOT NULL, "attachmentId" UUID NOT NULL, "documentId" UUID NOT NULL,
 PRIMARY KEY ("revisionId", "attachmentId"),
 FOREIGN KEY ("revisionId", "documentId") REFERENCES "DocumentRevision"("id", "documentId") ON DELETE RESTRICT,
 FOREIGN KEY ("attachmentId", "documentId") REFERENCES "Attachment"("id", "documentId") ON DELETE RESTRICT
);
CREATE FUNCTION scrawl_attachment_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Attachment records and revision references are immutable'; END;
$$;
CREATE TRIGGER attachment_immutable BEFORE UPDATE OR DELETE ON "Attachment" FOR EACH ROW EXECUTE FUNCTION scrawl_attachment_immutable();
CREATE TRIGGER revision_attachment_immutable BEFORE UPDATE OR DELETE ON "RevisionAttachment" FOR EACH ROW EXECUTE FUNCTION scrawl_attachment_immutable();
