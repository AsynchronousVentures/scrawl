// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, QueryResult } from 'pg';
import { readConfig } from '../src/config.js';
import { createDatabase } from '../src/db/client.js';
import { attachmentReferences, MAX_UPLOAD_BYTES } from '../src/core/attachments/index.js';
import { validateContent } from '../src/core/documents/content.js';
import { readDemoConfig, readPrivateDemoEnvironment } from './demo-config.js';

type Revision = {
  id: string; contentFormat: string; contentSchemaVersion: number; contentEditorVersion: string | null;
  body: unknown; plainText: string; attachmentIds: string[]; invalidAttachmentOwnership: boolean;
};
type Attachment = { id: string; size: number; sha256: string };
const batchSize = 100;

/** No repair or private values in the result. Files are immutable application-owned bytes. */
export async function checkContent(pool: Pool, storageRoot: string) {
  const result = {
    documents: 0, revisions: 0, attachments: 0,
    issues: { invalidDocumentHead: 0, invalidContent: 0, plainTextMismatch: 0,
      attachmentReferencesMismatch: 0, attachmentOwnershipMismatch: 0,
      missingFile: 0, invalidFile: 0, sizeMismatch: 0, hashMismatch: 0 },
  };
  const client = await pool.connect();
  try {
    // A scan must not mix an old head with newer revision/reference batches.
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const heads = await client.query<{ documents: string; invalid: string }>(`
      SELECT count(*)::text AS documents,
        count(*) FILTER (WHERE r."id" IS NULL)::text AS invalid
      FROM "Document" d LEFT JOIN "DocumentRevision" r
        ON r."documentId" = d."id" AND r."revisionNumber" = d."currentRevisionNumber"`);
    result.documents = Number(heads.rows[0]!.documents);
    result.issues.invalidDocumentHead = Number(heads.rows[0]!.invalid);
    let after: string | null = null;
    for (;;) {
      const batch: QueryResult<Revision> = await client.query<Revision>(`
        SELECT r."id", r."contentFormat", r."contentSchemaVersion", r."contentEditorVersion", r."body", r."plainText",
          ARRAY(SELECT ra."attachmentId"::text FROM "RevisionAttachment" ra
            WHERE ra."revisionId" = r."id" ORDER BY ra."attachmentId") AS "attachmentIds",
          EXISTS(SELECT 1 FROM "RevisionAttachment" ra LEFT JOIN "Attachment" a ON a."id" = ra."attachmentId"
            WHERE ra."revisionId" = r."id" AND (ra."documentId" <> r."documentId" OR a."id" IS NULL
              OR a."documentId" <> r."documentId")) AS "invalidAttachmentOwnership"
        FROM "DocumentRevision" r WHERE ($1::uuid IS NULL OR r."id" > $1::uuid)
        ORDER BY r."id" LIMIT $2`, [after, batchSize]);
      if (!batch.rows.length) break;
      for (const revision of batch.rows) {
        result.revisions++;
        if (revision.invalidAttachmentOwnership) result.issues.attachmentOwnershipMismatch++;
        try {
          const parsed = validateContent({ format: revision.contentFormat, schemaVersion: revision.contentSchemaVersion,
            editorVersion: revision.contentEditorVersion, document: revision.body });
          if (parsed.plainText !== revision.plainText) result.issues.plainTextMismatch++;
          const expected = attachmentReferences(parsed.content).sort();
          if (JSON.stringify(expected) !== JSON.stringify(revision.attachmentIds)) result.issues.attachmentReferencesMismatch++;
        } catch { result.issues.invalidContent++; }
      }
      after = batch.rows.at(-1)!.id;
    }
    after = null;
    for (;;) {
      const batch: QueryResult<Attachment> = await client.query<Attachment>(`
        SELECT "id", "size", "sha256" FROM "Attachment"
        WHERE ($1::uuid IS NULL OR "id" > $1::uuid) ORDER BY "id" LIMIT $2`, [after, batchSize]);
      if (!batch.rows.length) break;
      for (const attachment of batch.rows) {
        result.attachments++;
        if (!Number.isInteger(attachment.size) || attachment.size < 1 || attachment.size > MAX_UPLOAD_BYTES
          || !/^[a-f0-9]{64}$/.test(attachment.sha256)) { result.issues.invalidFile++; continue; }
        let file: Awaited<ReturnType<typeof open>> | undefined;
        try {
          // NOFOLLOW rejects symlinks; NONBLOCK avoids hanging on a substituted FIFO.
          file = await open(join(resolve(storageRoot), attachment.id), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          const metadata = await file.stat();
          if (!metadata.isFile()) { result.issues.invalidFile++; continue; }
          if (metadata.size !== attachment.size) { result.issues.sizeMismatch++; continue; }
          const hash = createHash('sha256'); let bytes = 0;
          for await (const chunk of file.createReadStream({ autoClose: false })) {
            bytes += chunk.length;
            if (bytes > MAX_UPLOAD_BYTES) throw new Error('File grew beyond the supported limit');
            hash.update(chunk);
          }
          if (bytes !== attachment.size) result.issues.sizeMismatch++;
          else if (hash.digest('hex') !== attachment.sha256) result.issues.hashMismatch++;
        } catch (error) {
          if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') result.issues.missingFile++;
          else result.issues.invalidFile++;
        } finally { await file?.close(); }
      }
      after = batch.rows.at(-1)!.id;
    }
    await client.query('COMMIT');
    return { ok: Object.values(result.issues).every(count => count === 0), ...result };
  } catch (error) {
    await client.query('ROLLBACK'); throw error;
  } finally { client.release(); }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--demo')) throw new Error('Use content:check [--demo]');
  const config = args[0] === '--demo' ? readDemoConfig(await readPrivateDemoEnvironment()).config : readConfig(process.env);
  const database = createDatabase(config, () => {});
  try {
    const result = await checkContent(database.pool, config.attachmentStorageDir);
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
  } finally { await database.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('Content integrity check failed. Check configuration, migrations and private storage. No data was changed.'); process.exitCode = 1; });
}
