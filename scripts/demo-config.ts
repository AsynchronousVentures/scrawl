// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import { lstat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { parseEnv } from 'node:util';
import { readConfig, readIdentityConfig } from '../src/config.js';
import type { Environment } from '../src/config.js';

export const DEMO_DATABASE = 'scrawl_demo_a';
export const DEMO_ENV_PATH = '.env.demo';
export const DEMO_CREDENTIALS_PATH = 'artifacts/demo/credentials.json';
export const DEMO_ROLES = ['administrator', 'editor', 'reader', 'outsider'] as const;
export type DemoRole = typeof DEMO_ROLES[number];
export type DemoAccount = Readonly<{ id: string; email: string; password: string }>;
export type DemoCredentials = Readonly<{
  database: typeof DEMO_DATABASE;
  accounts: Readonly<Record<DemoRole, DemoAccount>>;
}>;

/** Demo tools only consume a private, explicit file, never the ordinary DATABASE_URL. */
export async function readPrivateDemoFile(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0
      || (process.getuid && stat.uid !== process.getuid()) || stat.size > 16_384) {
      throw new Error('Demo files must be small, owner-only regular files');
    }
    return await file.readFile('utf8');
  } finally {
    await file.close();
  }
}

export async function readPrivateDemoEnvironment(path = DEMO_ENV_PATH): Promise<Environment> {
  if (process.env.NODE_ENV === 'production') throw new Error('Demo tools refuse production');
  return parseEnv(await readPrivateDemoFile(path));
}

export function readDemoConfig(env: Environment) {
  if (env.NODE_ENV !== 'development' || env.SCRAWL_DEMO_DISPOSABLE !== DEMO_DATABASE) {
    throw new Error('Demo tools require the explicit development disposable-database marker');
  }
  const config = readConfig(env);
  // Fixture commands reserve one connection for their coordinator lock.
  if (config.databasePoolMax < 2) throw new Error('Demo tools require DB_POOL_MAX of at least 2');
  const identity = readIdentityConfig(env, config);
  const target = new URL(config.databaseUrl);
  if (!['127.0.0.1', '[::1]', 'localhost'].includes(target.hostname)
    || target.pathname !== `/${DEMO_DATABASE}` || target.search || target.hash
    || !target.username || !target.password || config.host !== '127.0.0.1'
    || identity.origin !== `http://127.0.0.1:${config.port}` || identity.secureCookies
    || (env.POSTGRES_DB !== undefined && env.POSTGRES_DB !== DEMO_DATABASE)
    || (env.POSTGRES_USER !== undefined && env.POSTGRES_USER !== decodeURIComponent(target.username))
    || (env.POSTGRES_PASSWORD !== undefined && env.POSTGRES_PASSWORD !== decodeURIComponent(target.password))) {
    throw new Error('Demo tools require matching local API and designated disposable PostgreSQL targets');
  }
  return { config, identity };
}

function record(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input);
}

export async function readDemoCredentials(path = DEMO_CREDENTIALS_PATH): Promise<DemoCredentials> {
  let value: unknown;
  try { value = JSON.parse(await readPrivateDemoFile(path)); }
  catch { throw new Error('Demo credentials are invalid'); }
  if (!record(value) || value.database !== DEMO_DATABASE || !record(value.accounts)
    || Object.keys(value).length !== 2 || Object.keys(value.accounts).length !== DEMO_ROLES.length) {
    throw new Error('Demo credentials are invalid');
  }
  function account(role: DemoRole): DemoAccount {
    if (!record(value) || !record(value.accounts)) throw new Error('Demo credentials are invalid');
    const entry = value.accounts[role];
    if (!record(entry) || Object.keys(entry).length !== 3
      || typeof entry.id !== 'string' || !entry.id || entry.id.length > 200
      || entry.email !== `${role}@example.test`
      || typeof entry.password !== 'string' || entry.password.length < 12 || entry.password.length > 128) {
      throw new Error('Demo credentials are invalid');
    }
    return Object.freeze({ id: entry.id, email: entry.email, password: entry.password });
  }
  return Object.freeze({ database: DEMO_DATABASE, accounts: Object.freeze({
    administrator: account('administrator'), editor: account('editor'),
    reader: account('reader'), outsider: account('outsider'),
  }) });
}

export async function demoFileExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (record(error) && error.code === 'ENOENT') return false;
    throw error;
  }
}
