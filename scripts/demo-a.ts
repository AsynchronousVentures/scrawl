// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import { request as httpRequest } from 'node:http';
import { isDeepStrictEqual } from 'node:util';
import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { validateContent } from '../src/core/documents/content.js';
import { readDemoConfig, readDemoCredentials, readPrivateDemoEnvironment } from './demo-config.js';

let stage = 'configuration';
let checks = 0;
function check(condition: boolean, label: string): asserts condition {
  if (!condition) throw new Error(label);
  checks++;
}
function same(actual: unknown, expected: unknown, label: string) {
  check(isDeepStrictEqual(actual, expected), label);
}
function record(value: unknown): Record<string, unknown> {
  check(value !== null && typeof value === 'object' && !Array.isArray(value), 'Expected an object');
  return value as Record<string, unknown>;
}
function uuid(value: unknown): string {
  check(typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value), 'Expected a UUID');
  return value;
}
function snapshot(value: unknown) {
  const document = record(value);
  return { document, revision: record(document.revision), id: uuid(document.id) };
}
function content(lines: string[]) {
  return validateContent({ format: 'prosemirror-json', schemaVersion: 1, document: {
    type: 'doc', content: lines.map(text => ({ type: 'paragraph', content: [{ type: 'text', text }] })),
  } }).content;
}

function client(origin: string, peer: string) {
  // Each real socket client has its own cookie jar. Nothing is persisted or printed.
  const cookies = new Map<string, string>();
  return {
    secrets: () => [...cookies.values()],
    async request(method: string, path: string, body?: unknown, etag?: string) {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      return new Promise<{ status: number; data: unknown; etag: string | undefined }>((resolve, reject) => {
        const request = httpRequest(new URL(path, origin), {
          method, localAddress: peer,
          headers: {
            origin,
            ...(cookies.size ? { cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; ') } : {}),
            ...(payload ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) } : {}),
            ...(etag ? { 'if-match': etag } : {}),
          },
        }, response => {
          for (const cookie of response.headers['set-cookie'] ?? []) {
            const first = cookie.split(';')[0] ?? '';
            const separator = first.indexOf('=');
            if (separator < 1) continue;
            const name = first.slice(0, separator);
            const value = first.slice(separator + 1);
            if (value) cookies.set(name, value); else cookies.delete(name);
          }
          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > 2 * 1024 * 1024) request.destroy(new Error('Demo response too large'));
            else chunks.push(chunk);
          });
          response.on('error', reject);
          response.on('end', () => {
            try {
              const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              resolve({ status: response.statusCode ?? 0, data, etag: response.headers.etag });
            } catch { reject(new Error('Demo response was not JSON')); }
          });
        });
        request.setTimeout(15_000, () => request.destroy(new Error('Demo request timed out')));
        request.on('error', reject);
        request.end(payload);
      });
    },
  };
}

type Client = ReturnType<typeof client>;
async function expect(actor: Client, method: string, path: string, status: number, body?: unknown, etag?: string) {
  const response = await actor.request(method, path, body, etag);
  check(response.status === status, 'Unexpected HTTP status');
  return response;
}
function version(response: Awaited<ReturnType<Client['request']>>) {
  check(typeof response.etag === 'string' && /^"(?:doc|space)-[0-9a-f-]+-v[1-9][0-9]*"$/i.test(response.etag), 'Missing server ETag');
  return response.etag;
}
async function history(actor: Client, path: string) {
  const body = record((await expect(actor, 'GET', path + '/revisions', 200)).data);
  check(Array.isArray(body.items) && body.nextCursor === null, 'Unexpected bounded demo history');
  return body.items;
}
function hidden(response: Awaited<ReturnType<Client['request']>>) {
  check(response.etag === undefined, 'Denied response disclosed an ETag');
  same(Object.keys(record(response.data)).sort(), ['code', 'requestId', 'status', 'title', 'type'], 'Denied response disclosed resource fields');
  const serialized = JSON.stringify(response.data);
  check(!serialized.includes('Release checklist') && !serialized.includes('Run tests before deploying.')
    && !serialized.includes('currentRevisionNumber') && !serialized.includes('lockVersion'), 'Denied response disclosed document data');
}

async function writeArtifact(name: 'export' | 'result', value: unknown) {
  await mkdir('artifacts/demo', { recursive: true, mode: 0o700 });
  // Fixed synthetic artifact names; refuse symlinks and never accept an output target from input.
  const file = await open(`artifacts/demo/${name}.json`, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.()) throw new Error('Unsafe artifact target');
    await file.chmod(0o600);
    await file.truncate(0);
    await file.writeFile(JSON.stringify(value, null, 2) + '\n');
  } finally { await file.close(); }
}

async function main() {
  check(process.argv.length === 2, 'Demo A does not accept credential or target flags');
  const { identity } = readDemoConfig(await readPrivateDemoEnvironment());
  const credentials = await readDemoCredentials();
  const admin = client(identity.origin, '127.0.0.61');
  const editor = client(identity.origin, '127.0.0.62');
  const otherEditor = client(identity.origin, '127.0.0.63');
  const reader = client(identity.origin, '127.0.0.64');
  const outsider = client(identity.origin, '127.0.0.65');
  const anonymous = client(identity.origin, '127.0.0.66');

  stage = 'authentication';
  await expect(anonymous, 'GET', '/health/ready', 200);
  hidden(await expect(anonymous, 'GET', '/api/v1/me', 401));
  for (const [actor, role] of [[admin, 'administrator'], [editor, 'editor'], [otherEditor, 'editor'],
    [reader, 'reader'], [outsider, 'outsider']] as const) {
    const account = credentials.accounts[role];
    await expect(actor, 'POST', '/api/auth/sign-in/email', 200, { email: account.email, password: account.password });
    const me = record((await expect(actor, 'GET', '/api/v1/me', 200)).data);
    check(me.id === account.id && me.role === (role === 'administrator' ? 'administrator' : 'member'), 'Incorrect authenticated identity');
    check(actor.secrets().length > 0, 'Authentication did not issue a cookie');
  }
  check(!isDeepStrictEqual(editor.secrets(), otherEditor.secrets()), 'Editor sessions are not isolated');

  stage = 'space setup';
  const createdSpace = await expect(admin, 'POST', '/api/v1/spaces', 201, { name: 'Demo Handbook' });
  const spaceId = uuid(record(createdSpace.data).id);
  const spacePath = `/api/v1/spaces/${spaceId}`;
  let spaceTag = version(createdSpace);
  for (const role of ['editor', 'reader'] as const) {
    const grant = await expect(admin, 'PUT', `${spacePath}/members/${credentials.accounts[role].id}`, 200, { role }, spaceTag);
    spaceTag = version(grant);
  }
  hidden(await expect(outsider, 'GET', spacePath, 404));
  const outsiderSpaces = record((await expect(outsider, 'GET', '/api/v1/spaces', 200)).data);
  same(outsiderSpaces.items, [], 'Outsider discovered a space');
  hidden(await expect(reader, 'PUT', `${spacePath}/members/${credentials.accounts.outsider.id}`, 404, { role: 'editor' }, spaceTag));

  stage = 'document create';
  const initialContent = content(['Run tests before deploying.']);
  const created = await expect(editor, 'POST', spacePath + '/documents', 201, { title: 'Release checklist', content: initialContent });
  const initial = snapshot(created.data);
  const documentId = initial.id;
  const path = `/api/v1/documents/${documentId}`;
  const firstRevisionId = uuid(initial.revision.id);
  check(initial.document.currentRevisionNumber === 1 && initial.revision.revisionNumber === 1, 'Initial revision missing');
  check(initial.document.createdBy === credentials.accounts.editor.id && initial.revision.authorId === credentials.accounts.editor.id, 'Creator was not derived from the editor');
  same(initial.revision.content, initialContent, 'Initial content mismatch');
  check((await history(reader, path)).length === 1, 'Unexpected initial history');
  const firstRead = await expect(editor, 'GET', path, 200);
  const secondRead = await expect(otherEditor, 'GET', path, 200);
  const startingTag = version(firstRead);
  same(secondRead.data, firstRead.data, 'Isolated clients read different starting snapshots');
  check(version(secondRead) === startingTag, 'Isolated clients read different ETags');

  stage = 'stale save';
  const secondContent = content(['Run tests before deploying.', 'Verify the backup.']);
  const saved = await expect(editor, 'PATCH', path, 200, { content: secondContent }, startingTag);
  const second = snapshot(saved.data);
  let tag = version(saved);
  check(second.document.currentRevisionNumber === 2 && second.revision.revisionNumber === 2, 'Save did not append revision 2');
  same(second.revision.content, secondContent, 'Saved content mismatch');
  const beforeRejected = await history(reader, path);
  check(beforeRejected.length === 2, 'Save did not add exactly one revision');
  hidden(await expect(otherEditor, 'PATCH', path, 412, { content: content(['Stale edit must not commit.']) }, startingTag));
  same(await history(reader, path), beforeRejected, 'Stale save changed history');
  same((await expect(reader, 'GET', path, 200)).data, saved.data, 'Stale save changed the head');

  stage = 'missing precondition';
  hidden(await expect(editor, 'PATCH', path, 428, { title: 'Missing precondition must not commit' }));
  same(await history(reader, path), beforeRejected, 'Missing precondition changed history');
  same((await expect(reader, 'GET', path, 200)).data, saved.data, 'Missing precondition changed the head');

  stage = 'reader denial';
  for (const [suffix, method, body] of [
    ['', 'PATCH', { title: 'Reader must not edit' }],
    ['/restore', 'POST', { revisionId: firstRevisionId }],
    ['/archive', 'POST', {}], ['/unarchive', 'POST', {}],
  ] as const) hidden(await expect(reader, method, path + suffix, 404, body, tag));
  same(await history(reader, path), beforeRejected, 'Reader denial changed history');
  same((await expect(reader, 'GET', path, 200)).data, saved.data, 'Reader denial changed the head');

  stage = 'outsider denial';
  for (const target of [spacePath + '/documents', path, path + '/revisions', path + '/revisions/' + firstRevisionId]) {
    hidden(await expect(outsider, 'GET', target, 404));
    hidden(await expect(anonymous, 'GET', target, 401));
  }
  hidden(await expect(outsider, 'PATCH', path, 404, { title: 'Outsider must not edit' }, tag));
  same(await history(reader, path), beforeRejected, 'Outsider denial changed history');

  stage = 'restore';
  const restored = await expect(editor, 'POST', path + '/restore', 200, { revisionId: firstRevisionId }, tag);
  const selected = snapshot(restored.data);
  tag = version(restored);
  check(selected.document.currentRevisionNumber === 3 && selected.revision.revisionNumber === 3
    && selected.revision.id !== firstRevisionId, 'Restore rewrote history');
  same(selected.revision.content, initialContent, 'Restore content mismatch');
  const restoredHistory = await history(reader, path);
  check(restoredHistory.length === 3, 'Restore did not append exactly one revision');
  same(restoredHistory.slice(1), beforeRejected, 'Restore changed existing revision metadata');
  same(record((await expect(reader, 'GET', path + '/revisions/' + firstRevisionId, 200)).data).content, initialContent, 'Original history changed');
  same(record((await expect(reader, 'GET', path + '/revisions/' + uuid(second.revision.id), 200)).data).content, secondContent, 'Intervening history changed');

  stage = 'native export';
  hidden(await expect(outsider, 'GET', path + '/export', 404));
  hidden(await expect(anonymous, 'GET', path + '/export', 401));
  const exported = record((await expect(reader, 'GET', path + '/export', 200)).data);
  same(Object.keys(exported).sort(), ['content', 'document', 'exportVersion', 'format', 'revision'], 'Export field scope changed');
  check(exported.format === 'scrawl-document' && exported.exportVersion === 1, 'Export format mismatch');
  same(Object.keys(record(exported.document)).sort(), ['createdAt', 'createdBy', 'id', 'spaceId'], 'Export document provenance scope changed');
  same(Object.keys(record(exported.revision)).sort(), ['authorId', 'createdAt', 'id', 'revisionNumber', 'title'], 'Export revision provenance scope changed');
  const parsedExport = validateContent(exported.content);
  same(parsedExport.content, validateContent(selected.revision.content).content, 'Export does not match the selected content');
  check(parsedExport.plainText === 'Run tests before deploying.', 'Export parser text mismatch');
  same(exported.document, { id: documentId, spaceId, createdAt: selected.document.createdAt, createdBy: selected.document.createdBy }, 'Export document provenance mismatch');
  same(exported.revision, { id: selected.revision.id, revisionNumber: 3, title: selected.revision.title,
    createdAt: selected.revision.createdAt, authorId: selected.revision.authorId }, 'Export revision provenance mismatch');
  const serializedExport = JSON.stringify(exported);
  const privateValues = [identity.secret, ...Object.values(credentials.accounts).map(account => account.password),
    ...[admin, editor, otherEditor, reader, outsider].flatMap(actor => actor.secrets())];
  check(privateValues.every(value => !serializedExport.includes(value)), 'Export contains authentication/session data');

  stage = 'lifecycle';
  const archived = await expect(editor, 'POST', path + '/archive', 200, {}, tag);
  const archivedSnapshot = snapshot(archived.data);
  const archivedTag = version(archived);
  check(archivedSnapshot.document.archivedAt !== null && archivedSnapshot.document.currentRevisionNumber === 3
    && archivedSnapshot.document.lockVersion === Number(selected.document.lockVersion) + 1, 'Archive changed content history');
  same(archivedSnapshot.revision, selected.revision, 'Archive changed current content');
  same(await history(reader, path), restoredHistory, 'Archive changed history');
  hidden(await expect(reader, 'POST', path + '/unarchive', 404, {}, archivedTag));
  const activeList = record((await expect(reader, 'GET', spacePath + '/documents', 200)).data);
  same(activeList.items, [], 'Archived document remained in the default list');
  const unarchived = await expect(admin, 'POST', path + '/unarchive', 200, {}, archivedTag);
  const unarchivedSnapshot = snapshot(unarchived.data);
  tag = version(unarchived);
  check(unarchivedSnapshot.document.archivedAt === null && unarchivedSnapshot.document.archivedBy === null
    && unarchivedSnapshot.document.currentRevisionNumber === 3
    && unarchivedSnapshot.document.lockVersion === Number(selected.document.lockVersion) + 2, 'Unarchive changed content history');
  same(unarchivedSnapshot.revision, selected.revision, 'Unarchive changed current content');
  same(await history(reader, path), restoredHistory, 'Unarchive changed history');

  stage = 'membership revocation';
  const oldCookies = editor.secrets();
  await expect(admin, 'DELETE', `${spacePath}/members/${credentials.accounts.editor.id}`, 200, undefined, spaceTag);
  for (const target of [path, path + '/revisions', path + '/revisions/' + firstRevisionId, path + '/export', spacePath + '/documents']) {
    hidden(await expect(editor, 'GET', target, 404));
  }
  hidden(await expect(editor, 'PATCH', path, 404, { title: 'Revoked session must not write' }, tag));
  hidden(await expect(otherEditor, 'GET', path, 404));
  check(!isDeepStrictEqual(oldCookies, []) && isDeepStrictEqual(editor.secrets(), oldCookies), 'Revocation replaced the authenticated cookie');
  await expect(editor, 'GET', '/api/v1/me', 200);
  same(await history(reader, path), restoredHistory, 'Revoked write changed history');
  same((await expect(reader, 'GET', path, 200)).data, unarchived.data, 'Revoked write changed the head');

  stage = 'logout';
  for (const actor of [admin, editor, otherEditor, reader, outsider]) {
    await expect(actor, 'POST', '/api/auth/sign-out', 200, {});
    hidden(await expect(actor, 'GET', '/api/v1/me', 401));
  }
  stage = 'artifacts';
  await writeArtifact('export', exported);
  const result = { spaceId, documentId, revisionId: uuid(selected.revision.id), revisionNumber: 3, checks };
  await writeArtifact('result', result);
  console.log(`Demo A passed (${checks} assertions). Space ${spaceId}; document ${documentId}; revision 3. Export: artifacts/demo/export.json`);
}

main().catch(() => {
  // Assertion, parser, transport, and library errors may contain response bodies or credentials.
  console.error(`Demo A failed at ${stage}. Check the running demo API and fixture setup.`);
  process.exitCode = 1;
});
