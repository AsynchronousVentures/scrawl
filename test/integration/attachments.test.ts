// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfig } from '../../src/config.js';
import { createDatabase } from '../../src/db/client.js';
import { createCore } from '../../src/core/index.js';
import { createAttachments, MAX_UPLOAD_BYTES } from '../../src/core/attachments/index.js';
import { validateContent } from '../../src/core/documents/content.js';
import { createOperator } from '../../src/core/identity/operator.js';
import { HttpProblem } from '../../src/http/problems.js';
import { buildApp } from '../../src/app.js';

function object(value: unknown): Record<string, unknown> {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'Expected response object');
  return value as Record<string, unknown>;
}
function string(value: unknown): string { assert.equal(typeof value, 'string'); return value as string; }
function content(text: string, attachment?: { url: string; name: string }) {
  return validateContent({ format: 'blocknote-json', schemaVersion: 1, editorVersion: '0.55.0', document: [
    { id: 'synthetic-attachment-text', type: 'paragraph', content: [{ type: 'text', text, styles: {} }] },
    ...(attachment ? [{ id: 'synthetic-attachment-file', type: 'file', props: { url: attachment.url, name: attachment.name } }] : []),
  ] }).content;
}

test('private document attachments retain immutable bytes and revision ownership with real sessions', async (t) => {
  const baseConfig = readConfig(process.env);
  const target = new URL(baseConfig.databaseUrl);
  assert(baseConfig.nodeEnv !== 'production' && ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname));
  const administrator = createDatabase(baseConfig, () => {});
  const schema = 'scrawl_attachments_' + randomUUID().replaceAll('-', '');
  const storageRoot = await mkdtemp(join(tmpdir(), 'scrawl-private-attachments-'));
  await administrator.pool.query(`CREATE SCHEMA "${schema}"`);
  target.searchParams.set('schema', schema);
  const config = { ...baseConfig, databaseUrl: target.href, attachmentStorageDir: storageRoot };
  const database = createDatabase(config, () => {});
  const identityConfig = { origin: 'http://127.0.0.1:3000', secret: randomBytes(32).toString('hex'), secureCookies: false };
  const core = createCore(database.prisma, identityConfig, { attachmentStorageDir: storageRoot });
  const operator = createOperator(database.prisma, identityConfig);
  const app = await buildApp({ config, core, checkDatabase: () => database.ping(), logging: false });
  t.after(async () => {
    await app.close(); await database.close();
    await administrator.pool.query(`DROP SCHEMA "${schema}" CASCADE`); await administrator.close();
    await rm(storageRoot, { recursive: true, force: true });
  });
  const migration = spawnSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: config.databaseUrl }, encoding: 'utf8',
  });
  assert.equal(migration.status, 0, 'Existing migration history including private attachments must deploy');
  const address = await app.listen({ host: '127.0.0.1', port: 0 });

  function client(peer: string) {
    let cookie = '';
    return {
      get headers() { return new Headers({ cookie }); },
      async send(method: string, path: string, payload?: unknown, headers: Record<string, string> = {}) {
        const raw = Buffer.isBuffer(payload);
        const serialized = payload === undefined ? undefined : raw ? payload : Buffer.from(JSON.stringify(payload));
        return new Promise<{ status: number; data: unknown; bytes: Buffer; headers: IncomingHttpHeaders }>((resolve, reject) => {
          const request = httpRequest(new URL(path, address), { method, localAddress: peer, headers: {
            origin: identityConfig.origin, ...(cookie ? { cookie } : {}),
            ...(serialized ? { 'content-type': raw ? 'application/octet-stream' : 'application/json',
              'content-length': String(serialized.length) } : {}), ...headers,
          } }, response => {
            const chunks: Buffer[] = [];
            response.on('data', (chunk: Buffer) => chunks.push(chunk)); response.on('error', reject);
            response.on('end', () => {
              const cookies = response.headers['set-cookie'];
              if (cookies) cookie = cookies.map(value => value.split(';')[0]).join('; ');
              const bytes = Buffer.concat(chunks);
              const json = /^(?:application\/json|application\/problem\+json)/.test(String(response.headers['content-type']));
              resolve({ status: response.statusCode!, data: bytes.length && json ? JSON.parse(bytes.toString()) as unknown : null,
                bytes, headers: response.headers });
            });
          });
          request.on('error', reject); request.end(serialized);
        });
      },
      async upload(documentId: string, name: string, bytes: Buffer) {
        return this.send('POST', `/api/v1/documents/${documentId}/attachments`, bytes, { 'x-file-name': encodeURIComponent(name) });
      },
    };
  }
  const password = randomBytes(24).toString('base64url');
  const owner = await operator.bootstrap({ email: 'attachment-owner@example.test', name: 'Synthetic Attachment Owner', password });
  const editorUser = await operator.provision({ email: 'attachment-editor@example.test', name: 'Synthetic Attachment Editor', password });
  const readerUser = await operator.provision({ email: 'attachment-reader@example.test', name: 'Synthetic Attachment Reader', password });
  const outsiderUser = await operator.provision({ email: 'attachment-outsider@example.test', name: 'Synthetic Attachment Outsider', password });
  const admin = client('127.0.0.81'), editor = client('127.0.0.82'), reader = client('127.0.0.83');
  const outsider = client('127.0.0.84'), anonymous = client('127.0.0.85');
  for (const [agent, user] of [[admin, owner], [editor, editorUser], [reader, readerUser], [outsider, outsiderUser]] as const) {
    assert.equal((await agent.send('POST', '/api/auth/sign-in/email', { email: user.email, password })).status, 200);
  }
  const createdSpace = await admin.send('POST', '/api/v1/spaces', { name: 'Synthetic private attachment space' });
  assert.equal(createdSpace.status, 201);
  const spaceId = string(object(createdSpace.data).id);
  let spaceEtag = string(createdSpace.headers.etag);
  async function grant(userId: string, role: 'reader' | 'editor') {
    const response = await admin.send('PUT', `/api/v1/spaces/${spaceId}/members/${userId}`, { role }, { 'if-match': spaceEtag });
    assert.equal(response.status, 200); spaceEtag = string(response.headers.etag);
  }
  await grant(editorUser.id, 'editor'); await grant(readerUser.id, 'reader');
  async function document(title: string) {
    const response = await editor.send('POST', `/api/v1/spaces/${spaceId}/documents`, { title, content: content('Synthetic initial body') });
    assert.equal(response.status, 201);
    return { id: string(object(response.data).id), etag: string(response.headers.etag) };
  }
  const main = await document('Synthetic attachment document'), other = await document('Synthetic unrelated document');
  const uploadPath = `/api/v1/documents/${main.id}/attachments`;
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const textBytes = Buffer.from('Synthetic private attachment bytes.\n');
  let image: { id: string; url: string };
  let file: { id: string; url: string; name: string };
  async function snapshots() {
    return { documents: await database.prisma.document.findMany({ orderBy: { id: 'asc' } }),
      revisions: await database.prisma.documentRevision.findMany({ orderBy: { id: 'asc' } }),
      attachments: await database.prisma.attachment.findMany({ orderBy: { id: 'asc' } }),
      references: await database.prisma.revisionAttachment.findMany({ orderBy: [{ revisionId: 'asc' }, { attachmentId: 'asc' }] }),
      files: (await readdir(storageRoot)).sort() };
  }
  function denied(response: Awaited<ReturnType<typeof editor.send>>, status: number) {
    assert.equal(response.status, status); assert.equal(object(response.data).status, status);
    assert.equal(response.headers['content-disposition'], undefined);
    const error = response.bytes.toString();
    for (const privateValue of ['Synthetic', 'mimeType', 'sha256', 'storageRoot', storageRoot, password]) {
      assert(!error.includes(privateValue), 'Rejected attachment requests must not leak bytes, metadata, paths or credentials');
    }
  }

  await t.test('editor uploads real files without a revision or version change; authorized readers receive identical private bytes', async () => {
    const before = await snapshots();
    const imageResponse = await editor.upload(main.id, 'Synthetic résumé.png', png);
    assert.equal(imageResponse.status, 201);
    const imageDto = object(imageResponse.data);
    assert.deepEqual(Object.keys(imageDto).sort(), ['id', 'name', 'mimeType', 'size', 'url'].sort());
    assert.equal(imageDto.mimeType, 'image/png'); assert.equal(imageDto.size, png.length);
    image = { id: string(imageDto.id), url: string(imageDto.url) };
    const fileResponse = await editor.upload(main.id, 'Synthetic fixture.txt', textBytes);
    assert.equal(fileResponse.status, 201);
    const fileDto = object(fileResponse.data);
    assert.equal(fileDto.mimeType, 'text/plain'); assert.equal(fileDto.size, textBytes.length);
    file = { id: string(fileDto.id), url: string(fileDto.url), name: string(fileDto.name) };
    const after = await snapshots();
    assert.deepEqual(after.documents, before.documents); assert.deepEqual(after.revisions, before.revisions);
    assert.deepEqual(after.references, before.references); assert.equal(after.attachments.length, 2);
    assert.deepEqual(after.files, [image.id, file.id].sort());
    for (const [attachment, bytes] of [[image, png], [file, textBytes]] as const) {
      const record = await database.prisma.attachment.findUniqueOrThrow({ where: { id: attachment.id } });
      assert.equal(record.sha256, createHash('sha256').update(bytes).digest('hex'));
      assert.equal(record.documentId, main.id); assert.equal(record.createdBy, editorUser.id);
      assert.deepEqual(await readFile(join(storageRoot, attachment.id)), bytes);
      assert.equal((await stat(join(storageRoot, attachment.id))).mode & 0o777, 0o600);
      for (const agent of [admin, editor, reader]) {
        const response = await agent.send('GET', attachment.url);
        assert.equal(response.status, 200); assert.deepEqual(response.bytes, bytes);
        assert.equal(response.headers['cache-control'], 'no-store');
        assert.equal(response.headers['x-content-type-options'], 'nosniff');
        assert.equal(response.headers['content-security-policy'], "sandbox; default-src 'none'");
        assert.match(String(response.headers['content-disposition']), attachment.id === image.id ? /^inline;/ : /^attachment;/);
      }
    }
  });

  await t.test('readers cannot upload; outsiders and anonymous clients receive no bytes or attachment metadata', async () => {
    const before = await snapshots();
    for (const [agent, status] of [[reader, 404], [outsider, 404], [anonymous, 401]] as const) {
      denied(await agent.upload(main.id, 'Synthetic rejected.txt', textBytes), status);
      await assert.rejects(core.attachments.upload(agent.headers, main.id, 'Synthetic rejected.txt', textBytes),
        (error: unknown) => error instanceof HttpProblem && error.status === status);
    }
    for (const [agent, status] of [[outsider, 404], [anonymous, 401]] as const) {
      denied(await agent.send('GET', file.url), status);
      await assert.rejects(core.attachments.read(agent.headers, file.id),
        (error: unknown) => error instanceof HttpProblem && error.status === status);
    }
    denied(await outsider.send('GET', `/api/v1/attachments/${randomUUID()}/content`), 404);
    assert.deepEqual(await snapshots(), before);
  });

  await t.test('unsafe media, malformed names and bounded-byte violations create no file or database record', async () => {
    const before = await snapshots();
    for (const [name, bytes, status] of [
      ['Synthetic unsafe.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 415],
      ['Synthetic unsafe.html', Buffer.from('<!doctype html><script>alert(1)</script>'), 415],
      ['Synthetic random.bin', Buffer.from([0, 255, 1, 254]), 415],
      ['Synthetic false.txt', Buffer.from([0, 255, 1, 254]), 400],
      ['Synthetic false.png', Buffer.from('Not an image'), 415],
      ['../Synthetic escape.txt', textBytes, 400], ['Synthetic\\escape.txt', textBytes, 400],
      ['Synthetic\ncontrol.txt', textBytes, 400], ['x'.repeat(201), textBytes, 400],
      ['Synthetic empty.txt', Buffer.alloc(0), 413],
      ['Synthetic oversized.txt', Buffer.alloc(MAX_UPLOAD_BYTES + 1, 65), 413],
    ] as const) denied(await editor.upload(main.id, name, bytes), status);
    denied(await editor.send('POST', uploadPath, textBytes), 400);
    denied(await editor.send('POST', uploadPath, textBytes, { 'x-file-name': '%invalid' }), 400);
    assert.deepEqual(await snapshots(), before);
  });

  await t.test('saving native attachment blocks records ownership; removal and restore append history without changing bytes', async () => {
    const original = await database.prisma.documentRevision.findMany({ where: { documentId: main.id }, orderBy: { revisionNumber: 'asc' } });
    const saved = await editor.send('PATCH', `/api/v1/documents/${main.id}`, { content: content('Synthetic file reference', file) }, { 'if-match': main.etag });
    assert.equal(saved.status, 200); main.etag = string(saved.headers.etag);
    const revisionId = string(object(object(saved.data).revision).id);
    assert.deepEqual(await database.prisma.revisionAttachment.findMany({ where: { revisionId } }), [
      { revisionId, attachmentId: file.id, documentId: main.id },
    ]);
    const removed = await editor.send('PATCH', `/api/v1/documents/${main.id}`, { content: content('Synthetic file removed') }, { 'if-match': main.etag });
    assert.equal(removed.status, 200); main.etag = string(removed.headers.etag);
    const restored = await editor.send('POST', `/api/v1/documents/${main.id}/restore`, { revisionId }, { 'if-match': main.etag });
    assert.equal(restored.status, 200); main.etag = string(restored.headers.etag);
    const restoredRevision = object(object(restored.data).revision);
    assert.equal(restoredRevision.revisionNumber, 4); assert.notEqual(restoredRevision.id, revisionId);
    assert.deepEqual(validateContent(restoredRevision.content).content, validateContent(object(object(saved.data).revision).content).content);
    assert.deepEqual(await database.prisma.revisionAttachment.findMany({ where: { revisionId: string(restoredRevision.id) } }), [
      { revisionId: restoredRevision.id, attachmentId: file.id, documentId: main.id },
    ]);
    const history = await database.prisma.documentRevision.findMany({ where: { documentId: main.id }, orderBy: { revisionNumber: 'asc' } });
    assert.deepEqual(history.slice(0, original.length), original); assert.equal(history.length, 4);
    assert.deepEqual((await reader.send('GET', file.url)).bytes, textBytes);
    const exported = await reader.send('GET', `/api/v1/documents/${main.id}/export`);
    assert.equal(exported.status, 200);
    assert.deepEqual(validateContent(object(exported.data).content).content, validateContent(restoredRevision.content).content);
    assert(!exported.bytes.toString().includes('sha256')); assert(!exported.bytes.toString().includes(storageRoot));
  });

  await t.test('cross-document and missing references roll back revisions, heads and document creation', async () => {
    const before = await snapshots();
    for (const targetFile of [file, { ...file, url: `/api/v1/attachments/${randomUUID()}/content` }]) {
      denied(await editor.send('PATCH', `/api/v1/documents/${other.id}`, { content: content('Synthetic invalid foreign reference', targetFile) },
        { 'if-match': other.etag }), 400);
      denied(await editor.send('POST', `/api/v1/spaces/${spaceId}/documents`, {
        title: 'Synthetic invalid foreign document', content: content('Synthetic invalid foreign reference', targetFile),
      }), 400);
    }
    assert.deepEqual(await snapshots(), before);
  });

  await t.test('database constraints protect attachment metadata and reference ownership; failed uploads remove staged bytes', async () => {
    const before = await snapshots();
    for (const mutate of [
      () => database.prisma.attachment.update({ where: { id: file.id }, data: { name: 'Synthetic overwritten.txt' } }),
      () => database.prisma.attachment.delete({ where: { id: image.id } }),
      () => database.prisma.revisionAttachment.updateMany({ where: { attachmentId: file.id }, data: { documentId: other.id } }),
      () => database.prisma.revisionAttachment.deleteMany({ where: { attachmentId: file.id } }),
    ]) await assert.rejects(mutate);
    const otherRevision = await database.prisma.documentRevision.findFirstOrThrow({ where: { documentId: other.id } });
    await assert.rejects(database.prisma.revisionAttachment.create({ data: {
      revisionId: otherRevision.id, attachmentId: file.id, documentId: other.id,
    } }));
    await assert.rejects(database.prisma.revisionAttachment.create({ data: {
      revisionId: otherRevision.id, attachmentId: file.id, documentId: main.id,
    } }));
    await database.pool.query(`CREATE FUNCTION attachment_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Synthetic forced attachment insert failure'; END; $$`);
    await database.pool.query(`CREATE TRIGGER attachment_test_failure BEFORE INSERT ON "Attachment"
      FOR EACH ROW EXECUTE FUNCTION attachment_test_failure()`);
    try { denied(await editor.upload(main.id, 'Synthetic failed transaction.txt', textBytes), 500); }
    finally {
      await database.pool.query('DROP TRIGGER attachment_test_failure ON "Attachment"');
      await database.pool.query('DROP FUNCTION attachment_test_failure()');
    }
    assert.deepEqual(await snapshots(), before);
    assert.deepEqual(await readFile(join(storageRoot, file.id)), textBytes);
  });

  await t.test('archived documents reject uploads, retain authorized downloads and unarchive without changing history', async () => {
    const revisions = await database.prisma.documentRevision.findMany({ orderBy: { id: 'asc' } });
    const archive = await editor.send('POST', `/api/v1/documents/${main.id}/archive`, {}, { 'if-match': main.etag });
    assert.equal(archive.status, 200); main.etag = string(archive.headers.etag);
    const before = await snapshots();
    denied(await editor.upload(main.id, 'Synthetic archived.txt', textBytes), 409);
    assert.deepEqual(await snapshots(), before);
    const download = await reader.send('GET', file.url); assert.equal(download.status, 200); assert.deepEqual(download.bytes, textBytes);
    denied(await outsider.send('GET', file.url), 404);
    const unarchive = await editor.send('POST', `/api/v1/documents/${main.id}/unarchive`, {}, { 'if-match': main.etag });
    assert.equal(unarchive.status, 200); main.etag = string(unarchive.headers.etag);
    assert.deepEqual(await database.prisma.documentRevision.findMany({ orderBy: { id: 'asc' } }), revisions);
  });

  await t.test('upload rechecks membership under locks, and HTTP revocation blocks existing sessions without changing private bytes', async () => {
    const before = await snapshots();
    const racingAttachments = createAttachments(database.prisma, core.identity, { ...core.spaces,
      async authorize(...args: Parameters<typeof core.spaces.authorize>) {
        const actor = await core.spaces.authorize(...args);
        await database.prisma.spaceMembership.deleteMany({ where: { spaceId, userId: editorUser.id } });
        return actor;
      },
    }, storageRoot);
    await assert.rejects(racingAttachments.upload(editor.headers, main.id, 'Synthetic revoked during upload.txt', textBytes),
      (error: unknown) => error instanceof HttpProblem && error.status === 404);
    assert.deepEqual(await snapshots(), before);
    await grant(editorUser.id, 'editor');
    const cookie = editor.headers.get('cookie');
    const revoked = await admin.send('DELETE', `/api/v1/spaces/${spaceId}/members/${editorUser.id}`, undefined, { 'if-match': spaceEtag });
    assert.equal(revoked.status, 200); spaceEtag = string(revoked.headers.etag);
    denied(await editor.send('GET', file.url), 404);
    denied(await editor.upload(main.id, 'Synthetic revoked.txt', textBytes), 404);
    assert.equal((await editor.send('GET', '/api/v1/me')).status, 200);
    assert.equal(editor.headers.get('cookie'), cookie);
    assert.deepEqual((await reader.send('GET', file.url)).bytes, textBytes);
    const revokedReader = await admin.send('DELETE', `/api/v1/spaces/${spaceId}/members/${readerUser.id}`, undefined, { 'if-match': spaceEtag });
    assert.equal(revokedReader.status, 200);
    denied(await reader.send('GET', image.url), 404);
    assert.deepEqual(await snapshots(), before);
  });
});
