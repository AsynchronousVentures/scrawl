// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfig } from '../../src/config.js';
import { createDatabase } from '../../src/db/client.js';
import { createCore } from '../../src/core/index.js';
import { createOperator } from '../../src/core/identity/operator.js';
import { createPublishing } from '../../src/capabilities/publishing/index.js';
import { buildApp } from '../../src/app.js';
import { richDemoContent } from '../../scripts/demo-content.js';
import { backupInstance, restoreInstance } from '../../scripts/recovery.js';

function object(value: unknown): Record<string, unknown> {
  assert(value && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, unknown>;
}
function string(value: unknown): string { assert.equal(typeof value, 'string'); return value as string; }

test('native PostgreSQL 18 recovery preserves the whole synthetic instance and refuses unsafe targets', async t => {
  const base = readConfig(process.env); const baseUrl = new URL(base.databaseUrl);
  assert.notEqual(base.nodeEnv, 'production'); assert(['127.0.0.1', 'localhost', '[::1]'].includes(baseUrl.hostname));
  const administrator = createDatabase(base, () => {});
  assert.equal(Math.floor(Number((await administrator.pool.query("SELECT current_setting('server_version_num') AS version")).rows[0].version) / 10000), 18);
  const suffix = randomUUID().replaceAll('-', '');
  const sourceName = 'scrawl_recovery_source_' + suffix;
  const restoredName = 'scrawl_recovery_restored_' + suffix;
  const failedName = 'scrawl_recovery_failed_' + suffix;
  const root = await mkdtemp(join(tmpdir(), 'scrawl-recovery-'));
  const sourceStorage = join(root, 'source-files');
  const backup = join(root, 'backup'); const restoredStorage = join(root, 'restored-files');
  await mkdir(sourceStorage, { mode: 0o700 });
  let ownsSource = false; let ownsRestored = false;
  let database: ReturnType<typeof createDatabase> | undefined;
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  t.after(async () => {
    await app?.close(); await database?.close();
    if (ownsRestored) await administrator.pool.query(`DROP DATABASE "${restoredName}"`);
    if (ownsSource) await administrator.pool.query(`DROP DATABASE "${sourceName}"`);
    await administrator.close(); await rm(root, { recursive: true, force: true });
  });
  await administrator.pool.query(`CREATE DATABASE "${sourceName}" TEMPLATE template0`); ownsSource = true;
  const sourceUrl = new URL(baseUrl); sourceUrl.pathname = '/' + sourceName; sourceUrl.search = '';
  const config = { ...base, databaseUrl: sourceUrl.href, attachmentStorageDir: sourceStorage, publicPublishingEnabled: true };
  const options = { config, ...(process.env.SCRAWL_PG_CLIENT_CONTAINER ? { clientContainer: process.env.SCRAWL_PG_CLIENT_CONTAINER } : {}) };
  function cli(args: string[]) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/recovery.ts', ...args,
      ...(options.clientContainer ? ['--client-container', options.clientContainer] : [])], {
      env: { ...process.env, NODE_ENV: 'test', DATABASE_URL: config.databaseUrl, ATTACHMENT_STORAGE_DIR: sourceStorage }, encoding: 'utf8',
    });
    assert.equal(result.status, 0, 'The actual recovery command must succeed');
    assert.equal(result.stderr, '', 'Successful recovery must not suppress a native warning');
    assert(!result.stdout.includes(config.databaseUrl), 'Recovery output cannot contain connection secrets');
    return object(JSON.parse(result.stdout) as unknown);
  }
  const migration = spawnSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: sourceUrl.href }, encoding: 'utf8',
  }); assert.equal(migration.status, 0, 'The single migration history must deploy into the owned source');
  await t.test('backs up an empty migrated instance before its first upload creates private storage', async () => {
    await rm(sourceStorage, { recursive: true });
    const result = await backupInstance({ ...options, output: join(root, 'empty-backup'), applicationStopped: true });
    assert.equal(result.integrity.ok, true); assert.equal(result.integrity.documents, 0); assert.equal(result.files, 0);
    await assert.rejects(lstat(sourceStorage), { code: 'ENOENT' });
  });
  database = createDatabase(config, () => {});
  const migrationCountBefore = (await database.pool.query<{ count: number }>('SELECT count(*)::int AS count FROM _prisma_migrations')).rows[0]!.count;
  const identity = { origin: 'http://127.0.0.1:3000', secret: randomBytes(32).toString('hex'), secureCookies: false };
  const core = createCore(database.prisma, identity, { attachmentStorageDir: sourceStorage });
  const operator = createOperator(database.prisma, identity);
  const publishing = createPublishing(core.documents, core.identity, { enabled: true });
  app = await buildApp({ config, core, publishing, checkDatabase: () => database!.ping(), logging: false });
  let address = await app.listen({ host: '127.0.0.1', port: 0 });
  let peer = 110;
  function client() {
    const localAddress = `127.0.0.${peer++}`;
    let cookie = '';
    return {
      get headers() { return new Headers({ cookie }); },
      async send(method: string, path: string, payload?: unknown, headers: Record<string, string> = {}) {
        const binary = Buffer.isBuffer(payload);
        const body = payload === undefined ? undefined : binary ? payload : Buffer.from(JSON.stringify(payload));
        return new Promise<{ status: number; data: unknown; bytes: Buffer; etag?: string }>((done, reject) => {
          const request = httpRequest(new URL(path, address), { method, localAddress, headers: {
            origin: identity.origin, ...(cookie ? { cookie } : {}), ...headers,
            ...(body ? { 'content-type': binary ? 'application/octet-stream' : 'application/json', 'content-length': String(body.length) } : {}),
          } }, response => {
            const chunks: Buffer[] = [];
            response.on('data', (chunk: Buffer) => chunks.push(chunk)); response.on('error', reject);
            response.on('end', () => {
              if (response.headers['set-cookie']) cookie = response.headers['set-cookie'].map(value => value.split(';')[0]).join('; ');
              const bytes = Buffer.concat(chunks); const json = /application\/(json|problem\+json)/.test(String(response.headers['content-type']));
              done({ status: response.statusCode!, data: bytes.length && json ? JSON.parse(bytes.toString()) as unknown : null, bytes,
                ...(response.headers.etag ? { etag: response.headers.etag } : {}) });
            });
          }); request.on('error', reject); request.end(body);
        });
      },
    };
  }
  const password = randomBytes(24).toString('base64url');
  const ownerUser = await operator.bootstrap({ email: 'recovery-owner@example.test', name: 'Synthetic Recovery Owner', password });
  const readerUser = await operator.provision({ email: 'recovery-reader@example.test', name: 'Synthetic Reader', password });
  const outsiderUser = await operator.provision({ email: 'recovery-outsider@example.test', name: 'Synthetic Outsider', password });
  const admin = client(), reader = client(), outsider = client(), anonymous = client();
  for (const [agent, user] of [[admin, ownerUser], [reader, readerUser], [outsider, outsiderUser]] as const) {
    assert.equal((await agent.send('POST', '/api/auth/sign-in/email', { email: user.email, password })).status, 200);
  }
  const space = await admin.send('POST', '/api/v1/spaces', { name: 'Synthetic recovery handbook' }); assert.equal(space.status, 201);
  const spaceId = string(object(space.data).id);
  assert.equal((await admin.send('PUT', `/api/v1/spaces/${spaceId}/members/${readerUser.id}`, { role: 'reader' }, { 'if-match': space.etag! })).status, 200);
  const content = richDemoContent(['Synthetic recovery handbook', 'Durable private operations and rollback guidance']);
  const created = await admin.send('POST', `/api/v1/spaces/${spaceId}/documents`, { title: 'Synthetic approved handbook', content });
  assert.equal(created.status, 201); const id = string(object(created.data).id); const path = `/api/v1/documents/${id}`;
  const approvedBytes = Buffer.from('Synthetic approved attachment bytes.');
  const upload = await admin.send('POST', path + '/attachments', approvedBytes, { 'x-file-name': 'approved.txt' }); assert.equal(upload.status, 201);
  const attachmentId = string(object(upload.data).id);
  const approvedContent = { ...content, document: [...content.document,
    { id: 'synthetic-approved-file', type: 'file', props: { url: string(object(upload.data).url), name: 'approved.txt' } }] };
  const approved = await admin.send('PATCH', path, { title: 'Synthetic approved handbook', content: approvedContent }, { 'if-match': created.etag! });
  assert.equal(approved.status, 200);
  const approvedRevision = string(object(object(approved.data).revision).id);
  const published = await admin.send('POST', path + '/publication', { revisionId: approvedRevision }, { 'if-match': approved.etag! });
  assert.equal(published.status, 200); const publicId = string(object(object(published.data).publication).publicId);
  const privateUpload = await admin.send('POST', path + '/attachments', Buffer.from('Synthetic newer private bytes.'), { 'x-file-name': 'private.txt' });
  assert.equal(privateUpload.status, 201); const privateAttachmentId = string(object(privateUpload.data).id);
  const privateSaved = await admin.send('PATCH', path, { title: 'Synthetic private recovery handbook',
    content: { ...approvedContent, document: [...approvedContent.document,
      { id: 'synthetic-private-file', type: 'file', props: { url: string(object(privateUpload.data).url), name: 'private.txt' } }] } },
    { 'if-match': published.etag! }); assert.equal(privateSaved.status, 200);
  assert.equal((await reader.send('PUT', path + '/favorite', { favorited: true })).status, 200);
  const liveCreated = await admin.send('POST', `/api/v1/spaces/${spaceId}/documents`, { title: 'Synthetic live draft', content });
  assert.equal(liveCreated.status, 201); const liveId = string(object(liveCreated.data).id);
  const room = await core.documents.live.enroll(admin.headers, liveId, liveCreated.etag);
  await core.documents.live.comment(admin.headers, liveId, room.epoch,
    { type: 'create', body: [{ id: 'synthetic-restored-comment', type: 'paragraph', content: [{ type: 'text', text: 'Synthetic retained review note', styles: {} }] }] });
  const liveBefore = await core.documents.live.read(reader.headers, liveId);
  const sourceBefore = await database.prisma.document.findMany({ orderBy: { id: 'asc' }, include: { revisions: true } });
  const orphanId = randomUUID(), orphanBytes = Buffer.from('Synthetic unregistered bytes retained for operator review.');
  await writeFile(join(sourceStorage, orphanId), orphanBytes, { flag: 'wx', mode: 0o600 });

  await t.test('requires stopped connections and non-production whole-database targets before creating outputs', async () => {
    await assert.rejects(backupInstance({ ...options, output: backup, applicationStopped: false }));
    await assert.rejects(backupInstance({ ...options, config: { ...config, nodeEnv: 'production' }, output: backup, applicationStopped: true }));
    await assert.rejects(backupInstance({ ...options, output: 'web/dist/private-backup', applicationStopped: true }), /never source or frontend/);
    await assert.rejects(backupInstance({ ...options, output: backup, applicationStopped: true }), /Stop every application/);
    await assert.rejects(lstat(backup), { code: 'ENOENT' });
  });
  await app.close(); app = undefined; await database.close(); database = undefined;
  await t.test('native dump and matching private bytes form an owner-only complete backup, without runtime secrets', async () => {
    const result = cli(['backup', '--output', backup, '--application-stopped']);
    assert.equal(result.files, 3); assert.equal(object(result.integrity).documents, 2); assert.equal(object(result.integrity).revisions, 4);
    const manifest = await readFile(join(backup, 'manifest.json'), 'utf8');
    for (const secret of [password, identity.secret, config.databaseUrl]) assert(!manifest.includes(secret));
    assert.equal((await lstat(backup)).mode & 0o077, 0);
    for (const file of ['manifest.json', 'database.dump', `files/${attachmentId}`]) assert.equal((await lstat(join(backup, file))).mode & 0o077, 0);
    await assert.rejects(backupInstance({ ...options, output: backup, applicationStopped: true }), { code: 'EEXIST' });
    assert.equal(await readFile(join(backup, 'manifest.json'), 'utf8'), manifest);
  });
  await t.test('refuses untrusted archives, unrelated names and existing storage without creating a database', async () => {
    const common = { ...options, backup, databaseName: failedName, storage: sourceStorage };
    await assert.rejects(restoreInstance({ ...common, trusted: false }));
    await assert.rejects(restoreInstance({ ...common, trusted: true, databaseName: sourceName.replace('scrawl_recovery_', 'retained_') }));
    await assert.rejects(restoreInstance({ ...common, trusted: true }), { code: 'EEXIST' });
    await assert.rejects(restoreInstance({ ...common, storage: join(backup, 'new-files'), trusted: true }), /separate from the immutable backup/);
    await assert.rejects(lstat(join(backup, 'new-files')), { code: 'ENOENT' });
    assert.equal((await administrator.pool.query('SELECT 1 FROM pg_database WHERE datname = $1', [failedName])).rowCount, 0);
  });
  await t.test('refuses missing, tampered and symbolic-link private files before creating a target', async () => {
    const file = join(backup, 'files', attachmentId); const original = await readFile(file);
    await rm(file); await symlink(join(sourceStorage, attachmentId), file);
    await assert.rejects(restoreInstance({ ...options, backup, databaseName: failedName, storage: restoredStorage, trusted: true }));
    await rm(file); await writeFile(file, Buffer.from('Corrupted synthetic bytes'), { mode: 0o600 });
    await assert.rejects(restoreInstance({ ...options, backup, databaseName: failedName, storage: restoredStorage, trusted: true }));
    await rm(file);
    await assert.rejects(restoreInstance({ ...options, backup, databaseName: failedName, storage: restoredStorage, trusted: true }));
    await writeFile(file, original, { mode: 0o600 });
    assert.equal((await administrator.pool.query('SELECT 1 FROM pg_database WHERE datname = $1', [failedName])).rowCount, 0);
  });
  await t.test('rejects malformed manifests, path traversal and incomplete backup sets before touching a target', async () => {
    const manifestPath = join(backup, 'manifest.json'); const original = await readFile(manifestPath);
    const restore = () => restoreInstance({ ...options, backup, databaseName: failedName, storage: restoredStorage, trusted: true });
    try {
      await writeFile(manifestPath, '{'); await assert.rejects(restore());
      const manifest = object(JSON.parse(original.toString()) as unknown);
      const files = manifest.files as Record<string, unknown>[];
      files[0]!.name = '../outside'; await writeFile(manifestPath, JSON.stringify(manifest)); await assert.rejects(restore());
      await rm(manifestPath); await assert.rejects(restore());
    } finally { await writeFile(manifestPath, original, { mode: 0o600 }); }
    assert.equal((await administrator.pool.query('SELECT 1 FROM pg_database WHERE datname = $1', [failedName])).rowCount, 0);
    await assert.rejects(lstat(restoredStorage), { code: 'ENOENT' });
  });
  await t.test('native restore is transactional, cleans only its failed new target and preserves the source', async () => {
    const dumpPath = join(backup, 'database.dump'), manifestPath = join(backup, 'manifest.json');
    const originalDump = await readFile(dumpPath), originalManifest = await readFile(manifestPath);
    const truncated = originalDump.subarray(0, originalDump.length - 10);
    const manifest = object(JSON.parse(originalManifest.toString()) as unknown);
    manifest.dump = { name: 'database.dump', size: truncated.length, sha256: createHash('sha256').update(truncated).digest('hex') };
    await writeFile(dumpPath, truncated); await writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(restoreInstance({ ...options, backup, databaseName: failedName, storage: restoredStorage, trusted: true }), /Native pg_restore failed/);
    assert.equal((await administrator.pool.query('SELECT 1 FROM pg_database WHERE datname = $1', [failedName])).rowCount, 0);
    await assert.rejects(lstat(restoredStorage), { code: 'ENOENT' });
    await writeFile(dumpPath, originalDump); await writeFile(manifestPath, originalManifest);
  });
  await t.test('restores the entire migration ledger, records and immutable private files into a fresh owned target', async () => {
    const result = cli(['restore', '--backup', backup, '--database', restoredName, '--storage', restoredStorage, '--trusted']);
    ownsRestored = true; assert.equal(object(result.integrity).ok, true); assert.equal(result.files, 3);
    const restoredUrl = new URL(sourceUrl); restoredUrl.pathname = '/' + restoredName;
    const restoredDatabase = createDatabase({ ...config, databaseUrl: restoredUrl.href, attachmentStorageDir: restoredStorage }, () => {});
    try {
      assert.deepEqual(await restoredDatabase.prisma.document.findMany({ orderBy: { id: 'asc' }, include: { revisions: true } }), sourceBefore);
      assert.equal((await restoredDatabase.pool.query<{ count: number }>('SELECT count(*)::int AS count FROM _prisma_migrations')).rows[0]!.count, migrationCountBefore);
    } finally { await restoredDatabase.close(); }
    assert.deepEqual(await readFile(join(restoredStorage, attachmentId)), approvedBytes);
    assert.deepEqual(await readFile(join(restoredStorage, orphanId)), orphanBytes, 'Recovery must preserve private unregistered bytes, never clean them implicitly');
    const beforeManifest = await readFile(join(backup, 'manifest.json'));
    await assert.rejects(restoreInstance({ ...options, backup, databaseName: restoredName, storage: join(root, 'existing-db-refusal'), trusted: true }), /already exists/);
    assert.deepEqual(await readFile(join(backup, 'manifest.json')), beforeManifest);
    assert.equal((await administrator.pool.query('SELECT 1 FROM pg_database WHERE datname = $1', [restoredName])).rowCount, 1);
  });
  const restoredUrl = new URL(sourceUrl); restoredUrl.pathname = '/' + restoredName;
  const restoredConfig = { ...config, databaseUrl: restoredUrl.href, attachmentStorageDir: restoredStorage };
  database = createDatabase(restoredConfig, () => {});
  const restoredCore = createCore(database.prisma, identity, { attachmentStorageDir: restoredStorage });
  app = await buildApp({ config: restoredConfig, core: restoredCore,
    publishing: createPublishing(restoredCore.documents, restoredCore.identity, { enabled: true }),
    checkDatabase: () => database!.ping(), logging: false });
  address = await app.listen({ host: '127.0.0.1', port: 0 });
  await t.test('existing sessions, rich history, saved search, personal favorites and live comments survive', async () => {
    for (const agent of [admin, reader, outsider]) assert.equal((await agent.send('GET', '/api/v1/me')).status, 200);
    const saved = await reader.send('GET', path); assert.equal(saved.status, 200); assert.deepEqual(saved.data, privateSaved.data);
    assert.equal(saved.etag, privateSaved.etag);
    assert.equal(object(await restoredCore.documents.live.read(reader.headers, liveId)).sequence, liveBefore.sequence);
    assert.deepEqual((await restoredCore.documents.live.read(reader.headers, liveId)).state, liveBefore.state);
    const history = await reader.send('GET', path + '/revisions'); assert.equal(history.status, 200);
    assert.equal((object(history.data).items as unknown[]).length, 3);
    const favorites = await reader.send('GET', '/api/v1/favorites'); assert.equal(favorites.status, 200);
    assert.equal(string(object((object(favorites.data).items as unknown[])[0]).id), id);
    const search = await reader.send('GET', `/api/v1/search?q=recovery&spaceId=${spaceId}`); assert.equal(search.status, 200);
    assert((object(search.data).items as unknown[]).some(item => object(item).id === id));
    assert.equal((await outsider.send('GET', path)).status, 404);
    assert.equal((await outsider.send('GET', path + '/revisions')).status, 404);
    assert.deepEqual(object((await outsider.send('GET', '/api/v1/search?q=recovery')).data).items, []);
    assert.equal((await reader.send('PATCH', path, { title: 'Forbidden', content }, { 'if-match': saved.etag! })).status, 404);
  });
  await t.test('selected public revision and file boundaries survive independently of newer private content', async () => {
    const publicPath = `/api/public/publications/${publicId}`;
    const result = await anonymous.send('GET', publicPath); assert.equal(result.status, 200);
    assert(result.bytes.toString().includes('Synthetic approved handbook'));
    assert(!result.bytes.toString().includes('Synthetic private recovery handbook'));
    assert(!result.bytes.toString().includes(privateAttachmentId));
    assert.deepEqual((await anonymous.send('GET', publicPath + '/attachments/' + attachmentId)).bytes, approvedBytes);
    assert.equal((await anonymous.send('GET', publicPath + '/attachments/' + privateAttachmentId)).status, 404);
    assert.equal((await anonymous.send('GET', string(object(upload.data).url))).status, 401);
  });
  await t.test('fresh login and conditional writes remain authoritative after restore, with unchanged source history', async () => {
    const fresh = client(); assert.equal((await fresh.send('POST', '/api/auth/sign-in/email', { email: ownerUser.email, password })).status, 200);
    const before = await database!.prisma.documentRevision.count({ where: { documentId: id } });
    const changed = await fresh.send('PATCH', path, { title: 'Synthetic restored-only edit', content }, { 'if-match': privateSaved.etag! });
    assert.equal(changed.status, 200);
    assert.equal((await fresh.send('PATCH', path, { title: 'Rejected stale edit', content }, { 'if-match': privateSaved.etag! })).status, 412);
    assert.equal((await fresh.send('PATCH', path, { title: 'Rejected missing precondition', content })).status, 428);
    assert.equal(await database!.prisma.documentRevision.count({ where: { documentId: id } }), before + 1);
    const source = createDatabase(config, () => {});
    try { assert.deepEqual(await source.prisma.document.findMany({ orderBy: { id: 'asc' }, include: { revisions: true } }), sourceBefore); }
    finally { await source.close(); }
  });
});
