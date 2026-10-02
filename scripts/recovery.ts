// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { readConfig, type AppConfig } from '../src/config.js';
import { MAX_UPLOAD_BYTES } from '../src/core/attachments/index.js';
import { checkContent } from './content-check.js';
import { readDemoConfig, readPrivateDemoEnvironment } from './demo-config.js';

type FileRecord = { name: string; size: number; sha256: string };
type TableRecord = { name: string; rows: number; sha256: string };
type Manifest = { format: 'scrawl-recovery'; version: 1; postgres: 18; dump: FileRecord;
  files: FileRecord[]; tables: TableRecord[] };
type Options = { config: AppConfig; clientContainer?: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const recoveryName = /^scrawl_recovery_[a-z0-9_]{1,47}$/;
const repository = fileURLToPath(new URL('..', import.meta.url));

function privateDestination(path: string) {
  const destination = resolve(path); const within = relative(repository, destination);
  if (!isAbsolute(within) && within !== '..' && !within.startsWith('..' + sep)
    && !within.startsWith('artifacts' + sep) && !within.startsWith('var' + sep)) {
    throw new Error('Private recovery output inside this checkout must use ignored artifacts/ or var/, never source or frontend assets');
  }
  return destination;
}

function target(config: AppConfig) {
  const url = new URL(config.databaseUrl);
  if (process.env.NODE_ENV === 'production' || config.nodeEnv === 'production'
    || !['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || !url.username || !url.password || url.search || url.hash || url.pathname === '/') {
    throw new Error('Recovery requires a local non-production whole database, without schema overrides');
  }
  return url;
}

async function privateDirectory(path: string) {
  const info = await lstat(path);
  if (!info.isDirectory() || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) {
    throw new Error('Recovery directories must be owner-only directories, not symbolic links');
  }
}

async function storageFiles(path: string) {
  try { await privateDirectory(path); return (await readdir(path)).sort(); }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
}

async function privateFile(path: string, limit: number) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())
      || info.size > limit) throw new Error('Recovery files must be bounded owner-only regular files');
    return file;
  } catch (error) { await file.close(); throw error; }
}

async function fingerprint(path: string, limit: number): Promise<FileRecord> {
  const file = await privateFile(path, limit);
  try {
    const hash = createHash('sha256'); let size = 0;
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      size += chunk.length;
      if (size > limit) throw new Error('Recovery file exceeds its limit');
      hash.update(chunk);
    }
    return { name: path.split('/').at(-1)!, size, sha256: hash.digest('hex') };
  } finally { await file.close(); }
}

async function copyPrivate(source: string, destination: string) {
  const file = await privateFile(source, MAX_UPLOAD_BYTES);
  try { await writeFile(destination, await file.readFile(), { flag: 'wx', mode: 0o600 }); }
  finally { await file.close(); }
}

async function records(pool: pg.Pool): Promise<TableRecord[]> {
  const names = await pool.query<{ name: string }>(`SELECT tablename AS name FROM pg_tables
    WHERE schemaname = 'public' ORDER BY tablename`);
  const tables: TableRecord[] = [];
  for (const { name } of names.rows) {
    const identifier = '"' + name.replaceAll('"', '""') + '"';
    const result = await pool.query<{ rows: string; sha256: string }>(`SELECT count(*)::text AS rows,
      encode(sha256(convert_to(coalesce(string_agg(to_jsonb(t)::text, E'\\n' ORDER BY to_jsonb(t)::text), ''), 'UTF8')), 'hex') AS sha256
      FROM public.${identifier} t`);
    tables.push({ name, rows: Number(result.rows[0]!.rows), sha256: result.rows[0]!.sha256 });
  }
  if (!tables.some(table => table.name === '_prisma_migrations') || !tables.some(table => table.name === 'DocumentRevision')) {
    throw new Error('Recovery source does not contain the Scrawl migration history');
  }
  return tables;
}

async function stopped(pool: pg.Pool) {
  const result = await pool.query<{ connections: string }>(`SELECT count(*)::text AS connections FROM pg_stat_activity
    WHERE datname = current_database() AND pid <> pg_backend_pid()`);
  if (result.rows[0]!.connections !== '0') throw new Error('Stop every application and other connection to the source database first');
}

async function native(options: Options) {
  const url = target(options.config);
  const pool = new pg.Pool({ connectionString: url.href, max: 1, connectionTimeoutMillis: 2000,
    statement_timeout: 60_000, query_timeout: 60_000 });
  try {
    const version = await pool.query<{ version: string }>("SELECT current_setting('server_version_num') AS version");
    if (Math.floor(Number(version.rows[0]!.version) / 10_000) !== 18) throw new Error('Recovery targets PostgreSQL 18 only');
    if (options.clientContainer) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}$/.test(options.clientContainer)) throw new Error('Invalid native client container');
      const ports = spawnSync('docker', ['port', options.clientContainer, '5432/tcp'], { encoding: 'utf8' });
      if (ports.status !== 0 || !ports.stdout.trim().split('\n').includes(`127.0.0.1:${url.port || '5432'}`)) {
        throw new Error('Client container must be the existing PostgreSQL server at the configured loopback port');
      }
    }
    // Passwords travel only in the child environment, never argv, logs or the archive manifest.
    const env = { ...process.env, PGHOST: options.clientContainer ? '127.0.0.1' : url.hostname.replace(/^\[|\]$/g, ''),
      PGPORT: options.clientContainer ? '5432' : url.port || '5432', PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
      PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password), PGCONNECT_TIMEOUT: '5' };
    function run(command: 'pg_dump' | 'pg_restore', args: string[], input?: number, output?: number) {
      const docker = options.clientContainer;
      const result = spawnSync(docker ? 'docker' : command, docker ? ['exec', '-i',
        ...['PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD', 'PGCONNECT_TIMEOUT'].flatMap(name => ['-e', name]),
        docker, command, ...args] : args, {
        env, stdio: [input ?? 'ignore', output ?? 'pipe', 'pipe'], timeout: 120_000, maxBuffer: 1_048_576,
      });
      if (result.status !== 0 || result.error) throw new Error(`Native ${command} failed; no private diagnostic output was logged`);
      // Any dump/restore warning is review work, not a successful checkpoint.
      if (result.stderr?.length) throw new Error(`Native ${command} reported a warning; recovery refused`);
      return result.stdout?.toString() ?? '';
    }
    for (const command of ['pg_dump', 'pg_restore'] as const) {
      if (!new RegExp(`^${command} \\(PostgreSQL\\) 18\\.`).test(run(command, ['--version']))) {
        throw new Error('Recovery requires PostgreSQL 18 native clients');
      }
    }
    return { pool, run };
  } catch (error) { await pool.end(); throw error; }
}

/** Host-only stopped-application snapshot. Never includes the separate runtime secret file. */
export async function backupInstance(options: Options & { output: string; applicationStopped: boolean }) {
  if (!options.applicationStopped) throw new Error('Explicit application-stopped acknowledgement is required');
  const output = privateDestination(options.output); const tools = await native(options); let ownsOutput = false;
  try {
    await stopped(tools.pool);
    const names = await storageFiles(resolve(options.config.attachmentStorageDir));
    const integrity = await checkContent(tools.pool, options.config.attachmentStorageDir);
    if (!integrity.ok) throw new Error('Source content or private-file integrity failed');
    const before = await records(tools.pool);
    await mkdir(output, { mode: 0o700 }); ownsOutput = true;
    await mkdir(join(output, 'files'), { mode: 0o700 });
    const dump = await open(join(output, 'database.dump'), 'wx', 0o600);
    try { tools.run('pg_dump', ['--format=custom', '--no-acl'], undefined, dump.fd); }
    finally { await dump.close(); }
    const files: FileRecord[] = [];
    for (const name of names) {
      if (!uuid.test(name)) throw new Error('Private storage contains an unrecognized entry; inspect it before recovery');
      await copyPrivate(join(options.config.attachmentStorageDir, name), join(output, 'files', name));
      files.push(await fingerprint(join(output, 'files', name), MAX_UPLOAD_BYTES));
    }
    await stopped(tools.pool);
    assert.deepEqual(await records(tools.pool), before, 'Source records changed during backup');
    for (const file of files) assert.deepEqual(await fingerprint(join(options.config.attachmentStorageDir, file.name), MAX_UPLOAD_BYTES), file);
    assert.deepEqual(await storageFiles(options.config.attachmentStorageDir), files.map(file => file.name));
    const manifest: Manifest = { format: 'scrawl-recovery', version: 1, postgres: 18,
      dump: await fingerprint(join(output, 'database.dump'), 1_073_741_824), files, tables: before };
    // A manifest is the last completion marker. Incomplete directories cannot be restored.
    await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest), { flag: 'wx', mode: 0o600 });
    return { tables: before.length, files: files.length, integrity };
  } catch (error) { if (ownsOutput) await rm(output, { recursive: true, force: true }); throw error; }
  finally { await tools.pool.end(); }
}

async function readBackup(path: string): Promise<Manifest> {
  await privateDirectory(path); await privateDirectory(join(path, 'files'));
  const file = await privateFile(join(path, 'manifest.json'), 1_048_576);
  let manifest: Manifest;
  try {
    const value: unknown = JSON.parse(await file.readFile('utf8'));
    // This checks the complete native manifest shape without trusting filenames or extra fields.
    const expected = { format: 'scrawl-recovery', version: 1, postgres: 18, dump: {}, files: [], tables: [] };
    assert(value && typeof value === 'object');
    assert.deepEqual(Object.keys(value).sort(), Object.keys(expected).sort());
    manifest = value as Manifest;
    assert.equal(manifest.format, expected.format); assert.equal(manifest.version, 1); assert.equal(manifest.postgres, 18);
    function valid(record: FileRecord) {
      assert(record && typeof record === 'object');
      assert.deepEqual(Object.keys(record).sort(), ['name', 'size', 'sha256'].sort());
      assert(Number.isSafeInteger(record.size) && record.size >= 0); assert.match(record.sha256, /^[a-f0-9]{64}$/);
    }
    valid(manifest.dump); assert.equal(manifest.dump.name, 'database.dump');
    assert(Array.isArray(manifest.files) && Array.isArray(manifest.tables));
    for (const entry of manifest.files) { valid(entry); assert.match(entry.name, uuid); assert(entry.size <= MAX_UPLOAD_BYTES); }
    assert.equal(new Set(manifest.files.map(entry => entry.name)).size, manifest.files.length);
    for (const entry of manifest.tables) {
      assert.deepEqual(Object.keys(entry).sort(), ['name', 'rows', 'sha256'].sort());
      assert.match(entry.name, /^[a-zA-Z_][a-zA-Z0-9_]*$/); assert(Number.isSafeInteger(entry.rows) && entry.rows >= 0);
      assert.match(entry.sha256, /^[a-f0-9]{64}$/);
    }
    assert.equal(new Set(manifest.tables.map(entry => entry.name)).size, manifest.tables.length);
  } finally { await file.close(); }
  assert.deepEqual((await readdir(path)).sort(), ['database.dump', 'files', 'manifest.json']);
  assert.deepEqual((await readdir(join(path, 'files'))).sort(), manifest.files.map(entry => entry.name).sort());
  assert.deepEqual(await fingerprint(join(path, 'database.dump'), 1_073_741_824), manifest.dump);
  for (const entry of manifest.files) assert.deepEqual(await fingerprint(join(path, 'files', entry.name), MAX_UPLOAD_BYTES), entry);
  return manifest;
}

/** Creates a new development database only. Never cleans or replaces an existing database/storage path. */
export async function restoreInstance(options: Options & { backup: string; databaseName: string; storage: string; trusted: boolean }) {
  if (!options.trusted || !recoveryName.test(options.databaseName)) throw new Error('Restore requires a trusted archive and a new scrawl_recovery_ target');
  const backup = resolve(options.backup); const storage = privateDestination(options.storage);
  if (storage === backup || storage.startsWith(backup + sep)) throw new Error('Restore storage must be separate from the immutable backup');
  const manifest = await readBackup(backup); const tools = await native(options);
  let ownsStorage = false; let ownsDatabase = false; let restored: pg.Pool | undefined;
  try {
    await mkdir(storage, { mode: 0o700 }); ownsStorage = true;
    // CREATE DATABASE atomically refuses an existing target; there is deliberately no --clean or DROP before it.
    await tools.pool.query(`CREATE DATABASE "${options.databaseName}" TEMPLATE template0`); ownsDatabase = true;
    const url = target(options.config); url.pathname = '/' + options.databaseName;
    restored = new pg.Pool({ connectionString: url.href, max: 1, connectionTimeoutMillis: 2000 });
    const restoreTools = await native({ ...options, config: { ...options.config, databaseUrl: url.href } });
    try {
      const dump = await privateFile(join(resolve(options.backup), 'database.dump'), 1_073_741_824);
      try { restoreTools.run('pg_restore', ['--single-transaction', '--exit-on-error', '--no-owner', '--no-acl', '--dbname', options.databaseName], dump.fd); }
      finally { await dump.close(); }
    } finally { await restoreTools.pool.end(); }
    for (const entry of manifest.files) {
      await copyPrivate(join(resolve(options.backup), 'files', entry.name), join(storage, entry.name));
      assert.deepEqual(await fingerprint(join(storage, entry.name), MAX_UPLOAD_BYTES), entry);
    }
    assert.deepEqual(await records(restored), manifest.tables, 'Restored database records differ from the backup');
    const integrity = await checkContent(restored, storage);
    if (!integrity.ok) throw new Error('Restored content or private-file integrity failed');
    return { databaseName: options.databaseName, tables: manifest.tables.length, files: manifest.files.length, integrity };
  } catch (error) {
    await restored?.end(); restored = undefined;
    if (ownsDatabase) await tools.pool.query(`DROP DATABASE "${options.databaseName}"`);
    if (ownsStorage) await rm(storage, { recursive: true, force: true });
    throw error;
  } finally { await restored?.end(); await tools.pool.end(); }
}

async function main() {
  const args = process.argv.slice(2); const command = args.shift();
  const values = new Map<string, string>(); const flags = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (['--demo', '--application-stopped', '--trusted'].includes(arg)) {
      if (flags.has(arg)) throw new Error('Duplicate recovery argument'); flags.add(arg);
    } else if (['--output', '--backup', '--database', '--storage', '--client-container'].includes(arg)) {
      const value = args[++index];
      if (!value || value.startsWith('--') || values.has(arg)) throw new Error('Invalid recovery argument'); values.set(arg, value);
    } else throw new Error('Unknown recovery argument');
  }
  const config = flags.has('--demo') ? readDemoConfig(await readPrivateDemoEnvironment()).config : readConfig(process.env);
  const common = { config, ...(values.has('--client-container') ? { clientContainer: values.get('--client-container')! } : {}) };
  if (command === 'backup' && values.has('--output') && !flags.has('--trusted')
    && [...values.keys()].every(key => ['--output', '--client-container'].includes(key))) {
    console.log(JSON.stringify(await backupInstance({ ...common, output: values.get('--output')!, applicationStopped: flags.has('--application-stopped') })));
  } else if (command === 'restore' && values.has('--backup') && values.has('--database') && values.has('--storage')
    && !flags.has('--application-stopped') && !values.has('--output')) {
    console.log(JSON.stringify(await restoreInstance({ ...common, backup: values.get('--backup')!,
      databaseName: values.get('--database')!, storage: values.get('--storage')!, trusted: flags.has('--trusted') })));
  } else throw new Error('Use recovery backup --output PATH --application-stopped, or restore --backup PATH --database scrawl_recovery_NAME --storage PATH --trusted');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('Recovery refused or failed. Check stopped application, trusted private archive, fresh targets and PostgreSQL 18 configuration. Private diagnostics were not logged.'); process.exitCode = 1; });
}
