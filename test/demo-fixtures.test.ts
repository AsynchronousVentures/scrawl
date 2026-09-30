// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, chmod, lstat, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  DEMO_DATABASE, DEMO_ENV_PATH, DEMO_ROLES, readDemoConfig,
  readPrivateDemoEnvironment, readDemoCredentials,
} from '../scripts/demo-config.js';
import { initializeDemo } from '../scripts/demo-fixtures.js';
import { demoContent, richDemoContent } from '../scripts/demo-content.js';
import { validateContent } from '../src/core/documents/content.js';

const valid = {
  NODE_ENV: 'development', SCRAWL_DEMO_DISPOSABLE: DEMO_DATABASE,
  HOST: '127.0.0.1', PORT: '3100', APP_ORIGIN: 'http://127.0.0.1:3100',
  AUTH_SECRET: 'x'.repeat(32), DATABASE_URL: `postgresql://demo:synthetic-password@127.0.0.1:5433/${DEMO_DATABASE}`,
};

test('native demo versions retain stable block IDs and the pinned content envelope', () => {
  const initial = demoContent(['Run tests before deploying.']);
  const next = demoContent(['Run tests before deploying.', 'Verify the backup.']);
  assert.equal(initial.format, 'blocknote-json');
  assert.equal(initial.schemaVersion, 1);
  assert.equal(initial.editorVersion, '0.55.0');
  assert.deepEqual(next.document[0], initial.document[0]);
  assert.equal(validateContent(next).plainText, 'Run tests before deploying.\nVerify the backup.');
  assert.deepEqual(validateContent(JSON.parse(JSON.stringify(next))).content, next);
  assert.throws(() => demoContent([]));
});

test('rich demo fixture preserves native formatting, table cells, and nested blocks', () => {
  const content = richDemoContent(['Synthetic release checklist']);
  const parsed = validateContent(content);
  assert.deepEqual(validateContent(JSON.parse(JSON.stringify(content))).content, content);
  assert.deepEqual(content.document.map(block => block.type), [
    'paragraph', 'heading', 'paragraph', 'quote', 'bulletListItem', 'numberedListItem',
    'toggleListItem', 'table', 'codeBlock', 'divider',
  ]);
  assert(parsed.plainText.includes('Check\tResult\nNative blocks\tPreserved'));
  assert(parsed.plainText.includes('Nested review notes\nNesting is preserved'));
  const serialized = JSON.stringify(content);
  for (const style of ['bold', 'italic', 'underline', 'strike', 'code', 'textColor', 'backgroundColor']) {
    assert(serialized.includes(`"${style}"`));
  }
  assert(serialized.includes('"type":"link"'));
  assert(serialized.includes('"type":"tableCell"'));
  assert(serialized.includes('"type":"checkListItem"'));
});

test('demo configuration accepts designated local targets and configurable local ports', () => {
  assert.equal(readDemoConfig(valid).config.databaseUrl, valid.DATABASE_URL);
  const result = readDemoConfig({ ...valid, PORT: '3201', APP_ORIGIN: 'http://127.0.0.1:3201',
    DATABASE_URL: `postgresql://another:synthetic-password@localhost:5432/${DEMO_DATABASE}` });
  assert.equal(result.config.port, 3201);
  assert.equal(result.identity.secureCookies, false);
  assert.equal(readDemoConfig({ ...valid, DEMO_DB_PORT: '5433' }).config.databaseUrl, valid.DATABASE_URL);
  assert.equal(readDemoConfig({ ...valid, DEMO_DB_PORT: '5434',
    DATABASE_URL: `postgresql://demo:synthetic-password@127.0.0.1:5434/${DEMO_DATABASE}` }).config.databaseUrl,
    `postgresql://demo:synthetic-password@127.0.0.1:5434/${DEMO_DATABASE}`);
});

test('demo configuration refuses production, missing markers, non-demo databases, remote targets, and URL options', () => {
  for (const patch of [
    { NODE_ENV: 'production' }, { NODE_ENV: 'test' }, { SCRAWL_DEMO_DISPOSABLE: undefined },
    { SCRAWL_DEMO_DISPOSABLE: 'true' }, { HOST: '0.0.0.0' }, { APP_ORIGIN: 'http://example.test:3100' },
    { DB_POOL_MAX: '1' },
    { DEMO_DB_PORT: '5434' }, { DEMO_DB_PORT: '0' }, { DEMO_DB_PORT: '65536' },
    { DEMO_DB_PORT: '-1' }, { DEMO_DB_PORT: '5433.0' }, { DEMO_DB_PORT: 'invalid' },
    { APP_ORIGIN: 'http://127.0.0.1:3101' }, { POSTGRES_DB: 'production' },
    { POSTGRES_USER: 'other' }, { POSTGRES_PASSWORD: 'other' },
    { DATABASE_URL: 'postgresql://demo:secret@127.0.0.1:5433/scrawl' },
    { DATABASE_URL: 'postgresql://demo:secret@db.example.test:5433/scrawl_demo_a' },
    { DATABASE_URL: 'postgresql://demo:secret@127.0.0.1:5433/scrawl_demo_a?schema=public' },
    { DATABASE_URL: 'postgresql://demo:secret@127.0.0.1:5433/scrawl_demo_a?options=-csearch_path=production' },
    { DATABASE_URL: 'postgresql://demo:secret@127.0.0.1:5433/scrawl_demo_a#target' },
    { DATABASE_URL: 'postgresql://demo@127.0.0.1:5433/scrawl_demo_a' },
  ]) assert.throws(() => readDemoConfig({ ...valid, ...patch }));
});

test('demo init is exclusive, private, random, and reads configuration from its file', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'scrawl-demo-config-'));
  t.after(async () => { await rm(directory, { recursive: true }); });
  await initializeDemo(directory);
  const path = join(directory, DEMO_ENV_PATH);
  assert.equal((await lstat(path)).mode & 0o777, 0o600);
  const env = await readPrivateDemoEnvironment(path);
  assert.equal(env.SCRAWL_DEMO_DISPOSABLE, DEMO_DATABASE);
  assert.equal(env.POSTGRES_PASSWORD?.length, 43);
  assert.equal(env.AUTH_SECRET?.length, 64);
  assert.equal(env.DEMO_DB_PORT, '5434');
  assert(env.DATABASE_URL);
  assert.equal(new URL(env.DATABASE_URL).port, '5434');
  readDemoConfig(env);
  const original = await readFile(path, 'utf8');
  await assert.rejects(initializeDemo(directory));
  assert(await readFile(path, 'utf8') === original, 'Repeated init must preserve the private configuration');
  await chmod(path, 0o644);
  await assert.rejects(readPrivateDemoEnvironment(path));
  await chmod(path, 0o600);
  const link = join(directory, 'link');
  await symlink(path, link);
  await assert.rejects(readPrivateDemoEnvironment(link));
});

test('demo tools refuse an ambient production process and never fall back to its database', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'scrawl-demo-environment-'));
  t.after(async () => { await rm(directory, { recursive: true }); });
  const originalNodeEnv = process.env.NODE_ENV;
  const originalDatabase = process.env.DATABASE_URL;
  try {
    await initializeDemo(directory);
    process.env.DATABASE_URL = 'postgresql://ignored:ignored@db.example.test/production';
    const { config } = readDemoConfig(await readPrivateDemoEnvironment(join(directory, DEMO_ENV_PATH)));
    assert.equal(new URL(config.databaseUrl).pathname, `/${DEMO_DATABASE}`);
    process.env.NODE_ENV = 'production';
    await assert.rejects(readPrivateDemoEnvironment(join(directory, DEMO_ENV_PATH)), /refuse production/);
    const emptyDirectory = join(directory, 'empty');
    await mkdir(emptyDirectory);
    await assert.rejects(initializeDemo(emptyDirectory), /refuse production/);
    await assert.rejects(lstat(join(emptyDirectory, DEMO_ENV_PATH)));
  } finally {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalDatabase === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabase;
  }
});

test('demo credentials validate the private manifest without leaking invalid values', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'scrawl-demo-credentials-'));
  t.after(async () => { await rm(directory, { recursive: true }); });
  const path = join(directory, 'credentials.json');
  const accounts = Object.fromEntries(DEMO_ROLES.map((role) => [role, {
    id: `fixture-${role}`, email: `${role}@example.test`, password: randomBytes(24).toString('base64url'),
  }]));
  await writeFile(path, JSON.stringify({ database: DEMO_DATABASE, accounts }), { mode: 0o600 });
  const parsed = await readDemoCredentials(path);
  assert.equal(parsed.accounts.administrator.email, 'administrator@example.test');
  assert.equal(parsed.accounts.editor.id, 'fixture-editor');
  await writeFile(path, JSON.stringify({ database: DEMO_DATABASE, accounts, token: 'forbidden' }));
  await assert.rejects(readDemoCredentials(path), /Demo credentials are invalid/);
  await writeFile(path, '{"password":"SYNTHETIC-DO-NOT-ECHO"');
  await assert.rejects(readDemoCredentials(path), (error: unknown) =>
    error instanceof Error && error.message === 'Demo credentials are invalid');
  await writeFile(path, JSON.stringify({ database: DEMO_DATABASE, accounts }));
  await chmod(path, 0o644);
  await assert.rejects(readDemoCredentials(path));
});

test('fixture CLI refuses unsafe commands before connecting and never echoes arguments or secret configuration', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'scrawl-demo-refusal-'));
  t.after(async () => { await rm(directory, { recursive: true }); });
  const script = resolve('scripts/demo-fixtures.ts');
  const tsx = resolve('node_modules/tsx/dist/loader.mjs');
  const secret = 'SYNTHETIC-DO-NOT-ECHO';
  await writeFile(join(directory, DEMO_ENV_PATH), Object.entries({
    ...valid, DATABASE_URL: `postgresql://demo:${secret}@127.0.0.1:1/scrawl`,
  }).map(([key, value]) => `${key}=${value}`).join('\n'), { mode: 0o600 });
  for (const [args, nodeEnv] of [
    [[], 'development'], [['reset'], 'development'], [['reset', '--database', 'scrawl'], 'development'],
    [['reset', '--database', DEMO_DATABASE], 'development'],
    [['setup', '--database', DEMO_DATABASE, '--password', secret], 'development'],
    [['init'], 'production'], [['setup', '--database', DEMO_DATABASE], 'production'],
  ] as const) {
    const result = spawnSync(process.execPath, ['--import', tsx, script, ...args], {
      cwd: directory, env: { ...process.env, NODE_ENV: nodeEnv }, encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Demo fixture command failed/);
    assert(!result.stdout.includes(secret) && !result.stderr.includes(secret));
  }
  assert.equal((await lstat(join(directory, DEMO_ENV_PATH))).mode & 0o777, 0o600);
});
