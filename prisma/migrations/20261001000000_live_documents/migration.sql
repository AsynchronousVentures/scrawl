-- Private live storage is separate from immutable content revisions.
-- Existing documents remain outside live mode, without changing their history.
ALTER TABLE "Document" ADD COLUMN "liveEpoch" UUID;

CREATE TABLE "DocumentLive" (
    "documentId" UUID NOT NULL,
    "epoch" UUID NOT NULL,
    "sequence" BIGINT NOT NULL DEFAULT 0 CHECK ("sequence" >= 0),
    "schemaVersion" INTEGER NOT NULL DEFAULT 1 CHECK ("schemaVersion" = 1),
    "state" BYTEA NOT NULL CHECK (octet_length("state") BETWEEN 1 AND 8388608),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "DocumentLive_pkey" PRIMARY KEY ("documentId", "epoch"),
    CONSTRAINT "DocumentLive_documentId_fkey" FOREIGN KEY ("documentId")
        REFERENCES "Document"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- A current room must belong to its document at commit, including restore.
-- Old epochs stay private and retained after the pointer changes.
ALTER TABLE "Document" ADD CONSTRAINT "Document_id_liveEpoch_fkey"
    FOREIGN KEY ("id", "liveEpoch") REFERENCES "DocumentLive"("documentId", "epoch")
    ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;
