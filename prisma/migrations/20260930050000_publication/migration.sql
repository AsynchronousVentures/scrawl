-- SPDX-License-Identifier: AGPL-3.0-only
-- Archive invalidates every prior public approval; unarchive cannot lower it.
ALTER TABLE "Document" ADD COLUMN "availabilityVersion" INTEGER NOT NULL DEFAULT 1
  CHECK ("availabilityVersion" > 0);

CREATE TABLE "Publication" (
  "id" UUID PRIMARY KEY,
  "documentId" UUID NOT NULL UNIQUE REFERENCES "Document"("id") ON DELETE RESTRICT,
  "revisionNumber" INTEGER NOT NULL CHECK ("revisionNumber" > 0),
  "approvedAvailabilityVersion" INTEGER NOT NULL CHECK ("approvedAvailabilityVersion" > 0),
  "active" BOOLEAN NOT NULL DEFAULT TRUE,
  "publisherId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE RESTRICT,
  "publishedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  FOREIGN KEY ("documentId", "revisionNumber") REFERENCES "DocumentRevision"("documentId", "revisionNumber") ON DELETE RESTRICT
);
