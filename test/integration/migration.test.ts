// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { readConfig } from '../../src/config.js';
import { createDatabase } from '../../src/db/client.js';
import { createCore } from '../../src/core/index.js';
import { createOperator } from '../../src/core/identity/operator.js';
import { buildApp } from '../../src/app.js';

test('P2 migration preserves populated P1 identity, sessions, spaces, and memberships', async (t) => {
  const baseConfig = readConfig(process.env);
  const url = new URL(baseConfig.databaseUrl);
  assert(baseConfig.nodeEnv !== 'production' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname),
    'Migration fixtures require a local non-production database');
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

  function migrate(args: string[]) {
    const result = spawnSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', ...args], {
      env: { ...process.env, DATABASE_URL: config.databaseUrl }, encoding: 'utf8',
    });
    assert.equal(result.status, 0, 'The migration command must succeed');
  }
  const p1Migration = '20260930000000_identity_spaces';
  // Install exactly the baseline migration, then record it with Prisma's supported baselining command.
  await database.pool.query(await readFile(`prisma/migrations/${p1Migration}/migration.sql`, 'utf8'));
  migrate(['resolve', '--applied', p1Migration]);
  const missingP2 = await database.pool.query<{ relation: string | null }>('SELECT to_regclass(\'"Document"\')::text AS relation');
  assert.equal(missingP2.rows[0]?.relation, null);

  const password = randomBytes(24).toString('base64url');
  const owner = await operator.bootstrap({ email: 'upgrade-owner@example.test', name: 'Upgrade Owner', password });
  const member = await operator.provision({ email: 'upgrade-reader@example.test', name: 'Upgrade Reader', password });
  async function signIn(email: string, peer: string) {
    const response = await app.inject({ method: 'POST', url: '/api/auth/sign-in/email', remoteAddress: peer,
      headers: { origin: identityConfig.origin }, payload: { email, password } });
    assert.equal(response.statusCode, 200);
    const cookies = response.headers['set-cookie'];
    assert(cookies);
    return (Array.isArray(cookies) ? cookies : [cookies]).map((value) => value.split(';')[0]).join('; ');
  }
  const ownerCookie = await signIn(owner.email, '127.0.0.31');
  const memberCookie = await signIn(member.email, '127.0.0.32');
  const ownerHeaders = new Headers({ cookie: ownerCookie });
  // Seed the historical P1 schema directly. Current operations require slug
  // columns that this upgrade fixture deliberately has not installed yet.
  const space = { id: randomUUID() };
  await database.pool.query(`INSERT INTO "Space" ("id", "name", "createdBy", "updatedAt", "lockVersion")
    VALUES ($1, 'Synthetic baseline space', $2, now(), 2)`, [space.id, owner.id]);
  await database.pool.query(`INSERT INTO "SpaceMembership" ("spaceId", "userId", "role", "updatedAt")
    VALUES ($1, $2, 'reader', now())`, [space.id, member.id]);
  async function baselineFingerprint() {
    // Comparing digests prevents assertion failures from printing persisted credential/session values.
    const rows = await Promise.all([
      database.prisma.user.findMany({ orderBy: { id: 'asc' } }),
      database.prisma.account.findMany({ orderBy: { id: 'asc' } }),
      database.prisma.session.findMany({ orderBy: { id: 'asc' } }),
      database.prisma.space.findMany({ orderBy: { id: 'asc' }, select: {
        id: true, name: true, createdBy: true, createdAt: true, updatedAt: true, lockVersion: true,
      } }),
      database.prisma.spaceMembership.findMany({ orderBy: [{ spaceId: 'asc' }, { userId: 'asc' }] }),
    ]);
    return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  }
  const before = await baselineFingerprint();
  assert.equal(await database.prisma.user.count(), 2);
  assert.equal(await database.prisma.session.count(), 2);
  migrate(['deploy']);
  migrate(['deploy']);
  assert.equal(await baselineFingerprint(), before, 'Every persisted P1 record must remain unchanged');
  assert.equal((await database.prisma.space.findUniqueOrThrow({ where: { id: space.id } })).slug, 'synthetic-baseline-space');
  assert.equal(await database.prisma.document.count(), 0);
  assert.equal(await database.prisma.documentRevision.count(), 0);
  for (const [cookie, user] of [[ownerCookie, owner], [memberCookie, member]] as const) {
    const me = await app.inject({ url: '/api/v1/me', headers: { cookie } });
    assert.equal(me.statusCode, 200);
    assert.equal(me.json<{ id: string }>().id, user.id);
    assert.equal((await app.inject({ url: `/api/v1/spaces/${space.id}`, headers: { cookie } })).statusCode, 200);
  }
  await signIn(member.email, '127.0.0.33');
  const constraints = await database.pool.query<{ condeferrable: boolean; condeferred: boolean }>(`
    SELECT condeferrable, condeferred FROM pg_constraint
      WHERE conrelid = $1::regclass AND conname = 'Document_id_currentRevisionNumber_fkey'`, [`"${schema}"."Document"`]);
  assert.deepEqual(constraints.rows, [{ condeferrable: true, condeferred: true }]);
});
