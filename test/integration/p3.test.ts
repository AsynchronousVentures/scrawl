// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile, readdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { parseEnv } from 'node:util';
import { readConfig } from '../../src/config.js';
import { createDatabase } from '../../src/db/client.js';
import { validateContent } from '../../src/core/documents/content.js';
import { readDemoCredentials } from '../../scripts/demo-config.js';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('P3 Demo A uses real HTTP, repeatable isolated fixtures, guarded reset and native export', { timeout: 180_000 }, async (t) => {
  const baseConfig = readConfig(process.env);
  const url = new URL(baseConfig.databaseUrl);
  assert(baseConfig.nodeEnv !== 'production' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname),
    'Demo acceptance requires local non-production PostgreSQL');
  assert.notEqual(url.pathname, '/scrawl_demo_a', 'The integration baseline must not be the disposable demo database');
  assert(url.username && url.password, 'Demo acceptance requires local PostgreSQL credentials');
  const admin = createDatabase(baseConfig, () => {});
  let ownsDatabase = false;
  let database: ReturnType<typeof createDatabase> | undefined;
  let server: ChildProcess | undefined;
  let serverOutput = '';
  await mkdir(join(repository, 'artifacts'), { recursive: true });
  const cwd = await mkdtemp(join(repository, 'artifacts/p3-demo-'));
  t.after(async () => {
    if (server && server.exitCode === null) {
      server.kill('SIGTERM');
      await new Promise<void>((done) => server!.once('close', () => done()));
    }
    await database?.close();
    if (ownsDatabase) await admin.pool.query('DROP DATABASE "scrawl_demo_a"');
    await admin.close();
    await rm(cwd, { recursive: true, force: true });
  });

  async function command(script: string, args: string[] = [], environment: NodeJS.ProcessEnv = {}) {
    return new Promise<{ code: number | null; output: string }>((done, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', join(repository, 'scripts', script), ...args], {
        cwd, env: { ...process.env, ...environment }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
      const timeout = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Demo command timed out')); }, 45_000);
      child.once('error', (error) => { clearTimeout(timeout); reject(error); });
      child.once('close', (code) => { clearTimeout(timeout); done({ code, output }); });
    });
  }

  const existing = await admin.pool.query('SELECT 1 FROM pg_database WHERE datname = $1', ['scrawl_demo_a']);
  assert.equal(existing.rowCount, 0, 'Refusing to overwrite an existing disposable database');
  await admin.pool.query('CREATE DATABASE "scrawl_demo_a"');
  ownsDatabase = true;
  url.pathname = '/scrawl_demo_a';
  url.search = '';
  database = createDatabase({ ...baseConfig, databaseUrl: url.href }, () => {});

  const listener = createServer();
  await new Promise<void>((done, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', done); });
  const address = listener.address();
  assert(address && typeof address === 'object');
  const port = address.port;
  await new Promise<void>((done, reject) => listener.close((error) => error ? reject(error) : done()));
  const init = await command('demo-fixtures.ts', ['init']);
  assert.equal(init.code, 0, 'Demo environment initialization must succeed without printing secrets');
  const envPath = join(cwd, '.env.demo');
  const values = parseEnv(await readFile(envPath, 'utf8'));
  const secrets = [values.AUTH_SECRET!, values.POSTGRES_PASSWORD!];
  Object.assign(values, { DATABASE_URL: url.href, DEMO_DB_PORT: url.port || '5432', POSTGRES_USER: decodeURIComponent(url.username),
    POSTGRES_PASSWORD: decodeURIComponent(url.password), POSTGRES_DB: 'scrawl_demo_a',
    PORT: String(port), APP_ORIGIN: `http://127.0.0.1:${port}`, LOG_LEVEL: 'info', AUTH_SECRET: randomBytes(32).toString('hex') });
  const environmentText = () => Object.entries(values).map(([name, value]) => `${name}=${value}`).join('\n') + '\n';
  await writeFile(envPath, environmentText(), { mode: 0o600 });
  assert.equal((await stat(envPath)).mode & 0o777, 0o600);

  const fixtureArgs = ['--database', 'scrawl_demo_a'];
  const setup = await command('demo-fixtures.ts', ['setup', ...fixtureArgs]);
  assert.equal(setup.code, 0, 'Explicit setup must migrate and provision the fresh disposable database');
  const migrationLedger = 'SELECT * FROM "_prisma_migrations" WHERE finished_at IS NOT NULL ORDER BY migration_name';
  const migrations = await database.pool.query<{ migration_name: string }>(migrationLedger);
  const sourceMigrations = (await readdir(join(repository, 'prisma/migrations'), { withFileTypes: true }))
    .filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  assert.deepEqual(migrations.rows.map(row => row.migration_name), sourceMigrations,
    'Demo setup must deploy the one checked-in migration history');
  assert.equal(await database.prisma.user.count(), 4);
  const credentialPath = join(cwd, 'artifacts/demo/credentials.json');
  assert.equal((await stat(credentialPath)).mode & 0o777, 0o600);
  const initialCredentials = await readDemoCredentials(credentialPath);
  secrets.push(...Object.values(initialCredentials.accounts).map((account) => account.password));

  async function startServer() {
    server = spawn(process.execPath, ['--import', 'tsx', join(repository, 'scripts/demo-server.ts')], {
      cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout!.on('data', (chunk: Buffer) => { serverOutput += chunk.toString(); });
    server.stderr!.on('data', (chunk: Buffer) => { serverOutput += chunk.toString(); });
    const origin = values.APP_ORIGIN!;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { if ((await fetch(origin + '/health/ready')).status === 200) return; } catch { /* Only readiness is retried. */ }
      assert.equal(server.exitCode, null, 'The demo server must stay running');
      await delay(100);
    }
    assert.fail('The actual demo HTTP server did not become ready');
  }
  async function stopServer() {
    assert(server && server.exitCode === null);
    const child = server;
    const stopped = new Promise<void>((done) => child.once('close', () => done()));
    child.kill('SIGTERM');
    await stopped;
    assert.equal(child.exitCode, 0);
  }
  await startServer();
  const outputs = [init.output, setup.output];

  async function assertRun(expectedDocuments: number) {
    const run = await command('demo-a.ts');
    // Child diagnostics can contain private data. Surface only the runner's
    // known stage label, never its raw output or credential/session values.
    const stages = ['configuration', 'authentication', 'space setup', 'document create', 'stale save',
      'missing precondition', 'reader denial', 'outsider denial', 'invalid native save', 'native rich export',
      'restore', 'native export', 'lifecycle', 'membership revocation', 'logout', 'artifacts'];
    const stage = stages.find(value => run.output.includes(`Demo A failed at ${value}. Check the running demo API and fixture setup.`));
    assert.equal(run.code, 0, `Every walkthrough assertion must pass against the actual HTTP API${stage ? ` (${stage})` : ''}`);
    outputs.push(run.output);
    assert.equal(await database!.prisma.space.count(), expectedDocuments);
    assert.equal(await database!.prisma.document.count(), expectedDocuments);
    assert.equal(await database!.prisma.documentRevision.count(), expectedDocuments * 3);
    // Export JSON is an external boundary. These checks narrow its exact implemented contract.
    const exportPath = join(cwd, 'artifacts/demo/export.json');
    assert.equal((await stat(exportPath)).mode & 0o777, 0o600);
    const exported = JSON.parse(await readFile(exportPath, 'utf8')) as Record<string, unknown>;
    assert.deepEqual(Object.keys(exported).sort(), ['format', 'exportVersion', 'document', 'revision', 'content'].sort());
    assert.equal(exported.format, 'scrawl-document');
    assert.equal(exported.exportVersion, 1);
    const document = exported.document as { id: string; spaceId: string };
    const revision = exported.revision as { id: string; revisionNumber: number; title: string };
    assert.deepEqual(Object.keys(document).sort(), ['id', 'spaceId', 'createdAt', 'createdBy'].sort());
    assert.deepEqual(Object.keys(revision).sort(), ['id', 'revisionNumber', 'title', 'createdAt', 'authorId'].sort());
    assert.equal(revision.revisionNumber, 3);
    assert.equal(revision.title, 'Release checklist');
    const parsed = validateContent(exported.content);
    assert.equal(parsed.plainText, 'Run tests before deploying.');
    const stored = await database!.prisma.documentRevision.findUniqueOrThrow({ where: { id: revision.id } });
    assert.equal(stored.documentId, document.id);
    assert.deepEqual(parsed.content.document, stored.body);
    assert.equal(await database!.prisma.spaceMembership.count({ where: { spaceId: document.spaceId, role: 'editor' } }), 0);
    const result: unknown = JSON.parse(await readFile(join(cwd, 'artifacts/demo/result.json'), 'utf8'));
    assert(result && typeof result === 'object' && 'checks' in result && typeof result.checks === 'number' && result.checks > 20);
    return document.id;
  }

  await t.test('fresh walkthrough and repeated execution create independent documents without reseeding accounts', async () => {
    const first = await assertRun(1);
    const second = await assertRun(2);
    assert.notEqual(first, second);
    assert.equal(await database!.prisma.user.count(), 4);
    const repeated = await command('demo-fixtures.ts', ['setup', ...fixtureArgs]);
    outputs.push(repeated.output);
    assert.notEqual(repeated.code, 0, 'Setup must refuse a populated target rather than reset implicitly');
    assert.equal(await database!.prisma.document.count(), 2);
    assert.equal(await database!.prisma.documentRevision.count(), 6);
    const unchangedCredentials = await readDemoCredentials(credentialPath);
    assert(Object.values(unchangedCredentials.accounts).every((account) =>
      Object.values(initialCredentials.accounts).some((original) => original.id === account.id && original.password === account.password)),
    'Repeated setup must preserve the original accounts and private credentials');
  });

  await t.test('an assertion failure exits nonzero and never retries the failed save or document creation', async () => {
    await database!.pool.query('CREATE SEQUENCE demo_save_attempts');
    await database!.pool.query(`CREATE FUNCTION fail_demo_save() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM nextval('demo_save_attempts'); RAISE EXCEPTION 'Injected demo save failure'; END $$`);
    await database!.pool.query(`CREATE TRIGGER fail_demo_save BEFORE INSERT ON "DocumentRevision"
      FOR EACH ROW WHEN (NEW."revisionNumber" = 2) EXECUTE FUNCTION fail_demo_save()`);
    try {
      const failed = await command('demo-a.ts');
      outputs.push(failed.output);
      assert.notEqual(failed.code, 0, 'Failed HTTP assertions must fail the executable runner');
      assert.equal(await database!.prisma.space.count(), 3);
      assert.equal(await database!.prisma.document.count(), 3);
      assert.equal(await database!.prisma.documentRevision.count(), 7);
      const attempts = await database!.pool.query('SELECT last_value::integer, is_called FROM demo_save_attempts');
      assert.equal(attempts.rows[0]?.last_value, 1);
      assert.equal(attempts.rows[0]?.is_called, true);
    } finally {
      await database!.pool.query('DROP TRIGGER fail_demo_save ON "DocumentRevision"');
      await database!.pool.query('DROP FUNCTION fail_demo_save()');
      await database!.pool.query('DROP SEQUENCE demo_save_attempts');
    }
  });

  await t.test('reset needs explicit confirmation and refuses production or non-demo configurations', async () => {
    for (const args of [['reset'], ['reset', '--database', 'scrawl']]) {
      const refusal = await command('demo-fixtures.ts', args);
      outputs.push(refusal.output);
      assert.notEqual(refusal.code, 0);
    }
    const original = values.DATABASE_URL;
    values.DATABASE_URL = baseConfig.databaseUrl;
    await writeFile(envPath, environmentText());
    const wrongTarget = await command('demo-fixtures.ts', ['reset', ...fixtureArgs]);
    outputs.push(wrongTarget.output);
    assert.notEqual(wrongTarget.code, 0);
    values.DATABASE_URL = original!;
    values.NODE_ENV = 'production';
    await writeFile(envPath, environmentText());
    const production = await command('demo-fixtures.ts', ['reset', ...fixtureArgs]);
    outputs.push(production.output);
    assert.notEqual(production.code, 0);
    values.NODE_ENV = 'development';
    await writeFile(envPath, environmentText());
    assert.equal(await database!.prisma.document.count(), 3);
    assert.equal(await database!.prisma.documentRevision.count(), 7);
  });

  await t.test('explicit reset preserves migrations and permits a fresh setup and walkthrough', async () => {
    await stopServer();
    secrets.push(...(await database!.prisma.session.findMany({ select: { token: true } })).map((session) => session.token));
    const reset = await command('demo-fixtures.ts', ['reset', ...fixtureArgs]);
    outputs.push(reset.output);
    assert.equal(reset.code, 0);
    assert.equal(await database!.prisma.user.count(), 0);
    assert.equal(await database!.prisma.session.count(), 0);
    assert.equal(await database!.prisma.document.count(), 0);
    assert.equal(await database!.prisma.documentRevision.count(), 0);
    await assert.rejects(stat(credentialPath), (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'ENOENT');
    const retained = await database!.pool.query(migrationLedger);
    assert.deepEqual(retained.rows, migrations.rows, 'Explicit reset preserves every migration ledger record');
    const reseed = await command('demo-fixtures.ts', ['setup', ...fixtureArgs]);
    outputs.push(reseed.output);
    assert.equal(reseed.code, 0);
    const newCredentials = await readDemoCredentials(credentialPath);
    const newPasswords = Object.values(newCredentials.accounts).map((account) => account.password);
    assert(newPasswords.every((password) => !secrets.includes(password)), 'Explicit reset/setup must generate new credentials');
    secrets.push(...newPasswords);
    await startServer();
    await assertRun(1);
  });

  await stopServer();
  outputs.push(serverOutput);
  const sessions = await database.prisma.session.findMany({ select: { token: true } });
  const combined = outputs.join('\n');
  assert(!combined.includes(values.AUTH_SECRET!), 'Demo commands must not print the authentication secret');
  assert(!combined.includes(decodeURIComponent(url.password)), 'Demo commands must not print database credentials');
  assert(!combined.includes('Run tests before deploying.'), 'Document content must not reach command or request logs');
  for (const secret of secrets) assert(!combined.includes(secret), 'Private credentials and session data must never reach command output');
  for (const session of sessions) assert(!combined.includes(session.token), 'Session tokens must never reach command output');
});
