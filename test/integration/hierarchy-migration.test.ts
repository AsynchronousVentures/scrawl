// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { readConfig } from '../../src/config.js';
import { createDatabase } from '../../src/db/client.js';
import { createOperator } from '../../src/core/identity/operator.js';
import { createLiveState } from '../../src/core/live/content.js';
import { validateContent } from '../../src/core/documents/content.js';

test('hierarchy migration preserves populated native history, live bytes and selected publication', async t => {
  const base = readConfig(process.env), target = new URL(base.databaseUrl);
  assert(base.nodeEnv !== 'production' && ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname));
  const admin = createDatabase(base, () => {}), schema = 'scrawl_test_' + randomUUID().replaceAll('-', '');
  await admin.pool.query(`CREATE SCHEMA "${schema}"`);
  target.searchParams.set('schema', schema);
  const config = { ...base, databaseUrl: target.href }, database = createDatabase(config, () => {});
  t.after(async () => { await database.close(); await admin.pool.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.close(); });
  function migrate(args: string[]) {
    const result = spawnSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', ...args], {
      env: { ...process.env, DATABASE_URL: config.databaseUrl }, encoding: 'utf8',
    });
    assert.equal(result.status, 0, 'The disposable migration command must succeed');
  }
  const migration = '20261001010000_document_hierarchy';
  const names = (await readdir('prisma/migrations', { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  for (const name of names.filter(name => name < migration)) {
    await database.pool.query(await readFile(`prisma/migrations/${name}/migration.sql`, 'utf8'));
    migrate(['resolve', '--applied', name]);
  }
  const operator = createOperator(database.prisma, { origin: 'http://localhost:3000', secret: randomBytes(32).toString('hex'), secureCookies: false });
  const owner = await operator.bootstrap({ email: 'migration-owner@example.test', name: 'Migration owner', password: randomBytes(24).toString('base64url') });
  const spaceId = randomUUID(), documentId = randomUUID(), revisionId = randomUUID(), headId = randomUUID(), epoch = randomUUID(), attachmentId = randomUUID();
  const native = validateContent({ format: 'blocknote-json', schemaVersion: 1, editorVersion: '0.55.0', document: [
    { id: 'retained-paragraph', type: 'paragraph', content: [{ type: 'text', text: 'Retained native content', styles: {} }] },
    { id: 'retained-file', type: 'file', props: { name: 'Synthetic retained file', url: `/api/v1/attachments/${attachmentId}/content` } },
  ] }).content;
  await database.pool.query('INSERT INTO "Space" ("id", "name", "slug", "createdBy", "updatedAt") VALUES ($1,$2,$3,$4,now())', [spaceId, 'Retained space', 'retained-space', owner.id]);
  const connection = await database.pool.connect();
  try {
    await connection.query('BEGIN');
    await connection.query('INSERT INTO "Document" ("id", "spaceId", "slug", "currentRevisionNumber", "lockVersion", "createdBy", "updatedAt", "liveEpoch") VALUES ($1,$2,$3,2,2,$4,now(),$5)', [documentId, spaceId, 'retained-document', owner.id, epoch]);
    await connection.query('INSERT INTO "DocumentRevision" ("id", "documentId", "revisionNumber", "title", "contentFormat", "contentSchemaVersion", "contentEditorVersion", "body", "plainText", "authorId") VALUES ($1,$2,1,$3,$4,1,$5,$6,$7,$8)', [revisionId, documentId, 'Retained title', native.format, native.editorVersion, JSON.stringify(native.document), 'Retained native content', owner.id]);
    await connection.query('INSERT INTO "DocumentRevision" ("id", "documentId", "revisionNumber", "title", "contentFormat", "contentSchemaVersion", "contentEditorVersion", "body", "plainText", "authorId") VALUES ($1,$2,2,$3,$4,1,$5,$6,$7,$8)', [headId, documentId, 'Retained private head', native.format, native.editorVersion, JSON.stringify(native.document), 'Retained native content', owner.id]);
    const bytes = Buffer.from('synthetic retained bytes');
    await connection.query('INSERT INTO "Attachment" ("id", "documentId", "name", "mimeType", "size", "sha256", "createdBy") VALUES ($1,$2,$3,$4,$5,$6,$7)', [attachmentId, documentId, 'Synthetic retained file', 'text/plain', bytes.length, createHash('sha256').update(bytes).digest('hex'), owner.id]);
    await connection.query('INSERT INTO "RevisionAttachment" ("revisionId", "attachmentId", "documentId") VALUES ($1,$2,$3)', [revisionId, attachmentId, documentId]);
    await connection.query('INSERT INTO "RevisionAttachment" ("revisionId", "attachmentId", "documentId") VALUES ($1,$2,$3)', [headId, attachmentId, documentId]);
    const live = createLiveState('Retained unsaved live title', native);
    await connection.query('INSERT INTO "DocumentLive" ("documentId", "epoch", "sequence", "state", "updatedAt") VALUES ($1,$2,7,$3,now())', [documentId, epoch, Buffer.from(live)]);
    await connection.query('INSERT INTO "Publication" ("id", "documentId", "revisionNumber", "approvedAvailabilityVersion", "publisherId", "updatedAt") VALUES ($1,$2,1,1,$3,now())', [randomUUID(), documentId, owner.id]);
    await connection.query('COMMIT');
  } finally { await connection.query('ROLLBACK'); connection.release(); }
  async function snapshot() {
    const result: string[] = [];
    for (const table of ['user', 'account', 'Space', 'SpaceMembership', 'Document', 'DocumentRevision', 'DocumentLive', 'Attachment', 'RevisionAttachment', 'Publication']) {
      // Only digests leave the database; failures cannot print content or auth records.
      const { rows } = await database.pool.query<{ fingerprint: string }>(`SELECT md5(coalesce(string_agg((to_jsonb(t) - 'parentDocumentId')::text, '|' ORDER BY (to_jsonb(t) - 'parentDocumentId')::text), '')) AS fingerprint FROM "${table}" t`);
      result.push(rows[0]!.fingerprint);
    }
    return result;
  }
  const before = await snapshot();
  migrate(['deploy']); migrate(['deploy']);
  assert.deepEqual(await snapshot(), before);
  const document = await database.prisma.document.findUniqueOrThrow({ where: { id: documentId } });
  assert.equal(document.parentDocumentId, null); assert.equal(document.currentRevisionNumber, 2); assert.equal(document.lockVersion, 2);
  assert.equal(document.liveEpoch, epoch); assert.equal(document.slug, 'retained-document');
  const applied = await database.pool.query<{ migration_name: string }>('SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL ORDER BY migration_name');
  assert.deepEqual(applied.rows.map(row => row.migration_name), names);
});
