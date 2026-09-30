// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import { randomBytes } from 'node:crypto';
import { lstat, mkdir, open, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import type { PoolClient } from 'pg';
import { createDatabase } from '../src/db/client.js';
import { createOperator } from '../src/core/identity/operator.js';
import {
  DEMO_DATABASE, DEMO_ENV_PATH, DEMO_CREDENTIALS_PATH, DEMO_ROLES,
  demoFileExists, readDemoConfig, readPrivateDemoEnvironment,
} from './demo-config.js';
import type { DemoAccount, DemoRole } from './demo-config.js';

export async function initializeDemo(directory = process.cwd()): Promise<void> {
  if (process.env.NODE_ENV === 'production') throw new Error('Demo tools refuse production');
  const password = randomBytes(32).toString('base64url');
  const content = [
    '# Private development Demo A settings. This database is explicitly disposable.',
    'NODE_ENV=development', 'HOST=127.0.0.1', 'PORT=3100', 'LOG_LEVEL=info',
    'APP_ORIGIN=http://127.0.0.1:3100', `AUTH_SECRET=${randomBytes(32).toString('hex')}`,
    `SCRAWL_DEMO_DISPOSABLE=${DEMO_DATABASE}`, 'POSTGRES_USER=scrawl_demo',
    `POSTGRES_PASSWORD=${password}`, `POSTGRES_DB=${DEMO_DATABASE}`, 'DEMO_DB_PORT=5434',
    `DATABASE_URL=postgresql://scrawl_demo:${password}@127.0.0.1:5434/${DEMO_DATABASE}`,
    '',
  ].join('\n');
  // Exclusive creation preserves existing configuration, including symlink targets.
  const file = await open(resolve(directory, DEMO_ENV_PATH), 'wx', 0o600);
  try { await file.writeFile(content); } finally { await file.close(); }
}

async function privateDirectory(path: string) {
  if (!await demoFileExists(path)) await mkdir(path, { mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || (process.getuid && stat.uid !== process.getuid())
    || (path === 'artifacts/demo' && (stat.mode & 0o077) !== 0)) {
    throw new Error('Demo artifact directories must belong to the local operator');
  }
}

export async function runFixtureCommand(command: 'setup' | 'reset', confirmation: string): Promise<void> {
  if (confirmation !== DEMO_DATABASE) throw new Error('Confirm the disposable demo database by name');
  const { config, identity } = readDemoConfig(await readPrivateDemoEnvironment());
  for (const path of ['artifacts', 'artifacts/demo']) {
    if (await demoFileExists(path)) await privateDirectory(path);
  }
  if (await demoFileExists(DEMO_CREDENTIALS_PATH)) {
    const stat = await lstat(DEMO_CREDENTIALS_PATH);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0
      || (process.getuid && stat.uid !== process.getuid())) {
      throw new Error('Demo credentials must belong to the local operator');
    }
  }
  const database = createDatabase(config, () => { console.error('Demo database connection failed'); });
  let commandConnection: PoolClient | undefined;
  let commandLocked = false;
  try {
    const result = await database.pool.query<{ database: string; user: string }>(
      'SELECT current_database() AS database, current_user AS user',
    );
    if (result.rows[0]?.database !== DEMO_DATABASE
      || result.rows[0]?.user !== decodeURIComponent(new URL(config.databaseUrl).username)) {
      throw new Error('Connected database does not match the explicit demo target');
    }
    commandConnection = await database.pool.connect();
    const lock = await commandConnection.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(7242027) AS locked');
    commandLocked = lock.rows[0]?.locked === true;
    if (!commandLocked) throw new Error('Another demo fixture command is running');
    if (command === 'reset') {
      const resetArtifacts: string[] = [];
      for (const artifact of ['workspace.json', 'b-result.json', 'result.json', 'export.json']) {
        const path = `artifacts/demo/${artifact}`;
        if (await demoFileExists(path)) {
          const info = await lstat(path);
          if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0
            || (process.getuid && info.uid !== process.getuid())) throw new Error('Unsafe demo artifact');
          resetArtifacts.push(path);
        }
      }
      // No CASCADE and no schema/database drop. Preserve Prisma's migration ledger.
      const knownTables = ['user', 'session', 'account', 'verification', 'Space', 'SpaceMembership', 'Document', 'DocumentRevision', 'Attachment', 'RevisionAttachment', 'Publication'];
      const tables = await database.pool.query<{ tablename: string }>(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
      );
      if (tables.rows.some(({ tablename }) => tablename !== '_prisma_migrations' && !knownTables.includes(tablename))) {
        throw new Error('Demo reset refuses an unexpected database schema');
      }
      const existing = knownTables.filter((name) => tables.rows.some(({ tablename }) => tablename === name));
      await database.prisma.$transaction(async (tx) => {
        if (existing.length) await tx.$executeRawUnsafe(`TRUNCATE ${existing.map((name) => `"${name}"`).join(', ')}`);
      });
      if (await demoFileExists(DEMO_CREDENTIALS_PATH)) {
        await unlink(DEMO_CREDENTIALS_PATH);
      }
      for (const path of resetArtifacts) await unlink(path);
      console.log('Demo fixture data reset. Migrations and private configuration retained. Run setup explicitly.');
      return;
    }
    if (await demoFileExists(DEMO_CREDENTIALS_PATH)) throw new Error('Demo setup refuses existing credentials');
    const present = await database.pool.query<{ present: boolean }>("SELECT to_regclass('public.user') IS NOT NULL AS present");
    if (present.rows[0]?.present) {
      const users = await database.pool.query<{ count: string }>('SELECT count(*) AS count FROM "user"');
      if (users.rows[0]?.count !== '0') throw new Error('Demo setup refuses a populated instance');
    }
    await privateDirectory('artifacts');
    await privateDirectory('artifacts/demo');
    // Reserve the credential file before mutating, including concurrent setup attempts.
    // A failed partial setup remains explicit operator work; rerun never resets it.
    const credentialFile = await open(DEMO_CREDENTIALS_PATH, 'wx', 0o600);
    try {
      const migration = spawnSync(process.execPath, [
        fileURLToPath(new URL('../node_modules/prisma/build/index.js', import.meta.url)), 'migrate', 'deploy',
        '--config', fileURLToPath(new URL('../prisma.config.ts', import.meta.url)),
      ], { env: { NODE_ENV: 'development', DATABASE_URL: config.databaseUrl }, encoding: 'utf8' });
      if (migration.status !== 0) throw new Error('Demo migration failed');
      const operator = createOperator(database.prisma, identity);
      async function provision(role: DemoRole): Promise<DemoAccount> {
        const password = randomBytes(24).toString('base64url');
        const input = { email: `${role}@example.test`, name: `Demo ${role}`, password };
        const user = role === 'administrator' ? await operator.bootstrap(input) : await operator.provision(input);
        return { id: user.id, email: user.email, password };
      }
      const accounts = { administrator: await provision('administrator'), editor: await provision('editor'),
        reader: await provision('reader'), outsider: await provision('outsider') };
      await credentialFile.writeFile(JSON.stringify({ database: DEMO_DATABASE, accounts }, null, 2) + '\n');
      console.log('Demo accounts provisioned. Private credentials stored in artifacts/demo/credentials.json.');
      for (const role of DEMO_ROLES) console.log(`${role}: ${accounts[role].email} (${accounts[role].id})`);
    } finally {
      await credentialFile.close();
    }
  } finally {
    try {
      if (commandConnection && commandLocked) await commandConnection.query('SELECT pg_advisory_unlock(7242027)');
    } finally {
      commandConnection?.release();
      await database.close();
    }
  }
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true, options: { database: { type: 'string' } },
  });
  if (positionals.length !== 1) throw new Error('Use init, setup, or reset');
  const command = positionals[0];
  if (command === 'init' && values.database === undefined) {
    await initializeDemo();
    console.log('Private .env.demo created. Start the designated database, then run setup explicitly.');
  } else if ((command === 'setup' || command === 'reset') && values.database !== undefined) {
    await runFixtureCommand(command, values.database);
  } else throw new Error('Use init, or setup/reset --database scrawl_demo_a');
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(() => {
    console.error('Demo fixture command failed. Check the command, private configuration, designated database, and fixture state. Reset is always explicit.');
    process.exitCode = 1;
  });
}
