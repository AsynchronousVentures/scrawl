// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { readConfig } from '../../src/config.js';
import { createDatabase } from '../../src/db/client.js';
import { createCore } from '../../src/core/index.js';
import { createOperator } from '../../src/core/identity/operator.js';
import { createFavorites } from '../../src/core/favorites/index.js';
import { validateContent } from '../../src/core/documents/content.js';
import { HttpProblem } from '../../src/http/problems.js';
import { buildApp } from '../../src/app.js';

function object(value: unknown): Record<string, unknown> {
  assert(value && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, unknown>;
}
function string(value: unknown): string { assert.equal(typeof value, 'string'); return value as string; }
function items(value: unknown) { const list = object(value).items; assert(Array.isArray(list)); return list as unknown[]; }

test('personal favorites use current PostgreSQL grants and real authenticated HTTP sessions', async t => {
  const base = readConfig(process.env), target = new URL(base.databaseUrl);
  assert(base.nodeEnv !== 'production' && ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname));
  const administrator = createDatabase(base, () => {}), schema = 'scrawl_favorites_' + randomUUID().replaceAll('-', '');
  await administrator.pool.query(`CREATE SCHEMA "${schema}"`); target.searchParams.set('schema', schema);
  const config = { ...base, databaseUrl: target.href }, database = createDatabase(config, () => {});
  const identityConfig = { origin: 'http://127.0.0.1:3000', secret: randomBytes(32).toString('hex'), secureCookies: false };
  const core = createCore(database.prisma, identityConfig), operator = createOperator(database.prisma, identityConfig);
  const app = await buildApp({ config, core, logging: false, checkDatabase: () => database.ping() });
  t.after(async () => {
    await app.close(); await database.close();
    await administrator.pool.query(`DROP SCHEMA "${schema}" CASCADE`); await administrator.close();
  });
  const migration = spawnSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: config.databaseUrl }, encoding: 'utf8',
  }); assert.equal(migration.status, 0, 'The complete migration history must deploy');
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  function client(peer: string) {
    let cookie = '';
    return {
      get headers() { return new Headers({ cookie }); },
      async send(method: string, path: string, payload?: unknown, etag?: string) {
        const bytes = payload === undefined ? undefined : JSON.stringify(payload);
        return new Promise<{ status: number; data: unknown; etag?: string }>((done, reject) => {
          const request = httpRequest(new URL(path, address), { method, localAddress: peer, headers: {
            origin: identityConfig.origin, ...(cookie ? { cookie } : {}),
            ...(bytes ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(bytes)) } : {}),
            ...(etag ? { 'if-match': etag } : {}),
          } }, response => {
            const chunks: Buffer[] = []; response.on('data', (chunk: Buffer) => chunks.push(chunk)); response.on('error', reject);
            response.on('end', () => {
              if (response.headers['set-cookie']) cookie = response.headers['set-cookie'].map(value => value.split(';')[0]).join('; ');
              const body = Buffer.concat(chunks).toString();
              done({ status: response.statusCode!, data: body ? JSON.parse(body) as unknown : null,
                ...(response.headers.etag === undefined ? {} : { etag: response.headers.etag }) });
            });
          }); request.on('error', reject); request.end(bytes);
        });
      },
    };
  }
  const password = randomBytes(24).toString('base64url');
  const owner = await operator.bootstrap({ email: 'favorite-owner@example.test', name: 'Synthetic Owner', password });
  const readerUser = await operator.provision({ email: 'favorite-reader@example.test', name: 'Synthetic Reader', password });
  const editorUser = await operator.provision({ email: 'favorite-editor@example.test', name: 'Synthetic Editor', password });
  const outsiderUser = await operator.provision({ email: 'favorite-outsider@example.test', name: 'Synthetic Outsider', password });
  const admin = client('127.0.0.91'), reader = client('127.0.0.92'), editor = client('127.0.0.93'), outsider = client('127.0.0.94'), anonymous = client('127.0.0.95');
  for (const [agent, user] of [[admin, owner], [reader, readerUser], [editor, editorUser], [outsider, outsiderUser]] as const) {
    assert.equal((await agent.send('POST', '/api/auth/sign-in/email', { email: user.email, password })).status, 200);
  }
  const created = await admin.send('POST', '/api/v1/spaces', { name: 'Synthetic favorite workspace' }); assert.equal(created.status, 201);
  const spaceId = string(object(created.data).id); let spaceEtag = string(created.etag);
  async function grant(userId: string, role: 'reader' | 'editor') {
    const response = await admin.send('PUT', `/api/v1/spaces/${spaceId}/members/${userId}`, { role }, spaceEtag);
    assert.equal(response.status, 200); spaceEtag = string(response.etag);
  }
  await grant(readerUser.id, 'reader'); await grant(editorUser.id, 'editor');
  const content = validateContent({ format: 'blocknote-json', schemaVersion: 1, editorVersion: '0.55.0',
    document: [{ id: 'synthetic-favorite', type: 'paragraph', content: [{ type: 'text', text: 'Synthetic saved favorite body', styles: {} }] }] }).content;
  async function document(title: string) {
    const response = await editor.send('POST', `/api/v1/spaces/${spaceId}/documents`, { title, content }); assert.equal(response.status, 201);
    return { id: string(object(response.data).id), etag: string(response.etag) };
  }
  const main = await document('Synthetic bookmarked guide'); const path = `/api/v1/documents/${main.id}/favorite`;
  const snapshot = () => database.prisma.document.findUniqueOrThrow({ where: { id: main.id }, include: { revisions: true } });

  await t.test('readers set idempotent personal favorites without touching document history, grants or ETags', async () => {
    const before = await snapshot();
    assert.deepEqual((await reader.send('GET', path)).data, { favorited: false });
    for (let index = 0; index < 2; index++) {
      const response = await reader.send('PUT', path, { favorited: true }); assert.equal(response.status, 200);
      assert.deepEqual(response.data, { favorited: true }); assert.equal(response.etag, undefined);
    }
    assert.equal(await database.prisma.documentFavorite.count(), 1);
    assert.equal(items((await reader.send('GET', '/api/v1/favorites')).data).length, 1);
    assert.deepEqual(items((await editor.send('GET', '/api/v1/favorites')).data), []);
    assert.deepEqual(items((await admin.send('GET', '/api/v1/favorites')).data), []);
    assert.deepEqual(await snapshot(), before);
    assert.equal((await reader.send('GET', `/api/v1/documents/${main.id}`)).etag, main.etag);
  });
  await t.test('outsiders and anonymous sessions cannot discover favorite state or inject another owner', async () => {
    const before = await database.prisma.documentFavorite.findMany();
    for (const [agent, status] of [[outsider, 404], [anonymous, 401]] as const) {
      assert.equal((await agent.send('GET', path)).status, status);
      assert.equal((await agent.send('PUT', path, { favorited: true })).status, status);
      await assert.rejects(core.favorites.read(agent.headers, main.id), (error: unknown) => error instanceof HttpProblem && error.status === status);
      await assert.rejects(core.favorites.set(agent.headers, main.id, true), (error: unknown) => error instanceof HttpProblem && error.status === status);
    }
    assert.deepEqual(items((await outsider.send('GET', '/api/v1/favorites')).data), []);
    assert.equal((await anonymous.send('GET', '/api/v1/favorites')).status, 401);
    for (const payload of [{ favorited: true, userId: owner.id }, { favorited: 'true' }, {}, { favorited: null }]) {
      assert.equal((await reader.send('PUT', path, payload)).status, 400);
    }
    assert.deepEqual(await database.prisma.documentFavorite.findMany(), before);
  });
  await t.test('concurrent favorite commands serialize without duplicate rows or content changes', async () => {
    const before = await snapshot();
    const responses = await Promise.all(Array.from({ length: 8 }, () => reader.send('PUT', path, { favorited: true })));
    assert(responses.every(response => response.status === 200));
    assert.equal(await database.prisma.documentFavorite.count(), 1);
    assert.equal((await editor.send('PUT', path, { favorited: true })).status, 200);
    assert.equal(await database.prisma.documentFavorite.count(), 2);
    const opposing = await Promise.all([editor.send('PUT', path, { favorited: true }), editor.send('PUT', path, { favorited: false })]);
    assert(opposing.every(response => response.status === 200));
    assert.equal((await editor.send('PUT', path, { favorited: false })).status, 200);
    assert.equal((await editor.send('PUT', path, { favorited: false })).status, 200);
    assert.equal(await database.prisma.documentFavorite.count(), 1); assert.deepEqual(await snapshot(), before);
  });
  await t.test('favorites show only saved titles, hide archived documents and reappear after unarchive', async () => {
    const updated = await editor.send('PATCH', `/api/v1/documents/${main.id}`, { title: 'Synthetic renamed saved guide' }, main.etag);
    assert.equal(updated.status, 200); main.etag = string(updated.etag);
    const listed = items((await reader.send('GET', '/api/v1/favorites')).data);
    assert.equal(object(listed[0]).title, 'Synthetic renamed saved guide');
    assert.equal(object(listed[0]).spaceSlug, object(created.data).slug);
    const archived = await editor.send('POST', `/api/v1/documents/${main.id}/archive`, {}, main.etag);
    assert.equal(archived.status, 200); main.etag = string(archived.etag);
    assert.deepEqual(items((await reader.send('GET', '/api/v1/favorites')).data), []);
    assert.equal((await reader.send('PUT', path, { favorited: true })).status, 409);
    assert.equal(await database.prisma.documentFavorite.count(), 1);
    const restored = await editor.send('POST', `/api/v1/documents/${main.id}/unarchive`, {}, main.etag);
    assert.equal(restored.status, 200); main.etag = string(restored.etag);
    assert.equal(items((await reader.send('GET', '/api/v1/favorites')).data).length, 1);
  });
  await t.test('current grants filter before pagination and removing a favorite is private and idempotent', async () => {
    const second = await document('Synthetic second favorite'), third = await document('Synthetic third favorite');
    for (const selected of [second, third]) assert.equal((await reader.send('PUT', `/api/v1/documents/${selected.id}/favorite`, { favorited: true })).status, 200);
    const hiddenSpace = await admin.send('POST', '/api/v1/spaces', { name: 'Synthetic inaccessible favorite space' });
    assert.equal(hiddenSpace.status, 201);
    const hiddenId = '00000000-0000-4000-8000-000000000001';
    assert([main.id, second.id, third.id].every(id => id > hiddenId));
    const setup = await database.pool.connect();
    try {
      await setup.query('BEGIN');
      await setup.query(`INSERT INTO "Document" ("id","spaceId","slug","currentRevisionNumber","createdBy","updatedAt")
        VALUES ($1,$2,'synthetic-hidden-favorite',1,$3,now())`, [hiddenId, string(object(hiddenSpace.data).id), owner.id]);
      await setup.query(`INSERT INTO "DocumentRevision" ("id","documentId","revisionNumber","title","contentFormat", "contentSchemaVersion",
        "contentEditorVersion","body","plainText","authorId") VALUES ($1,$2,1,$3,$4,$5,$6,$7::jsonb,$8,$9)`,
      [randomUUID(), hiddenId, 'Synthetic inaccessible saved guide', content.format, content.schemaVersion,
        content.editorVersion, JSON.stringify(content.document), validateContent(content).plainText, owner.id]);
      // Valid personal metadata can outlive a grant; listing cannot trust its presence.
      await setup.query('INSERT INTO "DocumentFavorite" ("userId","documentId") VALUES ($1,$2)', [readerUser.id, hiddenId]);
      await setup.query('COMMIT');
    } finally { await setup.query('ROLLBACK'); setup.release(); }
    const seen: string[] = []; let cursor: string | null = null;
    do {
      const response = await reader.send('GET', `/api/v1/favorites?limit=1${cursor ? `&cursor=${cursor}` : ''}`); assert.equal(response.status, 200);
      const result = object(response.data); assert.equal(items(result).length, 1);
      seen.push(string(object(items(result)[0]).id)); cursor = result.nextCursor === null ? null : string(result.nextCursor);
    } while (cursor);
    assert.deepEqual(seen, [main.id, second.id, third.id].sort());
    for (const query of ['limit=0', 'limit=101', 'cursor=invalid', `userId=${owner.id}`]) {
      assert.equal((await reader.send('GET', `/api/v1/favorites?${query}`)).status, 400);
    }
    const before = await snapshot();
    const revoked = await admin.send('DELETE', `/api/v1/spaces/${spaceId}/members/${readerUser.id}`, undefined, spaceEtag);
    assert.equal(revoked.status, 200); spaceEtag = string(revoked.etag);
    assert.deepEqual(items((await reader.send('GET', '/api/v1/favorites?limit=1')).data), []);
    assert.equal((await reader.send('GET', path)).status, 404);
    assert.equal((await reader.send('PUT', path, { favorited: false })).status, 404);
    const staleAuthority = createFavorites(database.prisma, { ...core.identity, async actor(...args: Parameters<typeof core.identity.actor>) {
      const actor = await core.identity.actor(...args); return { ...actor, role: 'administrator' as const };
    } }, core.spaces);
    assert.deepEqual((await staleAuthority.list(reader.headers, { limit: 1 })).items, []);
    await grant(readerUser.id, 'reader');
    assert.equal(items((await reader.send('GET', '/api/v1/favorites')).data).length, 3);
    assert.equal((await reader.send('PUT', path, { favorited: false })).status, 200);
    assert.equal((await reader.send('PUT', path, { favorited: false })).status, 200);
    assert.equal(items((await reader.send('GET', '/api/v1/favorites')).data).length, 2); assert.deepEqual(await snapshot(), before);
  });
  await t.test('queued membership revocation wins before a pending favorite command rechecks access', async () => {
    const lock = await database.pool.connect(); let revoke: ReturnType<typeof admin.send> | undefined, pending: ReturnType<typeof reader.send> | undefined;
    const before = await database.prisma.documentFavorite.findMany();
    try {
      await lock.query('BEGIN'); await lock.query('SELECT "id" FROM "Space" WHERE "id"=$1::uuid FOR UPDATE', [spaceId]);
      revoke = admin.send('DELETE', `/api/v1/spaces/${spaceId}/members/${readerUser.id}`, undefined, spaceEtag);
      async function waitForSpaceLock(mode: 'UPDATE' | 'SHARE') {
        for (let attempt = 0; attempt < 100; attempt++) {
          // A row-lock wait uses a transaction/tuple lock. Its relation lock is
          // already granted, so scope the waiter by that relation and activity.
          const blocked = await database.pool.query(`SELECT 1 FROM pg_stat_activity a JOIN pg_locks l ON l.pid=a.pid
            WHERE a.wait_event_type='Lock' AND l.relation='"Space"'::regclass AND a.query LIKE $1`, [`%FOR ${mode}%`]);
          if (blocked.rowCount) return; await delay(10);
        }
        assert.fail(`Expected a queued Space FOR ${mode} operation`);
      }
      await waitForSpaceLock('UPDATE'); pending = reader.send('PUT', path, { favorited: true });
      await waitForSpaceLock('SHARE');
      await lock.query('COMMIT'); const revoked = await revoke; assert.equal(revoked.status, 200); spaceEtag = string(revoked.etag);
      assert.equal((await pending).status, 404); assert.deepEqual(await database.prisma.documentFavorite.findMany(), before);
    } finally { await lock.query('ROLLBACK'); lock.release(); await Promise.allSettled([revoke, pending]); }
    await grant(readerUser.id, 'reader');
  });
  await t.test('operator recovery invalidates favorite reads and writes using the old authenticated session', async () => {
    const before = await database.prisma.documentFavorite.findMany();
    await operator.recover(readerUser.email, randomBytes(24).toString('base64url'));
    assert.equal((await reader.send('GET', '/api/v1/favorites')).status, 401);
    assert.equal((await reader.send('GET', path)).status, 401);
    assert.equal((await reader.send('PUT', path, { favorited: true })).status, 401);
    assert.deepEqual(await database.prisma.documentFavorite.findMany(), before);
  });
});
