// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { readConfig } from '../../src/config.js';
import { createDatabase } from '../../src/db/client.js';
import { createCore } from '../../src/core/index.js';
import { validateContent } from '../../src/core/documents/content.js';
import { createOperator } from '../../src/core/identity/operator.js';
import { HttpProblem } from '../../src/http/problems.js';
import { buildApp } from '../../src/app.js';

function object(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), 'Expected a JSON object');
  return value as Record<string, unknown>;
}

function syntheticContent(text: string) {
  return validateContent({
    format: 'blocknote-json', schemaVersion: 1, editorVersion: '0.55.0',
    document: [
      { id: 'export-heading', type: 'heading', props: { level: 2 }, content: [{ type: 'text', text: 'Synthetic export', styles: {} }] },
      { id: 'export-paragraph', type: 'paragraph', content: [{ type: 'text', text: text + '\n', styles: { bold: true } },
        { type: 'link', href: 'https://example.test/reference', content: [{ type: 'text', text: 'Local fixture', styles: {} }] }] },
    ],
  }).content;
}

test('P3 native export against PostgreSQL and authenticated HTTP sessions', async (t) => {
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
  const migration = spawnSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: config.databaseUrl }, encoding: 'utf8',
  });
  assert.equal(migration.status, 0, 'The existing migration history must deploy');
  const address = await app.listen({ host: '127.0.0.1', port: 0 });

  function client(peer: string) {
    let cookie = '';
    return {
      get cookie() { return cookie; },
      async send(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
        const payload = body === undefined ? undefined : JSON.stringify(body);
        return new Promise<{ status: number; body: string; data: unknown; headers: IncomingHttpHeaders }>((resolve, reject) => {
          const req = httpRequest(new URL(path, address), {
            method, localAddress: peer,
            headers: {
              origin: identityConfig.origin, ...(cookie ? { cookie } : {}),
              ...(payload ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) } : {}),
              ...headers,
            },
          }, (response) => {
            const chunks: Buffer[] = [];
            response.on('data', (chunk: Buffer) => chunks.push(chunk));
            response.on('error', reject);
            response.on('end', () => {
              if (response.headers['set-cookie']) cookie = response.headers['set-cookie'].map((value) => value.split(';')[0]).join('; ');
              const text = Buffer.concat(chunks).toString();
              resolve({ status: response.statusCode!, body: text, data: text ? JSON.parse(text) : null, headers: response.headers });
            });
          });
          req.on('error', reject);
          req.end(payload);
        });
      },
    };
  }

  const credentials = Array.from({ length: 4 }, () => randomBytes(24).toString('base64url'));
  const adminUser = await operator.bootstrap({ email: 'export-owner@example.test', name: 'Export Owner', password: credentials[0]! });
  const editorUser = await operator.provision({ email: 'export-editor@example.test', name: 'Export Editor', password: credentials[1]! });
  const readerUser = await operator.provision({ email: 'export-reader@example.test', name: 'Export Reader', password: credentials[2]! });
  const outsiderUser = await operator.provision({ email: 'export-outsider@example.test', name: 'Export Outsider', password: credentials[3]! });
  const admin = client('127.0.0.51');
  const editor = client('127.0.0.52');
  const reader = client('127.0.0.53');
  const outsider = client('127.0.0.54');
  const anonymous = client('127.0.0.55');
  const clients = [admin, editor, reader, outsider];
  const users = [adminUser, editorUser, readerUser, outsiderUser];
  for (let index = 0; index < clients.length; index++) {
    assert.equal((await clients[index]!.send('POST', '/api/auth/sign-in/email', {
      email: users[index]!.email, password: credentials[index],
    })).status, 200, 'Real local authentication must succeed');
  }
  const spaceResponse = await admin.send('POST', '/api/v1/spaces', { name: 'Synthetic export space' });
  assert.equal(spaceResponse.status, 201);
  const space = object(spaceResponse.data);
  assert(typeof space.id === 'string');
  const spaceId = space.id;
  let spaceEtag = String(spaceResponse.headers.etag);
  for (const [user, role] of [[editorUser, 'editor'], [readerUser, 'reader']] as const) {
    const grant = await admin.send('PUT', `/api/v1/spaces/${spaceId}/members/${user.id}`, { role }, { 'if-match': spaceEtag });
    assert.equal(grant.status, 200);
    spaceEtag = String(grant.headers.etag);
  }
  const created = await editor.send('POST', `/api/v1/spaces/${spaceId}/documents`, {
    title: 'Synthetic first export title', content: syntheticContent('Synthetic old content'),
    changeNote: 'Synthetic note excluded from export',
  });
  assert.equal(created.status, 201);
  const createdDocument = object(created.data);
  const createdRevision = object(createdDocument.revision);
  assert(typeof createdDocument.id === 'string');
  assert(typeof createdRevision.id === 'string');
  const documentId = createdDocument.id;
  const exportPath = `/api/v1/documents/${documentId}/export`;
  const updated = await editor.send('PATCH', `/api/v1/documents/${documentId}`, {
    title: 'Synthetic current export title', content: syntheticContent('Synthetic current content'),
    changeNote: 'Synthetic later note excluded from export',
  }, { 'if-match': String(created.headers.etag) });
  assert.equal(updated.status, 200);
  const currentDocument = object(updated.data);
  const currentRevision = object(currentDocument.revision);
  let etag = String(updated.headers.etag);

  const opaqueAuthMarker = randomBytes(24).toString('base64url');
  await database.prisma.account.updateMany({ data: {
    accessToken: opaqueAuthMarker, refreshToken: opaqueAuthMarker, idToken: opaqueAuthMarker,
  } });
  const accounts = await database.prisma.account.findMany({ select: { password: true } });
  const sessions = await database.prisma.session.findMany({ select: { token: true } });
  const forbiddenValues = [...credentials, identityConfig.secret, opaqueAuthMarker,
    ...accounts.map((account) => account.password).filter((value): value is string => value !== null),
    ...sessions.map((session) => session.token), ...clients.map((agent) => agent.cookie),
    ...users.map((user) => user.email), 'Export Owner', 'Export Editor', 'Export Reader', 'Export Outsider'];

  function assertExport(response: Awaited<ReturnType<typeof admin.send>>) {
    assert.equal(response.status, 200);
    assert.match(String(response.headers['content-type']), /^application\/json/);
    assert.equal(response.headers['content-disposition'], `attachment; filename="scrawl-document-${documentId}.json"`);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers.etag, undefined);
    const exported = object(response.data);
    assert.deepEqual(Object.keys(exported).sort(), ['format', 'exportVersion', 'document', 'revision', 'content'].sort());
    assert.equal(exported.format, 'scrawl-document');
    assert.equal(exported.exportVersion, 1);
    assert.deepEqual(Object.keys(object(exported.document)).sort(), ['id', 'spaceId', 'createdAt', 'createdBy'].sort());
    assert.deepEqual(Object.keys(object(exported.revision)).sort(), ['id', 'revisionNumber', 'title', 'createdAt', 'authorId'].sort());
    for (const value of forbiddenValues) assert(!response.body.includes(value), 'Export must omit authentication and session values');
    assert.deepEqual(exported.document, {
      id: documentId, spaceId, createdAt: currentDocument.createdAt, createdBy: editorUser.id,
    });
    assert.deepEqual(exported.revision, {
      id: currentRevision.id, revisionNumber: 2, title: currentRevision.title,
      createdAt: currentRevision.createdAt, authorId: editorUser.id,
    });
    assert.deepEqual(validateContent(exported.content).content, validateContent(currentRevision.content).content);
    assert.deepEqual(validateContent(JSON.parse(JSON.stringify(exported.content))).content, exported.content);
    assert(!response.body.includes('Synthetic old content'), 'Export contains only the current snapshot');
    assert(!response.body.includes('Synthetic note excluded'), 'Export omits change notes');
    return exported;
  }

  function assertDenied(response: Awaited<ReturnType<typeof admin.send>>, status: number) {
    assert.equal(response.status, status);
    assert.equal(object(response.data).status, status);
    assert.equal(response.headers['content-disposition'], undefined);
    assert.equal(response.headers.etag, undefined);
    for (const value of ['Synthetic', 'revisionNumber', 'schemaVersion', 'createdBy', 'authorId', ...forbiddenValues]) {
      assert(!response.body.includes(value), 'Denied export must not disclose document or authentication data');
    }
  }

  await t.test('administrator, editor, and reader export the same validated current snapshot with minimal provenance', async () => {
    const exports = [];
    for (const agent of [admin, editor, reader]) exports.push(assertExport(await agent.send('GET', exportPath)));
    assert.deepEqual(exports[0], exports[1]);
    assert.deepEqual(exports[1], exports[2]);
    assert.deepEqual(await core.documents.exportNative(new Headers({ cookie: reader.cookie }), documentId), exports[0]);
    assert.equal(await database.prisma.documentRevision.count({ where: { documentId } }), 2);
  });

  await t.test('anonymous and outsider requests disclose no export, including direct core calls', async () => {
    assertDenied(await anonymous.send('GET', exportPath), 401);
    assertDenied(await outsider.send('GET', exportPath), 404);
    assertDenied(await outsider.send('GET', `/api/v1/documents/${randomUUID()}/export`), 404);
    for (const [headers, status] of [[new Headers(), 401], [new Headers({ cookie: outsider.cookie }), 404]] as const) {
      await assert.rejects(core.documents.exportNative(headers, documentId),
        (error: unknown) => error instanceof HttpProblem && error.status === status);
    }
  });

  await t.test('export rejects malformed IDs and unsupported revision selection without writing', async () => {
    assertDenied(await admin.send('GET', '/api/v1/documents/not-a-uuid/export'), 400);
    assertDenied(await admin.send('GET', `${exportPath}?revisionId=${createdRevision.id}`), 400);
    assertDenied(await admin.send('GET', `${exportPath}?includeHistory=true`), 400);
    assert.equal(await database.prisma.documentRevision.count({ where: { documentId } }), 2);
  });

  await t.test('archived content remains exportable to authorized readers without history or lifecycle state', async () => {
    const archive = await editor.send('POST', `/api/v1/documents/${documentId}/archive`, {}, { 'if-match': etag });
    assert.equal(archive.status, 200);
    etag = String(archive.headers.etag);
    assertExport(await reader.send('GET', exportPath));
    assertDenied(await outsider.send('GET', exportPath), 404);
    const unarchive = await editor.send('POST', `/api/v1/documents/${documentId}/unarchive`, {}, { 'if-match': etag });
    assert.equal(unarchive.status, 200);
    etag = String(unarchive.headers.etag);
    assertExport(await reader.send('GET', exportPath));
    assert.equal(await database.prisma.documentRevision.count({ where: { documentId } }), 2);
  });

  await t.test('membership revocation immediately denies export using the existing authenticated session', async () => {
    const existingCookie = reader.cookie;
    const revoke = await admin.send('DELETE', `/api/v1/spaces/${spaceId}/members/${readerUser.id}`, undefined,
      { 'if-match': spaceEtag });
    assert.equal(revoke.status, 200);
    assert.equal((await reader.send('GET', '/api/v1/me')).status, 200, 'Revocation does not replace authentication');
    assert(reader.cookie === existingCookie, 'The same cookie must remain in use');
    assertDenied(await reader.send('GET', exportPath), 404);
    await assert.rejects(core.documents.exportNative(new Headers({ cookie: existingCookie }), documentId),
      (error: unknown) => error instanceof HttpProblem && error.status === 404);
    assertExport(await admin.send('GET', exportPath));
    assert.equal(await database.prisma.documentRevision.count({ where: { documentId } }), 2);
  });
});
