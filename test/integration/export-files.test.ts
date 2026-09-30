// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import JSZip from 'jszip';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { buildApp } from '../../src/app.js';
import { readConfig } from '../../src/config.js';
import { createDatabase } from '../../src/db/client.js';
import { createCore } from '../../src/core/index.js';
import { createOperator } from '../../src/core/identity/operator.js';
import { createExporting } from '../../src/capabilities/exporting/index.js';
import { HttpProblem } from '../../src/http/problems.js';
import { validateContent } from '../../src/core/documents/content.js';
import { richDemoContent } from '../../scripts/demo-content.js';

function object(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

test('authorized PDF/DOCX snapshots and private images against PostgreSQL and real HTTP sessions', async (t) => {
  const base = readConfig(process.env);
  const url = new URL(base.databaseUrl);
  assert(base.nodeEnv !== 'production' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname),
    'Integration fixtures require a local non-production database');
  const directory = await mkdtemp(join(tmpdir(), 'scrawl-export-files-'));
  const adminDatabase = createDatabase(base, () => {});
  const schema = 'scrawl_test_' + randomUUID().replaceAll('-', '');
  await adminDatabase.pool.query(`CREATE SCHEMA "${schema}"`);
  url.searchParams.set('schema', schema);
  const config = { ...base, databaseUrl: url.href, attachmentStorageDir: join(directory, 'private') };
  const database = createDatabase(config, () => {});
  const identity = { origin: 'http://127.0.0.1:3000', secret: randomBytes(32).toString('hex'), secureCookies: false };
  const core = createCore(database.prisma, identity, { attachmentStorageDir: config.attachmentStorageDir });
  const exporting = createExporting(core.documents, core.attachments, { origin: identity.origin });
  const operator = createOperator(database.prisma, identity);
  const app = await buildApp({ config, core, exporting, checkDatabase: () => database.ping(), logging: false });
  t.after(async () => {
    await app.close();
    await database.close();
    await adminDatabase.pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await adminDatabase.close();
    await rm(directory, { recursive: true, force: true });
  });
  const migration = spawnSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: config.databaseUrl }, encoding: 'utf8',
  });
  assert.equal(migration.status, 0, 'The reviewed migration history must deploy into a fresh isolated schema');
  const address = await app.listen({ host: '127.0.0.1', port: 0 });

  function client(peer: string) {
    let cookie = '';
    return {
      get cookie() { return cookie; },
      async send(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
        const payload = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
        return new Promise<{ status: number; bytes: Buffer; data: unknown; headers: IncomingHttpHeaders }>((resolve, reject) => {
          const request = httpRequest(new URL(path, address), { method, localAddress: peer, headers: {
            origin: identity.origin, ...(cookie ? { cookie } : {}),
            ...(payload ? { 'content-type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json',
              'content-length': String(payload.length) } : {}), ...headers,
          } }, response => {
            const chunks: Buffer[] = [];
            response.on('data', (chunk: Buffer) => chunks.push(chunk));
            response.on('error', reject);
            response.on('end', () => {
              if (response.headers['set-cookie']) cookie = response.headers['set-cookie'].map(value => value.split(';')[0]).join('; ');
              const bytes = Buffer.concat(chunks);
              const json = String(response.headers['content-type']).includes('json');
              resolve({ status: response.statusCode!, bytes, data: json && bytes.length ? JSON.parse(bytes.toString()) : null,
                headers: response.headers });
            });
          });
          request.on('error', reject);
          request.end(payload);
        });
      },
    };
  }

  // Passwords are generated locally and retained only for their sign-in request.
  const credentials = randomBytes(24).toString('base64url');
  const users = [
    await operator.bootstrap({ email: 'file-owner@example.test', name: 'File Owner', password: credentials }),
    await operator.provision({ email: 'file-editor@example.test', name: 'File Editor', password: credentials }),
    await operator.provision({ email: 'file-reader@example.test', name: 'File Reader', password: credentials }),
    await operator.provision({ email: 'file-outsider@example.test', name: 'File Outsider', password: credentials }),
  ] as const;
  const owner = client('127.0.0.71');
  const editor = client('127.0.0.72');
  const reader = client('127.0.0.73');
  const outsider = client('127.0.0.74');
  const anonymous = client('127.0.0.75');
  for (const [index, actor] of [owner, editor, reader, outsider].entries()) {
    assert.equal((await actor.send('POST', '/api/auth/sign-in/email', { email: users[index]!.email, password: credentials })).status, 200);
  }
  const createdSpace = await owner.send('POST', '/api/v1/spaces', { name: 'Synthetic rendered exports' });
  assert.equal(createdSpace.status, 201);
  const spaceId = object(createdSpace.data).id;
  assert(typeof spaceId === 'string');
  let spaceEtag = String(createdSpace.headers.etag);
  for (const [user, role] of [[users[1]!, 'editor'], [users[2]!, 'reader']] as const) {
    const granted = await owner.send('PUT', `/api/v1/spaces/${spaceId}/members/${user.id}`, { role }, { 'if-match': spaceEtag });
    assert.equal(granted.status, 200);
    spaceEtag = String(granted.headers.etag);
  }
  const created = await editor.send('POST', `/api/v1/spaces/${spaceId}/documents`, {
    title: 'Synthetic historical file title', content: richDemoContent(['Historical rendered body']),
  });
  assert.equal(created.status, 201);
  const documentId = object(created.data).id;
  const firstRevisionId = object(object(created.data).revision).id;
  assert(typeof documentId === 'string' && typeof firstRevisionId === 'string');
  const path = `/api/v1/documents/${documentId}`;
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgaGD4DwAChAGA+gVWHQAAAABJRU5ErkJggg==', 'base64');
  const imageUpload = await editor.send('POST', `${path}/attachments`, png, { 'x-file-name': 'synthetic.png' });
  assert.equal(imageUpload.status, 201);
  const imageUrl = object(imageUpload.data).url;
  assert(typeof imageUrl === 'string');
  const fileUpload = await editor.send('POST', `${path}/attachments`, Buffer.from('Synthetic private file contents'), { 'x-file-name': 'synthetic.txt' });
  assert.equal(fileUpload.status, 201);
  const fileUrl = object(fileUpload.data).url;
  assert(typeof fileUrl === 'string');
  const currentContent = validateContent({ ...richDemoContent(['Current rendered body']), document: [
    ...richDemoContent(['Current rendered body']).document,
    { id: 'stored-private-image', type: 'image', props: { url: imageUrl, name: 'Private image', caption: 'Stored private image caption' } },
    { id: 'stored-private-file', type: 'file', props: { url: fileUrl, name: 'Private text file', caption: 'Stored private file caption' } },
  ] }).content;
  const saved = await editor.send('PATCH', path, { title: 'Synthetic current file title', content: currentContent },
    { 'if-match': String(created.headers.etag) });
  assert.equal(saved.status, 200);
  let etag = String(saved.headers.etag);
  const other = await owner.send('POST', `/api/v1/spaces/${spaceId}/documents`, {
    title: 'Synthetic unrelated document', content: richDemoContent(['Unrelated content']),
  });
  assert.equal(other.status, 201);
  const otherRevisionId = object(object(other.data).revision).id;
  assert(typeof otherRevisionId === 'string');
  const revisionCount = () => database.prisma.documentRevision.count({ where: { documentId } });

  async function textFrom(response: Awaited<ReturnType<typeof owner.send>>, format: 'pdf' | 'docx') {
    assert.equal(response.status, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers.etag, undefined);
    assert(String(response.headers['content-disposition']).includes(`scrawl-document-${documentId}-revision-`));
    if (format === 'docx') {
      assert.equal(response.headers['content-type'], 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      const zip = await JSZip.loadAsync(response.bytes);
      const body = await zip.file('word/document.xml')!.async('text');
      const metadata = await zip.file('docProps/core.xml')!.async('text');
      for (const secret of [credentials, identity.secret, owner.cookie, editor.cookie, reader.cookie, outsider.cookie,
        ...users.map(user => user.email), 'File Owner', 'File Editor', 'File Reader', 'File Outsider']) {
        assert(!body.includes(secret) && !metadata.includes(secret));
      }
      return body;
    }
    assert.equal(response.headers['content-type'], 'application/pdf');
    const loading = getDocument({ data: new Uint8Array(response.bytes), useSystemFonts: false });
    const pdf = await loading.promise;
    try {
      let text = '';
      for (let page = 1; page <= pdf.numPages; page++) {
        text += (await (await pdf.getPage(page)).getTextContent()).items.map(item => 'str' in item ? item.str : '').join(' ') + ' ';
      }
      const metadata = await pdf.getMetadata();
      const serialized = text + JSON.stringify(metadata.info);
      for (const secret of [credentials, identity.secret, owner.cookie, editor.cookie, reader.cookie, outsider.cookie,
        ...users.map(user => user.email), 'File Owner', 'File Editor', 'File Reader', 'File Outsider']) assert(!serialized.includes(secret));
      return text;
    } finally { await loading.destroy(); }
  }

  function denied(response: Awaited<ReturnType<typeof owner.send>>, status: number) {
    assert.equal(response.status, status);
    assert.equal(object(response.data).status, status);
    assert.equal(response.headers['content-disposition'], undefined);
    assert.equal(response.headers.etag, undefined);
    assert(!response.bytes.toString().includes('Synthetic'));
    assert(!response.bytes.toString().includes('rendered body'));
  }

  await t.test('administrator, editor and reader export the current snapshot and selected immutable history', async () => {
    for (const format of ['pdf', 'docx'] as const) {
      for (const actor of [owner, editor, reader]) {
        const text = await textFrom(await actor.send('GET', `${path}/exports/${format}`), format);
        for (const expected of ['Synthetic current file title', 'Current rendered body', 'Rich blocks', 'Nested review notes',
          'Stored private image caption', 'Stored private file caption']) assert(text.includes(expected));
        assert(!text.includes('Historical rendered body'));
      }
      const old = await textFrom(await reader.send('GET', `${path}/exports/${format}?revisionId=${firstRevisionId}`), format);
      assert(old.includes('Synthetic historical file title'));
      assert(old.includes('Historical rendered body'));
      assert(!old.includes('Current rendered body') && !old.includes('Stored private image caption'));
    }
    assert.equal(await revisionCount(), 2, 'Exports create no content revision');
    assert.deepEqual(validateContent(object(object((await reader.send('GET', path)).data).revision).content).content, currentContent);
  });

  await t.test('unauthorized discovery, cross-document revisions and malformed selections produce no download', async () => {
    for (const format of ['pdf', 'docx'] as const) {
      denied(await anonymous.send('GET', `${path}/exports/${format}`), 401);
      denied(await outsider.send('GET', `${path}/exports/${format}`), 404);
      denied(await reader.send('GET', `${path}/exports/${format}?revisionId=${otherRevisionId}`), 404);
      denied(await reader.send('GET', `${path}/exports/${format}?revisionId=invalid`), 400);
      denied(await reader.send('GET', `${path}/exports/${format}?includeHistory=true`), 400);
      await assert.rejects(exporting.download(new Headers({ cookie: outsider.cookie }), documentId, format),
        (error: unknown) => error instanceof HttpProblem && error.status === 404);
    }
    denied(await outsider.send('GET', imageUrl), 404);
    assert.equal(await revisionCount(), 2);
  });

  await t.test('archive/unarchive preserves downloadable snapshots and attachment history', async () => {
    const archived = await editor.send('POST', `${path}/archive`, {}, { 'if-match': etag });
    assert.equal(archived.status, 200);
    for (const format of ['pdf', 'docx'] as const) assert((await textFrom(await reader.send('GET', `${path}/exports/${format}`), format)).includes('Current rendered body'));
    const restored = await editor.send('POST', `${path}/unarchive`, {}, { 'if-match': String(archived.headers.etag) });
    assert.equal(restored.status, 200);
    etag = String(restored.headers.etag);
    assert.equal(await revisionCount(), 2);
    const image = await reader.send('GET', imageUrl);
    assert.equal(image.status, 200);
    assert.deepEqual(image.bytes, png);
  });

  await t.test('existing sessions lose file exports immediately after membership revocation or account recovery', async () => {
    const cookie = reader.cookie;
    const revoked = await owner.send('DELETE', `/api/v1/spaces/${spaceId}/members/${users[2]!.id}`, undefined,
      { 'if-match': spaceEtag });
    assert.equal(revoked.status, 200);
    assert.equal((await reader.send('GET', '/api/v1/me')).status, 200);
    assert.equal(reader.cookie, cookie);
    for (const format of ['pdf', 'docx'] as const) denied(await reader.send('GET', `${path}/exports/${format}`), 404);
    denied(await reader.send('GET', imageUrl), 404);
    await operator.recover(users[1]!.email, randomBytes(24).toString('base64url'));
    for (const format of ['pdf', 'docx'] as const) denied(await editor.send('GET', `${path}/exports/${format}`), 401);
    assert.equal(await revisionCount(), 2);
    assert((await textFrom(await owner.send('GET', `${path}/exports/pdf`), 'pdf')).includes('Current rendered body'));
  });
});
