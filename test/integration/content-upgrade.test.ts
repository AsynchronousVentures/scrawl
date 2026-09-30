// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readConfig } from '../../src/config.js';
import { createDatabase } from '../../src/db/client.js';
import { validateContent } from '../../src/core/documents/content.js';
import { upgradeContent } from '../../scripts/content-upgrade.js';

test('offline native upgrade preserves existing identity/history and requires a durable private archive', async t => {
  const config = readConfig(process.env);
  const target = new URL(config.databaseUrl);
  assert(config.nodeEnv !== 'production' && ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname));
  const admin = createDatabase(config, () => {});
  const schema = 'scrawl_test_' + randomUUID().replaceAll('-', '');
  await admin.pool.query(`CREATE SCHEMA "${schema}"`);
  target.searchParams.set('schema', schema);
  const database = createDatabase({ ...config, databaseUrl: target.href }, () => {});
  const directory = await mkdtemp(join(tmpdir(), 'scrawl-content-upgrade-'));
  t.after(async () => { await database.close(); await admin.pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.close(); await rm(directory, { recursive: true }); });
  const migration = spawnSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: target.href }, encoding: 'utf8',
  });
  assert.equal(migration.status, 0, 'One migration history deploys');
  const actor = 'upgrade-author';
  await database.prisma.user.create({ data: { id: actor, name: 'Synthetic upgrade author', email: 'upgrade@example.test' } });
  const space = await database.prisma.space.create({ data: { id: randomUUID(), name: 'Synthetic upgrade', slug: 'synthetic-upgrade', createdBy: actor } });
  const documentId = randomUUID();
  const oldBody = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Retained original text' }] }] };
  await database.prisma.$transaction(async tx => {
    await tx.document.create({ data: { id: documentId, slug: 'retained-title', spaceId: space.id, createdBy: actor, currentRevisionNumber: 2, lockVersion: 5 } });
    for (let number = 1; number <= 2; number++) await tx.documentRevision.create({ data: {
      id: randomUUID(), documentId, revisionNumber: number, title: 'Retained title', authorId: actor,
      contentFormat: 'prosemirror-json', contentSchemaVersion: 1, body: oldBody, plainText: 'Retained original text',
      changeNote: `Original change ${number}`,
    } });
  });
  const originals = await database.prisma.documentRevision.findMany({ orderBy: { revisionNumber: 'asc' } });
  const rawOriginals = (await database.pool.query('SELECT * FROM "DocumentRevision" ORDER BY "revisionNumber"')).rows;
  const originalDocument = await database.prisma.document.findUniqueOrThrow({ where: { id: documentId } });
  const users = await database.prisma.user.findMany();
  const backup = join(directory, 'originals.json');
  assert.deepEqual(await upgradeContent(database.pool, { apply: false }), { converted: 2, documents: 1, revisions: 2 });
  assert.deepEqual(await database.prisma.documentRevision.findMany({ orderBy: { revisionNumber: 'asc' } }), originals);
  await assert.rejects(upgradeContent(database.pool, { apply: true }), /archive path/);
  await database.pool.query(`CREATE FUNCTION reject_second_native_revision() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW."revisionNumber" = 2 AND NEW."contentFormat" = 'blocknote-json' THEN
      RAISE EXCEPTION 'Synthetic mid-conversion failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_second_native_revision BEFORE UPDATE ON "DocumentRevision"
      FOR EACH ROW EXECUTE FUNCTION reject_second_native_revision()`);
  const failedBackup = join(directory, 'failed-attempt-originals.json');
  await assert.rejects(upgradeContent(database.pool, { apply: true, backup: failedBackup }), /Synthetic mid-conversion failure/);
  assert.deepEqual(await database.prisma.documentRevision.findMany({ orderBy: { revisionNumber: 'asc' } }), originals,
    'A failure after the first conversion rolls back every revision');
  assert.deepEqual(await database.prisma.document.findUniqueOrThrow({ where: { id: documentId } }), originalDocument);
  assert.equal((await stat(failedBackup)).mode & 0o777, 0o600, 'Original archive survives a failed transaction');
  await database.pool.query('DROP TRIGGER reject_second_native_revision ON "DocumentRevision"; DROP FUNCTION reject_second_native_revision()');
  const result = await upgradeContent(database.pool, { apply: true, backup });
  assert.equal(result.converted, 2);
  assert.equal((await stat(backup)).mode & 0o777, 0o600);
  const archive = JSON.parse(await readFile(backup, 'utf8')) as { documents: unknown[]; revisions: unknown[] };
  assert.deepEqual(archive.documents, JSON.parse(JSON.stringify([originalDocument])));
  assert.deepEqual(archive.revisions, JSON.parse(JSON.stringify(rawOriginals)));
  const converted = await database.prisma.documentRevision.findMany({ orderBy: { revisionNumber: 'asc' } });
  for (const [index, revision] of converted.entries()) {
    const original = originals[index]!;
    const { contentFormat: _f, contentSchemaVersion: _s, contentEditorVersion: _e, body: _b, ...metadata } = revision;
    const { contentFormat: _of, contentSchemaVersion: _os, contentEditorVersion: _oe, body: _ob, ...oldMetadata } = original;
    assert.deepEqual(metadata, oldMetadata, 'Revision IDs/numbers/titles/authors/times/text remain unchanged');
    const checked = validateContent({ format: revision.contentFormat, schemaVersion: revision.contentSchemaVersion,
      editorVersion: revision.contentEditorVersion, document: revision.body });
    assert.equal(checked.plainText, original.plainText);
  }
  assert.deepEqual(await database.prisma.document.findUniqueOrThrow({ where: { id: documentId } }), originalDocument);
  assert.deepEqual(await database.prisma.user.findMany(), users);
  assert.deepEqual(await upgradeContent(database.pool, { apply: true, backup }), { converted: 0, documents: 1, revisions: 2 });
});

test('an unrepresentable revision aborts the whole conversion before archiving or changing history', async t => {
  const config = readConfig(process.env);
  const target = new URL(config.databaseUrl);
  assert(config.nodeEnv !== 'production' && ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname));
  const admin = createDatabase(config, () => {});
  const schema = 'scrawl_test_' + randomUUID().replaceAll('-', '');
  await admin.pool.query(`CREATE SCHEMA "${schema}"`);
  target.searchParams.set('schema', schema);
  const database = createDatabase({ ...config, databaseUrl: target.href }, () => {});
  const directory = await mkdtemp(join(tmpdir(), 'scrawl-content-invalid-'));
  t.after(async () => { await database.close(); await admin.pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.close(); await rm(directory, { recursive: true }); });
  const migration = spawnSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: target.href }, encoding: 'utf8',
  });
  assert.equal(migration.status, 0);
  await database.prisma.user.create({ data: { id: 'bad-upgrade', name: 'Synthetic', email: 'bad-upgrade@example.test' } });
  const space = await database.prisma.space.create({ data: { id: randomUUID(), name: 'Synthetic', slug: 'synthetic', createdBy: 'bad-upgrade' } });
  const documentId = randomUUID();
  await database.prisma.$transaction(async tx => {
    await tx.document.create({ data: { id: documentId, slug: 'retained-title', spaceId: space.id, createdBy: 'bad-upgrade', currentRevisionNumber: 2 } });
    for (let number = 1; number <= 2; number++) await tx.documentRevision.create({ data: {
      id: randomUUID(), documentId, revisionNumber: number, title: 'Synthetic', authorId: 'bad-upgrade',
      contentFormat: 'prosemirror-json', contentSchemaVersion: 1,
      body: number === 1 ? { type: 'doc', content: [{ type: 'paragraph' }] } : { type: 'unknown-real-data', text: 'Do not discard' }, plainText: '',
    } });
  });
  const before = await database.prisma.documentRevision.findMany({ orderBy: { revisionNumber: 'asc' } });
  const backup = join(directory, 'originals.json');
  await assert.rejects(upgradeContent(database.pool, { apply: true, backup }));
  assert.deepEqual(await database.prisma.documentRevision.findMany({ orderBy: { revisionNumber: 'asc' } }), before);
  await assert.rejects(stat(backup), { code: 'ENOENT' });
});
