// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { readConfig } from '../../src/config.js';
import { createDatabase } from '../../src/db/client.js';
import { createCore } from '../../src/core/index.js';
import { createOperator } from '../../src/core/identity/operator.js';
import { createAuth } from '../../src/core/identity/auth.js';
import { HttpProblem } from '../../src/http/problems.js';
import { buildApp } from '../../src/app.js';

const password = randomBytes(24).toString('base64url');

test('P1 identity and space acceptance against migrated PostgreSQL and real HTTP sessions', async (t) => {
  const baseConfig = readConfig(process.env);
  const url = new URL(baseConfig.databaseUrl);
  assert(baseConfig.nodeEnv !== 'production' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname),
    'Integration fixtures require a local non-production database');
  const adminDatabase = createDatabase(baseConfig, () => {});
  const schema = 'scrawl_test_' + randomUUID().replaceAll('-', '');
  await adminDatabase.pool.query(`CREATE SCHEMA "${schema}"`);
  url.searchParams.set('schema', schema);
  url.searchParams.set('application_name', schema);
  const config = { ...baseConfig, apiDocsEnabled: true, databaseUrl: url.href };
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
  assert.equal(migration.status, 0, 'Migration must succeed from an empty isolated schema');
  const secondMigration = spawnSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: config.databaseUrl }, encoding: 'utf8',
  });
  assert.equal(secondMigration.status, 0, 'Reapplying migrations must be safe');
  assert.equal(await database.prisma.user.count(), 0);
  const address = await app.listen({ host: '127.0.0.1', port: 0 });

  function client(peer: string) {
    let cookie = '';
    return {
      get cookie() { return cookie; },
      set cookie(value: string) { cookie = value; },
      async send(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
        const payload = body === undefined ? undefined : JSON.stringify(body);
        // JSON.parse is the external test boundary; each scenario asserts its wire contract below.
        return new Promise<{ status: number; body: string; data: ReturnType<typeof JSON.parse>; headers: import('node:http').IncomingHttpHeaders }>((resolve, reject) => {
          const req = httpRequest(new URL(path, address), {
            method, localAddress: peer,
            headers: {
              origin: identityConfig.origin,
              ...(cookie ? { cookie } : {}),
              ...(payload ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) } : {}),
              ...headers,
            },
          }, (response) => {
            const chunks: Buffer[] = [];
            response.on('data', (chunk: Buffer) => chunks.push(chunk));
            response.on('error', reject);
            response.on('end', () => {
              const cookies = response.headers['set-cookie'];
              if (cookies) cookie = cookies.map((c) => c.split(';')[0]).join('; ');
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
  const admin = client('127.0.0.2');
  const reader = client('127.0.0.3');
  const editor = client('127.0.0.4');
  const outsider = client('127.0.0.5');
  const anonymous = client('127.0.0.6');
  let adminUser: { id: string; email: string };
  let adminPassword = password;

  await t.test('concurrent bootstrap creates exactly one owner and cannot overwrite existing accounts', async () => {
    const attempts = await Promise.allSettled([
      operator.bootstrap({ email: 'owner-a@example.test', name: 'Owner A', password }),
      operator.bootstrap({ email: 'owner-b@example.test', name: 'Owner B', password }),
    ]);
    const winner = attempts.find((r) => r.status === 'fulfilled');
    assert(winner?.status === 'fulfilled');
    adminUser = winner.value;
    assert.equal(attempts.filter((r) => r.status === 'rejected').length, 1);
    assert.equal(await database.prisma.user.count(), 1);
    assert.equal(await database.prisma.account.count(), 1);
    await assert.rejects(operator.bootstrap({ email: adminUser.email, name: 'Replacement', password }), /already has users/);
    assert.equal((await database.prisma.user.findUniqueOrThrow({ where: { id: adminUser.id } })).name, adminUser.email.includes('owner-a') ? 'Owner A' : 'Owner B');
    // An instance with users but no administrator must not become bootstrap-eligible.
    await database.prisma.user.update({ where: { id: adminUser.id }, data: { role: 'member' } });
    await assert.rejects(operator.bootstrap({ email: 'takeover@example.test', name: 'Takeover', password }), /already has users/);
    await database.prisma.user.update({ where: { id: adminUser.id }, data: { role: 'administrator' } });
  });

  const readerUser = await operator.provision({ email: 'reader@example.test', name: 'Reader', password });
  const editorUser = await operator.provision({ email: 'editor@example.test', name: 'Editor', password });
  await operator.provision({ email: 'outsider@example.test', name: 'Outsider', password });

  await t.test('provisioning is member-only and failures leave no orphan credential records', async () => {
    assert.equal(readerUser.role, 'member');
    await assert.rejects(operator.provision({ email: readerUser.email, name: 'Replacement', password }));
    await assert.rejects(operator.provision({ email: 'invalid-email', name: 'Bad', password }));
    await assert.rejects(operator.provision({ email: 'short@example.test', name: 'Bad', password: 'short' }));
    assert.equal(await database.prisma.user.count(), 4);
    assert.equal(await database.prisma.account.count(), 4);
    const accounts = await database.prisma.account.findMany();
    assert(accounts.every((a) => a.providerId === 'credential' && a.password && a.password !== password));
  });

  await t.test('credential insertion failure rolls back the already-created auth user', async () => {
    await database.pool.query(`CREATE FUNCTION fail_credential() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Injected credential failure'; END $$`);
    await database.pool.query('CREATE TRIGGER fail_credential BEFORE INSERT ON "account" FOR EACH ROW EXECUTE FUNCTION fail_credential()');
    try {
      await assert.rejects(operator.provision({ email: 'rollback@example.test', name: 'Rollback', password }));
      assert.equal(await database.prisma.user.count({ where: { email: 'rollback@example.test' } }), 0);
      assert.equal(await database.prisma.account.count(), 4);
    } finally {
      await database.pool.query('DROP TRIGGER fail_credential ON "account"');
      await database.pool.query('DROP FUNCTION fail_credential()');
    }
  });

  await t.test('registration, HTTP provisioning/recovery, and role-assignment endpoints are absent', async () => {
    for (const path of ['/sign-up/email', '/admin/create-user', '/admin/set-role', '/request-password-reset', '/reset-password']) {
      assert.equal((await anonymous.send('POST', '/api/auth' + path, {
        email: 'takeover@example.test', password, name: 'Takeover', role: 'administrator',
      })).status, 404);
    }
    await assert.rejects(createAuth(database.prisma, identityConfig).api.signUpEmail({ body: { email: 'takeover@example.test', password, name: 'Takeover' } }));
    assert.equal(await database.prisma.user.count(), 4);
  });

  await t.test('real sign-in creates HttpOnly sessions and returns safe auth DTOs', async () => {
    for (const [agent, email] of [[admin, adminUser!.email], [reader, readerUser.email], [editor, editorUser.email], [outsider, 'outsider@example.test']] as const) {
      const result = await agent.send('POST', '/api/auth/sign-in/email', { email, password, role: 'administrator' });
      assert.equal(result.status, 200);
      assert(result.headers['set-cookie']?.some((c) => c.includes('HttpOnly') && /SameSite=Lax/i.test(c)));
      assert(!result.body.includes(password));
      assert(!('token' in result.data));
      assert(!('password' in result.data.user));
      assert.equal((await agent.send('GET', '/api/v1/me')).status, 200);
    }
    assert.equal((await reader.send('GET', '/api/v1/me')).data.role, 'member');
    const session = await reader.send('GET', '/api/auth/get-session');
    assert.equal(session.status, 200);
    assert.deepEqual(Object.keys(session.data.session), ['expiresAt']);
    assert(!session.body.includes(reader.cookie));
  });

  let spaceId: string;
  let etag: string;
  let privateSpaceId: string;
  await t.test('administrator creates spaces; anonymous and members cannot create', async () => {
    assert.equal((await anonymous.send('GET', '/api/v1/me')).status, 401);
    assert.equal((await anonymous.send('GET', '/api/v1/spaces')).status, 401);
    assert.equal((await anonymous.send('POST', '/api/v1/spaces', { name: 'Denied' })).status, 401);
    assert.equal((await reader.send('POST', '/api/v1/spaces', { name: 'Denied' })).status, 403);
    assert.equal((await admin.send('POST', '/api/v1/spaces', { name: 'Forged', createdBy: readerUser.id })).status, 400);
    const result = await admin.send('POST', '/api/v1/spaces', { name: 'Synthetic shared space' });
    assert.equal(result.status, 201);
    assert.equal(result.data.createdBy, adminUser!.id);
    assert.equal(result.data.lockVersion, 1);
    assert.equal(result.data.access, 'editor');
    spaceId = result.data.id;
    etag = String(result.headers.etag);
    privateSpaceId = (await admin.send('POST', '/api/v1/spaces', { name: 'Synthetic hidden space' })).data.id;
  });

  await t.test('membership writes enforce one strong space precondition before changing access', async () => {
    const path = `/api/v1/spaces/${spaceId}/members/${readerUser.id}`;
    assert.equal((await admin.send('PUT', path, { role: 'reader' })).status, 428);
    for (const invalid of [`W/${etag}`, '*', `${etag}, ${etag}`]) {
      assert.equal((await admin.send('PUT', path, { role: 'reader' }, { 'if-match': invalid })).status, 400);
    }
    assert.equal((await admin.send('PUT', path, { role: 'reader' }, { 'if-match': '"unknown-tag"' })).status, 412);
    assert.equal(await database.prisma.spaceMembership.count(), 0);
    const result = await admin.send('PUT', path, { role: 'reader' }, { 'if-match': etag });
    assert.equal(result.status, 200);
    const previous = etag;
    etag = String(result.headers.etag);
    assert.notEqual(etag, previous);
    assert.equal((await admin.send('PUT', path, { role: 'editor' }, { 'if-match': previous })).status, 412);
    const grant = await admin.send('PUT', `/api/v1/spaces/${spaceId}/members/${editorUser.id}`, { role: 'editor' }, { 'if-match': etag });
    assert.equal(grant.status, 200);
    etag = String(grant.headers.etag);
    const unknown = await admin.send('PUT', `/api/v1/spaces/${spaceId}/members/missing`, { role: 'reader' }, { 'if-match': etag });
    assert.equal(unknown.status, 404);
    assert.equal(String((await admin.send('GET', `/api/v1/spaces/${spaceId}`)).headers.etag), etag);
  });

  await t.test('account lookup is administrator-only and exposes a minimal existing-account profile', async () => {
    const path = '/api/v1/users/lookup';
    assert.equal((await anonymous.send('POST', path, { email: readerUser.email })).status, 401);
    for (const client of [reader, editor, outsider]) {
      for (const email of [readerUser.email, 'missing@example.test']) {
        const denied = await client.send('POST', path, { email });
        assert.equal(denied.status, 404);
        assert(!denied.body.includes(readerUser.email));
      }
    }
    const found = await admin.send('POST', path, { email: readerUser.email.toUpperCase() });
    assert.equal(found.status, 200);
    assert.deepEqual(found.data, { id: readerUser.id, email: readerUser.email, name: 'Reader', role: 'member' });
    assert.equal(found.headers['cache-control'], 'no-store');
    assert.equal((await admin.send('POST', path, { email: 'missing@example.test' })).status, 404);
    assert.equal((await admin.send('POST', path, { email: readerUser.email, role: 'administrator' })).status, 400);
    assert.equal((await admin.send('POST', path, { email: 'not-an-email' })).status, 400);
    await assert.rejects(core.identity.lookupUser(new Headers({ cookie: reader.cookie }), readerUser.email),
      (error: unknown) => error instanceof HttpProblem && error.status === 404);
    assert.equal(await database.prisma.user.count(), 4);
    assert.equal(await database.prisma.account.count(), 4);
  });

  await t.test('administrator membership reads are bounded and return the current space ETag without auth records', async () => {
    const path = `/api/v1/spaces/${spaceId}/members`;
    assert.equal((await anonymous.send('GET', path)).status, 401);
    for (const client of [reader, editor, outsider]) {
      const denied = await client.send('GET', path);
      assert.equal(denied.status, 404);
      assert(!denied.body.includes(readerUser.email));
      assert(!denied.headers.etag);
    }
    const first = await admin.send('GET', path + '?limit=1');
    assert.equal(first.status, 200); assert.equal(first.headers.etag, etag);
    assert.equal(first.data.items.length, 1);
    assert.deepEqual(Object.keys(first.data).sort(), ['items', 'lockVersion', 'nextCursor', 'spaceId']);
    assert.deepEqual(Object.keys(first.data.items[0]).sort(), ['role', 'user']);
    assert.deepEqual(Object.keys(first.data.items[0].user).sort(), ['email', 'id', 'name', 'role']);
    assert.equal(first.data.spaceId, spaceId);
    assert.equal(first.data.nextCursor, first.data.items[0].user.id);
    const second = await admin.send('GET', path + '?limit=1&cursor=' + encodeURIComponent(first.data.nextCursor));
    assert.equal(second.status, 200); assert.equal(second.headers.etag, etag);
    assert.equal(second.data.items.length, 1); assert.equal(second.data.nextCursor, null);
    assert.notEqual(first.data.items[0].user.id, second.data.items[0].user.id);
    assert.deepEqual([first.data.items[0].user.id, second.data.items[0].user.id].sort(), [readerUser.id, editorUser.id].sort());
    const empty = await admin.send('GET', `/api/v1/spaces/${privateSpaceId}/members`);
    assert.equal(empty.status, 200); assert.deepEqual(empty.data.items, []);
    assert.equal((await admin.send('GET', `/api/v1/spaces/${randomUUID()}/members`)).status, 404);
    for (const query of ['limit=0', 'limit=101', 'cursor=' + 'x'.repeat(129)]) {
      assert.equal((await admin.send('GET', path + '?' + query)).status, 400);
    }
    await assert.rejects(core.spaces.listMembers(new Headers({ cookie: reader.cookie }), { spaceId }),
      (error: unknown) => error instanceof HttpProblem && error.status === 404);
  });

  await t.test('a membership reader rechecks administrator privilege after waiting for the space lock', async () => {
    const lock = await database.pool.connect();
    try {
      await lock.query('BEGIN');
      await lock.query('SELECT id FROM "Space" WHERE id = $1 FOR UPDATE', [spaceId]);
      const nonAdmin = await reader.send('GET', `/api/v1/spaces/${spaceId}/members`);
      assert.equal(nonAdmin.status, 404, 'Non-admin reads must be denied while the space remains exclusively locked');
      const pending = admin.send('GET', `/api/v1/spaces/${spaceId}/members`);
      let blocked = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const waiting = await database.pool.query(`SELECT 1 FROM pg_stat_activity
          WHERE application_name = $1 AND wait_event_type = 'Lock' AND query LIKE '%FOR SHARE%'`, [schema]);
        if (waiting.rowCount) { blocked = true; break; }
        await delay(10);
      }
      assert(blocked, 'The actual HTTP read must wait for its space lock');
      await database.prisma.user.update({ where: { id: adminUser.id }, data: { role: 'member' } });
      await lock.query('COMMIT');
      const denied = await pending;
      assert.equal(denied.status, 404); assert(!denied.body.includes(readerUser.email));
      assert(!denied.headers.etag);
    } finally {
      await lock.query('ROLLBACK'); lock.release();
      await database.prisma.user.update({ where: { id: adminUser.id }, data: { role: 'administrator' } });
    }
  });

  await t.test('visibility is filtered before titles, pagination, versions, or existence are returned', async () => {
    const readerSpace = await reader.send('GET', `/api/v1/spaces/${spaceId}`);
    const editorSpace = await editor.send('GET', `/api/v1/spaces/${spaceId}`);
    assert.equal(readerSpace.status, 200);
    assert.equal(readerSpace.data.access, 'reader');
    assert.equal(editorSpace.status, 200);
    assert.equal(editorSpace.data.access, 'editor');
    assert.equal((await admin.send('GET', `/api/v1/spaces/${spaceId}`)).data.access, 'editor');
    assert(!('memberships' in readerSpace.data));
    const listing = await reader.send('GET', '/api/v1/spaces?limit=1');
    assert.deepEqual(listing.data.items.map((s: { id: string }) => s.id), [spaceId]);
    assert.equal(listing.data.items[0].access, 'reader');
    assert.equal((await editor.send('GET', '/api/v1/spaces')).data.items[0].access, 'editor');
    assert.equal(listing.data.nextCursor, null);
    assert.deepEqual((await outsider.send('GET', '/api/v1/spaces')).data, { items: [], nextCursor: null });
    for (const id of [spaceId, privateSpaceId, randomUUID()]) {
      const result = await outsider.send('GET', `/api/v1/spaces/${id}`);
      assert.equal(result.status, 404);
      assert.equal(result.data.code, 'NOT_FOUND');
      assert.equal(result.headers.etag, undefined);
      assert(!('access' in result.data));
      assert(!result.body.includes('Synthetic'));
    }
    assert.equal((await reader.send('GET', `/api/v1/spaces/${privateSpaceId}`)).status, 404);
    assert.equal((await anonymous.send('GET', `/api/v1/spaces/${spaceId}`)).status, 401);
    const first = await admin.send('GET', '/api/v1/spaces?limit=1');
    assert.equal(first.data.items.length, 1);
    const second = await admin.send('GET', '/api/v1/spaces?limit=1&cursor=' + first.data.nextCursor);
    assert.equal(second.data.items.length, 1);
    assert.notEqual(first.data.items[0].id, second.data.items[0].id);
    assert.equal(second.data.nextCursor, null);
    assert.equal((await admin.send('GET', '/api/v1/spaces?limit=101')).status, 400);
  });

  await t.test('readers/editors cannot grant, revoke, or self-promote and core callers cannot bypass policy', async () => {
    for (const agent of [reader, editor, outsider]) {
      for (const method of ['PUT', 'DELETE']) {
        assert.equal((await agent.send(method, `/api/v1/spaces/${spaceId}/members/${editorUser.id}`,
          method === 'PUT' ? { role: 'editor' } : undefined, { 'if-match': etag })).status, 404);
      }
    }
    assert.equal((await admin.send('PUT', `/api/v1/spaces/${spaceId}/members/${readerUser.id}`, { role: 'administrator' }, { 'if-match': etag })).status, 400);
    assert.equal((await editor.send('POST', '/api/auth/update-user', { role: 'administrator' })).status, 404);
    const readerHeaders = new Headers({ cookie: reader.cookie });
    const outsiderHeaders = new Headers({ cookie: outsider.cookie });
    await assert.rejects(core.spaces.create(readerHeaders, 'Denied'), (e: unknown) => e instanceof HttpProblem && e.status === 403);
    await assert.rejects(core.spaces.read(outsiderHeaders, spaceId), (e: unknown) => e instanceof HttpProblem && e.status === 404);
    await assert.rejects(core.spaces.changeMembership(readerHeaders, {
      spaceId, userId: readerUser.id, role: 'editor', expectedEtag: etag,
    }), (e: unknown) => e instanceof HttpProblem && e.status === 404);
    await assert.rejects(core.spaces.read(new Headers({ 'x-user-id': adminUser!.id }), spaceId),
      (e: unknown) => e instanceof HttpProblem && e.status === 401);
    assert.equal((await editor.send('GET', '/api/v1/me')).data.role, 'member');
  });

  await t.test('auth and product writes reject hostile browser origins and cross-site requests', async () => {
    const hostile = { origin: 'https://attacker.example.test', 'sec-fetch-site': 'cross-site' };
    assert.equal((await anonymous.send('POST', '/api/auth/sign-in/email', { email: readerUser.email, password }, hostile)).status, 403);
    const path = `/api/v1/spaces/${spaceId}/members/${readerUser.id}`;
    assert.equal((await admin.send('DELETE', path, undefined, { ...hostile, 'if-match': etag })).status, 403);
    assert.equal((await admin.send('DELETE', path, undefined, { origin: '', 'if-match': etag })).status, 403);
    assert.equal((await admin.send('DELETE', path, undefined, { 'sec-fetch-site': 'cross-site', 'if-match': etag })).status, 403);
    assert.equal((await reader.send('POST', '/api/auth/sign-out', {}, hostile)).status, 403);
  });

  await t.test('overlapping membership changes wait on the same row and exactly one current ETag wins', async () => {
    const lock = await database.pool.connect();
    await lock.query('BEGIN');
    try {
      await lock.query('SELECT "id" FROM "Space" WHERE "id" = $1 FOR UPDATE', [spaceId]);
      const path = `/api/v1/spaces/${spaceId}/members/${editorUser.id}`;
      const pending = [
        admin.send('PUT', path, { role: 'reader' }, { 'if-match': etag }),
        admin.send('PUT', path, { role: 'editor' }, { 'if-match': etag }),
      ];
      let blocked = 0;
      for (let i = 0; i < 100; i++) {
        const rows = await database.pool.query<{ count: string }>(
          `SELECT count(*)::text FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%FROM "Space"%FOR UPDATE%'
            AND pid IN (SELECT pid FROM pg_locks WHERE relation = $1::regclass)`, [`"${schema}"."Space"`],
        );
        blocked = Number(rows.rows[0]?.count);
        if (blocked >= 2) break;
        await delay(10);
      }
      assert.equal(blocked, 2, 'Both real HTTP transactions must overlap while waiting for the row lock');
      await lock.query('COMMIT');
      const results = await Promise.all(pending);
      assert.deepEqual(results.map((r) => r.status).sort(), [200, 412]);
      const winner = results.findIndex((r) => r.status === 200);
      const current = await database.prisma.spaceMembership.findUniqueOrThrow({ where: { spaceId_userId: { spaceId, userId: editorUser.id } } });
      assert.equal(current.role, winner === 0 ? 'reader' : 'editor');
      assert.equal((await editor.send('GET', `/api/v1/spaces/${spaceId}`)).data.access, current.role);
      etag = String(results[winner]!.headers.etag);
    } finally {
      await lock.query('ROLLBACK');
      lock.release();
    }
  });

  await t.test('membership revocation applies immediately to an already authenticated user', async () => {
    const result = await admin.send('DELETE', `/api/v1/spaces/${spaceId}/members/${readerUser.id}`, undefined, { 'if-match': etag });
    assert.equal(result.status, 200);
    etag = String(result.headers.etag);
    assert.equal((await reader.send('GET', '/api/v1/me')).status, 200);
    assert.equal((await reader.send('GET', `/api/v1/spaces/${spaceId}`)).status, 404);
    assert.deepEqual((await reader.send('GET', '/api/v1/spaces')).data.items, []);
  });

  await t.test('logout invalidates the actual persisted session', async () => {
    const oldCookie = reader.cookie;
    assert.equal((await reader.send('POST', '/api/auth/sign-out', {})).status, 200);
    reader.cookie = oldCookie;
    assert.equal((await reader.send('GET', '/api/v1/me')).status, 401);
  });

  await t.test('operator recovery resets credentials and atomically revokes all existing sessions', async () => {
    const otherEditor = client('127.0.0.7');
    assert.equal((await otherEditor.send('POST', '/api/auth/sign-in/email', { email: editorUser.email, password })).status, 200);
    assert.equal(await database.prisma.session.count({ where: { userId: editorUser.id } }), 2);
    const replacement = randomBytes(24).toString('base64url');
    await assert.rejects(operator.recover(editorUser.email, 'short'));
    assert.equal(await database.prisma.session.count({ where: { userId: editorUser.id } }), 2);
    const result = await operator.recover(editorUser.email, replacement);
    assert.deepEqual(result, { id: editorUser.id });
    assert.equal(await database.prisma.session.count({ where: { userId: editorUser.id } }), 0);
    assert.equal((await editor.send('GET', '/api/v1/me')).status, 401);
    assert.equal((await otherEditor.send('GET', `/api/v1/spaces/${spaceId}`)).status, 401);
    const freshEditor = client('127.0.0.8');
    assert.equal((await freshEditor.send('POST', '/api/auth/sign-in/email', { email: editorUser.email, password })).status, 401);
    assert.equal((await freshEditor.send('POST', '/api/auth/sign-in/email', { email: editorUser.email, password: replacement })).status, 200);
    await assert.rejects(operator.recover('missing@example.test', replacement), /not found/);
    assert.equal(await database.prisma.verification.count(), 0);
  });

  await t.test('a membership writer rechecks session revocation after waiting for the space lock', async () => {
    const lock = await database.pool.connect();
    await lock.query('BEGIN');
    try {
      await lock.query('SELECT "id" FROM "Space" WHERE "id" = $1 FOR UPDATE', [spaceId]);
      const pending = admin.send('PUT', `/api/v1/spaces/${spaceId}/members/${readerUser.id}`, { role: 'reader' }, { 'if-match': etag });
      let blocked = false;
      for (let i = 0; i < 100; i++) {
        const result = await database.pool.query<{ count: string }>(
          `SELECT count(*)::text FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%FROM "Space"%FOR UPDATE%'
            AND pid IN (SELECT pid FROM pg_locks WHERE relation = $1::regclass)`, [`"${schema}"."Space"`],
        );
        if (Number(result.rows[0]?.count) === 1) { blocked = true; break; }
        await delay(10);
      }
      assert(blocked, 'The authenticated writer must be waiting on the space lock');
      adminPassword = randomBytes(24).toString('base64url');
      await operator.recover(adminUser!.email, adminPassword);
      await lock.query('COMMIT');
      assert.equal((await pending).status, 401);
      assert.equal(await database.prisma.spaceMembership.count({ where: { spaceId, userId: readerUser.id } }), 0);
      const refreshed = client('127.0.0.12');
      assert.equal((await refreshed.send('POST', '/api/auth/sign-in/email', { email: adminUser!.email, password: adminPassword })).status, 200);
      admin.cookie = refreshed.cookie;
      assert.equal(String((await admin.send('GET', `/api/v1/spaces/${spaceId}`)).headers.etag), etag);
    } finally {
      await lock.query('ROLLBACK');
      lock.release();
    }
  });

  await t.test('production auth uses Secure cookies without exposing credentials in JSON', async () => {
    const secureCore = createCore(database.prisma, { ...identityConfig, origin: 'https://scrawl.example.test', secureCookies: true });
    const secureApp = await buildApp({ config, core: secureCore, checkDatabase: () => database.ping(), logging: false });
    try {
      const result = await secureApp.inject({ method: 'POST', url: '/api/auth/sign-in/email', remoteAddress: '127.0.0.9',
        headers: { origin: 'https://scrawl.example.test' }, payload: { email: adminUser!.email, password: adminPassword } });
      assert.equal(result.statusCode, 200);
      const cookies = result.headers['set-cookie'];
      assert((Array.isArray(cookies) ? cookies : [cookies]).some((c) => c?.includes('Secure') && c.includes('HttpOnly')));
      assert(!('token' in result.json()));
    } finally { await secureApp.close(); }
  });

  await t.test('auth rate limiting cannot be bypassed with forged forwarding headers', async () => {
    const probe = client('127.0.0.10');
    let last = 0;
    for (let i = 0; i < 5; i++) {
      last = (await probe.send('POST', '/api/auth/sign-in/email', { email: 'absent@example.test', password },
        { 'x-forwarded-for': `198.51.100.${i}`, 'x-scrawl-client-ip': `198.51.100.${i}` })).status;
    }
    assert.equal(last, 429);
  });

  await t.test('live OpenAPI retains P1 and includes only implemented packet routes', async () => {
    const result = await admin.send('GET', '/openapi.json');
    assert.deepEqual(Object.keys(result.data.paths).sort(), [
      '/api/v1/collaboration',
      '/api/v1/search', '/api/v1/attachments/{id}/content', '/api/v1/documents/{id}/attachments',
      '/api/v1/spaces/by-slug/{slug}', '/api/v1/spaces/{id}/documents/by-slug/{slug}',
      '/api/v1/documents/{id}', '/api/v1/documents/{id}/duplicate', '/api/v1/documents/{id}/move', '/api/v1/documents/{id}/archive', '/api/v1/documents/{id}/restore',
      '/api/v1/documents/{id}/export',
      '/api/v1/documents/{id}/revisions', '/api/v1/documents/{id}/revisions/{revisionId}', '/api/v1/documents/{id}/unarchive',
      '/api/v1/users/lookup', '/api/v1/spaces/{id}/members',
      '/api/v1/me', '/api/v1/spaces', '/api/v1/spaces/{id}', '/api/v1/spaces/{id}/members/{userId}', '/health/live', '/health/ready',
      '/api/v1/spaces/{id}/documents',
    ].sort());
    assert.deepEqual((await admin.send('GET', '/api/v1/collaboration')).data, { enabled: false });
    assert.equal((await anonymous.send('GET', '/api/v1/collaboration')).status, 401);
  });

  await t.test('real auth logging excludes passwords, cookies, callback URLs, and submitted/query content', async () => {
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import { readFileSync } from 'node:fs';
      import { readConfig } from './src/config.ts';
      import { createDatabase } from './src/db/client.ts';
      import { createCore } from './src/core/index.ts';
      import { buildApp } from './src/app.ts';
      const input = JSON.parse(readFileSync(0, 'utf8'));
      const config = readConfig({ NODE_ENV: 'test', DATABASE_URL: input.databaseUrl });
      const database = createDatabase(config, () => {});
      const core = createCore(database.prisma, input.identityConfig);
      const app = await buildApp({ config, core, checkDatabase: () => database.ping() });
      try {
        const response = await app.inject({ method: 'POST', url: '/api/auth/sign-in/email?token=query-secret',
          remoteAddress: '127.0.0.13', headers: { origin: input.identityConfig.origin, authorization: 'Bearer authorization-secret' },
          payload: { email: input.email, password: input.password, extra: 'body-secret' } });
        if (response.statusCode !== 200) throw new Error('Log probe sign-in failed');
        const cookies = response.headers['set-cookie'];
        const cookie = (Array.isArray(cookies) ? cookies : [cookies]).map(c => c.split(';')[0]).join('; ');
        await app.inject({ method: 'POST', url: '/api/auth/sign-in/email', remoteAddress: '127.0.0.13',
          headers: { origin: input.identityConfig.origin, cookie },
          payload: { email: input.email, password: input.password, callbackURL: 'https://attacker.example.test/?token=callback-secret' } });
        await app.inject({ url: '/api/v1/me', headers: { cookie: 'session=cookie-secret' } });
      } finally { await app.close(); await database.close(); }
    `], {
      input: JSON.stringify({ databaseUrl: config.databaseUrl, identityConfig, email: adminUser!.email, password: adminPassword }),
      encoding: 'utf8',
    });
    assert.equal(child.status, 0, 'Real logger probe must complete');
    assert(!`${child.stdout}${child.stderr}`.includes('-secret'));
    assert(!`${child.stdout}${child.stderr}`.includes(adminPassword));
    assert(child.stdout.includes('incoming request'));
  });
});
