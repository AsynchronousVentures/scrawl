// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfig } from '../../src/config.js';
import { createDatabase } from '../../src/db/client.js';
import { createCore } from '../../src/core/index.js';
import { createOperator } from '../../src/core/identity/operator.js';
import { createPublishing } from '../../src/capabilities/publishing/index.js';
import { CONTENT_LIMITS, validateContent } from '../../src/core/documents/content.js';
import { HttpProblem } from '../../src/http/problems.js';
import { buildApp } from '../../src/app.js';

function object(value: unknown): Record<string, unknown> {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'Expected a response object');
  return value as Record<string, unknown>;
}
function string(value: unknown): string { assert.equal(typeof value, 'string'); return value as string; }
type MediaFixture = { type: 'file' | 'image'; url: string; name: string };
function native(text: string, media: MediaFixture[] = []) {
  return validateContent({ format: 'blocknote-json', schemaVersion: 1, editorVersion: '0.55.0', document: [
    { id: 'synthetic-publication-heading', type: 'heading', props: { level: 2 }, content: [{ type: 'text', text: 'Synthetic heading', styles: {} }] },
    { id: 'synthetic-publication-text', type: 'paragraph', content: [{ type: 'text', text, styles: {} }] },
    ...media.map((file, index) => ({ id: `synthetic-publication-media-${index}`, type: file.type,
      props: { url: file.url, name: file.name, caption: 'Synthetic approved caption' } })),
    ...(media[0] ? [{ id: 'synthetic-publication-link', type: 'paragraph', content: [
      { type: 'link', href: media[0].url, content: [{ type: 'text', text: 'Synthetic file link', styles: { underline: true } }] },
    ] }] : []),
  ] }).content;
}

test('selected-revision publishing enforces atomic approval, lifecycle and file allowlists with real sessions', async (t) => {
  const base = readConfig(process.env);
  const url = new URL(base.databaseUrl);
  assert(base.nodeEnv !== 'production' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  assert.notEqual(url.port, '5433', 'The retained PostgreSQL 17 instance must not be modified');
  const administrator = createDatabase(base, () => {});
  const schema = 'scrawl_publication_' + randomUUID().replaceAll('-', '');
  const storageRoot = await mkdtemp(join(tmpdir(), 'scrawl-publication-'));
  await administrator.pool.query(`CREATE SCHEMA "${schema}"`);
  url.searchParams.set('schema', schema);
  const config = { ...base, databaseUrl: url.href, attachmentStorageDir: storageRoot, publicPublishingEnabled: true };
  const database = createDatabase(config, () => {});
  const identityConfig = { origin: 'http://127.0.0.1:3000', secret: randomBytes(32).toString('hex'), secureCookies: false };
  const core = createCore(database.prisma, identityConfig, { attachmentStorageDir: storageRoot });
  const publishing = createPublishing(core.documents, core.identity, { enabled: true });
  const paused = createPublishing(core.documents, core.identity, { enabled: false });
  const operator = createOperator(database.prisma, identityConfig);
  const app = await buildApp({ config, core, publishing, checkDatabase: () => database.ping(), logging: false });
  const pausedApp = await buildApp({ config: { ...config, publicPublishingEnabled: false }, core, publishing: paused,
    checkDatabase: () => database.ping(), logging: false });
  t.after(async () => {
    await app.close(); await pausedApp.close(); await database.close();
    await administrator.pool.query(`DROP SCHEMA "${schema}" CASCADE`); await administrator.close();
    await rm(storageRoot, { recursive: true, force: true });
  });
  const migration = spawnSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: config.databaseUrl }, encoding: 'utf8',
  });
  assert.equal(migration.status, 0, 'The complete reviewed migration history must deploy');
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const pausedAddress = await pausedApp.listen({ host: '127.0.0.1', port: 0 });

  function client(peer: string) {
    let cookie = '';
    return {
      get headers() { return new Headers({ cookie }); },
      async send(method: string, path: string, payload?: unknown, headers: Record<string, string> = {}, baseAddress = address) {
        const binary = Buffer.isBuffer(payload);
        const bytes = payload === undefined ? undefined : binary ? payload : Buffer.from(JSON.stringify(payload));
        return new Promise<{ status: number; data: unknown; bytes: Buffer; headers: IncomingHttpHeaders }>((resolve, reject) => {
          const request = httpRequest(new URL(path, baseAddress), { method, localAddress: peer, headers: {
            origin: identityConfig.origin, ...(cookie ? { cookie } : {}),
            ...(bytes ? { 'content-type': binary ? 'application/octet-stream' : 'application/json', 'content-length': String(bytes.length) } : {}),
            ...headers,
          } }, response => {
            const chunks: Buffer[] = [];
            response.on('data', (chunk: Buffer) => chunks.push(chunk)); response.on('error', reject);
            response.on('end', () => {
              if (response.headers['set-cookie']) cookie = response.headers['set-cookie'].map(value => value.split(';')[0]).join('; ');
              const bytes = Buffer.concat(chunks);
              const json = /^(?:application\/json|application\/problem\+json)/.test(String(response.headers['content-type']));
              resolve({ status: response.statusCode!, data: bytes.length && json ? JSON.parse(bytes.toString()) as unknown : null,
                bytes, headers: response.headers });
            });
          });
          request.on('error', reject); request.end(bytes);
        });
      },
    };
  }
  const password = randomBytes(24).toString('base64url');
  const owner = await operator.bootstrap({ email: 'publishing-owner@example.test', name: 'Synthetic Publishing Owner', password });
  const editorUser = await operator.provision({ email: 'publishing-editor@example.test', name: 'Synthetic Publishing Editor', password });
  const readerUser = await operator.provision({ email: 'publishing-reader@example.test', name: 'Synthetic Publishing Reader', password });
  const outsiderUser = await operator.provision({ email: 'publishing-outsider@example.test', name: 'Synthetic Publishing Outsider', password });
  const admin = client('127.0.0.91'), editor = client('127.0.0.92'), reader = client('127.0.0.93');
  const outsider = client('127.0.0.94'), anonymous = client('127.0.0.95');
  for (const [agent, user] of [[admin, owner], [editor, editorUser], [reader, readerUser], [outsider, outsiderUser]] as const) {
    assert.equal((await agent.send('POST', '/api/auth/sign-in/email', { email: user.email, password })).status, 200);
  }
  const createdSpace = await admin.send('POST', '/api/v1/spaces', { name: 'Synthetic private source space' });
  assert.equal(createdSpace.status, 201);
  const spaceId = string(object(createdSpace.data).id);
  let spaceEtag = string(createdSpace.headers.etag);
  for (const [user, role] of [[editorUser, 'editor'], [readerUser, 'reader']] as const) {
    const response = await admin.send('PUT', `/api/v1/spaces/${spaceId}/members/${user.id}`, { role }, { 'if-match': spaceEtag });
    assert.equal(response.status, 200); spaceEtag = string(response.headers.etag);
  }
  async function document(title: string) {
    const created = await editor.send('POST', `/api/v1/spaces/${spaceId}/documents`, { title, content: native('Synthetic oldest body') });
    assert.equal(created.status, 201);
    return { id: string(object(created.data).id), revisionId: string(object(object(created.data).revision).id), etag: string(created.headers.etag) };
  }
  const main = await document('Synthetic original title'), other = await document('Synthetic other title');
  const originalEtag = main.etag;
  const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const textBytes = Buffer.from('Synthetic approved file bytes.\n');
  async function upload(name: string, bytes: Buffer) {
    const response = await editor.send('POST', `/api/v1/documents/${main.id}/attachments`, bytes, { 'x-file-name': encodeURIComponent(name) });
    assert.equal(response.status, 201);
    const value = object(response.data);
    return { id: string(value.id), url: string(value.url), name: string(value.name) };
  }
  const approvedImage = await upload('Synthetic approved.png', imageBytes);
  const approvedFile = await upload('Synthetic approved.txt', textBytes);
  const unrelatedFile = await upload('Synthetic never referenced.txt', Buffer.from('Synthetic never referenced file bytes.'));
  const approvedContent = native('Synthetic approved body with literal <script>alert("synthetic")</script> text.', [
    { ...approvedImage, type: 'image' }, { ...approvedFile, type: 'file' },
  ]);
  const approved = await editor.send('PATCH', `/api/v1/documents/${main.id}`, {
    title: 'Synthetic approved title', content: approvedContent, changeNote: 'Synthetic private approval note',
  }, { 'if-match': main.etag });
  assert.equal(approved.status, 200); main.etag = string(approved.headers.etag);
  const approvedRevisionId = string(object(object(approved.data).revision).id);
  const publicationPath = `/api/v1/documents/${main.id}/publication`;
  let publicId = '';
  function publicPath(id = publicId) { return `/api/public/publications/${id}`; }
  function publicFile(id: string) { return `${publicPath()}/attachments/${id}`; }
  async function snapshots() {
    return { documents: await database.prisma.document.findMany({ orderBy: { id: 'asc' } }),
      revisions: await database.prisma.documentRevision.findMany({ orderBy: { id: 'asc' } }),
      grants: await database.prisma.publication.findMany({ orderBy: { id: 'asc' } }),
      attachments: await database.prisma.attachment.findMany({ orderBy: { id: 'asc' } }),
      references: await database.prisma.revisionAttachment.findMany({ orderBy: [{ revisionId: 'asc' }, { attachmentId: 'asc' }] }) };
  }
  function denied(response: Awaited<ReturnType<typeof admin.send>>, status: number) {
    assert.equal(response.status, status); assert.equal(object(response.data).status, status);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers.etag, undefined); assert.equal(response.headers['content-disposition'], undefined);
    for (const forbidden of ['Synthetic', 'revisionNumber', 'schemaVersion', 'sha256', storageRoot, password]) {
      assert(!response.bytes.toString().includes(forbidden), 'Rejected requests must not reveal source content, metadata or credentials');
    }
  }
  async function publish(revisionId = approvedRevisionId) {
    const response = await admin.send('POST', publicationPath, { revisionId }, { 'if-match': main.etag });
    assert.equal(response.status, 200); main.etag = string(response.headers.etag);
    const status = object(response.data); assert.deepEqual(Object.keys(status).sort(), ['publication', 'lockVersion'].sort());
    const grant = object(status.publication);
    assert.deepEqual(Object.keys(grant).sort(), ['publicId', 'revisionId', 'revisionNumber', 'publishedAt', 'active'].sort());
    const id = string(grant.publicId);
    if (publicId) assert.equal(id, publicId, 'Republishing preserves the opaque public ID');
    publicId = id; assert.equal(grant.active, true); assert.equal(grant.revisionId, revisionId);
    return response;
  }

  await t.test('disabled publishing denies public access and mutations while authenticated private workflows remain usable', async () => {
    const before = await snapshots();
    const availability = await admin.send('GET', '/api/v1/publishing', undefined, {}, pausedAddress);
    assert.equal(availability.status, 200); assert.deepEqual(availability.data, { enabled: false, mayPublish: false });
    denied(await anonymous.send('GET', publicPath(randomUUID()), undefined, {}, pausedAddress), 404);
    denied(await admin.send('POST', publicationPath, { revisionId: approvedRevisionId }, { 'if-match': main.etag }, pausedAddress), 404);
    denied(await admin.send('DELETE', publicationPath, undefined, { 'if-match': main.etag }, pausedAddress), 404);
    assert.equal((await reader.send('GET', `/api/v1/documents/${main.id}`, undefined, {}, pausedAddress)).status, 200);
    assert.equal((await reader.send('GET', `/api/v1/documents/${main.id}/export`, undefined, {}, pausedAddress)).status, 200);
    assert.deepEqual(await snapshots(), before);
    await assert.rejects(paused.read(randomUUID()), (error: unknown) => error instanceof HttpProblem && error.status === 404);
  });

  await t.test('only administrators with source visibility may publish; status and availability remain authorized', async () => {
    const before = await snapshots();
    assert.deepEqual((await admin.send('GET', '/api/v1/publishing')).data, { enabled: true, mayPublish: true });
    for (const agent of [reader, editor, outsider]) {
      assert.deepEqual((await agent.send('GET', '/api/v1/publishing')).data, { enabled: true, mayPublish: false });
    }
    denied(await anonymous.send('GET', '/api/v1/publishing'), 401);
    for (const [agent, status] of [[reader, 403], [editor, 403], [outsider, 404], [anonymous, 401]] as const) {
      denied(await agent.send('POST', publicationPath, { revisionId: approvedRevisionId }, { 'if-match': main.etag }), status);
      denied(await agent.send('DELETE', publicationPath, undefined, { 'if-match': main.etag }), status);
    }
    assert.equal((await reader.send('GET', publicationPath)).status, 200);
    denied(await outsider.send('GET', publicationPath), 404); denied(await anonymous.send('GET', publicationPath), 401);
    let callbackInvoked = false;
    await assert.rejects(core.documents.mutatePublication(editor.headers, main.id, main.etag, 2, async () => { callbackInvoked = true; }),
      (error: unknown) => error instanceof HttpProblem && error.status === 403);
    assert.equal(callbackInvoked, false); assert.deepEqual(await snapshots(), before);
  });

  await t.test('missing or stale preconditions and foreign revisions leave publication, versions and history unchanged', async () => {
    const before = await snapshots();
    denied(await admin.send('POST', publicationPath, { revisionId: approvedRevisionId }), 428);
    denied(await admin.send('DELETE', publicationPath), 428);
    denied(await admin.send('POST', publicationPath, { revisionId: approvedRevisionId }, { 'if-match': originalEtag }), 412);
    denied(await admin.send('DELETE', publicationPath, undefined, { 'if-match': originalEtag }), 412);
    for (const revisionId of [other.revisionId, randomUUID()]) {
      denied(await admin.send('POST', publicationPath, { revisionId }, { 'if-match': main.etag }), 404);
    }
    for (const body of [{ revisionId: 'unknown' }, { revisionId: approvedRevisionId, publisherId: owner.id }, { revisionNumber: 2 }]) {
      denied(await admin.send('POST', publicationPath, body, { 'if-match': main.etag }), 400);
    }
    assert.deepEqual(await snapshots(), before);
  });

  await t.test('public URL expansion is validated before grant creation and cannot publish an unreadable oversized envelope', async () => {
    const bounded = await document('Synthetic resource boundary document');
    const uploaded = await editor.send('POST', `/api/v1/documents/${bounded.id}/attachments`, textBytes,
      { 'x-file-name': encodeURIComponent('Synthetic bounded.txt') });
    assert.equal(uploaded.status, 201);
    const file = object(uploaded.data);
    const media: MediaFixture[] = [{ type: 'file', url: string(file.url), name: string(file.name) }];
    const overhead = Buffer.byteLength(JSON.stringify(native('x', media))) - 1;
    const maximum = native('x'.repeat(CONTENT_LIMITS.maxBytes - overhead), media);
    assert.equal(Buffer.byteLength(JSON.stringify(maximum)), CONTENT_LIMITS.maxBytes);
    const saved = await editor.send('PATCH', `/api/v1/documents/${bounded.id}`, { content: maximum }, { 'if-match': bounded.etag });
    assert.equal(saved.status, 200);
    const before = await snapshots();
    denied(await admin.send('POST', `/api/v1/documents/${bounded.id}/publication`, {
      revisionId: string(object(object(saved.data).revision).id),
    }, { 'if-match': string(saved.headers.etag) }), 413);
    assert.deepEqual(await snapshots(), before);
  });

  await t.test('approval changes only the grant and document lock; anonymous output has no private IDs, metadata or history', async () => {
    const before = await snapshots();
    const response = await publish();
    const grant = object(object(response.data).publication);
    assert.equal(grant.revisionNumber, 2);
    const after = await snapshots(); assert.deepEqual(after.revisions, before.revisions);
    assert.deepEqual(after.attachments, before.attachments); assert.deepEqual(after.references, before.references);
    assert.equal(after.grants.length, 1);
    const document = after.documents.find(value => value.id === main.id)!;
    assert.equal(document.lockVersion, before.documents.find(value => value.id === main.id)!.lockVersion + 1);
    assert.equal(document.currentRevisionNumber, 2); assert.equal(document.availabilityVersion, 1);
    const publicResponse = await anonymous.send('GET', publicPath());
    assert.equal(publicResponse.status, 200); assert.equal(publicResponse.headers.etag, undefined);
    assert.equal(publicResponse.headers['cache-control'], 'no-store');
    const data = object(publicResponse.data); assert.deepEqual(Object.keys(data).sort(), ['title', 'content', 'publishedAt'].sort());
    assert.equal(data.title, 'Synthetic approved title'); assert.equal(data.publishedAt, grant.publishedAt);
    const expected = JSON.stringify(approvedContent).replaceAll(approvedImage.url, publicFile(approvedImage.id))
      .replaceAll(approvedFile.url, publicFile(approvedFile.id));
    assert.deepEqual(validateContent(data.content).content, validateContent(JSON.parse(expected)).content);
    for (const forbidden of [main.id, spaceId, approvedRevisionId, owner.id, editorUser.id, password, identityConfig.secret,
      'Synthetic private source space', 'Synthetic private approval note', 'Synthetic oldest body', 'authorId', 'createdBy', 'plainText']) {
      assert(!publicResponse.bytes.toString().includes(forbidden), 'Anonymous projections omit private identifiers and metadata');
    }
    assert.equal((await reader.send('GET', publicationPath)).headers.etag, main.etag);
  });

  await t.test('new private title, content and files never advance the selected public revision or its attachment allowlist', async () => {
    const previousPublic = await anonymous.send('GET', publicPath());
    const privateFile = await upload('Synthetic private newer.txt', Buffer.from('Synthetic private newer bytes.'));
    const saved = await editor.send('PATCH', `/api/v1/documents/${main.id}`, {
      title: 'Synthetic private newer title', content: native('Synthetic private newer body', [{ ...privateFile, type: 'file' }]),
      changeNote: 'Synthetic private newer note',
    }, { 'if-match': main.etag });
    assert.equal(saved.status, 200); main.etag = string(saved.headers.etag);
    assert.equal(object(object(saved.data).revision).revisionNumber, 3);
    const currentPublic = await anonymous.send('GET', publicPath());
    assert.equal(currentPublic.status, 200); assert.deepEqual(currentPublic.data, previousPublic.data);
    assert(!currentPublic.bytes.toString().includes('Synthetic private newer'));
    for (const [attachment, bytes] of [[approvedImage, imageBytes], [approvedFile, textBytes]] as const) {
      const response = await anonymous.send('GET', publicFile(attachment.id));
      assert.equal(response.status, 200); assert.deepEqual(response.bytes, bytes);
      assert.equal(response.headers['cache-control'], 'no-store'); assert.equal(response.headers['x-content-type-options'], 'nosniff');
      assert.equal(response.headers['content-security-policy'], "sandbox; default-src 'none'");
    }
    for (const id of [privateFile.id, unrelatedFile.id, randomUUID()]) denied(await anonymous.send('GET', publicFile(id)), 404);
    denied(await anonymous.send('GET', approvedFile.url), 401);
    denied(await anonymous.send('GET', publicPath(approvedRevisionId)), 404);
    for (const query of [`revisionId=${main.revisionId}`, 'includeHistory=true', 'includePrivate=true']) {
      denied(await anonymous.send('GET', `${publicPath()}?${query}`), 400);
    }
    denied(await anonymous.send('GET', `${publicFile(approvedImage.id)}?revisionId=${approvedRevisionId}`), 400);
    assert.equal((await database.prisma.publication.findUniqueOrThrow({ where: { documentId: main.id } })).revisionNumber, 2);
  });

  await t.test('concurrent publication changes on one ETag produce one success and one conflict without a revision', async () => {
    const before = await snapshots(); const etag = main.etag;
    const responses = await Promise.all([
      admin.send('POST', publicationPath, { revisionId: approvedRevisionId }, { 'if-match': etag }),
      admin.send('DELETE', publicationPath, undefined, { 'if-match': etag }),
    ]);
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 412]);
    main.etag = string(responses.find(response => response.status === 200)!.headers.etag);
    const after = await snapshots(); assert.deepEqual(after.revisions, before.revisions);
    assert.equal(after.documents.find(value => value.id === main.id)!.lockVersion, before.documents.find(value => value.id === main.id)!.lockVersion + 1);
    await publish();
  });

  await t.test('grant failures, malformed allowlists and database ownership constraints roll back atomically', async () => {
    const before = await snapshots();
    await assert.rejects(core.documents.mutatePublication(admin.headers, main.id, main.etag, 2, async context => {
      await context.tx.publication.update({ where: { documentId: main.id }, data: { active: false } });
      throw new Error('Synthetic failure after grant write');
    }), /Synthetic failure/);
    assert.deepEqual(await snapshots(), before);
    await assert.rejects(database.prisma.publication.create({ data: {
      id: randomUUID(), documentId: other.id, revisionNumber: 2, approvedAvailabilityVersion: 1,
      publisherId: owner.id, active: true,
    } }));
    assert.deepEqual(await snapshots(), before);
    await database.pool.query(`CREATE FUNCTION publication_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Synthetic publication write failure'; END; $$`);
    await database.pool.query(`CREATE TRIGGER publication_test_failure BEFORE UPDATE ON "Publication"
      FOR EACH ROW EXECUTE FUNCTION publication_test_failure()`);
    try { denied(await admin.send('POST', publicationPath, { revisionId: approvedRevisionId }, { 'if-match': main.etag }), 500); }
    finally {
      await database.pool.query('DROP TRIGGER publication_test_failure ON "Publication"');
      await database.pool.query('DROP FUNCTION publication_test_failure()');
    }
    assert.deepEqual(await snapshots(), before);
    // A corrupted historical body must not be partially exposed or used to
    // rewrite an unapproved private URL. Restore it inside the owned fixture.
    const revision = await database.prisma.documentRevision.findUniqueOrThrow({ where: { id: approvedRevisionId } });
    const corrupt = native('Synthetic corrupt source', [{ ...unrelatedFile, type: 'file' }]);
    await database.pool.query('UPDATE "DocumentRevision" SET "body" = $1::jsonb WHERE "id" = $2::uuid', [JSON.stringify(corrupt.document), approvedRevisionId]);
    try {
      denied(await anonymous.send('GET', publicPath()), 404);
      denied(await admin.send('POST', publicationPath, { revisionId: approvedRevisionId }, { 'if-match': main.etag }), 400);
    } finally {
      await database.pool.query('UPDATE "DocumentRevision" SET "body" = $1::jsonb WHERE "id" = $2::uuid', [JSON.stringify(revision.body), approvedRevisionId]);
    }
    assert.deepEqual(await snapshots(), before);
  });

  await t.test('archive invalidates approval permanently until an explicit republish; unpublish immediately revokes public streams', async () => {
    const history = await database.prisma.documentRevision.findMany({ orderBy: { id: 'asc' } });
    const archive = await editor.send('POST', `/api/v1/documents/${main.id}/archive`, {}, { 'if-match': main.etag });
    assert.equal(archive.status, 200); main.etag = string(archive.headers.etag);
    const archived = await database.prisma.document.findUniqueOrThrow({ where: { id: main.id } });
    assert.equal(archived.availabilityVersion, 2);
    const repeated = await editor.send('POST', `/api/v1/documents/${main.id}/archive`, {}, { 'if-match': main.etag });
    assert.equal(repeated.status, 200); assert.equal(repeated.headers.etag, main.etag);
    assert.equal((await database.prisma.document.findUniqueOrThrow({ where: { id: main.id } })).availabilityVersion, 2);
    denied(await anonymous.send('GET', publicPath()), 404); denied(await anonymous.send('GET', publicFile(approvedImage.id)), 404);
    denied(await admin.send('POST', publicationPath, { revisionId: approvedRevisionId }, { 'if-match': main.etag }), 409);
    const unarchive = await editor.send('POST', `/api/v1/documents/${main.id}/unarchive`, {}, { 'if-match': main.etag });
    assert.equal(unarchive.status, 200); main.etag = string(unarchive.headers.etag);
    assert.equal((await database.prisma.document.findUniqueOrThrow({ where: { id: main.id } })).availabilityVersion, 2);
    assert.equal(object(object((await admin.send('GET', publicationPath)).data).publication).active, false);
    denied(await anonymous.send('GET', publicPath()), 404); denied(await anonymous.send('GET', publicFile(approvedFile.id)), 404);
    await publish(); assert.equal((await anonymous.send('GET', publicPath())).status, 200);
    assert.equal((await database.prisma.publication.findUniqueOrThrow({ where: { documentId: main.id } })).approvedAvailabilityVersion, 2);
    const revoked = await admin.send('DELETE', publicationPath, undefined, { 'if-match': main.etag });
    assert.equal(revoked.status, 200); main.etag = string(revoked.headers.etag);
    assert.equal(object(object(revoked.data).publication).active, false);
    denied(await anonymous.send('GET', publicPath()), 404); denied(await anonymous.send('GET', publicFile(approvedFile.id)), 404);
    assert.deepEqual(await database.prisma.documentRevision.findMany({ orderBy: { id: 'asc' } }), history);
  });

  await t.test('global disable is a pause, not grant deletion, and cannot affect private content or file access', async () => {
    await publish();
    const before = await snapshots();
    denied(await anonymous.send('GET', publicPath(), undefined, {}, pausedAddress), 404);
    denied(await anonymous.send('GET', publicFile(approvedImage.id), undefined, {}, pausedAddress), 404);
    await assert.rejects(paused.attachment(publicId, approvedImage.id), (error: unknown) => error instanceof HttpProblem && error.status === 404);
    assert.equal((await reader.send('GET', `/api/v1/documents/${main.id}`, undefined, {}, pausedAddress)).status, 200);
    assert.deepEqual((await reader.send('GET', approvedFile.url, undefined, {}, pausedAddress)).bytes, textBytes);
    assert.equal((await anonymous.send('GET', publicPath())).status, 200);
    assert.deepEqual(await snapshots(), before);
  });

  await t.test('a real session revoked while approval waits for the space lock cannot commit a grant or version change', async () => {
    const before = await snapshots();
    const principal = await core.identity.resolve(admin.headers);
    let unlock!: () => void;
    const release = new Promise<void>(resolve => { unlock = resolve; });
    let acquired!: (pid: number) => void;
    const locked = new Promise<number>(resolve => { acquired = resolve; });
    const blocker = database.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "Space" WHERE "id" = ${spaceId}::uuid FOR UPDATE`;
      const [backend] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      acquired(backend!.pid); await release;
    }, { timeout: 10_000 });
    const pid = await locked;
    const pending = publishing.publish(admin.headers, main.id, { revisionId: approvedRevisionId }, main.etag);
    // Observe a genuine PostgreSQL lock wait instead of relying on timing.
    const deadline = Date.now() + 4_000;
    try {
      while (true) {
        const wait = await database.pool.query<{ blocked: boolean }>('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))) AS blocked', [pid]);
        if (wait.rows[0]?.blocked) break;
        assert(Date.now() < deadline, 'Approval must reach the actual space lock');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      await database.prisma.session.delete({ where: { id: principal.sessionId } });
    } finally { unlock(); await blocker; }
    await assert.rejects(pending, (error: unknown) => error instanceof HttpProblem && error.status === 401);
    assert.deepEqual(await snapshots(), before);
    denied(await admin.send('POST', publicationPath, { revisionId: approvedRevisionId }, { 'if-match': main.etag }), 401);
  });
});
