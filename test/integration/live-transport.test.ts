// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { request } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { MessageType } from '@hocuspocus/server';
import { RESTYjsThreadStore } from '@blocknote/core/yjs';
import { DefaultThreadStoreAuth } from '@blocknote/core/comments';
import { createDecoder, readVarString, readVarUint } from 'lib0/decoding';
import { createEncoder, writeVarString, writeVarUint, writeVarUint8Array, toUint8Array } from 'lib0/encoding';
import * as Y from 'yjs';
import { readConfig } from '../../src/config.js';
import { createDatabase } from '../../src/db/client.js';
import { claimLiveOwner } from '../../src/db/live-owner.js';
import { createCore } from '../../src/core/index.js';
import { createOperator } from '../../src/core/identity/operator.js';
import { createCollaboration } from '../../src/capabilities/collaboration/index.js';
import { documentEtag } from '../../src/core/documents/index.js';
import { spaceEtag } from '../../src/core/spaces/index.js';
import { readLiveState } from '../../src/core/live/content.js';
import { HttpProblem } from '../../src/http/problems.js';
import { demoContent, richDemoContent } from '../../scripts/demo-content.js';
import { buildApp } from '../../src/app.js';

async function until(predicate: () => boolean | Promise<boolean>, description: string) {
  for (let i = 0; i < 200; i++) { if (await predicate()) return; await delay(25); }
  assert.fail(description);
}
function title(document: Y.Doc) { const value = document.getMap('metadata').get('title'); assert(value instanceof Y.Text); return value; }
function nativeText(document: Y.Doc, containing: string) {
  const pending = [...document.getXmlFragment('document').toArray()];
  while (pending.length) {
    const node = pending.shift()!;
    if (node instanceof Y.XmlText) { if (node.toString().includes(containing)) return node; }
    else { assert(node instanceof Y.XmlElement); pending.unshift(...node.toArray()); }
  }
  throw new Error('Expected synthetic native text');
}

test('prepared same-origin live transport commits before actual socket delivery and uses real cookie sessions', { timeout: 60_000 }, async t => {
  const base = readConfig(process.env), url = new URL(base.databaseUrl);
  assert(base.nodeEnv !== 'production' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  const adminDb = createDatabase(base, () => {}), schema = 'scrawl_test_transport_' + randomUUID().replaceAll('-', '');
  await adminDb.pool.query(`CREATE SCHEMA "${schema}"`); url.searchParams.set('schema', schema);
  const config = { ...base, databaseUrl: url.href }, database = createDatabase(config, () => {});
  const identityConfig = { origin: 'http://127.0.0.1:3000', secret: randomBytes(32).toString('hex'), secureCookies: false };
  const core = createCore(database.prisma, identityConfig), operator = createOperator(database.prisma, identityConfig);
  const migrated = spawnSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], { env: { ...process.env, DATABASE_URL: config.databaseUrl } });
  assert.equal(migrated.status, 0);
  let lease = await claimLiveOwner(database.pool);
  let transport = createCollaboration(core, lease, identityConfig.origin);
  const app = await buildApp({ config, core, collaboration: transport, logging: false, checkDatabase: () => database.ping() });
  transport.attach(app.server);
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const socketUrl = address.replace('http:', 'ws:') + '/api/v1/live';
  type LiveMetadata = { type: 'live-state'; epoch: string; sequence: string; documentEtag: string; canWrite: boolean };
  const clients: { provider: HocuspocusProvider; websocket: HocuspocusProviderWebsocket; document: Y.Doc; frames: number[]; metadata: LiveMetadata[]; socket: WebSocket | undefined; socketCount: number }[] = [];
  t.after(async () => {
    for (const client of clients) { client.provider.destroy(); client.websocket.destroy(); client.document.destroy(); }
    await transport.close(app.server); await lease.close(); await app.close(); await database.close();
    await adminDb.pool.query(`DROP SCHEMA "${schema}" CASCADE`); await adminDb.close();
  });
  const password = randomBytes(24).toString('base64url');
  const administrator = await operator.bootstrap({ email: 'owner@example.test', name: 'Owner', password });
  const editorUser = await operator.provision({ email: 'editor@example.test', name: 'Editor', password });
  const peerUser = await operator.provision({ email: 'peer@example.test', name: 'Peer', password });
  const readerUser = await operator.provision({ email: 'reader@example.test', name: 'Reader', password });
  const outsiderUser = await operator.provision({ email: 'outsider@example.test', name: 'Outsider', password });
  async function login(email: string, localAddress: string) {
    const body = JSON.stringify({ email, password });
    return new Promise<Headers>((resolve, reject) => {
      const req = request(new URL('/api/auth/sign-in/email', address), { method: 'POST', localAddress,
        headers: { origin: identityConfig.origin, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) } }, response => {
        response.resume(); response.on('end', () => {
          try { assert.equal(response.statusCode, 200); assert(response.headers['set-cookie']);
            resolve(new Headers({ origin: identityConfig.origin, cookie: response.headers['set-cookie'].map(cookie => cookie.split(';')[0]).join('; ') }));
          } catch (error) { reject(error); }
        }); response.on('error', reject);
      }); req.on('error', reject); req.end(body);
    });
  }
  const admin = await login(administrator.email, '127.0.0.31'), editor = await login(editorUser.email, '127.0.0.32');
  const peer = await login(peerUser.email, '127.0.0.33'), reader = await login(readerUser.email, '127.0.0.34');
  const outsider = await login(outsiderUser.email, '127.0.0.35');
  let space = await core.spaces.create(admin, 'Synthetic socket handbook');
  for (const [user, role] of [[editorUser, 'editor'], [peerUser, 'editor'], [readerUser, 'reader']] as const) {
    space = await core.spaces.changeMembership(admin, { spaceId: space.id, userId: user.id, role, expectedEtag: spaceEtag(space) });
  }
  const saved = await core.documents.create(editor, space.id, { title: 'Initial socket handbook', content: richDemoContent(['Private synthetic socket body']) });
  let room = await core.documents.live.enroll(editor, saved.id, documentEtag(saved));
  const name = () => `${saved.id}:${room.epoch}`;
  const writeIsPaused = async () => (await database.pool.query<{ waiting: boolean }>(`SELECT EXISTS(
    SELECT 1 FROM pg_stat_activity activity JOIN pg_locks lock ON lock.pid=activity.pid
    WHERE activity.wait_event='advisory' AND lock.relation=$1::regclass
      AND activity.query LIKE '%DocumentLive%' AND activity.pid<>pg_backend_pid()) AS waiting`,
  [`"${schema}"."DocumentLive"`])).rows[0]!.waiting;

  async function connect(headers: Headers, documentName = name(), presence = false) {
    const document = new Y.Doc({ gc: false }), frames: number[] = [], metadata: LiveMetadata[] = [];
    document.getXmlFragment('document'); document.getMap('metadata'); document.getMap('threads');
    let socket: WebSocket | undefined, socketCount = 0;
    class SessionSocket extends WebSocket {
      constructor(url: string) {
        super(url, { headers: { origin: identityConfig.origin, cookie: headers.get('cookie') ?? '' } }); socket = this; socketCount++;
        this.on('message', data => {
          const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : Array.isArray(data) ? Buffer.concat(data) : data;
          const decoder = createDecoder(bytes); readVarString(decoder); const type = readVarUint(decoder); frames.push(type);
          if (type === 5) {
            const state: unknown = JSON.parse(readVarString(decoder));
            assert(state && typeof state === 'object' && 'type' in state && state.type === 'live-state'
              && 'epoch' in state && typeof state.epoch === 'string' && 'sequence' in state && typeof state.sequence === 'string'
              && 'documentEtag' in state && typeof state.documentEtag === 'string' && 'canWrite' in state && typeof state.canWrite === 'boolean');
            assert.deepEqual(Object.keys(state).sort(), ['canWrite', 'documentEtag', 'epoch', 'sequence', 'type']);
            metadata.push(state as LiveMetadata);
          }
        });
      }
    }
    const websocket = new HocuspocusProviderWebsocket({ url: socketUrl, autoConnect: false, maxAttempts: 1, WebSocketPolyfill: SessionSocket,
      // The configured hook runs before the provider schedules reconnect. A
      // later event listener cannot cancel a retry that is already scheduled.
      onClose: () => websocket.disconnect(),
    });
    const provider = new HocuspocusProvider({ websocketProvider: websocket, name: documentName, document,
      ...(presence ? {} : { awareness: null }) });
    provider.attach();
    const client = { provider, websocket, document, frames, metadata, get socket() { return socket; }, get socketCount() { return socketCount; } }; clients.push(client);
    await websocket.connect();
    return client;
  }
  await t.test('real HTTP enrollment and native REST comment clients preserve authorization, JSON contracts and history', async () => {
    const contract = app.swagger(); assert('openapi' in contract);
    const resolveOperation = contract.paths?.['/api/v1/documents/{id}/live/{epoch}/threads/{threadId}/resolve']?.post;
    const response = resolveOperation?.responses?.['200']; assert(response && !('$ref' in response));
    assert(response.content?.['application/json'], 'Generated OpenAPI describes the actual native JSON null response');
    const requestBody = resolveOperation?.requestBody; assert(requestBody && !('$ref' in requestBody));
    assert.equal(requestBody.required, false, 'The documented native command accepts its official bodyless request');
    const doc = await core.documents.create(editor, space.id, { title: 'Native HTTP comments', content: demoContent(['Private HTTP fixture']) });
    const path = `/api/v1/documents/${doc.id}/live`;
    async function http(headers: Headers, suffix: string, method = 'GET', body?: unknown, etag?: string) {
      const input = new Headers(headers); input.set('content-type', 'application/json');
      if (etag !== undefined) input.set('if-match', etag);
      return fetch(address + path + suffix, { method, headers: input, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    }
    assert.equal((await http(new Headers(), '')).status, 401);
    assert.equal((await http(outsider, '')).status, 404);
    assert.equal((await http(editor, '', 'POST')).status, 428);
    assert.equal((await http(new Headers({ cookie: editor.get('cookie')! }), '', 'POST', undefined, documentEtag(doc))).status, 403);
    const enrolled = await http(reader, '', 'POST', undefined, documentEtag(doc));
    assert.equal(enrolled.status, 200);
    const metadata = await enrolled.json() as { epoch: string; sequence: string; documentEtag: string; canWrite: boolean };
    assert.deepEqual(Object.keys(metadata).sort(), ['canWrite', 'documentEtag', 'documentId', 'epoch', 'schemaVersion', 'sequence']);
    assert.equal(metadata.canWrite, false); assert.equal(enrolled.headers.get('etag'), metadata.documentEtag);
    const savedHead = await fetch(address + `/api/v1/documents/${doc.id}`, { headers: editor });
    assert.equal(savedHead.status, 200);
    assert.equal((await savedHead.json()).editingMode, 'live');
    const savedList = await fetch(address + `/api/v1/spaces/${space.id}/documents`, { headers: reader });
    assert.equal(savedList.status, 200);
    assert.equal((await savedList.json()).items.find((item: { id: string }) => item.id === doc.id)?.editingMode, 'live');
    assert.equal((await http(editor, '', 'POST', undefined, documentEtag(doc))).status, 412);
    const names = await http(reader, '/users', 'POST', { userIds: [administrator.id, editorUser.id, readerUser.id, outsiderUser.id, 'unknown-user'] });
    assert.equal(names.status, 200);
    const users = await names.json() as { id: string; name: string }[];
    assert.deepEqual(users.map(user => user.id).sort(), [administrator.id, editorUser.id, readerUser.id].sort());
    assert(users.every(user => Object.keys(user).sort().join(',') === 'id,name'));
    assert.equal((await http(outsider, '/users', 'POST', { userIds: [editorUser.id] })).status, 404);
    assert.equal((await http(reader, '/users', 'POST', { userIds: Array.from({ length: 129 }, (_, index) => String(index)) })).status, 400);
    const author = await connect(editor, `${doc.id}:${metadata.epoch}`), recipient = await connect(reader, `${doc.id}:${metadata.epoch}`);
    await until(() => author.provider.isSynced && recipient.provider.isSynced, 'HTTP native clients receive initial live state');
    const store = new RESTYjsThreadStore(address + path + `/${metadata.epoch}/threads`, Object.fromEntries(editor),
      author.document.getMap('threads'), new DefaultThreadStoreAuth(editorUser.id, 'editor'));
    const comment = { body: demoContent(['Private HTTP discussion']).document };
    const thread = await store.createThread({ initialComment: comment });
    assert.equal(thread.type, 'thread'); assert.equal(thread.comments[0]!.userId, editorUser.id);
    assert.equal(thread.comments[0]!.body[0].content[0].text, 'Private HTTP discussion');
    assert(!JSON.stringify(thread).includes('session'));
    await until(() => recipient.document.getMap('threads').has(thread.id), 'Committed HTTP comment reaches authorized reader');
    const selection = { anchor: Y.createRelativePositionFromTypeIndex(nativeText(author.document, 'Private HTTP fixture'), 0),
      head: Y.createRelativePositionFromTypeIndex(nativeText(author.document, 'Private HTTP fixture'), 5) };
    const anchored = await http(editor, `/${metadata.epoch}/threads/${thread.id}/addToDocument`, 'POST', {
      selection: { prosemirror: { anchor: 0, head: 999999 }, yjs: selection },
    });
    assert.equal(anchored.status, 200); assert.equal(await anchored.json(), null);
    assert.equal((await http(reader, `/${metadata.epoch}/threads`, 'POST', { initialComment: comment })).status, 404);
    assert.equal((await http(outsider, `/${metadata.epoch}/threads`, 'POST', { initialComment: comment })).status, 404);
    assert.equal((await http(editor, `/${metadata.epoch}/threads`, 'POST', { initialComment: comment, userId: outsiderUser.id })).status, 400);
    const reply = await store.addComment({ threadId: thread.id, comment });
    assert.equal(reply.userId, editorUser.id);
    assert.equal(await store.updateComment({ threadId: thread.id, commentId: reply.id, comment }), null);
    assert.equal(await store.addReaction({ threadId: thread.id, commentId: reply.id, emoji: '👍' }), null);
    assert.equal(await store.deleteReaction({ threadId: thread.id, commentId: reply.id, emoji: '👍' }), null);
    assert.equal(await store.resolveThread({ threadId: thread.id }), null);
    assert.equal(await store.unresolveThread({ threadId: thread.id }), null);
    assert.equal(await store.deleteComment({ threadId: thread.id, commentId: reply.id, softDelete: true }), null);
    assert.equal(await store.deleteThread({ threadId: thread.id }), null);
    const missing = await http(editor, `/${metadata.epoch}/checkpoint`, 'POST', {}, metadata.documentEtag);
    assert.equal(missing.status, 428);
    const current = await http(editor, ''); assert.equal(current.status, 200);
    const latest = await current.json() as typeof metadata;
    assert.equal(latest.canWrite, true);
    const checkpoint = await http(editor, `/${metadata.epoch}/checkpoint`, 'POST', { sequence: latest.sequence }, latest.documentEtag);
    assert.equal(checkpoint.status, 200);
    const savedHttp = await checkpoint.json() as { revision: { content: unknown }; currentRevisionNumber: number };
    assert.equal(savedHttp.currentRevisionNumber, 1, 'Live-only comments do not create document revisions');
    assert.deepEqual(savedHttp.revision.content, doc.revision.content);
    assert(!Object.hasOwn(savedHttp, 'recipients')); assert(!Object.hasOwn(savedHttp, 'state'));
    assert.equal((await http(editor, `/${metadata.epoch}/checkpoint`, 'POST', { sequence: metadata.sequence }, latest.documentEtag)).status, 412);
    title(author.document).insert(title(author.document).length, ' saved over HTTP');
    await until(() => author.provider.unsyncedChanges === 0 && title(recipient.document).toString().endsWith(' saved over HTTP'), 'Native changes commit before explicit HTTP save');
    const changed = await (await http(editor, '')).json() as typeof metadata;
    const saves = await Promise.all([0, 1].map(() => http(editor, `/${metadata.epoch}/checkpoint`, 'POST', { sequence: changed.sequence }, changed.documentEtag)));
    assert.deepEqual(saves.map(response => response.status).sort(), [200, 412]);
    assert.equal(await database.prisma.documentRevision.count({ where: { documentId: doc.id } }), 2);
    assert.equal((await http(reader, `/${metadata.epoch}/checkpoint`, 'POST', { sequence: changed.sequence }, changed.documentEtag)).status, 404);
    const checkpointed = await (await http(editor, '')).json() as typeof metadata;
    await until(() => recipient.metadata.some(state => state.documentEtag === checkpointed.documentEtag), 'Accepted checkpoints send authorized metadata');
    const restored = await http(editor, `/${metadata.epoch}/restore`, 'POST', { sequence: checkpointed.sequence, revisionId: doc.revision.id }, checkpointed.documentEtag);
    assert.equal(restored.status, 200);
    const result = await restored.json() as { room: { epoch: string }; document: { currentRevisionNumber: number } };
    assert.equal(result.document.currentRevisionNumber, 3); assert.notEqual(result.room.epoch, metadata.epoch);
    assert(!Object.hasOwn(result.room, 'state'));
    await until(() => [author, recipient].every(client => client.socket?.readyState === WebSocket.CLOSED), 'HTTP restore immediately closes old-epoch sockets');
    const fresh = await connect(editor, `${doc.id}:${result.room.epoch}`);
    await until(() => fresh.provider.isSynced, 'Restored HTTP epoch starts from its immutable revision');
    assert.equal(fresh.document.getMap('threads').size, 0);
    const archiveHeaders = new Headers(admin); archiveHeaders.set('content-type', 'application/json');
    archiveHeaders.set('if-match', restored.headers.get('etag')!);
    const archived = await fetch(`${address}/api/v1/documents/${doc.id}/archive`, { method: 'POST', headers: archiveHeaders, body: '{}' });
    assert.equal(archived.status, 200);
    await until(() => fresh.socket?.readyState === WebSocket.CLOSED, 'HTTP archive closes live connections after commit');
    assert.equal((await http(reader, '')).status, 409);
    archiveHeaders.set('if-match', archived.headers.get('etag')!);
    const unarchived = await fetch(`${address}/api/v1/documents/${doc.id}/unarchive`, { method: 'POST', headers: archiveHeaders, body: '{}' });
    assert.equal(unarchived.status, 200);
    assert.equal(await database.prisma.documentRevision.count({ where: { documentId: doc.id } }), 3);
    assert.equal((await (await http(reader, '')).json() as typeof metadata).epoch, result.room.epoch);
    space = await core.spaces.changeMembership(admin, { spaceId: space.id, userId: readerUser.id, role: null, expectedEtag: spaceEtag(space) });
    try {
      const revokedNames = await http(editor, '/users', 'POST', { userIds: [readerUser.id, editorUser.id] });
      assert.equal(revokedNames.status, 200);
      assert.deepEqual((await revokedNames.json() as { id: string }[]).map(user => user.id), [editorUser.id]);
      assert.equal((await http(reader, '/users', 'POST', { userIds: [editorUser.id] })).status, 404);
    } finally {
      space = await core.spaces.changeMembership(admin, { spaceId: space.id, userId: readerUser.id, role: 'reader', expectedEtag: spaceEtag(space) });
    }
    fresh.provider.destroy(); fresh.websocket.destroy();
  });
  const writer = await connect(editor), viewer = await connect(reader);
  let observer = await connect(peer);
  await until(() => [writer, observer, viewer].every(client => client.provider.isSynced && client.provider.unsyncedChanges === 0), 'All roles synchronize the initial durable state');
  await t.test('initial sync is identical, outsiders get no document bytes, and anonymous/wrong-origin upgrades fail', async () => {
    await until(() => [writer, observer, viewer].every(client => client.metadata.length > 0), 'Genuine peers receive initial authorized metadata');
    assert([writer, observer, viewer].every(client => client.frames.includes(0) && client.frames.includes(5)));
    assert.equal(title(viewer.document).toString(), saved.revision.title);
    assert.deepEqual(readLiveState(Y.encodeStateAsUpdate(viewer.document)).content, saved.revision.content);
    const denied = await connect(outsider);
    await until(() => denied.socket?.readyState === WebSocket.CLOSED, 'Outsider socket closes');
    assert(!denied.provider.isSynced); assert.equal(denied.document.getXmlFragment('document').length, 0);
    assert(!denied.frames.includes(0));
    assert.equal(denied.metadata.length, 0);
    for (const headers of [{ origin: identityConfig.origin }, { origin: 'https://foreign.example.test', cookie: editor.get('cookie')! }]) {
      const ws = new WebSocket(socketUrl, { headers });
      const status = await new Promise<number>(resolve => { ws.on('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode!); ws.terminate(); }); ws.on('error', () => {}); });
      assert.equal(status, 403);
    }
  });
  await t.test('failed initial room loading releases its unpublished document and a fresh connection reads durable state', async () => {
    const freshDocument = await core.documents.create(editor, space.id, { title: 'Synthetic failed-load document', content: richDemoContent(['Synthetic load fixture']) });
    const freshRoom = await core.documents.live.enroll(editor, freshDocument.id, documentEtag(freshDocument));
    const freshName = `${freshDocument.id}:${freshRoom.epoch}`, original = core.documents.live.read;
    let reads = 0;
    core.documents.live.read = async (...args: Parameters<typeof original>) => {
      const result = await original(...args);
      if (++reads === 2) throw new Error('Synthetic initial-load response failure');
      return result;
    };
    try {
      const failed = await connect(editor, freshName);
      await until(() => failed.socket?.readyState === WebSocket.CLOSED, 'Failed initial load closes without content');
      assert.equal(failed.document.getXmlFragment('document').length, 0);
    } finally { core.documents.live.read = original; }
    const recovered = await connect(editor, freshName);
    await until(() => recovered.provider.isSynced && recovered.provider.unsyncedChanges === 0, 'Fresh load succeeds after failure');
    assert.equal(title(recovered.document).toString(), freshDocument.revision.title);
    assert.deepEqual(readLiveState(Y.encodeStateAsUpdate(recovered.document)).content, freshDocument.revision.content);
  });
  await t.test('a SQL-gated edit emits neither successful acknowledgement nor peer change before commit', async () => {
    const gate = await database.pool.connect();
    await database.pool.query(`CREATE FUNCTION pause_socket_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      PERFORM pg_advisory_xact_lock(7242033,hashtext('${schema}')); RETURN NEW; END $$;
      CREATE TRIGGER socket_gate BEFORE UPDATE ON "DocumentLive" FOR EACH ROW EXECUTE FUNCTION pause_socket_write()`);
    try {
      await gate.query('SELECT pg_advisory_lock(7242033,hashtext($1))', [schema]);
      const beforeAck = writer.frames.filter(type => type === 8).length;
      title(writer.document).insert(0, 'Committed ');
      await until(writeIsPaused, 'The actual socket write waits inside PostgreSQL');
      assert.equal(title(observer.document).toString(), saved.revision.title);
      assert.equal(title(viewer.document).toString(), saved.revision.title);
      assert.equal(writer.frames.filter(type => type === 8).length, beforeAck);
      assert(writer.provider.unsyncedChanges > 0);
      let joined = false;
      const joining = connect(reader).then(client => { joined = true; return client; });
      await until(() => clients.at(-1)?.socket?.readyState === WebSocket.OPEN, 'The new socket opens while the write is gated');
      await delay(25);
      assert.equal(joined, false, 'Room authentication waits for acceptance and its captured recipient audience');
      await gate.query('SELECT pg_advisory_unlock(7242033,hashtext($1))', [schema]);
      const newcomer = await joining;
      await until(() => writer.provider.unsyncedChanges === 0 && title(observer.document).toString().startsWith('Committed ') && title(viewer.document).toString().startsWith('Committed '), 'Only committed content reaches peers and successful acknowledgement');
      assert(writer.frames.filter(type => type === 8).length > beforeAck, 'The actual successful acknowledgement frame arrives after commit');
      await until(() => newcomer.provider.isSynced && newcomer.provider.unsyncedChanges === 0, 'The joining peer synchronizes without a retry');
      assert.equal(newcomer.socketCount, 1); assert.equal(title(newcomer.document).toString(), title(observer.document).toString());
      room = await core.documents.live.read(editor, saved.id);
      assert.equal(readLiveState(room.state).title, title(writer.document).toString());
      assert.equal(await database.prisma.documentRevision.count({ where: { documentId: saved.id } }), 1);
    } finally { await gate.query('SELECT pg_advisory_unlock(7242033,hashtext($1))', [schema]); gate.release(); await database.pool.query('DROP TRIGGER socket_gate ON "DocumentLive"; DROP FUNCTION pause_socket_write()'); }
  });
  await t.test('concurrent genuine editors converge and a crafted reader write is never delivered', async () => {
    title(writer.document).insert(0, 'Editor '); title(observer.document).insert(0, 'Peer ');
    await until(() => writer.provider.unsyncedChanges === 0 && observer.provider.unsyncedChanges === 0 && title(writer.document).toString() === title(observer.document).toString(), 'Concurrent editors converge');
    room = await core.documents.live.read(editor, saved.id);
    const before = Buffer.from(room.state), observerTitle = title(observer.document).toString();
    title(viewer.document).insert(0, 'FORGED READER ');
    await until(() => viewer.socket?.readyState === WebSocket.CLOSED, 'Crafted reader writer closes');
    assert.equal(title(observer.document).toString(), observerTitle);
    assert.deepEqual(Buffer.from((await core.documents.live.read(editor, saved.id)).state), before);
  });
  await t.test('concurrent native paragraph and table-cell edits preserve the other rich block structures', async () => {
    nativeText(writer.document, 'Private synthetic socket body').insert(0, 'Edited paragraph: ');
    nativeText(observer.document, 'Preserved').insert(0, 'Edited table: ');
    await until(() => writer.provider.unsyncedChanges === 0 && observer.provider.unsyncedChanges === 0,
      'Rich body changes are acknowledged only after durable acceptance');
    room = await core.documents.live.read(admin, saved.id);
    const projected = readLiveState(room.state);
    assert.match(projected.plainText, /Edited paragraph:/); assert.match(projected.plainText, /Edited table:/);
    assert.deepEqual(readLiveState(Y.encodeStateAsUpdate(observer.document)).content, projected.content);
    assert.deepEqual(readLiveState(Y.encodeStateAsUpdate(writer.document)).content, projected.content);
    for (const block of saved.revision.content.document) {
      if (block.id === 'demo-line-1' || block.type === 'table') continue;
      assert.deepEqual(projected.content.document.find(candidate => candidate.id === block.id), block);
    }
  });
  await t.test('a forced database write failure retains local work without acknowledgement, delivery or durable mutation', async () => {
    room = await core.documents.live.read(editor, saved.id); const before = Buffer.from(room.state);
    await database.pool.query(`CREATE FUNCTION reject_socket_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END $$;
      CREATE TRIGGER socket_failure BEFORE UPDATE ON "DocumentLive" FOR EACH ROW EXECUTE FUNCTION reject_socket_write()`);
    try {
      title(writer.document).insert(0, 'UNCOMMITTED ');
      await until(() => writer.socket?.readyState === WebSocket.CLOSED, 'Failed writer closes without success');
      assert(writer.provider.unsyncedChanges > 0); assert(title(writer.document).toString().startsWith('UNCOMMITTED '));
      assert(!title(observer.document).toString().includes('UNCOMMITTED'));
      assert.deepEqual(Buffer.from((await core.documents.live.read(editor, saved.id)).state), before);
      assert.equal(await database.prisma.documentRevision.count({ where: { documentId: saved.id } }), 1);
    } finally { await database.pool.query('DROP TRIGGER socket_failure ON "DocumentLive"; DROP FUNCTION reject_socket_write()'); }
    await until(() => observer.socket?.readyState === WebSocket.CLOSED, 'Persistence failure invalidates every cached peer');
    // A failure closes the room instead of claiming that an uncertain commit
    // rolled back. Reconnect deliberately to its durable state after unloading.
    await delay(50);
    observer = await connect(peer);
    await until(() => observer.provider.isSynced && observer.provider.unsyncedChanges === 0, 'Recovered peer reads durable content');
  });
  let deliveredThreadId: string, deliveredCommentId: string;
  const commentBody = demoContent(['Private review excluded from saved surfaces']).document;
  await t.test('server comments reach real editor/reader sockets only after the SQL commit', async () => {
    const readerPeer = await connect(reader);
    await until(() => readerPeer.provider.isSynced && readerPeer.provider.unsyncedChanges === 0, 'Reader synchronizes before a server comment');
    room = await core.documents.live.read(editor, saved.id);
    const beforeSequence = room.sequence;
    await until(() => observer.metadata.at(-1)?.sequence === beforeSequence,
      `Initial server metadata must arrive; observed frame types ${JSON.stringify(observer.frames)}`);
    const gate = await database.pool.connect();
    await database.pool.query(`CREATE FUNCTION pause_comment_delivery() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      PERFORM pg_advisory_xact_lock(7242035,hashtext('${schema}')); RETURN NEW; END $$;
      CREATE TRIGGER comment_delivery_gate BEFORE UPDATE ON "DocumentLive" FOR EACH ROW EXECUTE FUNCTION pause_comment_delivery()`);
    try {
      await gate.query('SELECT pg_advisory_lock(7242035,hashtext($1))', [schema]);
      let returned = false;
      const pending = transport.comment(editor, saved.id, room.epoch, { type: 'create', body: commentBody }).then(result => { returned = true; return result; });
      await until(writeIsPaused, 'The server comment is actually blocked in its SQL acceptance');
      assert.equal(returned, false);
      assert.equal(observer.document.getMap('threads').size, 0); assert.equal(readerPeer.document.getMap('threads').size, 0);
      assert.equal(observer.metadata.at(-1)?.sequence, beforeSequence);
      await gate.query('SELECT pg_advisory_unlock(7242035,hashtext($1))', [schema]);
      const result = await pending; assert(result?.type === 'thread');
      deliveredThreadId = result.id; deliveredCommentId = result.comments[0]!.id;
      assert.equal(result.comments[0]!.userId, editorUser.id);
      await until(() => observer.document.getMap('threads').has(result.id) && readerPeer.document.getMap('threads').has(result.id), 'Only committed native comment state reaches authorized peers');
      room = await core.documents.live.read(reader, saved.id);
      await until(() => readerPeer.metadata.at(-1)?.sequence === room.sequence, 'Reader receives accepted-state metadata');
      assert.equal(readerPeer.metadata.at(-1)?.canWrite, false);
      assert.deepEqual(readLiveState(Y.encodeStateAsUpdate(observer.document)), readLiveState(room.state));
      assert(!JSON.stringify(await core.documents.exportNative(reader, saved.id)).includes('Private review'));
      assert.equal(await database.prisma.documentRevision.count({ where: { documentId: saved.id } }), 1);
    } finally { await gate.query('SELECT pg_advisory_unlock(7242035,hashtext($1))', [schema]); gate.release(); await database.pool.query('DROP TRIGGER comment_delivery_gate ON "DocumentLive"; DROP FUNCTION pause_comment_delivery()'); }
  });
  await t.test('denied comment actions neither mutate nor invalidate another authorized peer', async () => {
    const before = await core.documents.live.read(editor, saved.id);
    for (const headers of [reader, outsider]) await assert.rejects(transport.comment(headers, saved.id, room.epoch,
      { type: 'create', body: commentBody }), (error: unknown) => error instanceof HttpProblem && error.status === 404);
    await assert.rejects(transport.comment(peer, saved.id, room.epoch,
      { type: 'edit', threadId: deliveredThreadId, commentId: deliveredCommentId, body: commentBody }),
      (error: unknown) => error instanceof HttpProblem && error.status === 403);
    assert.deepEqual(await core.documents.live.read(editor, saved.id), before);
    assert.equal(observer.socket?.readyState, WebSocket.OPEN);
    assert.equal(observer.document.getMap('threads').size, 1);
  });
  await t.test('a failed server comment closes the old room without comment delivery or durable change', async () => {
    const before = await core.documents.live.read(editor, saved.id);
    await database.pool.query(`CREATE FUNCTION fail_server_comment() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 'Synthetic server comment failure'; END $$;
      CREATE TRIGGER server_comment_failure BEFORE UPDATE ON "DocumentLive" FOR EACH ROW EXECUTE FUNCTION fail_server_comment()`);
    try {
      await assert.rejects(transport.comment(editor, saved.id, room.epoch, { type: 'create', body: commentBody }));
      await until(() => observer.socket?.readyState === WebSocket.CLOSED, 'Database failure closes the cached peer');
      assert.equal(observer.document.getMap('threads').size, 1);
      assert.deepEqual(await core.documents.live.read(editor, saved.id), before);
      assert.equal(await database.prisma.documentRevision.count({ where: { documentId: saved.id } }), 1);
    } finally { await database.pool.query('DROP TRIGGER server_comment_failure ON "DocumentLive"; DROP FUNCTION fail_server_comment()'); }
    observer = await connect(peer); await until(() => observer.provider.isSynced && observer.provider.unsyncedChanges === 0, 'Fresh peer loads the unchanged committed comment state');
    assert.equal(observer.document.getMap('threads').size, 1);
  });
  await t.test('uncertain server comment acceptance reloads its real committed state without early delivery', async () => {
    const original = core.documents.live.comment, before = await core.documents.live.read(editor, saved.id);
    core.documents.live.comment = async (...args: Parameters<typeof original>) => { await original(...args); throw new HttpProblem(503, 'SYNTHETIC_COMMIT_UNCERTAIN'); };
    try {
      await assert.rejects(transport.comment(editor, saved.id, room.epoch, { type: 'create', body: commentBody }));
      await until(() => observer.socket?.readyState === WebSocket.CLOSED, 'Unknown commit response invalidates the old comment cache');
      assert.equal(observer.document.getMap('threads').size, 1);
      room = await core.documents.live.read(editor, saved.id);
      assert.equal(BigInt(room.sequence), BigInt(before.sequence) + 1n);
    } finally { core.documents.live.comment = original; }
    observer = await connect(peer); await until(() => observer.provider.isSynced && observer.provider.unsyncedChanges === 0, 'Replacement peer loads committed unacknowledged comments');
    assert.equal(observer.document.getMap('threads').size, 2);
    assert(clients.every(client => client.socketCount === 1));
  });
  await t.test('an exception after an actual commit closes the old cache and reconnect reloads durable unacknowledged work', async () => {
    const uncertain = await connect(editor); await until(() => uncertain.provider.isSynced && uncertain.provider.unsyncedChanges === 0, 'Editor connects before injected response loss');
    const original = core.documents.live.update;
    const peerTitle = title(observer.document).toString(), beforeAck = uncertain.frames.filter(type => type === 8).length;
    core.documents.live.update = async (...args: Parameters<typeof original>) => {
      await original(...args);
      throw new Error('Synthetic response loss after actual commit');
    };
    try {
      title(uncertain.document).insert(0, 'DURABLE BUT UNACKNOWLEDGED ');
      await until(() => uncertain.socket?.readyState === WebSocket.CLOSED && observer.socket?.readyState === WebSocket.CLOSED, 'Ambiguous persistence closes every peer');
      assert.equal(uncertain.frames.filter(type => type === 8).length, beforeAck);
      assert(uncertain.provider.unsyncedChanges > 0);
      assert.equal(title(observer.document).toString(), peerTitle);
      room = await core.documents.live.read(admin, saved.id);
      assert(readLiveState(room.state).title.startsWith('DURABLE BUT UNACKNOWLEDGED '));
      assert.equal(await database.prisma.documentRevision.count({ where: { documentId: saved.id } }), 1);
    } finally { core.documents.live.update = original; }
    await delay(50);
    observer = await connect(peer); await until(() => observer.provider.isSynced && observer.provider.unsyncedChanges === 0, 'Fresh peer reloads the committed state');
    assert.equal(title(observer.document).toString(), readLiveState(room.state).title);
    assert(clients.every(client => client.socketCount === 1), 'No rejected draft is automatically reconnected or replayed');
  });
  await t.test('revocation closes an existing session before native/comment delivery', async () => {
    const revoked = await connect(reader); await until(() => revoked.provider.isSynced && revoked.provider.unsyncedChanges === 0, 'Reader reconnects before revocation');
    const before = title(revoked.document).toString();
    const beforeState = Y.encodeStateAsUpdate(revoked.document);
    space = await core.spaces.changeMembership(admin, { spaceId: space.id, userId: readerUser.id, role: null, expectedEtag: spaceEtag(space) });
    await transport.comment(editor, saved.id, room.epoch, { type: 'reply', threadId: deliveredThreadId, body: commentBody });
    title(observer.document).insert(0, 'After revocation ');
    await until(() => observer.provider.unsyncedChanges === 0 && revoked.socket?.readyState === WebSocket.CLOSED, 'Revoked recipient receives no later content');
    assert.equal(title(revoked.document).toString(), before);
    assert.deepEqual(Y.encodeStateAsUpdate(revoked.document), beforeState);
    room = await core.documents.live.read(editor, saved.id);
    assert(revoked.metadata.every(state => state.epoch !== room.epoch || state.sequence !== room.sequence));
    const forbidden = await connect(reader); await until(() => forbidden.socket?.readyState === WebSocket.CLOSED, 'Revoked cookie cannot reconnect');
    assert.equal(forbidden.document.getXmlFragment('document').length, 0);
  });
  await t.test('unknown/protected updates close without fan-out and restart reloads the exact committed state', async () => {
    const attacker = await connect(editor); await until(() => attacker.provider.isSynced && attacker.provider.unsyncedChanges === 0, 'Editor reconnects to durable state');
    room = await core.documents.live.read(editor, saved.id); const before = Buffer.from(room.state);
    attacker.document.getMap('threads').set('forged-comment', 'private');
    await until(() => attacker.socket?.readyState === WebSocket.CLOSED, 'Protected thread writer closes');
    assert.deepEqual(Buffer.from((await core.documents.live.read(editor, saved.id)).state), before);
    await transport.close(app.server); transport = createCollaboration(core, lease, identityConfig.origin); transport.attach(app.server);
    const fresh = await connect(peer); await until(() => fresh.provider.isSynced && fresh.provider.unsyncedChanges === 0, 'Fresh connection loads the stored CRDT state');
    assert.deepEqual(Y.encodeStateVector(fresh.document), Y.encodeStateVector(observer.document));
    assert.equal(readLiveState(Y.encodeStateAsUpdate(fresh.document)).title, readLiveState(room.state).title);
    observer = fresh;
  });
  await t.test('native presence uses server identities, owns one client ID and never changes stored content', async () => {
    let presenceSpace = await core.spaces.create(admin, 'Private presence fixture');
    for (const [user, role] of [[editorUser, 'editor'], [peerUser, 'editor'], [readerUser, 'reader']] as const) {
      presenceSpace = await core.spaces.changeMembership(admin, { spaceId: presenceSpace.id, userId: user.id, role,
        expectedEtag: spaceEtag(presenceSpace) });
    }
    const document = await core.documents.create(editor, presenceSpace.id,
      { title: 'Private presence', content: demoContent(['Authorized native cursor text']) });
    const enrolled = await core.documents.live.enroll(editor, document.id, documentEtag(document));
    const address = `${document.id}:${enrolled.epoch}`;
    const writer = await connect(editor, address, true), viewer = await connect(reader, address, true);
    await until(() => writer.provider.isSynced && viewer.provider.isSynced, 'Separate real sessions synchronize before presence');
    assert(writer.provider.awareness && viewer.provider.awareness);
    const editorName = (await core.identity.me(editor)).name;
    const before = await database.prisma.documentLive.findFirstOrThrow({ where: { documentId: document.id } });
    const text = nativeText(writer.document, 'Authorized native cursor text');
    const cursor = { anchor: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, 0)),
      head: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, 10)) };
    writer.provider.awareness.setLocalState({ user: { id: administrator.id, name: 'Forged administrator',
      color: 'url(https://example.test/forged)', email: 'private@example.test' }, cursor, privateDraft: 'DO NOT SHARE' });
    await until(() => Boolean(viewer.provider.awareness?.getStates().get(writer.document.clientID)?.cursor),
      'Reader receives the authorized native cursor');
    // The native helper returns ID instances; the actual protocol uses JSON.
    const expectedPresence: unknown = JSON.parse(JSON.stringify({ user: { id: editorUser.id, name: editorName, color: '#91ad95' }, cursor }));
    assert.deepEqual(viewer.provider.awareness.getStates().get(writer.document.clientID), expectedPresence);
    assert.deepEqual(await database.prisma.documentLive.findFirstOrThrow({ where: { documentId: document.id } }), before);
    assert.equal(await database.prisma.documentRevision.count({ where: { documentId: document.id } }), 1);
    const outsiderClient = await connect(outsider, address, true);
    await until(() => outsiderClient.socket?.readyState === WebSocket.CLOSED, 'Outsider cannot join a presence room');
    assert.equal(outsiderClient.document.getXmlFragment('document').length, 0);
    assert.deepEqual([...outsiderClient.provider.awareness!.getStates().keys()], [outsiderClient.document.clientID]);

    function awarenessFrame(states: readonly [number, unknown][]) {
      const update = createEncoder(); writeVarUint(update, states.length);
      for (const [clientId, state] of states) {
        writeVarUint(update, clientId); writeVarUint(update, 1000); writeVarString(update, JSON.stringify(state));
      }
      const frame = createEncoder(); writeVarString(frame, address); writeVarUint(frame, 1);
      writeVarUint8Array(frame, toUint8Array(update)); return toUint8Array(frame);
    }
    // Native queries may relay peers. Even forged copies on bound or first-use
    // connections are ignored; only the owner's connection can change them.
    for (const presence of [true, false]) {
      const attacker = await connect(peer, address, presence); await until(() => attacker.provider.isSynced, 'Attacker authenticates normally');
      const frames = attacker.frames.filter(type => type === MessageType.Sync).length;
      attacker.socket!.send(awarenessFrame([[writer.document.clientID, { user: { name: 'Impersonated' }, cursor }]]));
      attacker.provider.forceSync();
      await until(() => attacker.frames.filter(type => type === MessageType.Sync).length > frames, 'Subsequent native synchronization proves the preceding forged relay was handled');
      assert.equal(attacker.socket!.readyState, WebSocket.OPEN);
      assert.deepEqual(viewer.provider.awareness.getStates().get(writer.document.clientID), expectedPresence);
    }
    const privateTitlePosition = Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(title(writer.document), 0));
    for (const states of [
      [[100, { user: {} }], [101, { user: {} }]],
      [[100, { cursor: { anchor: { tname: 'metadata' }, head: { tname: 'metadata' } } }]],
      [[100, { cursor: { anchor: privateTitlePosition, head: privateTitlePosition } }]],
      [[100, { privateDraft: 'x'.repeat(4096) }]],
    ] as [number, unknown][][]) {
      const attacker = await connect(peer, address); await until(() => attacker.provider.isSynced, 'Malformed presence sender connects');
      attacker.socket!.send(awarenessFrame(states));
      await until(() => attacker.socket?.readyState === WebSocket.CLOSED, 'Malformed/oversized presence is rejected');
      assert.equal(viewer.provider.awareness.getStates().get(writer.document.clientID)?.user.name, editorName);
    }
    presenceSpace = await core.spaces.changeMembership(admin, { spaceId: presenceSpace.id, userId: editorUser.id, role: null,
      expectedEtag: spaceEtag(presenceSpace) });
    await until(() => writer.socket?.readyState === WebSocket.CLOSED, 'Existing presence session closes after revocation');
    await until(() => !viewer.provider.awareness?.getStates().has(writer.document.clientID), 'Revoked presence disappears from remaining readers');
    assert.deepEqual(await database.prisma.documentLive.findFirstOrThrow({ where: { documentId: document.id } }), before);
  });
  await t.test('passive session expiry and a current role downgrade stop writes through existing sockets', async () => {
    const expiringHeaders = await login(editorUser.email, '127.0.0.36');
    const principal = await core.identity.resolve(expiringHeaders);
    const expiring = await connect(expiringHeaders); await until(() => expiring.provider.isSynced, 'Expiring editor connects');
    await database.prisma.session.update({ where: { id: principal.sessionId }, data: { expiresAt: new Date(Date.now() - 1) } });
    await until(() => expiring.socket?.readyState === WebSocket.CLOSED, 'A passive expired session closes without typing');
    const downgraded = await connect(editor); await until(() => downgraded.provider.isSynced && downgraded.provider.unsyncedChanges === 0, 'Editor connects before downgrade');
    space = await core.spaces.changeMembership(admin, { spaceId: space.id, userId: editorUser.id, role: 'reader', expectedEtag: spaceEtag(space) });
    await until(() => downgraded.metadata.at(-1)?.canWrite === false, 'Passive permission audit informs the existing client that editing is no longer allowed');
    const before = title(observer.document).toString();
    title(downgraded.document).insert(0, 'FORGED DOWNGRADE ');
    await until(() => downgraded.socket?.readyState === WebSocket.CLOSED, 'The downgraded user cannot mutate');
    assert.equal(title(observer.document).toString(), before);
    assert(!readLiveState((await core.documents.live.read(admin, saved.id)).state).title.includes('FORGED DOWNGRADE'));
  });
  await t.test('malformed and oversized actual frames cannot alter a room or reach another client', async () => {
    const before = Buffer.from((await core.documents.live.read(admin, saved.id)).state);
    for (const frame of [Buffer.from([255]), Buffer.alloc(1024 * 1024 + 257)]) {
      const malformed = await connect(admin); await until(() => malformed.provider.isSynced, 'Authorized sender connects');
      assert(malformed.socket); malformed.socket.send(frame);
      await until(() => malformed.socket?.readyState === WebSocket.CLOSED, 'Rejected actual frame closes its sender');
      assert.deepEqual(Buffer.from((await core.documents.live.read(admin, saved.id)).state), before);
    }
  });
  await t.test('archive closes passive connections; unarchive requires fresh authorization and preserves history', async () => {
    const before = title(observer.document).toString();
    const archived = await core.documents.archive(admin, saved.id, documentEtag(await core.documents.read(admin, saved.id)));
    await until(() => observer.socket?.readyState === WebSocket.CLOSED, 'Archive closes passive peers');
    const forbidden = await connect(peer); await until(() => forbidden.socket?.readyState === WebSocket.CLOSED, 'Archived room cannot reconnect');
    assert.equal(forbidden.document.getXmlFragment('document').length, 0);
    await core.documents.unarchive(admin, saved.id, documentEtag(archived));
    observer = await connect(peer); await until(() => observer.provider.isSynced && observer.provider.unsyncedChanges === 0, 'Unarchive opens a fresh authorized provider');
    assert.equal(title(observer.document).toString(), before);
    assert.equal(await database.prisma.documentRevision.count({ where: { documentId: saved.id } }), 1);
  });
  await t.test('checkpoint and restore append immutable history and reject old-epoch connections without replay', async () => {
    room = await core.documents.live.read(admin, saved.id);
    await core.documents.live.checkpoint(admin, saved.id, { epoch: room.epoch, sequence: room.sequence }, room.documentEtag);
    room = await core.documents.live.read(admin, saved.id); const oldName = name(), oldTitle = title(observer.document).toString();
    const restored = await core.documents.live.restore(admin, saved.id, { epoch: room.epoch, sequence: room.sequence, revisionId: saved.revision.id }, room.documentEtag);
    room = restored.room;
    await until(() => observer.socket?.readyState === WebSocket.CLOSED, 'Restore invalidates every old-epoch connection');
    assert.equal(title(observer.document).toString(), oldTitle);
    const old = await connect(peer, oldName); await until(() => old.socket?.readyState === WebSocket.CLOSED, 'Old epoch cannot reconnect');
    assert.equal(old.document.getXmlFragment('document').length, 0);
    observer = await connect(peer); await until(() => observer.provider.isSynced && observer.provider.unsyncedChanges === 0, 'Restored epoch uses a new document/provider');
    assert.equal(title(observer.document).toString(), saved.revision.title);
    assert.equal(await database.prisma.documentRevision.count({ where: { documentId: saved.id } }), 3);
    assert(clients.every(client => client.socketCount === 1), 'Each connection attempt remains deliberate');
    assert.equal(await database.prisma.documentLive.count({ where: { documentId: saved.id } }), 2);
  });
  await t.test('operator recovery in another operation closes passive recipients without relying on route notifications', async () => {
    const recoveryPassword = randomBytes(24).toString('base64url');
    await operator.recover(peerUser.email, recoveryPassword);
    await until(() => observer.socket?.readyState === WebSocket.CLOSED, 'Recovery closes the existing idle session');
    const forbidden = await connect(peer); await until(() => forbidden.socket?.readyState === WebSocket.CLOSED, 'Recovered cookie cannot reconnect');
    assert.equal(forbidden.document.getXmlFragment('document').length, 0);
    observer = await connect(admin); await until(() => observer.provider.isSynced, 'Remaining authorized administrator connects');
  });
  await t.test('graceful shutdown drains a SQL-gated write before ownership handoff without acknowledgements or new history', async () => {
    await until(() => observer.provider.isSynced && observer.provider.unsyncedChanges === 0, 'The writer finishes initial synchronization');
    const recipient = await connect(admin);
    await until(() => recipient.provider.isSynced && recipient.provider.unsyncedChanges === 0, 'The recipient finishes initial synchronization');
    const beforeRoom = await core.documents.live.read(admin, saved.id);
    const beforeTitle = title(recipient.document).toString();
    const beforeAck = observer.frames.filter(type => type === 8).length;
    const revisions = await database.prisma.documentRevision.count({ where: { documentId: saved.id } });
    const gate = await database.pool.connect();
    let closing: Promise<void> | undefined;
    await database.pool.query(`CREATE FUNCTION pause_shutdown_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      PERFORM pg_advisory_xact_lock(7242035,hashtext('${schema}')); RETURN NEW; END $$;
      CREATE TRIGGER shutdown_gate BEFORE UPDATE ON "DocumentLive" FOR EACH ROW EXECUTE FUNCTION pause_shutdown_write()`);
    try {
      await gate.query('SELECT pg_advisory_lock(7242035,hashtext($1))', [schema]);
      title(observer.document).insert(0, 'Accepted during shutdown ');
      await until(writeIsPaused, 'The actual write is paused inside PostgreSQL');
      let closed = false;
      closing = transport.close(app.server).then(() => { closed = true; });
      await until(() => clients.every(client => client.socket?.readyState === WebSocket.CLOSED), 'Shutdown closes every real socket');
      assert.equal(closed, false, 'Shutdown cannot finish while acceptance is still in flight');
      lease.assertHeld();
      assert.equal(observer.frames.filter(type => type === 8).length, beforeAck);
      assert.equal(title(recipient.document).toString(), beforeTitle);
      await gate.query('SELECT pg_advisory_unlock(7242035,hashtext($1))', [schema]);
      await closing;
      const durable = await core.documents.live.read(admin, saved.id);
      assert.equal(BigInt(durable.sequence), BigInt(beforeRoom.sequence) + 1n);
      assert.equal(readLiveState(durable.state).title, title(observer.document).toString());
      assert.equal(observer.frames.filter(type => type === 8).length, beforeAck);
      assert.equal(title(recipient.document).toString(), beforeTitle);
      assert.equal(await database.prisma.documentRevision.count({ where: { documentId: saved.id } }), revisions);
    } finally {
      await gate.query('SELECT pg_advisory_unlock(7242035,hashtext($1))', [schema]);
      gate.release();
      await closing;
      await database.pool.query('DROP TRIGGER shutdown_gate ON "DocumentLive"; DROP FUNCTION pause_shutdown_write()');
    }
    await lease.close();
    lease = await claimLiveOwner(database.pool);
    transport = createCollaboration(core, lease, identityConfig.origin); transport.attach(app.server);
    observer = await connect(admin);
    await until(() => observer.provider.isSynced && observer.provider.unsyncedChanges === 0, 'The new owner reloads accepted content');
    assert.equal(title(observer.document).toString(), readLiveState((await core.documents.live.read(admin, saved.id)).state).title);
  });
  await t.test('ownership loss during a SQL-gated write emits no acknowledgement; a new owner reloads committed state', async () => {
    await until(() => observer.provider.unsyncedChanges === 0, 'Administrator initially has no pending frames');
    const recipient = await connect(admin); await until(() => recipient.provider.isSynced && recipient.provider.unsyncedChanges === 0, 'A second authorized recipient connects');
    const beforeTitle = title(recipient.document).toString(), beforeAck = observer.frames.filter(type => type === 8).length;
    const beforeRoom = await core.documents.live.read(admin, saved.id);
    const gate = await database.pool.connect();
    await database.pool.query(`CREATE FUNCTION pause_lease_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      PERFORM pg_advisory_xact_lock(7242034,hashtext('${schema}')); RETURN NEW; END $$;
      CREATE TRIGGER lease_gate BEFORE UPDATE ON "DocumentLive" FOR EACH ROW EXECUTE FUNCTION pause_lease_write()`);
    try {
      await gate.query('SELECT pg_advisory_lock(7242034,hashtext($1))', [schema]);
      title(observer.document).insert(0, 'Unacknowledged lease loss ');
      await until(writeIsPaused, 'Socket acceptance is actually paused inside its SQL write');
      assert.equal((await database.pool.query<{ terminated: boolean }>('SELECT pg_terminate_backend($1) AS terminated', [lease.pid])).rows[0]?.terminated, true);
      await lease.lost;
      await until(() => clients.every(client => client.socket?.readyState === WebSocket.CLOSED), 'Ownership loss closes every socket');
      assert.equal(observer.frames.filter(type => type === 8).length, beforeAck);
      assert.equal(title(recipient.document).toString(), beforeTitle);
      const ws = new WebSocket(socketUrl, { headers: { origin: identityConfig.origin, cookie: editor.get('cookie')! } });
      const status = await new Promise<number>(resolve => { ws.on('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode!); ws.terminate(); }); ws.on('error', () => {}); });
      assert.equal(status, 403);
      await gate.query('SELECT pg_advisory_unlock(7242034,hashtext($1))', [schema]);
      // A configured database timeout can roll back this already in-flight
      // write. Close waits for either outcome; neither may emit a success.
      await transport.close(app.server);
      const durable = await core.documents.live.read(admin, saved.id);
      if (durable.sequence === beforeRoom.sequence) assert.deepEqual(Buffer.from(durable.state), Buffer.from(beforeRoom.state));
      else {
        assert.equal(BigInt(durable.sequence), BigInt(beforeRoom.sequence) + 1n);
        assert.equal(readLiveState(durable.state).title, title(observer.document).toString());
      }
      assert.equal(observer.frames.filter(type => type === 8).length, beforeAck);
    } finally { await gate.query('SELECT pg_advisory_unlock(7242034,hashtext($1))', [schema]); gate.release(); await database.pool.query('DROP TRIGGER lease_gate ON "DocumentLive"; DROP FUNCTION pause_lease_write()'); }
    await transport.close(app.server);
    const oldPid = lease.pid; lease = await claimLiveOwner(database.pool); assert.notEqual(lease.pid, oldPid);
    transport = createCollaboration(core, lease, identityConfig.origin); transport.attach(app.server);
    const fresh = await connect(admin); await until(() => fresh.provider.isSynced && fresh.provider.unsyncedChanges === 0, 'Replacement owner reads the complete durable state');
    assert.equal(title(fresh.document).toString(), readLiveState((await core.documents.live.read(admin, saved.id)).state).title);
    assert.equal(await database.prisma.documentRevision.count({ where: { documentId: saved.id } }), 3);
  });
});
