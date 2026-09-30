-- CreateTable
CREATE TABLE "Document" (
    "id" UUID NOT NULL,
    "spaceId" UUID NOT NULL,
    "currentRevisionNumber" INTEGER NOT NULL,
    "lockVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "archivedAt" TIMESTAMPTZ(3),
    "archivedBy" TEXT,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentRevision" (
    "id" UUID NOT NULL,
    "documentId" UUID NOT NULL,
    "revisionNumber" INTEGER NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "contentFormat" TEXT NOT NULL,
    "contentSchemaVersion" INTEGER NOT NULL,
    "body" JSONB NOT NULL,
    "plainText" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "changeNote" VARCHAR(2000),

    CONSTRAINT "DocumentRevision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Document_spaceId_archivedAt_id_idx" ON "Document"("spaceId", "archivedAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentRevision_documentId_revisionNumber_key" ON "DocumentRevision"("documentId", "revisionNumber");

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "Space"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
-- Initial creation inserts the document before its first revision in one transaction.
-- Every committed head must exist and belong to it; Prisma cannot express deferrability.
ALTER TABLE "Document" ADD CONSTRAINT "Document_id_currentRevisionNumber_fkey" FOREIGN KEY ("id", "currentRevisionNumber") REFERENCES "DocumentRevision"("documentId", "revisionNumber") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_archivedBy_fkey" FOREIGN KEY ("archivedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentRevision" ADD CONSTRAINT "DocumentRevision_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentRevision" ADD CONSTRAINT "DocumentRevision_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Document" ADD CONSTRAINT "Document_versions_check" CHECK ("currentRevisionNumber" > 0 AND "lockVersion" > 0);
ALTER TABLE "Document" ADD CONSTRAINT "Document_archive_check" CHECK (("archivedAt" IS NULL) = ("archivedBy" IS NULL));
ALTER TABLE "DocumentRevision" ADD CONSTRAINT "DocumentRevision_number_check" CHECK ("revisionNumber" > 0);
ALTER TABLE "DocumentRevision" ADD CONSTRAINT "DocumentRevision_title_check" CHECK (length(btrim("title")) > 0);
ALTER TABLE "DocumentRevision" ADD CONSTRAINT "DocumentRevision_format_check" CHECK ("contentFormat" = 'prosemirror-json' AND "contentSchemaVersion" = 1);
