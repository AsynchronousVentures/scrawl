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
import { createDecoder, readVarString, readVarUint } from 'lib0/decoding';
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
import { richDemoContent } from '../../scripts/demo-content.js';
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
  const app = await buildApp({ config, core, logging: false, checkDatabase: () => database.ping() });
  transport.attach(app.server);
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const socketUrl = address.replace('http:', 'ws:') + '/api/v1/live';
  const clients: { provider: HocuspocusProvider; websocket: HocuspocusProviderWebsocket; document: Y.Doc; frames: number[]; socket: WebSocket | undefined; socketCount: number }[] = [];
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
  async function connect(headers: Headers, documentName = name()) {
    const document = new Y.Doc({ gc: false }), frames: number[] = [];
    document.getXmlFragment('document'); document.getMap('metadata'); document.getMap('threads');
    let socket: WebSocket | undefined, socketCount = 0;
    class SessionSocket extends WebSocket {
      constructor(url: string) {
        super(url, { headers: { origin: identityConfig.origin, cookie: headers.get('cookie') ?? '' } }); socket = this; socketCount++;
        this.on('message', data => {
          if (!Buffer.isBuffer(data)) return;
          const decoder = createDecoder(data); readVarString(decoder); frames.push(readVarUint(decoder));
        });
      }
    }
    const websocket = new HocuspocusProviderWebsocket({ url: socketUrl, autoConnect: false, maxAttempts: 1, WebSocketPolyfill: SessionSocket,
      // The configured hook runs before the provider schedules reconnect. A
      // later event listener cannot cancel a retry that is already scheduled.
      onClose: () => websocket.disconnect(),
    });
    const provider = new HocuspocusProvider({ websocketProvider: websocket, name: documentName, document, awareness: null });
    provider.attach();
    const client = { provider, websocket, document, frames, get socket() { return socket; }, get socketCount() { return socketCount; } }; clients.push(client);
    await websocket.connect();
    return client;
  }
  const writer = await connect(editor), viewer = await connect(reader);
  let observer = await connect(peer);
  await until(() => [writer, observer, viewer].every(client => client.provider.isSynced && client.provider.unsyncedChanges === 0), 'All roles synchronize the initial durable state');
  await t.test('initial sync is identical, outsiders get no document bytes, and anonymous/wrong-origin upgrades fail', async () => {
    assert.equal(title(viewer.document).toString(), saved.revision.title);
    assert.deepEqual(readLiveState(Y.encodeStateAsUpdate(viewer.document)).content, saved.revision.content);
    const denied = await connect(outsider);
    await until(() => denied.socket?.readyState === WebSocket.CLOSED, 'Outsider socket closes');
    assert(!denied.provider.isSynced); assert.equal(denied.document.getXmlFragment('document').length, 0);
    assert(!denied.frames.includes(0));
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
      await until(async () => (await database.pool.query<{ waiting: boolean }>(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event='advisory' AND query LIKE '%DocumentLive%' AND pid<>pg_backend_pid()) AS waiting`)).rows[0]!.waiting, 'The actual socket write waits inside PostgreSQL');
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
  await t.test('revocation closes an existing session before another editor can deliver new bytes', async () => {
    const revoked = await connect(reader); await until(() => revoked.provider.isSynced, 'Reader reconnects before revocation');
    const before = title(revoked.document).toString();
    space = await core.spaces.changeMembership(admin, { spaceId: space.id, userId: readerUser.id, role: null, expectedEtag: spaceEtag(space) });
    title(observer.document).insert(0, 'After revocation ');
    await until(() => observer.provider.unsyncedChanges === 0 && revoked.socket?.readyState === WebSocket.CLOSED, 'Revoked recipient receives no later content');
    assert.equal(title(revoked.document).toString(), before);
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
  await t.test('passive session expiry and a current role downgrade stop writes through existing sockets', async () => {
    const expiringHeaders = await login(editorUser.email, '127.0.0.36');
    const principal = await core.identity.resolve(expiringHeaders);
    const expiring = await connect(expiringHeaders); await until(() => expiring.provider.isSynced, 'Expiring editor connects');
    await database.prisma.session.update({ where: { id: principal.sessionId }, data: { expiresAt: new Date(Date.now() - 1) } });
    await until(() => expiring.socket?.readyState === WebSocket.CLOSED, 'A passive expired session closes without typing');
    const downgraded = await connect(editor); await until(() => downgraded.provider.isSynced && downgraded.provider.unsyncedChanges === 0, 'Editor connects before downgrade');
    space = await core.spaces.changeMembership(admin, { spaceId: space.id, userId: editorUser.id, role: 'reader', expectedEtag: spaceEtag(space) });
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
      await until(async () => (await database.pool.query<{ waiting: boolean }>(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event='advisory' AND query LIKE '%DocumentLive%' AND pid<>pg_backend_pid()) AS waiting`)).rows[0]!.waiting, 'Socket acceptance is actually paused inside its SQL write');
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
