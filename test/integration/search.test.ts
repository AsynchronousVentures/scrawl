// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readConfig } from '../../src/config.js';
import { createDatabase } from '../../src/db/client.js';
import { createCore } from '../../src/core/index.js';
import { createOperator } from '../../src/core/identity/operator.js';
import { createSearch } from '../../src/core/search/index.js';
import { validateContent } from '../../src/core/documents/content.js';
import { HttpProblem } from '../../src/http/problems.js';
import { buildApp } from '../../src/app.js';
import { rebuildSearchIndex } from '../../scripts/search-index.js';

function object(input: unknown): Record<string, unknown> {
  assert(input && typeof input === 'object' && !Array.isArray(input), 'Expected response object');
  return input as Record<string, unknown>;
}
function string(input: unknown): string { assert.equal(typeof input, 'string'); return input as string; }
function body(text: string) {
  return validateContent({ format: 'blocknote-json', schemaVersion: 1, editorVersion: '0.55.0',
    document: [{ id: 'synthetic-search', type: 'paragraph', content: [{ type: 'text', text, styles: {} }] }] }).content;
}

test('real authenticated PostgreSQL search filters current content before rank, excerpts and limits', async (t) => {
  const baseConfig = readConfig(process.env);
  const target = new URL(baseConfig.databaseUrl);
  assert(baseConfig.nodeEnv !== 'production' && ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname));
  const administrator = createDatabase(baseConfig, () => {});
  const schema = 'scrawl_search_' + randomUUID().replaceAll('-', '');
  await administrator.pool.query(`CREATE SCHEMA "${schema}"`);
  target.searchParams.set('schema', schema);
  const config = { ...baseConfig, databaseUrl: target.href };
  const database = createDatabase(config, () => {});
  const identityConfig = { origin: 'http://127.0.0.1:3000', secret: randomBytes(32).toString('hex'), secureCookies: false };
  const core = createCore(database.prisma, identityConfig);
  const operator = createOperator(database.prisma, identityConfig);
  const app = await buildApp({ config, core, checkDatabase: () => database.ping(), logging: false });
  t.after(async () => {
    await app.close(); await database.close();
    await administrator.pool.query(`DROP SCHEMA "${schema}" CASCADE`); await administrator.close();
  });
  const migration = spawnSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: config.databaseUrl }, encoding: 'utf8',
  });
  assert.equal(migration.status, 0, 'Existing migration history including generated search must deploy');
  const address = await app.listen({ host: '127.0.0.1', port: 0 });

  function client(peer: string) {
    let cookie = '';
    return {
      get headers() { return new Headers({ cookie }); },
      async send(method: string, path: string, payload?: unknown, expectedEtag?: string) {
        const content = payload === undefined ? undefined : JSON.stringify(payload);
        return new Promise<{ status: number; body: string; data: unknown; etag?: string }>((resolve, reject) => {
          const request = httpRequest(new URL(path, address), { method, localAddress: peer, headers: {
            origin: identityConfig.origin, ...(cookie ? { cookie } : {}),
            ...(content ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(content)) } : {}),
            ...(expectedEtag ? { 'if-match': expectedEtag } : {}),
          } }, response => {
            const chunks: Buffer[] = [];
            response.on('data', (chunk: Buffer) => chunks.push(chunk)); response.on('error', reject);
            response.on('end', () => {
              const cookies = response.headers['set-cookie'];
              if (cookies) cookie = cookies.map(value => value.split(';')[0]).join('; ');
              const body = Buffer.concat(chunks).toString();
              resolve({ status: response.statusCode!, body, data: body ? JSON.parse(body) as unknown : null,
                ...(response.headers.etag === undefined ? {} : { etag: response.headers.etag }) });
            });
          });
          request.on('error', reject); request.end(content);
        });
      },
    };
  }
  const password = randomBytes(24).toString('base64url');
  const owner = await operator.bootstrap({ email: 'search-owner@example.test', name: 'Synthetic Search Owner', password });
  const readerUser = await operator.provision({ email: 'search-reader@example.test', name: 'Synthetic Search Reader', password });
  const editorUser = await operator.provision({ email: 'search-editor@example.test', name: 'Synthetic Search Editor', password });
  await operator.provision({ email: 'search-outsider@example.test', name: 'Synthetic Search Outsider', password });
  const admin = client('127.0.0.71'), reader = client('127.0.0.72'), editor = client('127.0.0.73');
  const outsider = client('127.0.0.74'), anonymous = client('127.0.0.75');
  for (const [agent, email] of [[admin, owner.email], [reader, readerUser.email], [editor, editorUser.email], [outsider, 'search-outsider@example.test']] as const) {
    assert.equal((await agent.send('POST', '/api/auth/sign-in/email', { email, password })).status, 200);
  }
  async function space(name: string) {
    const result = await admin.send('POST', '/api/v1/spaces', { name }); assert.equal(result.status, 201);
    return { id: string(object(result.data).id), etag: string(result.etag) };
  }
  const main = await space('Synthetic permitted space'), secondary = await space('Synthetic secondary space'), hidden = await space('Synthetic hidden space');
  async function grant(target: typeof main, userId: string, role: 'reader' | 'editor') {
    const result = await admin.send('PUT', `/api/v1/spaces/${target.id}/members/${userId}`, { role }, target.etag);
    assert.equal(result.status, 200); target.etag = string(result.etag);
  }
  await grant(main, readerUser.id, 'reader'); await grant(main, editorUser.id, 'editor'); await grant(secondary, editorUser.id, 'editor');
  async function document(spaceId: string, title: string, text: string) {
    const result = await admin.send('POST', `/api/v1/spaces/${spaceId}/documents`, { title, content: body(text) });
    assert.equal(result.status, 201);
    return { id: string(object(result.data).id), etag: string(result.etag) };
  }
  const titleHit = await document(main.id, 'Nebula title match', 'Synthetic plain body.');
  const bodyHit = await document(main.id, 'Synthetic body match', 'A synthetic nebula appears in this body.');
  const elsewhere = await document(secondary.id, 'Nebula in another permitted space', 'Synthetic second-space body.');
  const secret = await document(hidden.id, 'Hidden secret title', 'forbiddenuniqueterm confidentialbody');
  const historical = await document(main.id, 'Synthetic historical document', 'obsoleteonly text');

  async function search(agent: typeof reader, query: string, spaceId?: string, limit?: number) {
    const parameters = new URLSearchParams({ q: query });
    if (spaceId) parameters.set('spaceId', spaceId);
    if (limit !== undefined) parameters.set('limit', String(limit));
    const response = await agent.send('GET', `/api/v1/search?${parameters}`);
    assert.equal(response.status, 200);
    const data = object(response.data); assert.deepEqual(Object.keys(data), ['items']); assert(Array.isArray(data.items));
    return { response, items: data.items.map(item => {
      const result = object(item); assert.deepEqual(Object.keys(result).sort(), ['id', 'spaceId', 'title', 'excerpt'].sort());
      assert(string(result.excerpt).length <= 320);
      return { id: string(result.id), spaceId: string(result.spaceId), title: string(result.title), excerpt: string(result.excerpt) };
    }) };
  }

  await t.test('reader and editor search title/body, title weighting and deterministic bounded order', async () => {
    const first = await search(reader, 'NEBULA');
    assert.deepEqual(first.items.map(item => item.id), [titleHit.id, bodyHit.id]);
    assert(first.items[1]?.excerpt.includes('nebula'));
    assert.deepEqual((await search(reader, 'nebula', main.id, 1)).items.map(item => item.id), [titleHit.id]);
    assert.deepEqual((await search(editor, 'nebula', secondary.id)).items.map(item => item.id), [elsewhere.id]);
    assert.equal((await search(reader, 'nebula', secondary.id)).items.length, 0);
    assert.deepEqual((await search(reader, 'nebula')).items, first.items);
    assert.equal((await search(admin, 'forbiddenuniqueterm')).items[0]?.id, secret.id);
  });

  await t.test('outsiders and forbidden-space queries disclose no title, snippet, count or version evidence', async () => {
    for (const agent of [reader, editor, outsider]) {
      const global = await search(agent, 'forbiddenuniqueterm');
      assert.deepEqual(global.items, []); assert.equal(global.response.body, '{"items":[]}');
      assert.equal((await search(agent, 'forbiddenuniqueterm', hidden.id)).response.body,
        (await search(agent, 'forbiddenuniqueterm', randomUUID())).response.body);
    }
    assert.equal((await anonymous.send('GET', '/api/v1/search?q=nebula')).status, 401);
    await assert.rejects(core.search.find(new Headers(), { query: 'nebula' }), (error: unknown) => error instanceof HttpProblem && error.status === 401);
  });

  await t.test('search uses only the current head, refreshes after save and follows archive/unarchive', async () => {
    assert.equal((await search(reader, 'obsoleteonly')).items[0]?.id, historical.id);
    const saved = await admin.send('PATCH', `/api/v1/documents/${historical.id}`, { content: body('currentonly replacement') }, historical.etag);
    assert.equal(saved.status, 200); historical.etag = string(saved.etag);
    assert.deepEqual((await search(reader, 'obsoleteonly')).items, []);
    assert.equal((await search(reader, 'currentonly')).items[0]?.id, historical.id);
    assert.equal(await database.prisma.documentRevision.count({ where: { documentId: historical.id } }), 2);
    const archived = await admin.send('POST', `/api/v1/documents/${historical.id}/archive`, {}, historical.etag);
    assert.equal(archived.status, 200); historical.etag = string(archived.etag);
    assert.deepEqual((await search(reader, 'currentonly')).items, []);
    const restored = await admin.send('POST', `/api/v1/documents/${historical.id}/unarchive`, {}, historical.etag);
    assert.equal(restored.status, 200); historical.etag = string(restored.etag);
    assert.equal((await search(reader, 'currentonly')).items[0]?.id, historical.id);
    assert.equal(await database.prisma.documentRevision.count({ where: { documentId: historical.id } }), 2);
  });

  await t.test('plain excerpts are bounded even for long tokens and SQL-looking query syntax is inert', async () => {
    const long = await document(main.id, 'Synthetic long excerpt', 'x'.repeat(5000) + ' longneedle text');
    assert.equal((await search(reader, 'longneedle')).items[0]?.id, long.id);
    const html = await document(main.id, 'Synthetic literal code', '<script>alert("synthetic")</script> snippetneedle');
    const snippet = (await search(reader, 'snippetneedle')).items.find(item => item.id === html.id);
    assert(snippet); assert(!snippet.excerpt.includes('<b>')); assert(!snippet.excerpt.includes('</b>'));
    for (const query of ['"; DROP TABLE "Document"; --', 'nebula | forbiddenuniqueterm', '!!!']) await search(reader, query);
    assert.equal(await database.prisma.document.count({ where: { id: titleHit.id } }), 1);
    for (const query of ['', ' ', 'x'.repeat(201), 'invalid\u0000query']) {
      const invalid = await reader.send('GET', `/api/v1/search?${new URLSearchParams({ q: query })}`); assert.equal(invalid.status, 400);
    }
    for (const suffix of ['q=nebula&limit=51', 'q=nebula&limit=0', 'q=nebula&spaceId=invalid', 'q=nebula&unexpected=1']) {
      assert.equal((await reader.send('GET', '/api/v1/search?' + suffix)).status, 400);
    }
    assert.equal((await reader.send('POST', `/api/v1/spaces/${main.id}/documents`, { title: 'Denied', content: body('nebula') })).status, 404);
  });

  await t.test('generated-vector migration backfills derived state without changing source snapshots', async () => {
    const documents = await database.prisma.document.findMany({ orderBy: { id: 'asc' } });
    const revisions = await database.prisma.documentRevision.findMany({ orderBy: { id: 'asc' } });
    // Only this test's random schema is modified. Removing/reapplying derived
    // state proves the reviewed migration backfills existing immutable sources.
    await database.pool.query('ALTER TABLE "DocumentRevision" DROP COLUMN "searchVector"');
    await database.pool.query(await readFile('prisma/migrations/20260930030000_document_search/migration.sql', 'utf8'));
    assert.deepEqual(await database.prisma.document.findMany({ orderBy: { id: 'asc' } }), documents);
    assert.deepEqual(await database.prisma.documentRevision.findMany({ orderBy: { id: 'asc' } }), revisions);
    assert.equal((await search(reader, 'currentonly')).items[0]?.id, historical.id);
    const metadata = await database.pool.query<{ stored: string; gin: boolean }>(`
      SELECT attribute.attgenerated AS stored,
        EXISTS(SELECT 1 FROM pg_indexes WHERE schemaname = current_schema()
          AND indexname = 'DocumentRevision_searchVector_idx' AND indexdef LIKE '%USING gin%') AS gin
      FROM pg_attribute attribute WHERE attribute.attrelid = '"DocumentRevision"'::regclass
        AND attribute.attname = 'searchVector'`);
    assert.deepEqual(metadata.rows, [{ stored: 's', gin: true }]);
  });

  await t.test('derived-index rebuild preserves revisions, document versions and search results', async () => {
    const documents = await database.prisma.document.findMany({ orderBy: { id: 'asc' } });
    const revisions = await database.prisma.documentRevision.findMany({ orderBy: { id: 'asc' } });
    const results = await search(reader, 'nebula');
    await rebuildSearchIndex(config);
    assert.deepEqual(await database.prisma.document.findMany({ orderBy: { id: 'asc' } }), documents);
    assert.deepEqual(await database.prisma.documentRevision.findMany({ orderBy: { id: 'asc' } }), revisions);
    assert.deepEqual((await search(reader, 'nebula')).items, results.items);
  });

  await t.test('the SQL statement rechecks current grants, role and session after identity resolution', async () => {
    const staleMembership = createSearch(database.prisma, { ...core.identity,
      async actor(principal, db) {
        const actor = await core.identity.actor(principal, db);
        await database.prisma.spaceMembership.deleteMany({ where: { userId: editorUser.id } });
        return actor;
      },
    });
    assert.deepEqual(await staleMembership.find(editor.headers, { query: 'nebula' }), { items: [] });
    const staleRole = createSearch(database.prisma, { ...core.identity,
      async actor(principal, db) {
        const actor = await core.identity.actor(principal, db);
        await database.prisma.user.update({ where: { id: owner.id }, data: { role: 'member' } });
        return actor;
      },
    });
    try { assert.deepEqual(await staleRole.find(admin.headers, { query: 'forbiddenuniqueterm' }), { items: [] }); }
    finally { await database.prisma.user.update({ where: { id: owner.id }, data: { role: 'administrator' } }); }
    const staleSession = createSearch(database.prisma, { ...core.identity,
      async actor(principal, db) {
        const actor = await core.identity.actor(principal, db);
        await database.prisma.session.delete({ where: { id: principal.sessionId } });
        return actor;
      },
    });
    await assert.rejects(staleSession.find(editor.headers, { query: 'nebula' }), (error: unknown) => error instanceof HttpProblem && error.status === 401);
  });

  await t.test('membership revocation removes matches using the same still-authenticated cookie', async () => {
    const before = reader.headers.get('cookie');
    const revoked = await admin.send('DELETE', `/api/v1/spaces/${main.id}/members/${readerUser.id}`, undefined, main.etag);
    assert.equal(revoked.status, 200);
    assert.equal((await reader.send('GET', '/api/v1/me')).status, 200);
    assert.equal(reader.headers.get('cookie'), before);
    assert.deepEqual((await search(reader, 'nebula')).items, []);
  });
});
