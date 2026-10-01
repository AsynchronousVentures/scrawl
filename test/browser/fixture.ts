// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { parseEnv } from 'node:util';
import type { Locator } from '@playwright/test';
import { readConfig } from '../../src/config.js';
import { createDatabase } from '../../src/db/client.js';
import { DEMO_DATABASE, readDemoCredentials, readPrivateDemoFile } from '../../scripts/demo-config.js';
import type { DemoCredentials, DemoRole } from '../../scripts/demo-config.js';
import type { DemoBResult } from '../../scripts/demo-b.js';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Owns one explicit, disposable database. Run after test:db, never alongside it. */
export async function createBrowserDemo(options: { collaboration?: boolean } = {}) {
  const baseConfig = readConfig(process.env);
  const target = new URL(baseConfig.databaseUrl);
  if (baseConfig.nodeEnv === 'production' || !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)
    || target.pathname === `/${DEMO_DATABASE}` || !target.username || !target.password) {
    throw new Error('Browser acceptance requires a separate local non-production PostgreSQL baseline');
  }
  const administrator = createDatabase(baseConfig, () => {});
  let database: ReturnType<typeof createDatabase> | undefined;
  let server: ChildProcess | undefined;
  let ownsDatabase = false;
  let cwd: string | undefined;
  let output = '';
  const secrets = [decodeURIComponent(target.password)];
  let closed = false;
  let setupStage = 'target verification';

  async function stopServer() {
    if (!server || server.exitCode !== null) return;
    const child = server;
    const stopped = new Promise<void>((done, reject) => {
      const deadline = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('Browser demo server did not stop'));
      }, 12_000);
      child.once('close', () => { clearTimeout(deadline); done(); });
    });
    child.kill('SIGTERM');
    await stopped;
    if (child.exitCode !== 0) throw new Error('Browser demo server failed to stop gracefully');
  }

  async function close() {
    if (closed) return;
    closed = true;
    let failed = false;
    try { await stopServer(); } catch { failed = true; }
    try {
      if (database) {
        const tables = await database.pool.query<{ present: string | null }>("SELECT to_regclass('session')::text AS present");
        if (tables.rows[0]?.present) {
          const sessions = await database.prisma.session.findMany({ select: { token: true } });
          secrets.push(...sessions.map((session) => session.token));
        }
      }
      if (secrets.some((secret) => secret && output.includes(secret))) failed = true;
    } catch { failed = true; }
    try { await database?.close(); } catch { failed = true; }
    try { if (ownsDatabase) await administrator.pool.query('DROP DATABASE "scrawl_demo_a"'); } catch { failed = true; }
    try { await administrator.close(); } catch { failed = true; }
    try { if (cwd) await rm(cwd, { recursive: true, force: true }); } catch { failed = true; }
    if (failed) throw new Error('Browser demo cleanup or secret-safe output verification failed');
  }

  async function command(script: string, args: string[] = []) {
    if (!cwd) throw new Error('Browser fixture directory is unavailable');
    return new Promise<void>((done, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', join(repository, 'scripts', script), ...args], {
        cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
      });
      const deadline = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Browser fixture command timed out')); }, 45_000);
      let commandOutput = '';
      child.stdout.on('data', (chunk: Buffer) => { const value = chunk.toString(); output += value; commandOutput += value; });
      child.stderr.on('data', (chunk: Buffer) => { const value = chunk.toString(); output += value; commandOutput += value; });
      child.once('error', () => { clearTimeout(deadline); reject(new Error('Browser fixture command could not start')); });
      child.once('close', (code) => {
        clearTimeout(deadline);
        if (code === 0) done();
        else {
          // Expose only the script's known, static stage message. Child output
          // can otherwise contain connection URLs, passwords or session cookies.
          const stages = ['configuration', 'authentication', 'space setup', 'document create', 'stale save',
            'missing precondition', 'reader denial', 'outsider denial', 'invalid native save', 'native rich export',
            'restore', 'native export', 'lifecycle', 'membership revocation', 'logout', 'artifacts'];
          const stage = script === 'demo-a.ts' ? stages.find(value => commandOutput.includes(
            `Demo A failed at ${value}. Check the running demo API and fixture setup.`,
          )) : undefined;
          reject(new Error(`Browser fixture command failed (${script})${stage ? ` during ${stage}` : ''}`));
        }
      });
    });
  }

  try {
    // Refuse existing data rather than resetting an arbitrary DATABASE_URL or named database.
    const existing = await administrator.pool.query('SELECT 1 FROM pg_database WHERE datname = $1', [DEMO_DATABASE]);
    if (existing.rowCount !== 0) throw new Error('Refusing an existing browser demo database');
    await administrator.pool.query('CREATE DATABASE "scrawl_demo_a"');
    ownsDatabase = true;
    setupStage = 'private fixture initialization';
    target.pathname = `/${DEMO_DATABASE}`;
    target.search = '';
    target.hash = '';
    database = createDatabase({ ...baseConfig, databaseUrl: target.href }, () => {});
    await mkdir(join(repository, 'artifacts'), { recursive: true });
    cwd = await mkdtemp(join(repository, 'artifacts/p4-browser-'));
    await command('demo-fixtures.ts', ['init']);
    const environmentPath = join(cwd, '.env.demo');
    const values = parseEnv(await readPrivateDemoFile(environmentPath));
    if (!values.AUTH_SECRET || !values.POSTGRES_PASSWORD) throw new Error('Browser fixture configuration is incomplete');
    secrets.push(values.AUTH_SECRET, values.POSTGRES_PASSWORD);

    const listener = createServer();
    await new Promise<void>((done, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', done); });
    const address = listener.address();
    if (!address || typeof address !== 'object') throw new Error('Browser demo port is unavailable');
    const port = address.port;
    await new Promise<void>((done, reject) => listener.close((error) => error ? reject(error) : done()));
    const origin = `http://127.0.0.1:${port}`;
    Object.assign(values, {
      DATABASE_URL: target.href, POSTGRES_USER: decodeURIComponent(target.username),
      POSTGRES_PASSWORD: decodeURIComponent(target.password), POSTGRES_DB: DEMO_DATABASE,
      DEMO_DB_PORT: target.port || '5432',
      PORT: String(port), APP_ORIGIN: origin, LOG_LEVEL: 'info', AUTH_SECRET: randomBytes(32).toString('hex'),
      // This newly owned disposable database exercises explicit publication;
      // the application default and every non-demo target remain disabled.
      PUBLIC_PUBLISHING_ENABLED: 'true',
      COLLABORATION_ENABLED: String(options.collaboration ?? false),
    });
    secrets.push(values.AUTH_SECRET);
    await writeFile(environmentPath, Object.entries(values).map(([name, value]) => `${name}=${value}`).join('\n') + '\n', { mode: 0o600 });
    setupStage = 'migrations and account provisioning';
    await command('demo-fixtures.ts', ['setup', '--database', DEMO_DATABASE]);
    const accounts: DemoCredentials = await readDemoCredentials(join(cwd, 'artifacts/demo/credentials.json'));
    secrets.push(...Object.values(accounts.accounts).map((account) => account.password));
    if ((await stat(join(repository, 'web/dist/index.html'))).isFile() !== true) throw new Error('Build the frontend before browser acceptance');

    setupStage = 'server startup and readiness';
    async function startServer() {
      server = spawn(process.execPath, ['--import', 'tsx', join(repository, 'scripts/demo-server.ts')], {
        cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
      });
      server.stdout!.on('data', (chunk: Buffer) => { output += chunk.toString(); });
      server.stderr!.on('data', (chunk: Buffer) => { output += chunk.toString(); });
      server.once('error', () => { output += 'Browser demo server could not start'; });
      let ready = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        try { if ((await fetch(origin + '/health/ready')).status === 200) { ready = true; break; } }
        catch { /* Only readiness reads are retried. */ }
        if (server.exitCode !== null) throw new Error('Browser demo server exited before readiness');
        await delay(100);
      }
      if (!ready) throw new Error('Browser demo server did not become ready');
    }
    await startServer();

    let loginCount = 0;
    let lastLogin = 0;
    async function reserveAuthenticationAttempt() {
      // The pinned library resets its burst after 10 seconds without another attempt.
      // Browser contexts share a peer, so wait after the last attempt in a burst.
      const now = Date.now();
      if (now - lastLogin >= 10_250) loginCount = 0;
      if (loginCount >= 3) {
        await delay(Math.max(1, lastLogin + 10_250 - now));
        loginCount = 0;
      }
      loginCount++;
      lastLogin = Date.now();
    }
    let seedCount = 0;
    let lastSeed = 0;
    return {
      origin,
      database,
      accountId: (role: DemoRole) => accounts.accounts[role].id,
      accountEmail: (role: DemoRole) => accounts.accounts[role].email,
      authenticationCompleted() { lastLogin = Date.now(); },
      async fillCredentials(email: Locator, password: Locator, role: DemoRole) {
        await reserveAuthenticationAttempt();
        try {
          await email.fill(accounts.accounts[role].email);
          await password.fill(accounts.accounts[role].password);
        } catch {
          // Playwright fill() errors include the attempted value. Replace them with a safe error.
          try { await password.fill(''); } catch { /* Keep the original diagnostics private. */ }
          throw new Error('Could not enter private demo credentials');
        }
      },
      async seed(): Promise<DemoBResult> {
        const now = Date.now();
        if (now - lastSeed >= 10_250) seedCount = 0;
        if (seedCount >= 3) {
          await delay(Math.max(1, lastSeed + 10_250 - now));
          seedCount = 0;
        }
        await command('demo-b.ts', ['--database', DEMO_DATABASE]);
        // Completion is later than authentication. Using it avoids process-startup jitter
        // admitting a fourth sign-in before the unchanged server window has elapsed.
        lastSeed = Date.now();
        seedCount++;
        const result: unknown = JSON.parse(await readPrivateDemoFile(join(cwd!, 'artifacts/demo/b-result.json')));
        if (result === null || typeof result !== 'object'
          || !('spaceId' in result) || typeof result.spaceId !== 'string'
          || !('documentId' in result) || typeof result.documentId !== 'string'
          || !('revisionId' in result) || typeof result.revisionId !== 'string'
          || !('revisionNumber' in result) || result.revisionNumber !== 1) throw new Error('Browser seed result is invalid');
        return { spaceId: result.spaceId, documentId: result.documentId, revisionId: result.revisionId, revisionNumber: 1 };
      },
      async restart(collaboration: boolean) {
        // Only this owned fixture process/configuration changes. Its database,
        // credentials and sessions survive, so restart tests exercise real recovery.
        await stopServer();
        values.COLLABORATION_ENABLED = String(collaboration);
        await writeFile(environmentPath, Object.entries(values).map(([name, value]) => `${name}=${value}`).join('\n') + '\n', { mode: 0o600 });
        await startServer();
      },
      async runDemoA() { await command('demo-a.ts'); },
      close,
    };
  } catch {
    let cleanupFailed = false;
    try { await close(); } catch { cleanupFailed = true; }
    // PostgreSQL/child errors can disclose connection URLs. Keep failure diagnostics static.
    throw new Error(`Browser demo setup failed during ${setupStage}.${cleanupFailed ? ' Cleanup also failed.' : ' Disposable resources were cleaned up.'} Check local PostgreSQL, fixture targets and the frontend build.`);
  }
}

export type BrowserDemo = Awaited<ReturnType<typeof createBrowserDemo>>;
