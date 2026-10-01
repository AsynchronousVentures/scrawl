// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { readConfig } from '../../src/config.js';
import { createDatabase } from '../../src/db/client.js';
import { createCore } from '../../src/core/index.js';
import { createOperator } from '../../src/core/identity/operator.js';
import { HttpProblem } from '../../src/http/problems.js';
import { buildApp } from '../../src/app.js';
import { CONTENT_LIMITS, validateContent } from '../../src/core/documents/content.js';

function content(text: string) {
  return validateContent({ format: 'blocknote-json', schemaVersion: 1, editorVersion: '0.55.0',
    document: [{ id: 'synthetic-body', type: 'paragraph', content: [{ type: 'text', text, styles: {} }] }] }).content;
}

test('P2 documents and immutable history against PostgreSQL and authenticated HTTP sessions', async (t) => {
  const baseConfig = readConfig(process.env);
  const url = new URL(baseConfig.databaseUrl);
  assert(baseConfig.nodeEnv !== 'production' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname),
    'Integration fixtures require a local non-production database');
  const adminDatabase = createDatabase(baseConfig, () => {});
  const schema = 'scrawl_test_' + randomUUID().replaceAll('-', '');
  await adminDatabase.pool.query(`CREATE SCHEMA "${schema}"`);
  url.searchParams.set('schema', schema);
  const config = { ...baseConfig, databaseUrl: url.href };
  const database = createDatabase(config, () => {});
  const identityConfig = { origin: 'http://127.0.0.1:3000', secret: randomBytes(32).toString('hex'), secureCookies: false };
  const core = createCore(database.prisma, identityConfig);
  const operator = createOperator(database.prisma, identityConfig);
  const app = await buildApp({ config, core, checkDatabase: () => database.ping(), logging: false });
  t.after(async () => {
    await app.close();
    await database.close();
    await adminDatabase.pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await adminDatabase.close();
  });

  for (let attempt = 0; attempt < 2; attempt++) {
    const migration = spawnSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
      env: { ...process.env, DATABASE_URL: config.databaseUrl }, encoding: 'utf8',
    });
    assert.equal(migration.status, 0, 'The full migration history must deploy and safely reapply');
  }
  const migrations = await database.pool.query<{ migration_name: string }>(
    'SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL ORDER BY migration_name',
  );
  const expectedHistory = (await readdir('prisma/migrations', { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  assert.deepEqual(migrations.rows.map(row => row.migration_name), expectedHistory, 'One reviewed migration history deploys completely');
  assert.equal(migrations.rows[0]?.migration_name, '20260930000000_identity_spaces');
  assert.equal(migrations.rows[2]?.migration_name, '20260930020000_blocknote_native');
  const address = await app.listen({ host: '127.0.0.1', port: 0 });

  function client(peer: string) {
    let cookie = '';
    return {
      get cookie() { return cookie; },
      async send(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
        const payload = body === undefined ? undefined : JSON.stringify(body);
        // The wire JSON boundary is narrowed by contract assertions in each scenario.
        return new Promise<{ status: number; body: string; data: ReturnType<typeof JSON.parse>; headers: import('node:http').IncomingHttpHeaders }>((resolve, reject) => {
          const req = httpRequest(new URL(path, address), {
            method, localAddress: peer,
            headers: {
              origin: identityConfig.origin,
              ...(cookie ? { cookie } : {}),
              ...(payload ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) } : {}),
              ...headers,
            },
          }, (response) => {
            const chunks: Buffer[] = [];
            response.on('data', (chunk: Buffer) => chunks.push(chunk));
            response.on('error', reject);
            response.on('end', () => {
              const cookies = response.headers['set-cookie'];
              if (cookies) cookie = cookies.map((value) => value.split(';')[0]).join('; ');
              const bodyText = Buffer.concat(chunks).toString();
              resolve({ status: response.statusCode!, body: bodyText,
                data: bodyText ? JSON.parse(bodyText) : null, headers: response.headers });
            });
          });
          req.on('error', reject);
          req.end(payload);
        });
      },
    };
  }

  const password = randomBytes(24).toString('base64url');
  const adminUser = await operator.bootstrap({ email: 'owner@example.test', name: 'Owner', password });
  const readerUser = await operator.provision({ email: 'reader@example.test', name: 'Reader', password });
  const editorUser = await operator.provision({ email: 'editor@example.test', name: 'Editor', password });
  await operator.provision({ email: 'outsider@example.test', name: 'Outsider', password });
  const admin = client('127.0.0.21');
  const reader = client('127.0.0.22');
  const editor = client('127.0.0.23');
  const outsider = client('127.0.0.24');
  const anonymous = client('127.0.0.25');
  for (const [agent, email] of [[admin, adminUser.email], [reader, readerUser.email], [editor, editorUser.email],
    [outsider, 'outsider@example.test']] as const) {
    assert.equal((await agent.send('POST', '/api/auth/sign-in/email', { email, password })).status, 200);
    assert.equal((await agent.send('GET', '/api/v1/me')).status, 200);
  }
  const space = await admin.send('POST', '/api/v1/spaces', { name: 'Synthetic document space' });
  assert.equal(space.status, 201);
  const spaceId: string = space.data.id;
  let spaceEtag = String(space.headers.etag);
  for (const [user, role] of [[readerUser, 'reader'], [editorUser, 'editor']] as const) {
    const grant = await admin.send('PUT', `/api/v1/spaces/${spaceId}/members/${user.id}`, { role }, { 'if-match': spaceEtag });
    assert.equal(grant.status, 200);
    spaceEtag = String(grant.headers.etag);
  }
  const privateSpace = await admin.send('POST', '/api/v1/spaces', { name: 'Synthetic private space' });
  assert.equal(privateSpace.status, 201);
  const privateSpaceId: string = privateSpace.data.id;
  const initialContent = content('Synthetic initial body');
  let documentId: string;
  let secondDocumentId: string;
  let firstRevisionId: string;
  let secondRevisionId: string;
  let etag: string;

  const documentPath = () => `/api/v1/documents/${documentId}`;
  const revisionCount = () => database.prisma.documentRevision.count({ where: { documentId } });
  const blockedSpaceWriters = async () => {
    const result = await database.pool.query<{ count: string }>(
      `SELECT count(DISTINCT a.pid)::text FROM pg_stat_activity a JOIN pg_locks l ON l.pid = a.pid
        WHERE a.wait_event_type = 'Lock' AND a.query LIKE '%FROM "Space"%FOR UPDATE%'
          AND l.relation = $1::regclass`, [`"${schema}"."Space"`],
    );
    return Number(result.rows[0]?.count);
  };
  const expectProblem = (response: Awaited<ReturnType<typeof admin.send>>, status: number) => {
    assert.equal(response.status, status);
    assert.equal(response.data.status, status);
    assert.equal(response.headers.etag, undefined);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert(!response.body.includes('Synthetic'));
    assert(!response.body.includes('currentRevisionNumber'));
    assert(!response.body.includes('lockVersion'));
    assert(!response.body.includes('DocumentRevision'));
  };

  await t.test('authorized create derives creator/author and returns a separate native content DTO', async () => {
    for (const [agent, status] of [[anonymous, 401], [reader, 404], [outsider, 404]] as const) {
      expectProblem(await agent.send('POST', `/api/v1/spaces/${spaceId}/documents`, {
        title: 'Synthetic denied title', content: initialContent,
      }), status);
    }
    expectProblem(await reader.send('POST', `/api/v1/spaces/${privateSpaceId}/documents`, {
      title: 'Synthetic denied title', content: initialContent,
    }), 404);
    expectProblem(await editor.send('POST', `/api/v1/spaces/${spaceId}/documents`, {
      title: 'Synthetic forged author', content: initialContent, createdBy: adminUser.id,
    }), 400);
    const result = await editor.send('POST', `/api/v1/spaces/${spaceId}/documents`, {
      title: 'Synthetic initial title', content: initialContent, changeNote: 'Initial snapshot',
    });
    assert.equal(result.status, 201);
    documentId = result.data.id;
    firstRevisionId = result.data.revision.id;
    etag = String(result.headers.etag);
    assert.equal(result.headers.location, documentPath());
    assert.equal(etag, `"doc-${documentId}-bn1-v1"`);
    assert.equal(result.data.editingMode, 'solo');
    assert.deepEqual(Object.keys(result.data).sort(), ['id', 'slug', 'spaceId', 'spaceSlug', 'parentDocumentId', 'editingMode', 'currentRevisionNumber', 'lockVersion',
      'createdAt', 'createdBy', 'updatedAt', 'archivedAt', 'archivedBy', 'revision'].sort());
    assert.deepEqual(Object.keys(result.data.revision).sort(), ['id', 'documentId', 'revisionNumber', 'title',
      'content', 'plainText', 'authorId', 'createdAt', 'changeNote'].sort());
    assert.equal(result.data.createdBy, editorUser.id);
    assert.equal(result.data.revision.authorId, editorUser.id);
    assert.equal(result.data.currentRevisionNumber, 1);
    assert.equal(result.data.revision.revisionNumber, 1);
    assert.equal(result.data.lockVersion, 1);
    assert.equal(result.data.archivedAt, null);
    assert.equal(result.data.archivedBy, null);
    assert.deepEqual(result.data.revision.content, initialContent);
    assert.equal(result.data.revision.plainText, 'Synthetic initial body');
    assert.equal(result.data.revision.changeNote, 'Initial snapshot');
    assert.equal(await revisionCount(), 1);
    const second = await admin.send('POST', `/api/v1/spaces/${spaceId}/documents`, {
      title: 'Synthetic second document', content: content('Synthetic second body'),
    });
    assert.equal(second.status, 201);
    secondDocumentId = second.data.id;
    const updatedSecond = await admin.send('PATCH', `/api/v1/documents/${secondDocumentId}`, {
      title: 'Synthetic second revision',
    }, { 'if-match': String(second.headers.etag) });
    assert.equal(updatedSecond.status, 200);
    secondRevisionId = updatedSecond.data.revision.id;
    assert.equal(updatedSecond.data.currentRevisionNumber, 2);
  });

  await t.test('native snapshots retain their producing version and PostgreSQL refuses invalid native encodings', async () => {
    const original = await database.prisma.documentRevision.findUniqueOrThrow({ where: { id: firstRevisionId } });
    assert.equal(original.contentFormat, 'blocknote-json');
    assert.equal(original.contentSchemaVersion, 1);
    assert.equal(original.contentEditorVersion, '0.55.0');
    for (const version of [null, 'future']) {
      await assert.rejects(database.pool.query('UPDATE "DocumentRevision" SET "contentEditorVersion" = $1 WHERE "id" = $2', [version, firstRevisionId]),
        (error: unknown) => error instanceof Error && 'code' in error && error.code === '23514');
    }
    await assert.rejects(database.pool.query('UPDATE "DocumentRevision" SET "body" = $1 WHERE "id" = $2', ['{}', firstRevisionId]),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === '23514');
    assert.deepEqual(await database.prisma.documentRevision.findUniqueOrThrow({ where: { id: firstRevisionId } }), original);
  });

  await t.test('PostgreSQL checks missing and cross-document heads at transaction commit', async () => {
    const brokenId = randomUUID();
    const connection = await database.pool.connect();
    try {
      await connection.query('BEGIN');
      // Insertion succeeds before the deferred check; COMMIT must reject the missing initial revision.
      await connection.query(`INSERT INTO "Document"
        ("id", "slug", "spaceId", "currentRevisionNumber", "lockVersion", "createdBy", "createdAt", "updatedAt")
        VALUES ($1, 'broken-head', $2, 1, 1, $3, now(), now())`, [brokenId, spaceId, editorUser.id]);
      await assert.rejects(connection.query('COMMIT'), (error: unknown) =>
        error instanceof Error && 'code' in error && error.code === '23503');
      await connection.query('ROLLBACK');
      assert.equal(await database.prisma.document.count({ where: { id: brokenId } }), 0);
      await connection.query('BEGIN');
      // Revision 2 exists only on the other document, so matching its number alone is insufficient.
      await connection.query('UPDATE "Document" SET "currentRevisionNumber" = 2 WHERE "id" = $1', [documentId]);
      await assert.rejects(connection.query('COMMIT'), (error: unknown) =>
        error instanceof Error && 'code' in error && error.code === '23503');
      await connection.query('ROLLBACK');
      assert.equal((await database.prisma.document.findUniqueOrThrow({ where: { id: documentId } })).currentRevisionNumber, 1);
    } finally {
      await connection.query('ROLLBACK');
      connection.release();
    }
  });

  await t.test('authorized bounded lists and reads expose no hidden titles, content, or versions', async () => {
    const visible = await reader.send('GET', documentPath());
    assert.equal(visible.status, 200);
    assert.equal(String(visible.headers.etag), etag);
    assert.deepEqual(visible.data.revision.content, initialContent);
    const listPath = `/api/v1/spaces/${spaceId}/documents`;
    const first = await reader.send('GET', listPath + '?limit=1');
    assert.equal(first.status, 200);
    assert.equal(first.data.items.length, 1);
    assert.equal(typeof first.data.items[0].title, 'string');
    assert(!('content' in first.data.items[0]));
    assert(!('revision' in first.data.items[0]));
    assert(!('plainText' in first.data.items[0]));
    const second = await reader.send('GET', listPath + '?limit=1&cursor=' + first.data.nextCursor);
    assert.equal(second.data.items.length, 1);
    assert.notEqual(first.data.items[0].id, second.data.items[0].id);
    assert.equal(second.data.nextCursor, null);
    for (const query of ['limit=0', 'limit=101', 'cursor=invalid', 'includeArchived=invalid', 'unexpected=true']) {
      expectProblem(await reader.send('GET', listPath + '?' + query), 400);
    }
    for (const path of [listPath, documentPath(), documentPath() + '/revisions',
      documentPath() + '/revisions/' + firstRevisionId, `/api/v1/spaces/${privateSpaceId}/documents`]) {
      expectProblem(await outsider.send('GET', path), 404);
      expectProblem(await anonymous.send('GET', path), 401);
    }
    expectProblem(await reader.send('GET', `/api/v1/spaces/${privateSpaceId}/documents`), 404);
    expectProblem(await reader.send('GET', '/api/v1/documents/' + randomUUID()), 404);
  });

  await t.test('every existing-document mutation requires exactly one current strong ETag', async () => {
    const operations = [
      { method: 'PATCH', suffix: '', body: { title: 'Synthetic changed title' } },
      { method: 'POST', suffix: '/restore', body: { revisionId: firstRevisionId } },
      { method: 'POST', suffix: '/archive', body: {} },
      { method: 'POST', suffix: '/unarchive', body: {} },
    ];
    for (const operation of operations) {
      const path = documentPath() + operation.suffix;
      expectProblem(await editor.send(operation.method, path, operation.body), 428);
      expectProblem(await editor.send(operation.method, path, operation.body, { 'if-match': '"stale-tag"' }), 412);
      for (const invalid of [`W/${etag}`, '*', `${etag}, ${etag}`, 'unquoted']) {
        expectProblem(await editor.send(operation.method, path, operation.body, { 'if-match': invalid }), 400);
      }
    }
    assert.equal(await revisionCount(), 1);
    assert.equal(String((await reader.send('GET', documentPath())).headers.etag), etag);
  });

  await t.test('readers and outsiders cannot mutate or bypass core policy with verified sessions', async () => {
    for (const [agent, status] of [[reader, 404], [outsider, 404], [anonymous, 401]] as const) {
      for (const [method, suffix, body] of [
        ['PATCH', '', { title: 'Synthetic denied update' }],
        ['POST', '/restore', { revisionId: firstRevisionId }],
        ['POST', '/archive', {}], ['POST', '/unarchive', {}],
      ] as const) {
        expectProblem(await agent.send(method, documentPath() + suffix, body, { 'if-match': etag }), status);
      }
    }
    const readerHeaders = new Headers({ cookie: reader.cookie });
    const outsiderHeaders = new Headers({ cookie: outsider.cookie });
    const editorHeaders = new Headers({ cookie: editor.cookie });
    const notFound = (error: unknown) => error instanceof HttpProblem && error.status === 404;
    await assert.rejects(core.documents.create(readerHeaders, spaceId, { title: 'Denied', content: initialContent }), notFound);
    await assert.rejects(core.documents.read(outsiderHeaders, documentId), notFound);
    await assert.rejects(core.documents.list(outsiderHeaders, spaceId), notFound);
    await assert.rejects(core.documents.listRevisions(outsiderHeaders, documentId), notFound);
    await assert.rejects(core.documents.readRevision(outsiderHeaders, documentId, firstRevisionId), notFound);
    await assert.rejects(core.documents.update(readerHeaders, documentId, { title: 'Denied' }, etag), notFound);
    await assert.rejects(core.documents.restore(readerHeaders, documentId, { revisionId: firstRevisionId }, etag), notFound);
    await assert.rejects(core.documents.archive(readerHeaders, documentId, etag), notFound);
    await assert.rejects(core.documents.unarchive(readerHeaders, documentId, etag), notFound);
    await assert.rejects(core.documents.update(new Headers({ 'x-user-id': adminUser.id }), documentId, { title: 'Denied' }, etag),
      (error: unknown) => error instanceof HttpProblem && error.status === 401);
    await assert.rejects(core.documents.update(editorHeaders, documentId, { title: 'Missing condition' }),
      (error: unknown) => error instanceof HttpProblem && error.status === 428);
    await assert.rejects(core.documents.update(editorHeaders, documentId, { content: { ...initialContent, extra: true } }, etag),
      (error: unknown) => error instanceof HttpProblem && error.status === 400);
    assert.equal(await revisionCount(), 1);
  });

  await t.test('title/body saves add snapshots, while a canonical no-op retains revision and lock version', async () => {
    const result = await editor.send('PATCH', documentPath(), { title: 'Synthetic title-only change', changeNote: 'Retitled' }, { 'if-match': etag });
    assert.equal(result.status, 200);
    assert.equal(result.data.currentRevisionNumber, 2);
    assert.equal(result.data.lockVersion, 2);
    assert.deepEqual(result.data.revision.content, initialContent);
    assert.equal(result.data.revision.plainText, 'Synthetic initial body');
    etag = String(result.headers.etag);
    const noOp = await editor.send('PATCH', documentPath(), {
      title: result.data.revision.title, content: initialContent, changeNote: 'Ignored no-op note',
    }, { 'if-match': etag });
    assert.equal(noOp.status, 200);
    assert.deepEqual(noOp.data, result.data);
    assert.equal(String(noOp.headers.etag), etag);
    assert.equal(await revisionCount(), 2);
    for (const input of [{}, { changeNote: 'No content fields' }, { title: 'Changed', lockVersion: 99 },
      { title: 'Changed', authorId: adminUser.id }, { title: 'Changed', spaceId: privateSpaceId }]) {
      expectProblem(await editor.send('PATCH', documentPath(), input, { 'if-match': etag }), 400);
    }
    const changed = await editor.send('PATCH', documentPath(), { content: content('Synthetic replacement body') }, { 'if-match': etag });
    assert.equal(changed.status, 200);
    assert.equal(changed.data.currentRevisionNumber, 3);
    assert.equal(changed.data.revision.title, 'Synthetic title-only change');
    assert.equal(changed.data.revision.plainText, 'Synthetic replacement body');
    assert.equal(changed.data.revision.authorId, editorUser.id);
    etag = String(changed.headers.etag);
  });

  await t.test('history is immutable, scoped to its document, and paginated without full bodies', async () => {
    const history = await reader.send('GET', documentPath() + '/revisions?limit=2');
    assert.equal(history.status, 200);
    assert.deepEqual(history.data.items.map((revision: { revisionNumber: number }) => revision.revisionNumber), [3, 2]);
    assert.equal(history.data.nextCursor, 2);
    assert(history.data.items.every((revision: Record<string, unknown>) => !('content' in revision) && !('plainText' in revision)));
    const last = await reader.send('GET', documentPath() + '/revisions?limit=2&cursor=2');
    assert.deepEqual(last.data.items.map((revision: { revisionNumber: number }) => revision.revisionNumber), [1]);
    assert.equal(last.data.nextCursor, null);
    for (const query of ['limit=101', 'cursor=0', 'cursor=invalid', 'unexpected=true']) {
      expectProblem(await reader.send('GET', documentPath() + '/revisions?' + query), 400);
    }
    const original = await reader.send('GET', documentPath() + '/revisions/' + firstRevisionId);
    assert.equal(original.status, 200);
    assert.equal(original.data.title, 'Synthetic initial title');
    assert.deepEqual(original.data.content, initialContent);
    assert.equal(original.data.authorId, editorUser.id);
    expectProblem(await editor.send('GET', documentPath() + '/revisions/' + secondRevisionId), 404);
    expectProblem(await editor.send('GET', `/api/v1/documents/${secondDocumentId}/revisions/${firstRevisionId}`), 404);
    expectProblem(await editor.send('POST', documentPath() + '/restore', { revisionId: secondRevisionId }, { 'if-match': etag }), 404);
    assert.equal(await revisionCount(), 3);
    assert.equal(String((await reader.send('GET', documentPath())).headers.etag), etag);
    const row = await database.prisma.documentRevision.findUniqueOrThrow({ where: { id: firstRevisionId } });
    assert.equal(row.title, 'Synthetic initial title');
    assert.deepEqual(row.body, initialContent.document);
  });

  await t.test('restore inserts a new attributed revision even when restoring the current content', async () => {
    const original = await database.prisma.documentRevision.findUniqueOrThrow({ where: { id: firstRevisionId } });
    const restored = await admin.send('POST', documentPath() + '/restore', {
      revisionId: firstRevisionId, changeNote: 'Restore initial content',
    }, { 'if-match': etag });
    assert.equal(restored.status, 200);
    assert.equal(restored.data.currentRevisionNumber, 4);
    assert.equal(restored.data.lockVersion, 4);
    assert.equal(restored.data.revision.title, original.title);
    assert.deepEqual(restored.data.revision.content, initialContent);
    assert.notEqual(restored.data.revision.id, firstRevisionId);
    assert.equal(restored.data.revision.authorId, adminUser.id);
    assert.equal(restored.data.revision.changeNote, 'Restore initial content');
    etag = String(restored.headers.etag);
    const sameContent = await editor.send('POST', documentPath() + '/restore', {
      revisionId: restored.data.revision.id,
    }, { 'if-match': etag });
    assert.equal(sameContent.status, 200);
    assert.equal(sameContent.data.currentRevisionNumber, 5);
    assert.equal(sameContent.data.lockVersion, 5);
    assert.notEqual(sameContent.data.revision.id, restored.data.revision.id);
    assert.equal(sameContent.data.revision.authorId, editorUser.id);
    assert.equal(await revisionCount(), 5);
    assert.deepEqual(await database.prisma.documentRevision.findUniqueOrThrow({ where: { id: firstRevisionId } }), original);
    etag = String(sameContent.headers.etag);
  });

  await t.test('two real simultaneous saves share one ETag and commit exactly one new revision', async () => {
    const before = await database.prisma.document.findUniqueOrThrow({ where: { id: documentId } });
    const beforeCount = await revisionCount();
    const lock = await database.pool.connect();
    await lock.query('BEGIN');
    let attempts: ReturnType<typeof editor.send>[] = [];
    try {
      await lock.query('SELECT "id" FROM "Space" WHERE "id" = $1 FOR UPDATE', [spaceId]);
      attempts = [
        editor.send('PATCH', documentPath(), { title: 'Synthetic race writer A' }, { 'if-match': etag }),
        admin.send('PATCH', documentPath(), { title: 'Synthetic race writer B' }, { 'if-match': etag }),
      ];
      let blocked = 0;
      for (let i = 0; i < 100; i++) {
        blocked = await blockedSpaceWriters();
        if (blocked >= 2) break;
        await delay(10);
      }
      assert.equal(blocked, 2, 'Both authenticated HTTP transactions must overlap waiting for the space row');
      await lock.query('COMMIT');
      const results = await Promise.all(attempts);
      assert.deepEqual(results.map((result) => result.status).sort(), [200, 412]);
      const winner = results.findIndex((result) => result.status === 200);
      const saved = await database.prisma.document.findUniqueOrThrow({ where: { id: documentId } });
      assert.equal(saved.currentRevisionNumber, before.currentRevisionNumber + 1);
      assert.equal(saved.lockVersion, before.lockVersion + 1);
      assert.equal(await revisionCount(), beforeCount + 1);
      const head = await database.prisma.documentRevision.findUniqueOrThrow({
        where: { documentId_revisionNumber: { documentId, revisionNumber: saved.currentRevisionNumber } },
      });
      assert.equal(head.title, winner === 0 ? 'Synthetic race writer A' : 'Synthetic race writer B');
      assert.equal(head.authorId, winner === 0 ? editorUser.id : adminUser.id);
      etag = String(results[winner]!.headers.etag);
    } finally {
      await lock.query('ROLLBACK');
      lock.release();
      await Promise.allSettled(attempts);
    }
  });

  await t.test('native blocks, formatting, media and advanced table cells persist without schema expansion or loss', async () => {
    const richContent = validateContent({ format: 'blocknote-json', schemaVersion: 1, editorVersion: '0.55.0', document: [
      { id: 'heading', type: 'heading', props: { level: 6, isToggleable: true }, content: [{ type: 'text', text: 'Synthetic heading', styles: { bold: true, italic: true } }] },
      { id: 'paragraph', type: 'paragraph', content: [
        { type: 'text', text: 'Synthetic after break\n', styles: { underline: true, strike: true, textColor: 'blue', backgroundColor: 'yellow' } },
        { type: 'link', href: 'https://example.test/docs', content: [{ type: 'text', text: 'Synthetic link', styles: {} }] },
      ] },
      { id: 'inline-code', type: 'paragraph', content: [{ type: 'text', text: 'Synthetic inline code', styles: { code: true } }] },
      { id: 'bullet', type: 'bulletListItem', content: [{ type: 'text', text: 'Synthetic bullet', styles: {} }] },
      { id: 'ordered', type: 'numberedListItem', props: { start: 3 }, content: [{ type: 'text', text: 'Synthetic ordered', styles: {} }] },
      { id: 'code', type: 'codeBlock', props: { language: 'typescript' }, content: [{ type: 'text', text: 'const synthetic = 1;', styles: {} }] },
      { id: 'check', type: 'checkListItem', props: { checked: true }, content: [{ type: 'text', text: 'Synthetic check', styles: {} }] },
      { id: 'toggle', type: 'toggleListItem', children: [{ id: 'nested', type: 'paragraph', content: [{ type: 'text', text: 'Synthetic nested', styles: {} }] }] },
      { id: 'quote', type: 'quote', content: [{ type: 'text', text: 'Synthetic quote', styles: {} }] },
      { id: 'divider', type: 'divider' },
      ...['audio', 'file', 'image', 'video'].map(type => ({ id: type, type,
        props: { url: `https://example.test/synthetic.${type}`, caption: `Synthetic ${type}` } })),
      { id: 'table', type: 'table', content: { type: 'tableContent', columnWidths: [200, null], headerRows: 1, rows: [
        { cells: [{ type: 'tableCell', props: { colspan: 2, backgroundColor: 'yellow', textAlignment: 'center' }, content: [{ type: 'text', text: 'Synthetic table header', styles: { bold: true } }] }] },
        { cells: [[], [{ type: 'text', text: 'Synthetic table cell', styles: {} }]] },
      ] } },
    ] }).content;
    const saved = await editor.send('PATCH', documentPath(), { content: richContent }, { 'if-match': etag });
    assert.equal(saved.status, 200);
    assert.deepEqual(validateContent(saved.data.revision.content).content, richContent);
    assert.equal(new Set(richContent.document.map(block => block.type)).size, 14);
    for (const text of ['Synthetic heading', 'Synthetic link', 'Synthetic after break', 'Synthetic bullet', 'Synthetic ordered', 'const synthetic = 1;']) {
      assert(saved.data.revision.plainText.includes(text));
    }
    assert(!saved.data.revision.plainText.includes('https://example.test'));
    etag = String(saved.headers.etag);
    const reloaded = await reader.send('GET', documentPath());
    assert.equal(reloaded.status, 200);
    assert.deepEqual(reloaded.data.revision, saved.data.revision);
    const historical = await reader.send('GET', documentPath() + '/revisions/' + saved.data.revision.id);
    assert.equal(historical.status, 200);
    assert.deepEqual(validateContent(historical.data.content).content, richContent);
    const reordered = structuredClone(richContent);
    const firstBlock = reordered.document[0];
    assert(firstBlock?.type === 'heading');
    const firstInline = firstBlock.content[0];
    assert(firstInline?.type === 'text');
    firstInline.styles = { italic: true, bold: true };
    const canonicalNoOp = await editor.send('PATCH', documentPath(), {
      title: '  ' + saved.data.revision.title + '  ', content: reordered, changeNote: 'Ignored canonical no-op',
    }, { 'if-match': etag });
    assert.equal(canonicalNoOp.status, 200);
    assert.deepEqual(canonicalNoOp.data, saved.data);
    assert.equal(String(canonicalNoOp.headers.etag), etag);
  });

  await t.test('a failure after revision insert rolls back the entire save and leaves a valid head', async () => {
    const before = await database.prisma.document.findUniqueOrThrow({ where: { id: documentId } });
    const beforeCount = await revisionCount();
    await database.pool.query('CREATE SEQUENCE injected_revision_seen');
    await database.pool.query(`CREATE FUNCTION fail_document_head() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."currentRevisionNumber" <> OLD."currentRevisionNumber" THEN
          IF EXISTS (SELECT 1 FROM "DocumentRevision" r
            WHERE r."documentId" = NEW."id" AND r."revisionNumber" = NEW."currentRevisionNumber") THEN
            PERFORM nextval('injected_revision_seen');
          END IF;
          RAISE EXCEPTION 'Injected document head failure';
        END IF;
        RETURN NEW;
      END $$`);
    await database.pool.query('CREATE TRIGGER fail_document_head BEFORE UPDATE ON "Document" FOR EACH ROW EXECUTE FUNCTION fail_document_head()');
    try {
      expectProblem(await editor.send('PATCH', documentPath(), {
        title: 'Synthetic failed snapshot', content: content('Synthetic rollback body'),
      }, { 'if-match': etag }), 500);
      // Sequence advances survive rollback, proving the inserted revision existed inside the failed write.
      const observed = await database.pool.query<{ is_called: boolean }>('SELECT is_called FROM injected_revision_seen');
      assert.equal(observed.rows[0]?.is_called, true);
      assert.deepEqual(await database.prisma.document.findUniqueOrThrow({ where: { id: documentId } }), before);
      assert.equal(await revisionCount(), beforeCount);
      const integrity = await database.pool.query<{ missing_heads: string; orphan_revisions: string }>(`
        SELECT
          (SELECT count(*)::text FROM "Document" d LEFT JOIN "DocumentRevision" r
            ON r."documentId" = d."id" AND r."revisionNumber" = d."currentRevisionNumber"
            WHERE r."id" IS NULL) AS missing_heads,
          (SELECT count(*)::text FROM "DocumentRevision" r LEFT JOIN "Document" d
            ON d."id" = r."documentId" WHERE d."id" IS NULL) AS orphan_revisions`);
      assert.deepEqual(integrity.rows, [{ missing_heads: '0', orphan_revisions: '0' }]);
      assert.equal(String((await reader.send('GET', documentPath())).headers.etag), etag);
    } finally {
      await database.pool.query('DROP TRIGGER fail_document_head ON "Document"');
      await database.pool.query('DROP FUNCTION fail_document_head()');
      await database.pool.query('DROP SEQUENCE injected_revision_seen');
    }
  });

  await t.test('archive and unarchive advance lifecycle locks without rewriting content history', async () => {
    const before = await reader.send('GET', documentPath());
    const beforeCount = await revisionCount();
    const archived = await editor.send('POST', documentPath() + '/archive', {}, { 'if-match': etag });
    assert.equal(archived.status, 200);
    assert.equal(archived.data.currentRevisionNumber, before.data.currentRevisionNumber);
    assert.equal(archived.data.lockVersion, before.data.lockVersion + 1);
    assert.equal(archived.data.archivedBy, editorUser.id);
    assert.equal(typeof archived.data.archivedAt, 'string');
    assert.deepEqual(archived.data.revision, before.data.revision);
    const activeEtag = etag;
    etag = String(archived.headers.etag);
    assert.notEqual(etag, activeEtag);
    assert.equal(await revisionCount(), beforeCount);
    const activeList = await reader.send('GET', `/api/v1/spaces/${spaceId}/documents`);
    assert(!activeList.data.items.some((item: { id: string }) => item.id === documentId));
    const allList = await reader.send('GET', `/api/v1/spaces/${spaceId}/documents?includeArchived=true`);
    assert(allList.data.items.some((item: { id: string }) => item.id === documentId));
    const historical = await reader.send('GET', documentPath() + '/revisions/' + firstRevisionId);
    assert.equal(historical.status, 200);
    assert.equal((await reader.send('GET', documentPath())).status, 200);
    expectProblem(await editor.send('PATCH', documentPath(), { title: 'Synthetic archived update' }, { 'if-match': etag }), 409);
    expectProblem(await editor.send('POST', documentPath() + '/restore', { revisionId: firstRevisionId }, { 'if-match': etag }), 409);
    expectProblem(await editor.send('POST', documentPath() + '/unarchive', {}, { 'if-match': activeEtag }), 412);
    const repeatedArchive = await editor.send('POST', documentPath() + '/archive', {}, { 'if-match': etag });
    assert.equal(repeatedArchive.status, 200);
    assert.deepEqual(repeatedArchive.data, archived.data);
    assert.equal(String(repeatedArchive.headers.etag), etag);
    const unarchived = await admin.send('POST', documentPath() + '/unarchive', {}, { 'if-match': etag });
    assert.equal(unarchived.status, 200);
    assert.equal(unarchived.data.currentRevisionNumber, before.data.currentRevisionNumber);
    assert.equal(unarchived.data.lockVersion, before.data.lockVersion + 2);
    assert.equal(unarchived.data.archivedBy, null);
    assert.equal(unarchived.data.archivedAt, null);
    assert.deepEqual(unarchived.data.revision, before.data.revision);
    etag = String(unarchived.headers.etag);
    const repeatedUnarchive = await admin.send('POST', documentPath() + '/unarchive', {}, { 'if-match': etag });
    assert.equal(repeatedUnarchive.status, 200);
    assert.deepEqual(repeatedUnarchive.data, unarchived.data);
    assert.equal(String(repeatedUnarchive.headers.etag), etag);
    assert.equal(await revisionCount(), beforeCount);
    const restoredList = await reader.send('GET', `/api/v1/spaces/${spaceId}/documents`);
    assert(restoredList.data.items.some((item: { id: string }) => item.id === documentId));
  });

  await t.test('malformed native content, properties, URLs and resource limits fail without new history', async () => {
    const before = await database.prisma.document.findUniqueOrThrow({ where: { id: documentId } });
    const beforeCount = await revisionCount();
    const envelope = (document: unknown[]) => ({ format: 'blocknote-json', schemaVersion: 1, editorVersion: '0.55.0', document });
    const invalid = [
      { ...initialContent, schemaVersion: 2 }, { ...initialContent, format: 'html' }, { ...initialContent, extra: true },
      { ...initialContent, format: 'prosemirror-json' }, { ...initialContent, editorVersion: 'future' },
      envelope([{ id: 'unsupported', type: 'unregisteredCustomBlock' }]),
      envelope([{ id: 'paragraph', type: 'paragraph', props: { hidden: true }, content: [{ type: 'text', text: 'Synthetic content', styles: {} }] }]),
      envelope([{ id: 'heading', type: 'heading', props: { level: 7 }, content: [{ type: 'text', text: 'Synthetic content', styles: {} }] }]),
      envelope([{ id: 'paragraph', type: 'paragraph', content: [{ type: 'text', text: 'Synthetic content', styles: { unknown: true } }] }]),
      envelope([{ id: 'code', type: 'codeBlock', content: [{ type: 'text', text: 'Synthetic code', styles: { bold: true } }] }]),
    ];
    for (const href of ['javascript:alert(1)', 'data:text/plain,synthetic', 'file:///synthetic', '/relative',
      'https://user:password@example.test', 'https://example.test/%0a', 'https://example.test/ space']) {
      invalid.push(envelope([{ id: 'paragraph', type: 'paragraph', content: [{ type: 'link', href,
        content: [{ type: 'text', text: 'Synthetic content', styles: {} }] }] }]));
      invalid.push(envelope([{ id: 'media', type: 'image', props: { url: href } }]));
    }
    for (const malformed of invalid) {
      expectProblem(await editor.send('PATCH', documentPath(), { content: malformed }, { 'if-match': etag }), 400);
    }
    for (const malformed of [{ title: '   ' }, { title: 'x'.repeat(201) }, { content: null },
      { title: 'Synthetic note overflow', changeNote: 'x'.repeat(2001) }]) {
      expectProblem(await editor.send('PATCH', documentPath(), malformed, { 'if-match': etag }), 400);
    }
    const beforeDocuments = await database.prisma.document.count();
    for (const invalidText of ['Synthetic\u0000text', 'Synthetic\ud800text', 'Synthetic\udffftext']) {
      expectProblem(await editor.send('POST', `/api/v1/spaces/${spaceId}/documents`, {
        title: invalidText, content: initialContent,
      }), 400);
      expectProblem(await editor.send('POST', `/api/v1/spaces/${spaceId}/documents`, {
        title: 'Synthetic invalid note', content: initialContent, changeNote: invalidText,
      }), 400);
      expectProblem(await editor.send('PATCH', documentPath(), { title: invalidText }, { 'if-match': etag }), 400);
      expectProblem(await editor.send('PATCH', documentPath(), { title: 'Synthetic invalid note', changeNote: invalidText }, { 'if-match': etag }), 400);
      expectProblem(await editor.send('POST', documentPath() + '/restore', {
        revisionId: firstRevisionId, changeNote: invalidText,
      }, { 'if-match': etag }), 400);
    }
    assert.equal(await database.prisma.document.count(), beforeDocuments);
    let nested: unknown = { id: 'leaf', type: 'paragraph', content: [] };
    for (let i = 0; i < CONTENT_LIMITS.maxDepth; i++) {
      nested = { id: `nested-${i}`, type: 'bulletListItem', children: [nested] };
    }
    const tooDeep = envelope([nested]);
    const tooMany = envelope(Array.from({ length: 10_000 }, (_, index) => ({ id: `many-${index}`, type: 'paragraph', content: [] })));
    const tooManyBytes = envelope([{ id: 'large', type: 'paragraph', content: [{ type: 'text', text: '🙂'.repeat(66_000), styles: {} }] }]);
    for (const oversized of [tooDeep, tooMany, tooManyBytes]) {
      expectProblem(await editor.send('PATCH', documentPath(), { content: oversized }, { 'if-match': etag }), 413);
    }
    expectProblem(await editor.send('PATCH', documentPath(), { content: envelope([{ id: 'large', type: 'paragraph', content: [{ type: 'text', text: 'x'.repeat(1_048_576), styles: {} }] }]) }, { 'if-match': etag }), 413);
    await assert.rejects(core.documents.update(new Headers({ cookie: editor.cookie }), documentId, { content: tooManyBytes }, etag),
      (error: unknown) => error instanceof HttpProblem && error.status === 413);
    assert.equal(await revisionCount(), beforeCount);
    assert.deepEqual(await database.prisma.document.findUniqueOrThrow({ where: { id: documentId } }), before);
  });

  await t.test('a blocked document writer rechecks membership after the space lock is released', async () => {
    const before = await database.prisma.document.findUniqueOrThrow({ where: { id: documentId } });
    const beforeCount = await revisionCount();
    const lock = await database.pool.connect();
    await lock.query('BEGIN');
    let pending: ReturnType<typeof editor.send> | undefined;
    try {
      await lock.query('SELECT "id" FROM "Space" WHERE "id" = $1 FOR UPDATE', [spaceId]);
      pending = editor.send('PATCH', documentPath(), { title: 'Synthetic revoked write' }, { 'if-match': etag });
      let blocked = false;
      for (let i = 0; i < 100; i++) {
        if (await blockedSpaceWriters() === 1) { blocked = true; break; }
        await delay(10);
      }
      assert(blocked, 'The editor must be waiting for the space lock before access changes');
      // Model a grant revocation committed ahead of the waiting writer, using the same lock order.
      await lock.query('DELETE FROM "SpaceMembership" WHERE "spaceId" = $1 AND "userId" = $2', [spaceId, editorUser.id]);
      await lock.query('UPDATE "Space" SET "lockVersion" = "lockVersion" + 1 WHERE "id" = $1', [spaceId]);
      await lock.query('COMMIT');
      expectProblem(await pending, 404);
      assert.equal((await editor.send('GET', '/api/v1/me')).status, 200);
      expectProblem(await editor.send('GET', documentPath()), 404);
      assert.equal(await revisionCount(), beforeCount);
      assert.deepEqual(await database.prisma.document.findUniqueOrThrow({ where: { id: documentId } }), before);
    } finally {
      await lock.query('ROLLBACK');
      lock.release();
      if (pending) await Promise.allSettled([pending]);
    }
    spaceEtag = String((await admin.send('GET', `/api/v1/spaces/${spaceId}`)).headers.etag);
    const grant = await admin.send('PUT', `/api/v1/spaces/${spaceId}/members/${editorUser.id}`, { role: 'editor' }, { 'if-match': spaceEtag });
    assert.equal(grant.status, 200);
    assert.equal((await editor.send('GET', documentPath())).status, 200);
  });

  await t.test('same-space organization requires current grants and ETags without rewriting content history', async () => {
    const first = await editor.send('POST', `/api/v1/spaces/${spaceId}/documents`, { title: 'Organization parent A', content: content('Parent A') });
    const second = await editor.send('POST', `/api/v1/spaces/${spaceId}/documents`, { title: 'Organization parent B', content: content('Parent B') });
    assert.equal(first.status, 201); assert.equal(second.status, 201); assert.equal(first.data.parentDocumentId, null);
    const child = await editor.send('POST', `/api/v1/spaces/${spaceId}/documents`, {
      title: 'Organization child', content: content('Complete native child'), parentDocumentId: first.data.id,
    });
    assert.equal(child.status, 201); assert.equal(child.data.parentDocumentId, first.data.id);
    const path = `/api/v1/documents/${child.data.id}`, condition = { 'if-match': String(child.headers.etag) };
    expectProblem(await editor.send('POST', path + '/move', { parentDocumentId: second.data.id }), 428);
    expectProblem(await reader.send('POST', path + '/move', { parentDocumentId: null }, condition), 404);
    expectProblem(await outsider.send('GET', path), 404);
    expectProblem(await outsider.send('GET', `/api/v1/spaces/${spaceId}/documents`), 404);
    const foreign = await admin.send('POST', `/api/v1/spaces/${privateSpaceId}/documents`, { title: 'Private parent', content: content('Private') });
    assert.equal(foreign.status, 201);
    expectProblem(await editor.send('POST', path + '/move', { parentDocumentId: foreign.data.id }, condition), 404);
    expectProblem(await admin.send('POST', path + '/move', { parentDocumentId: foreign.data.id }, condition), 404);
    expectProblem(await editor.send('POST', path + '/move', {}, condition), 400);
    const self = await editor.send('POST', path + '/move', { parentDocumentId: child.data.id }, condition);
    expectProblem(self, 409); assert.equal(self.data.code, 'DOCUMENT_HIERARCHY_CYCLE');
    expectProblem(await admin.send('POST', `/api/v1/spaces/${spaceId}/documents`, {
      title: 'Denied cross-space child', content: content('Denied'), parentDocumentId: foreign.data.id,
    }), 404);
    await assert.rejects(core.documents.move(new Headers({ cookie: reader.cookie }), child.data.id,
      { parentDocumentId: null }, String(child.headers.etag)), error => error instanceof HttpProblem && error.status === 404);
    const originalRevision = await database.prisma.documentRevision.findFirstOrThrow({ where: { documentId: child.data.id } });
    const moved = await editor.send('POST', path + '/move', { parentDocumentId: second.data.id }, condition);
    assert.equal(moved.status, 200); assert.equal(moved.data.parentDocumentId, second.data.id);
    assert.equal(moved.data.lockVersion, child.data.lockVersion + 1); assert.equal(moved.data.currentRevisionNumber, 1);
    assert.equal(moved.data.slug, child.data.slug); assert.deepEqual(moved.data.revision, child.data.revision);
    expectProblem(await editor.send('PATCH', path, { title: 'Stale structural baseline' }, condition), 412);
    expectProblem(await editor.send('POST', path + '/move', { parentDocumentId: null }, condition), 412);
    const noop = await editor.send('POST', path + '/move', { parentDocumentId: second.data.id }, { 'if-match': String(moved.headers.etag) });
    assert.equal(noop.status, 200); assert.equal(noop.headers.etag, moved.headers.etag);
    assert.deepEqual(await database.prisma.documentRevision.findFirstOrThrow({ where: { documentId: child.data.id } }), originalRevision);
    assert.equal(await database.prisma.documentRevision.count({ where: { documentId: child.data.id } }), 1);
    const root = await editor.send('POST', path + '/move', { parentDocumentId: null }, { 'if-match': String(noop.headers.etag) });
    assert.equal(root.status, 200); assert.equal(root.data.parentDocumentId, null);
    const read = await reader.send('GET', path); assert.equal(read.status, 200); assert.equal(read.data.parentDocumentId, null);
    await assert.rejects(database.pool.query('UPDATE "Document" SET "parentDocumentId" = $1 WHERE "id" = $2', [foreign.data.id, child.data.id]),
      error => error instanceof Error && 'code' in error && error.code === '23503');
    await assert.rejects(database.pool.query('UPDATE "Document" SET "parentDocumentId" = $1 WHERE "id" = $2', [child.data.id, child.data.id]),
      error => error instanceof Error && 'code' in error && error.code === '23514');
    assert.equal((await editor.send('GET', path)).data.parentDocumentId, null);
  });

  await t.test('reciprocal and stale concurrent moves cannot create cycles or extra revisions', async () => {
    const a = await editor.send('POST', `/api/v1/spaces/${spaceId}/documents`, { title: 'Concurrent parent A', content: content('A') });
    const b = await editor.send('POST', `/api/v1/spaces/${spaceId}/documents`, { title: 'Concurrent parent B', content: content('B') });
    const results = await Promise.all([
      editor.send('POST', `/api/v1/documents/${a.data.id}/move`, { parentDocumentId: b.data.id }, { 'if-match': String(a.headers.etag) }),
      editor.send('POST', `/api/v1/documents/${b.data.id}/move`, { parentDocumentId: a.data.id }, { 'if-match': String(b.headers.etag) }),
    ]);
    assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
    assert.equal(results.find(result => result.status === 409)!.data.code, 'DOCUMENT_HIERARCHY_CYCLE');
    const child = await editor.send('POST', `/api/v1/spaces/${spaceId}/documents`, { title: 'Concurrent moving child', content: content('Unchanged child') });
    const writes = await Promise.all([
      editor.send('POST', `/api/v1/documents/${child.data.id}/move`, { parentDocumentId: a.data.id }, { 'if-match': String(child.headers.etag) }),
      editor.send('POST', `/api/v1/documents/${child.data.id}/move`, { parentDocumentId: b.data.id }, { 'if-match': String(child.headers.etag) }),
    ]);
    assert.deepEqual(writes.map(result => result.status).sort(), [200, 412]);
    const saved = await editor.send('GET', `/api/v1/documents/${child.data.id}`);
    assert.equal(saved.data.lockVersion, 2); assert.equal(saved.data.currentRevisionNumber, 1);
    assert.equal(await database.prisma.documentRevision.count({ where: { documentId: child.data.id } }), 1);
  });

  await t.test('archive never cascades or leaves an active child below an archived parent', async () => {
    const parent = await editor.send('POST', `/api/v1/spaces/${spaceId}/documents`, { title: 'Archive parent', content: content('Parent') });
    const child = await editor.send('POST', `/api/v1/spaces/${spaceId}/documents`, { title: 'Archive child', content: content('Child'), parentDocumentId: parent.data.id });
    const parentPath = `/api/v1/documents/${parent.data.id}`, childPath = `/api/v1/documents/${child.data.id}`;
    const denied = await editor.send('POST', parentPath + '/archive', {}, { 'if-match': String(parent.headers.etag) });
    expectProblem(denied, 409); assert.equal(denied.data.code, 'DOCUMENT_HAS_ACTIVE_CHILDREN');
    assert.equal((await editor.send('GET', parentPath)).headers.etag, parent.headers.etag);
    const archivedChild = await editor.send('POST', childPath + '/archive', {}, { 'if-match': String(child.headers.etag) }); assert.equal(archivedChild.status, 200);
    const archivedParent = await editor.send('POST', parentPath + '/archive', {}, { 'if-match': String(parent.headers.etag) }); assert.equal(archivedParent.status, 200);
    expectProblem(await editor.send('POST', childPath + '/unarchive', {}, { 'if-match': String(archivedChild.headers.etag) }), 409);
    expectProblem(await editor.send('POST', `/api/v1/spaces/${spaceId}/documents`, { title: 'Denied archived parent', content: content('Denied'), parentDocumentId: parent.data.id }), 409);
    const moved = await editor.send('POST', childPath + '/move', { parentDocumentId: null }, { 'if-match': String(archivedChild.headers.etag) }); assert.equal(moved.status, 200);
    const active = await editor.send('POST', childPath + '/unarchive', {}, { 'if-match': String(moved.headers.etag) }); assert.equal(active.status, 200);
    assert.equal(active.data.parentDocumentId, null); assert.equal(active.data.currentRevisionNumber, 1);
    assert.equal(await database.prisma.documentRevision.count({ where: { documentId: parent.data.id } }), 1);
    assert.equal(await database.prisma.documentRevision.count({ where: { documentId: child.data.id } }), 1);
    assert((await editor.send('GET', parentPath)).data.archivedAt);
  });

  await t.test('hierarchy depth includes the entire moved subtree and live storage remains unchanged', async () => {
    let last: string | null = null, depth31: string | null = null;
    for (let depth = 1; depth <= 32; depth++) {
      const created = await editor.send('POST', `/api/v1/spaces/${spaceId}/documents`, { title: `Depth ${depth}`, content: content('Bounded depth'), parentDocumentId: last });
      assert.equal(created.status, 201); last = created.data.id; if (depth === 31) depth31 = created.data.id;
    }
    const deep = await editor.send('POST', `/api/v1/spaces/${spaceId}/documents`, { title: 'Too deep', content: content('Rejected'), parentDocumentId: last });
    expectProblem(deep, 409); assert.equal(deep.data.code, 'DOCUMENT_HIERARCHY_TOO_DEEP');
    const root = await editor.send('POST', `/api/v1/spaces/${spaceId}/documents`, { title: 'Moving subtree root', content: content('Native root') });
    const child = await editor.send('POST', `/api/v1/spaces/${spaceId}/documents`, { title: 'Moving subtree child', content: content('Native child'), parentDocumentId: root.data.id });
    assert.equal(child.status, 201);
    const denied = await editor.send('POST', `/api/v1/documents/${root.data.id}/move`, { parentDocumentId: depth31 }, { 'if-match': String(root.headers.etag) });
    expectProblem(denied, 409); assert.equal(denied.data.code, 'DOCUMENT_HIERARCHY_TOO_DEEP');
    const enrolled = await core.documents.live.enroll(new Headers({ cookie: editor.cookie }), root.data.id, String(root.headers.etag));
    const before = await database.prisma.documentLive.findFirstOrThrow({ where: { documentId: root.data.id } });
    const liveParent = await editor.send('POST', `/api/v1/spaces/${spaceId}/documents`, { title: 'Live organization parent', content: content('Parent') });
    assert.equal(liveParent.status, 201);
    const moved = await editor.send('POST', `/api/v1/documents/${root.data.id}/move`, { parentDocumentId: liveParent.data.id }, { 'if-match': enrolled.documentEtag });
    assert.equal(moved.status, 200); assert.equal(moved.data.editingMode, 'live');
    assert.deepEqual(await database.prisma.documentLive.findFirstOrThrow({ where: { documentId: root.data.id } }), before);
    assert.equal(moved.data.currentRevisionNumber, 1);
  });


  await t.test('a queued move rechecks a revoked grant without changing hierarchy, versions or history', async () => {
    const parent = await editor.send('POST', `/api/v1/spaces/${spaceId}/documents`, { title: 'Revocation target', content: content('Target') });
    const child = await editor.send('POST', `/api/v1/spaces/${spaceId}/documents`, { title: 'Revoked moving document', content: content('Complete retained body') });
    assert.equal(parent.status, 201); assert.equal(child.status, 201);
    const before = await database.prisma.document.findUniqueOrThrow({ where: { id: child.data.id } });
    const lock = await database.pool.connect(); await lock.query('BEGIN');
    let pending: ReturnType<typeof editor.send> | undefined;
    try {
      await lock.query('SELECT "id" FROM "Space" WHERE "id" = $1 FOR UPDATE', [spaceId]);
      pending = editor.send('POST', `/api/v1/documents/${child.data.id}/move`, { parentDocumentId: parent.data.id }, { 'if-match': String(child.headers.etag) });
      let blocked = false;
      for (let i = 0; i < 100; i++) { if (await blockedSpaceWriters() === 1) { blocked = true; break; } await delay(10); }
      assert(blocked, 'The move must be waiting for the space lock');
      await lock.query('DELETE FROM "SpaceMembership" WHERE "spaceId" = $1 AND "userId" = $2', [spaceId, editorUser.id]);
      await lock.query('UPDATE "Space" SET "lockVersion" = "lockVersion" + 1 WHERE "id" = $1', [spaceId]);
      await lock.query('COMMIT'); expectProblem(await pending, 404);
      assert.deepEqual(await database.prisma.document.findUniqueOrThrow({ where: { id: child.data.id } }), before);
      assert.equal(await database.prisma.documentRevision.count({ where: { documentId: child.data.id } }), 1);
      assert.equal((await editor.send('GET', '/api/v1/me')).status, 200);
    } finally { await lock.query('ROLLBACK'); lock.release(); if (pending) await Promise.allSettled([pending]); }
  });

});
