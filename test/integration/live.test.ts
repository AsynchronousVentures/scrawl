// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { request } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { ServerBlockNoteEditor } from '@blocknote/server-util';
import * as Y from 'yjs';
import { readConfig } from '../../src/config.js';
import { createDatabase } from '../../src/db/client.js';
import { createCore } from '../../src/core/index.js';
import { createOperator } from '../../src/core/identity/operator.js';
import { documentEtag } from '../../src/core/documents/index.js';
import { spaceEtag } from '../../src/core/spaces/index.js';
import { HttpProblem } from '../../src/http/problems.js';
import { readLiveState } from '../../src/core/live/content.js';
import { contentSchema, validateContent } from '../../src/core/documents/content.js';
import { demoContent } from '../../scripts/demo-content.js';
import { buildApp } from '../../src/app.js';

function frame(state: Uint8Array, edit: (doc: Y.Doc) => void) {
  const doc = new Y.Doc({ gc: false });
  doc.getXmlFragment('document'); doc.getMap('metadata'); doc.getMap('threads');
  Y.applyUpdate(doc, state);
  try { const vector = Y.encodeStateVector(doc); edit(doc); return Y.encodeStateAsUpdate(doc, vector); }
  finally { doc.destroy(); }
}
function text(doc: Y.Doc) {
  const nodes = [...doc.getXmlFragment('document').toArray()];
  while (nodes.length) {
    const node = nodes.shift()!;
    if (node instanceof Y.XmlText) return node;
    assert(node instanceof Y.XmlElement); nodes.unshift(...node.toArray());
  }
  throw new Error('Synthetic body must contain native text');
}
function title(doc: Y.Doc) { const value = doc.getMap('metadata').get('title'); assert(value instanceof Y.Text); return value; }
async function problem(operation: Promise<unknown>, status: number, code?: string) {
  await assert.rejects(operation, (error: unknown) => {
    assert(error instanceof HttpProblem); assert.equal(error.status, status);
    if (code) assert.equal(error.code, code); return true;
  });
}

test('private native live storage uses PostgreSQL and genuine authenticated sessions', async t => {
  const base = readConfig(process.env), url = new URL(base.databaseUrl);
  assert(base.nodeEnv !== 'production' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  const owner = createDatabase(base, () => {}), schema = 'scrawl_test_live_' + randomUUID().replaceAll('-', '');
  await owner.pool.query(`CREATE SCHEMA "${schema}"`);
  url.searchParams.set('schema', schema);
  const config = { ...base, databaseUrl: url.href }, database = createDatabase(config, () => {});
  const identityConfig = { origin: 'http://127.0.0.1:3000', secret: randomBytes(32).toString('hex'), secureCookies: false };
  const attachmentStorageDir = await mkdtemp(join(tmpdir(), 'scrawl-live-test-'));
  const core = createCore(database.prisma, identityConfig, { attachmentStorageDir }), operator = createOperator(database.prisma, identityConfig);
  const app = await buildApp({ config, core, checkDatabase: () => database.ping(), logging: false });
  t.after(async () => { await app.close(); await database.close(); await owner.pool.query(`DROP SCHEMA "${schema}" CASCADE`); await owner.close(); await rm(attachmentStorageDir, { recursive: true }); });
  for (let i = 0; i < 2; i++) {
    const migrated = spawnSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
      env: { ...process.env, DATABASE_URL: config.databaseUrl }, encoding: 'utf8',
    });
    assert.equal(migrated.status, 0, 'One migration history deploys and safely reapplies');
  }
  const address = await app.listen({ host: '127.0.0.1', port: 0 }), password = randomBytes(24).toString('base64url');
  const adminUser = await operator.bootstrap({ email: 'owner@example.test', name: 'Owner', password });
  const editorUser = await operator.provision({ email: 'editor@example.test', name: 'Editor', password });
  const peerUser = await operator.provision({ email: 'peer@example.test', name: 'Peer', password });
  const readerUser = await operator.provision({ email: 'reader@example.test', name: 'Reader', password });
  const outsiderUser = await operator.provision({ email: 'outsider@example.test', name: 'Outsider', password });
  async function login(email: string, localAddress: string) {
    const payload = JSON.stringify({ email, password });
    return new Promise<Headers>((resolve, reject) => {
      const req = request(new URL('/api/auth/sign-in/email', address), { method: 'POST', localAddress,
        headers: { origin: identityConfig.origin, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) } }, response => {
        response.resume(); response.on('error', reject); response.on('end', () => {
          try { assert.equal(response.statusCode, 200); assert(response.headers['set-cookie']?.length);
            resolve(new Headers({ origin: identityConfig.origin, cookie: response.headers['set-cookie'].map(value => value.split(';')[0]).join('; ') }));
          } catch (error) { reject(error); }
        });
      }); req.on('error', reject); req.end(payload);
    });
  }
  const admin = await login(adminUser.email, '127.0.0.21'), editor = await login(editorUser.email, '127.0.0.22');
  const peer = await login(peerUser.email, '127.0.0.23'), reader = await login(readerUser.email, '127.0.0.24');
  const outsider = await login(outsiderUser.email, '127.0.0.25');
  const anotherReader = await login(readerUser.email, '127.0.0.26');
  const connections = await Promise.all([['administrator', admin], ['editor', editor], ['peer', peer],
    ['reader', reader], ['another-reader', anotherReader], ['outsider', outsider]].map(async ([connectionId, headers]) => {
    assert(typeof connectionId === 'string' && headers instanceof Headers);
    return { connectionId, principal: await core.identity.resolve(headers) };
  }));
  let space = await core.spaces.create(admin, 'Synthetic live storage');
  for (const [user, role] of [[editorUser, 'editor'], [peerUser, 'editor'], [readerUser, 'reader']] as const) {
    space = await core.spaces.changeMembership(admin, { spaceId: space.id, userId: user.id, role, expectedEtag: spaceEtag(space) });
  }
  const create = () => core.documents.create(editor, space.id, { title: 'Synthetic live handbook', content: demoContent(['Synthetic initial content']) });
  let document = await create();
  const id = document.id, firstRevision = document.revision.id;
  let room: Awaited<ReturnType<typeof core.documents.live.read>>;
  const count = () => database.prisma.documentRevision.count({ where: { documentId: id } });
  const read = () => core.documents.read(editor, id);
  const savedRoom = () => database.prisma.documentLive.findUniqueOrThrow({ where: { documentId_epoch: { documentId: id, epoch: room.epoch } } });
  const waitForLock = async (table: 'Document' | 'Space' | 'DocumentLive' | 'user') => {
    for (let i = 0; ; i++) {
      const waiting = await database.pool.query<{ count: string }>(`SELECT count(DISTINCT activity.pid)::text
        FROM pg_stat_activity activity JOIN pg_locks lock ON lock.pid=activity.pid
        WHERE activity.wait_event_type='Lock' AND lock.relation=$1::regclass
          AND activity.query LIKE $2 AND activity.pid<>pg_backend_pid()`, [`"${schema}"."${table}"`, `%"${table}"%`]);
      if (Number(waiting.rows[0]?.count)) return;
      assert(i < 200, 'The authenticated operation must reach its guarded row lock'); await delay(10);
    }
  };
  const checkpoint = (headers = editor, etag = documentEtag(document), snapshot = room) => core.documents.live.checkpoint(headers, id,
    { epoch: snapshot.epoch, sequence: snapshot.sequence }, etag);

  await t.test('reader enrollment is server-derived, authorized, preconditioned and atomic', async () => {
    await problem(core.documents.live.enroll(outsider, id, documentEtag(document)), 404);
    await problem(core.documents.live.enroll(new Headers(), id, documentEtag(document)), 401);
    await problem(core.documents.live.enroll(reader, id), 428);
    const enrolled = await Promise.allSettled([reader, editor].map(headers => core.documents.live.enroll(headers, id, documentEtag(document))));
    assert.equal(enrolled.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = enrolled.find(result => result.status === 'rejected'); assert(rejected?.status === 'rejected');
    assert(rejected.reason instanceof HttpProblem); assert.equal(rejected.reason.status, 412);
    room = await core.documents.live.read(reader, id); document = await read();
    assert.equal(room.sequence, '0'); assert.equal(document.lockVersion, 2); assert.equal(await count(), 1);
    assert.deepEqual(readLiveState(room.state).content, document.revision.content);
    assert.equal((await core.documents.live.enroll(reader, id, documentEtag(document))).epoch, room.epoch);
    assert.equal(await database.prisma.documentLive.count(), 1);
    assert(!JSON.stringify(document).includes('liveEpoch'));
    await problem(core.documents.live.read(outsider, id), 404);
    for (const headers of [reader, outsider]) {
      await problem(core.documents.live.update(headers, id, room.epoch, room.state), 404);
      await problem(checkpoint(headers), 404);
    }
  });
  await t.test('concurrent updates merge, duplicate delivery is idempotent, saved surfaces remain unchanged', async () => {
    const first = frame(room.state, doc => { text(doc).insert(text(doc).length, ' checkpointmarker'); title(doc).insert(title(doc).length, ' A'); });
    const second = frame(room.state, doc => { text(doc).insert(text(doc).length, ' peermarker'); title(doc).insert(title(doc).length, ' B'); });
    await Promise.all([core.documents.live.update(editor, id, room.epoch, first), core.documents.live.update(peer, id, room.epoch, second)]);
    room = await core.documents.live.read(reader, id);
    assert.equal(room.sequence, '2'); const projection = readLiveState(room.state);
    assert.match(projection.plainText, /checkpointmarker/); assert.match(projection.plainText, /peermarker/);
    assert.match(projection.title, / A/); assert.match(projection.title, / B/);
    const before = await savedRoom(); const duplicate = await core.documents.live.update(editor, id, room.epoch, second);
    assert.equal(duplicate.sequence, '2'); assert.deepEqual((await savedRoom()), before);
    assert.deepEqual(await read(), document); assert.equal(await count(), 1);
    assert.equal((await core.search.find(reader, { query: 'checkpointmarker' })).items.length, 0);
    assert(!JSON.stringify(await core.documents.exportNative(reader, id)).includes('checkpointmarker'));
    await problem(core.documents.update(editor, id, { title: 'Bypass' }, documentEtag(document)), 409, 'LIVE_DOCUMENT_REQUIRES_CHECKPOINT');
    await problem(core.documents.restore(editor, id, { revisionId: firstRevision }, documentEtag(document)), 409, 'LIVE_DOCUMENT_REQUIRES_CHECKPOINT');
  });
  await t.test('current recipient grants and session validity are authoritative, including multiple sessions and downgrade', async () => {
    const authorized = await core.documents.live.authorizeConnections(editor, id, room.epoch, connections);
    assert.deepEqual(authorized.recipients, connections.filter(connection => connection.connectionId !== 'outsider').map(connection => ({
      connectionId: connection.connectionId, canWrite: !['reader', 'another-reader'].includes(connection.connectionId),
    })));
    assert(!('state' in authorized)); assert(!JSON.stringify(authorized).includes('@example.test'));
    space = await core.spaces.changeMembership(admin, { spaceId: space.id, userId: peerUser.id, role: 'reader', expectedEtag: spaceEtag(space) });
    const downgraded = await core.documents.live.authorizeConnections(editor, id, room.epoch, connections);
    assert.equal(downgraded.recipients.find(connection => connection.connectionId === 'peer')?.canWrite, false);
    await problem(core.documents.live.update(peer, id, room.epoch, room.state, connections), 404);
    space = await core.spaces.changeMembership(admin, { spaceId: space.id, userId: peerUser.id, role: 'editor', expectedEtag: spaceEtag(space) });
    const secondSession = connections.find(connection => connection.connectionId === 'another-reader'); assert(secondSession);
    await database.prisma.session.update({ where: { id: secondSession.principal.sessionId }, data: { expiresAt: new Date(0) } });
    const receipt = await core.documents.live.update(editor, id, room.epoch, frame(room.state, () => {}), connections);
    assert.deepEqual(receipt.recipients.map(connection => connection.connectionId), ['administrator', 'editor', 'peer', 'reader']);
    assert.equal(receipt.sequence, room.sequence);
    await problem(core.documents.live.authorizeConnections(outsider, id, room.epoch, connections), 404);
    await problem(core.documents.live.authorizeConnections(editor, id, randomUUID(), connections), 412);
  });
  await t.test('checkpoint requires exact versions and concurrent saves append exactly one immutable revision', async () => {
    await problem(core.documents.live.checkpoint(editor, id, { epoch: room.epoch, sequence: room.sequence }), 428);
    await problem(core.documents.live.checkpoint(editor, id, { epoch: room.epoch }, documentEtag(document)), 428);
    await problem(checkpoint(editor, documentEtag(document), { ...room, sequence: '0' }), 412);
    assert.equal(await count(), 1);
    const outcomes = await Promise.allSettled([checkpoint(editor), checkpoint(peer)]);
    assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = outcomes.find(result => result.status === 'rejected'); assert(rejected?.status === 'rejected');
    assert(rejected.reason instanceof HttpProblem); assert.equal(rejected.reason.status, 412);
    document = await read(); assert.equal(await count(), 2); assert.equal(document.lockVersion, 3);
    assert.equal((await core.search.find(reader, { query: 'checkpointmarker' })).items[0]?.id, id);
    assert.match(JSON.stringify(await core.documents.exportNative(reader, id)), /checkpointmarker/);
    const before = document; assert.deepEqual(await checkpoint(), before); assert.deepEqual(await read(), before);
    assert.equal(await count(), 2);
  });
  await t.test('live attachment references remain document-owned and checkpoint allowlists are transactional', async () => {
    const other = await create(), bytes = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#648574' } }).png().toBuffer();
    const foreign = await core.attachments.upload(editor, other.id, 'Synthetic.png', bytes);
    const own = await core.attachments.upload(editor, id, 'Synthetic.png', bytes);
    const engine = ServerBlockNoteEditor.create({ schema: contentSchema });
    const withImage = (url: string) => frame(room.state, doc => {
      const blocks = readLiveState(room.state).content.document;
      const native = validateContent({ ...document.revision.content,
        document: [...blocks, { id: 'synthetic-live-image', type: 'image', props: { url } }] }).content;
      engine.blocksToYXmlFragment(native.document, doc.getXmlFragment('document'));
    });
    const before = await savedRoom();
    await problem(core.documents.live.update(editor, id, room.epoch, withImage(foreign.url)), 400, 'INVALID_ATTACHMENT_REFERENCE');
    assert.deepEqual(await savedRoom(), before); assert.equal(await count(), 2);
    room = await core.documents.live.update(editor, id, room.epoch, withImage(own.url));
    assert.equal(await database.prisma.revisionAttachment.count({ where: { attachmentId: own.id } }), 0);
    // The accepted live image is included in the next explicit checkpoint,
    // whose existing append transaction creates its historical allowlist.
  });
  await t.test('temporary blank title and failed database writes preserve committed state and history', async () => {
    room = await core.documents.live.update(editor, id, room.epoch, frame(room.state, doc => title(doc).delete(0, title(doc).length)));
    await problem(checkpoint(), 400);
    await problem(core.documents.live.restore(editor, id, { epoch: room.epoch, sequence: room.sequence, revisionId: firstRevision }, documentEtag(document)), 409, 'LIVE_CHECKPOINT_REQUIRED');
    room = await core.documents.live.update(editor, id, room.epoch, frame(room.state, doc => title(doc).insert(0, document.revision.title)));
    const before = await savedRoom();
    await database.pool.query(`CREATE FUNCTION fail_live_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic live fault'; END $$;
      CREATE TRIGGER live_fault BEFORE UPDATE ON "DocumentLive" FOR EACH ROW EXECUTE FUNCTION fail_live_update()`);
    try { await assert.rejects(core.documents.live.update(editor, id, room.epoch, frame(room.state, doc => text(doc).insert(0, 'Rejected ')))); }
    finally { await database.pool.query('DROP TRIGGER live_fault ON "DocumentLive"; DROP FUNCTION fail_live_update()'); }
    assert.deepEqual(await savedRoom(), before); assert.deepEqual(await read(), document); assert.equal(await count(), 2);
    room = await core.documents.live.update(editor, id, room.epoch, frame(room.state, doc => text(doc).insert(0, 'Pending ')));
    const accepted = await savedRoom();
    await database.pool.query(`CREATE FUNCTION fail_live_head() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic checkpoint fault'; END $$;
      CREATE TRIGGER head_fault BEFORE UPDATE ON "Document" FOR EACH ROW EXECUTE FUNCTION fail_live_head()`);
    try { await assert.rejects(checkpoint()); }
    finally { await database.pool.query('DROP TRIGGER head_fault ON "Document"; DROP FUNCTION fail_live_head()'); }
    assert.deepEqual(await savedRoom(), accepted); assert.deepEqual(await read(), document); assert.equal(await count(), 2);
    assert.equal(await database.prisma.revisionAttachment.count({ where: { documentId: id } }), 0);
    document = await checkpoint(); assert.equal(await count(), 3);
    assert.equal(await database.prisma.revisionAttachment.count({ where: { documentId: id, revisionId: document.revision.id } }), 1);
  });
  await t.test('restore appends a checkpoint, retains the old epoch and refuses cross-document revisions and old frames', async () => {
    const other = await create(); const previousRoom = await savedRoom(), old = room;
    await problem(core.documents.live.restore(editor, id, { epoch: room.epoch, sequence: room.sequence, revisionId: other.revision.id }, documentEtag(document)), 404);
    const restored = await core.documents.live.restore(editor, id, { epoch: room.epoch, sequence: room.sequence, revisionId: firstRevision }, documentEtag(document));
    assert.equal(restored.document.lockVersion, document.lockVersion + 1); assert.equal(restored.document.currentRevisionNumber, 4);
    assert.notEqual(restored.document.revision.id, firstRevision); assert.equal(restored.room.sequence, '0'); assert.notEqual(restored.room.epoch, room.epoch);
    assert.deepEqual(await savedRoom(), previousRoom);
    document = restored.document; room = restored.room;
    await problem(core.documents.live.update(editor, id, old.epoch, frame(old.state, doc => text(doc).insert(0, 'Old epoch '))), 412);
    assert.deepEqual(readLiveState(room.state).content, document.revision.content);
    assert.equal(await count(), 4);
  });
  await t.test('archive preserves live state and history; unarchive rechecks current access', async () => {
    const before = await savedRoom(); document = await core.documents.archive(editor, id, documentEtag(document));
    await problem(core.documents.live.read(reader, id), 409, 'DOCUMENT_ARCHIVED');
    await problem(core.documents.live.update(editor, id, room.epoch, room.state), 409, 'DOCUMENT_ARCHIVED');
    document = await core.documents.unarchive(editor, id, documentEtag(document));
    room = await core.documents.live.read(editor, id); assert.deepEqual(await savedRoom(), before); assert.equal(await count(), 4);
  });
  await t.test('authenticated malformed and protected client updates leave durable bytes and history unchanged', async () => {
    const before = await savedRoom();
    await problem(core.documents.live.update(editor, id, room.epoch, Uint8Array.of(255)), 400);
    await problem(core.documents.live.update(editor, id, room.epoch, new Uint8Array(1024 * 1024 + 1)), 413);
    await problem(core.documents.live.update(editor, id, room.epoch, frame(room.state, doc => doc.getMap('threads').set('forged', 'author'))), 403);
    await problem(core.documents.live.update(editor, id, room.epoch, frame(room.state, doc => doc.getMap('unknown').set('hidden', 'content'))), 400);
    assert.deepEqual(await savedRoom(), before); assert.equal(await count(), 4);
  });
  await t.test('recipient account recovery waits for durable acceptance, then is excluded from subsequent delivery receipts', async () => {
    const gate = await database.pool.connect();
    await gate.query('SELECT pg_advisory_lock(7242031, hashtext($1))', [schema]);
    await database.pool.query(`CREATE FUNCTION pause_live_acceptance() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_advisory_xact_lock(7242031, hashtext('${schema}')); RETURN NEW; END $$;
      CREATE TRIGGER acceptance_gate BEFORE UPDATE ON "DocumentLive" FOR EACH ROW EXECUTE FUNCTION pause_live_acceptance()`);
    let released = false;
    const pending: Promise<unknown>[] = [];
    try {
      const accepted = core.documents.live.update(editor, id, room.epoch, frame(room.state, doc => text(doc).insert(0, 'Durably accepted ')), connections);
      pending.push(accepted);
      await waitForLock('DocumentLive');
      let recovered = false;
      const recovery = operator.recover(readerUser.email, randomBytes(24).toString('base64url')).then(() => { recovered = true; });
      pending.push(recovery);
      await waitForLock('user'); assert.equal(recovered, false);
      await gate.query('SELECT pg_advisory_unlock(7242031, hashtext($1))', [schema]); released = true;
      const receipt = await accepted; room = receipt;
      assert.equal(receipt.recipients.find(connection => connection.connectionId === 'reader')?.canWrite, false);
      await recovery;
      assert(Buffer.from((await savedRoom()).state).equals(Buffer.from(receipt.state)));
      assert.match(readLiveState(room.state).plainText, /Durably accepted/); assert.equal(await count(), 4);
      const current = await core.documents.live.authorizeConnections(editor, id, room.epoch, connections);
      assert.deepEqual(current.recipients.map(connection => connection.connectionId), ['administrator', 'editor', 'peer']);
      await problem(core.documents.live.read(reader, id), 401);
    } finally {
      if (!released) await gate.query('SELECT pg_advisory_unlock(7242031, hashtext($1))', [schema]);
      await Promise.allSettled(pending);
      gate.release();
      await database.pool.query('DROP TRIGGER acceptance_gate ON "DocumentLive"; DROP FUNCTION pause_live_acceptance()');
    }
  });
  await t.test('revoked grants and recovered sessions are rechecked after waiting for locks', async () => {
    const blocked = async (headers: Headers, revoke: () => Promise<unknown>, expected: number) => {
      const connection = await database.pool.connect();
      try {
        await connection.query('BEGIN'); await connection.query('SELECT "id" FROM "Document" WHERE "id"=$1 FOR UPDATE', [id]);
        const pending = core.documents.live.update(headers, id, room.epoch, frame(room.state, doc => text(doc).insert(0, 'Denied ')));
        // Observe the operation waiting on this document, rather than guessing with a sleep.
        await waitForLock('Document');
        await revoke(); await connection.query('COMMIT'); await problem(pending, expected);
      } finally { await connection.query('ROLLBACK'); connection.release(); }
    };
    const before = await savedRoom();
    await blocked(peer, () => operator.recover(peerUser.email, randomBytes(24).toString('base64url')), 401);
    // Membership writes take the space lock first. Revoke before releasing a
    // held space lock so the waiting operation cannot observe an old grant.
    const connection = await database.pool.connect();
    try {
      await connection.query('BEGIN'); await connection.query('SELECT "id" FROM "Space" WHERE "id"=$1 FOR UPDATE', [space.id]);
      const pending = core.documents.live.update(editor, id, room.epoch, room.state);
      await waitForLock('Space');
      await connection.query('DELETE FROM "SpaceMembership" WHERE "spaceId"=$1 AND "userId"=$2', [space.id, editorUser.id]);
      await connection.query('COMMIT'); await problem(pending, 404);
    } finally { await connection.query('ROLLBACK'); connection.release(); }
    assert.deepEqual(await savedRoom(), before); assert.equal(await count(), 4);
    await problem(core.documents.live.read(editor, id), 404);
  });
  await t.test('the current live pointer is checked at commit and cannot reference another document', async () => {
    const other = await core.documents.create(admin, space.id, { title: 'Retained solo document', content: demoContent(['Untouched history']) });
    const before = await core.documents.read(admin, other.id);
    await assert.rejects(database.prisma.$transaction(async tx => {
      await tx.document.update({ where: { id: other.id }, data: { liveEpoch: room.epoch } });
    }));
    assert.deepEqual(await core.documents.read(admin, other.id), before);
    assert.equal((await database.prisma.document.findUniqueOrThrow({ where: { id: other.id } })).liveEpoch, null);
    assert.equal(await database.prisma.documentLive.count({ where: { documentId: other.id } }), 0);
  });
});

test('live migration preserves populated solo documents, immutable revisions and existing metadata', async t => {
  const base = readConfig(process.env), url = new URL(base.databaseUrl);
  assert(base.nodeEnv !== 'production' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  const owner = createDatabase(base, () => {}), schema = 'scrawl_test_live_upgrade_' + randomUUID().replaceAll('-', '');
  await owner.pool.query(`CREATE SCHEMA "${schema}"`); url.searchParams.set('schema', schema);
  const database = createDatabase({ ...base, databaseUrl: url.href }, () => {});
  t.after(async () => { await database.close(); await owner.pool.query(`DROP SCHEMA "${schema}" CASCADE`); await owner.close(); });
  const liveMigration = '20261001000000_live_documents';
  const history = (await readdir('prisma/migrations', { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  for (const name of history.filter(name => name < liveMigration)) await database.pool.query(await readFile(`prisma/migrations/${name}/migration.sql`, 'utf8'));
  await database.pool.query(`INSERT INTO "user" ("id","name","email","updatedAt") VALUES ('synthetic-live-upgrade','Synthetic','live-upgrade@example.test',now())`);
  const spaceId = randomUUID(), documentId = randomUUID();
  await database.pool.query(`INSERT INTO "Space" ("id","name","slug","createdBy","updatedAt") VALUES ($1,'Retained handbook','retained-handbook','synthetic-live-upgrade',now())`, [spaceId]);
  const connection = await database.pool.connect();
  try {
    await connection.query('BEGIN');
    await connection.query(`INSERT INTO "Document" ("id","spaceId","slug","currentRevisionNumber","lockVersion","createdBy","updatedAt") VALUES ($1,$2,'retained-page',2,4,'synthetic-live-upgrade',now())`, [documentId, spaceId]);
    for (const number of [1, 2]) await connection.query(`INSERT INTO "DocumentRevision" ("id","documentId","revisionNumber","title","contentFormat","contentSchemaVersion","contentEditorVersion","body","plainText","authorId")
      VALUES ($1,$2,$3,'Retained title','blocknote-json',1,'0.55.0',$4,'Retained body','synthetic-live-upgrade')`, [randomUUID(), documentId, number, JSON.stringify(demoContent(['Retained body']).document)]);
    await connection.query('COMMIT');
  } finally { connection.release(); }
  const fingerprint = () => Promise.all(['user', 'Space', 'Document', 'DocumentRevision'].map(async table =>
    (await database.pool.query(`SELECT to_jsonb(t) - 'liveEpoch' AS snapshot FROM "${table}" t ORDER BY "id"`)).rows));
  const before = await fingerprint();
  await database.pool.query(await readFile(`prisma/migrations/${liveMigration}/migration.sql`, 'utf8'));
  assert.deepEqual(await fingerprint(), before);
  assert.equal(await database.prisma.documentLive.count(), 0);
  assert.equal((await database.prisma.document.findUniqueOrThrow({ where: { id: documentId } })).liveEpoch, null);
  const constraint = await database.pool.query(`SELECT condeferrable, condeferred FROM pg_constraint WHERE conrelid=$1::regclass AND conname='Document_id_liveEpoch_fkey'`, [`"${schema}"."Document"`]);
  assert.deepEqual(constraint.rows, [{ condeferrable: true, condeferred: true }]);
});
