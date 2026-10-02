-- Personal navigation metadata never changes document content/history or grants.
CREATE TABLE "DocumentFavorite" (
  "userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "documentId" UUID NOT NULL REFERENCES "Document" ("id") ON DELETE CASCADE,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("userId", "documentId")
);
CREATE INDEX "DocumentFavorite_documentId_idx" ON "DocumentFavorite" ("documentId");
