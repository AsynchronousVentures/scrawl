// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { readConfig } from '../../src/config.js';
import { createDatabase } from '../../src/db/client.js';
import { createCore } from '../../src/core/index.js';
import { createOperator } from '../../src/core/identity/operator.js';
import { documentEtag } from '../../src/core/documents/index.js';
import { spaceEtag } from '../../src/core/spaces/index.js';
import { HttpProblem } from '../../src/http/problems.js';
import { buildApp } from '../../src/app.js';
import { validateContent } from '../../src/core/documents/content.js';

async function fixture(t: test.TestContext) {
  const base = readConfig(process.env), target = new URL(base.databaseUrl);
  assert(base.nodeEnv !== 'production' && ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname));
  const administrator = createDatabase(base, () => {}), schema = 'scrawl_slugs_' + randomUUID().replaceAll('-', '');
  await administrator.pool.query(`CREATE SCHEMA "${schema}"`);
  target.searchParams.set('schema', schema);
  target.searchParams.set('application_name', schema);
  const config = { ...base, databaseUrl: target.href }, database = createDatabase(config, () => {});
  t.after(async () => { await database.close(); await administrator.pool.query(`DROP SCHEMA "${schema}" CASCADE`); await administrator.close(); });
  return { config, database };
}

const content = validateContent({ format: 'blocknote-json', schemaVersion: 1, editorVersion: '0.55.0',
  document: [{ id: 'synthetic-slug-body', type: 'paragraph', content: [{ type: 'text', text: 'Synthetic retained body', styles: {} }] }] }).content;
const denied = (error: unknown) => error instanceof HttpProblem && error.status === 404;

test('persisted readable slugs handle concurrent collisions and enforce current access', async t => {
  const { config, database } = await fixture(t);
  const migration = spawnSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: config.databaseUrl }, encoding: 'utf8',
  });
  assert.equal(migration.status, 0, 'The complete migration history must deploy');
  const identity = { origin: 'http://127.0.0.1:3000', secret: randomBytes(32).toString('hex'), secureCookies: false };
  const core = createCore(database.prisma, identity), operator = createOperator(database.prisma, identity);
  const app = await buildApp({ config, core, checkDatabase: () => database.ping(), logging: false });
  t.after(() => app.close());
  const password = randomBytes(24).toString('base64url');
  await operator.bootstrap({ email: 'slug-owner@example.test', name: 'Synthetic owner', password });
  const member = await operator.provision({ email: 'slug-reader@example.test', name: 'Synthetic reader', password });
  await operator.provision({ email: 'slug-outsider@example.test', name: 'Synthetic outsider', password });
  async function signIn(email: string, peer: string) {
    const response = await app.inject({ method: 'POST', url: '/api/auth/sign-in/email', remoteAddress: peer,
      headers: { origin: identity.origin }, payload: { email, password } });
    assert.equal(response.statusCode, 200);
    const cookies = response.headers['set-cookie']; assert(cookies);
    return new Headers({ cookie: (Array.isArray(cookies) ? cookies : [cookies]).map(value => value.split(';')[0]).join('; ') });
  }
  const owner = await signIn('slug-owner@example.test', '127.0.0.51');
  const reader = await signIn(member.email, '127.0.0.52');
  const outsider = await signIn('slug-outsider@example.test', '127.0.0.53');
  const spaces = await Promise.all([core.spaces.create(owner, 'Café handbook'), core.spaces.create(owner, 'Cafe handbook')]);
  assert.deepEqual(spaces.map(space => space.slug).sort(), ['cafe-handbook', 'cafe-handbook-2']);
  const space = spaces.find(space => space.slug === 'cafe-handbook')!;
  const otherSpace = spaces.find(candidate => candidate.id !== space.id)!;
  const granted = await core.spaces.changeMembership(owner, { spaceId: space.id, userId: member.id, role: 'reader', expectedEtag: spaceEtag(space) });
  const documents = await Promise.all([core.documents.create(owner, space.id, { title: 'Getting started', content }),
    core.documents.create(owner, space.id, { title: 'Getting started', content })]);
  assert.deepEqual(documents.map(document => document.slug).sort(), ['getting-started', 'getting-started-2']);
  const original = documents.find(document => document.slug === 'getting-started')!;

  await t.test('slugs are scoped, bounded, collision-safe and reserved after archive', async () => {
    const numeric = await core.documents.create(owner, space.id, { title: 'Getting started 2', content });
    assert.equal(numeric.slug, 'getting-started-2-2');
    assert.equal((await core.documents.create(owner, otherSpace.id, { title: 'Getting started', content })).slug, 'getting-started');
    assert.equal((await core.documents.create(owner, space.id, { title: '✨', content })).slug, 'document');
    const long = await core.documents.create(owner, space.id, { title: 'a'.repeat(200), content });
    assert.equal(long.slug, 'a'.repeat(64));
    const archived = await core.documents.archive(owner, original.id, documentEtag(original));
    assert.equal((await core.documents.create(owner, space.id, { title: 'Getting started', content })).slug, 'getting-started-3');
    await core.documents.unarchive(owner, original.id, documentEtag(archived));
  });

  await t.test('title saves, restore and slug reads keep identity, head and ETag contracts', async () => {
    const current = await core.documents.read(owner, original.id);
    const saved = await core.documents.update(owner, original.id, { title: 'A new title', content }, documentEtag(current));
    const restored = await core.documents.restore(owner, original.id, { revisionId: original.revision.id }, documentEtag(saved));
    assert.equal(saved.slug, original.slug); assert.equal(restored.slug, original.slug);
    assert.equal(restored.currentRevisionNumber, 3);
    assert.deepEqual(await core.documents.readBySlug(reader, space.id, original.slug), restored);
    const response = await app.inject({ url: `/api/v1/spaces/${space.id}/documents/by-slug/${original.slug}`, headers: { cookie: reader.get('cookie')! } });
    assert.equal(response.statusCode, 200); assert.equal(response.headers.etag, documentEtag(restored));
    assert.equal(response.json<{ id: string; spaceSlug: string }>().id, original.id);
    assert.equal(response.json<{ spaceSlug: string }>().spaceSlug, space.slug);
  });

  await t.test('outsiders and revoked sessions cannot resolve slugs or discover metadata', async () => {
    for (const path of [`/api/v1/spaces/by-slug/${space.slug}`, `/api/v1/spaces/${space.id}/documents/by-slug/${original.slug}`]) {
      for (const [headers, status] of [[outsider, 404], [new Headers(), 401]] as const) {
        const response = await app.inject({ url: path, headers: { cookie: headers.get('cookie') ?? '' } });
        assert.equal(response.statusCode, status);
        assert(!response.body.includes('Getting started') && !response.body.includes('revisionNumber') && !response.body.includes(space.slug));
      }
    }
    await assert.rejects(core.spaces.readBySlug(outsider, space.slug), denied);
    await assert.rejects(core.documents.readBySlug(outsider, space.id, original.slug), denied);
    await assert.rejects(core.documents.readBySlug(reader, space.id, 'missing-document'), denied);
    await core.spaces.changeMembership(owner, { spaceId: space.id, userId: member.id, role: null, expectedEtag: spaceEtag(granted) });
    await assert.rejects(core.spaces.readBySlug(reader, space.slug), denied);
    await assert.rejects(core.documents.readBySlug(reader, space.id, original.slug), denied);
  });

  await t.test('space creation rechecks a revoked session after waiting for the slug lock', async () => {
    const blocker = await database.pool.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT pg_advisory_xact_lock(1935897196, 1)');
    const count = await database.prisma.space.count();
    const pending = core.spaces.create(owner, 'Must not be created after recovery');
    const rejected = assert.rejects(pending, (error: unknown) => error instanceof HttpProblem && error.status === 401);
    try {
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const result = await database.pool.query<{ waiting: boolean }>(`SELECT EXISTS (SELECT 1 FROM pg_locks l
          JOIN pg_stat_activity a ON a.pid = l.pid WHERE l.locktype = 'advisory' AND l.classid = 1935897196
          AND l.objid = 1 AND NOT l.granted AND a.application_name = current_schema()) AS waiting`);
        if (result.rows[0]?.waiting) { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert(waiting, 'The creation must actually wait for the namespace lock');
      await operator.recover('slug-owner@example.test', randomBytes(24).toString('base64url'));
    } finally { await blocker.query('ROLLBACK'); blocker.release(); }
    await rejected;
    assert.equal(await database.prisma.space.count(), count);
  });
});

test('slug migration backfills retained rows without changing content, heads or versions', async t => {
  const { database } = await fixture(t);
  const migrations = (await readdir('prisma/migrations', { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  const slugMigration = '20260930060000_readable_slugs';
  for (const name of migrations.filter(name => name < slugMigration)) await database.pool.query(await readFile(`prisma/migrations/${name}/migration.sql`, 'utf8'));
  await database.pool.query(`INSERT INTO "user" ("id", "name", "email", "updatedAt") VALUES ('synthetic-slugs', 'Synthetic', 'retained-slugs@example.test', now())`);
  const spaceId = randomUUID();
  await database.pool.query(`INSERT INTO "Space" ("id", "name", "createdBy", "updatedAt") VALUES ($1, 'Café handbook', 'synthetic-slugs', now())`, [spaceId]);
  const connection = await database.pool.connect();
  try {
    await connection.query('BEGIN');
    for (const title of ['Getting started', 'Getting started', 'Getting started 2', '✨', 'a'.repeat(200)]) {
      const id = randomUUID();
      await connection.query(`INSERT INTO "Document" ("id", "spaceId", "currentRevisionNumber", "createdBy", "updatedAt") VALUES ($1, $2, 1, 'synthetic-slugs', now())`, [id, spaceId]);
      await connection.query(`INSERT INTO "DocumentRevision" ("id", "documentId", "revisionNumber", "title", "contentFormat", "contentSchemaVersion", "contentEditorVersion", "body", "plainText", "authorId")
        VALUES ($1, $2, 1, $3, 'blocknote-json', 1, '0.55.0', $4, 'Synthetic retained body', 'synthetic-slugs')`, [randomUUID(), id, title, JSON.stringify(content.document)]);
    }
    await connection.query('COMMIT');
  } finally { connection.release(); }
  async function snapshots() {
    return Promise.all(['Space', 'Document', 'DocumentRevision'].map(async table =>
      (await database.pool.query(`SELECT to_jsonb(t) - 'slug' AS snapshot FROM "${table}" t ORDER BY "id"`)).rows));
  }
  const before = await snapshots();
  await database.pool.query(await readFile(`prisma/migrations/${slugMigration}/migration.sql`, 'utf8'));
  assert.deepEqual(await snapshots(), before);
  assert.equal((await database.prisma.space.findUniqueOrThrow({ where: { id: spaceId } })).slug, 'cafe-handbook');
  const assigned = await database.prisma.document.findMany({ select: { slug: true } });
  assert.equal(new Set(assigned.map(document => document.slug)).size, 5);
  assert(assigned.every(document => document.slug.length <= 80 && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(document.slug)));
});
