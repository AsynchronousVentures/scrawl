// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

export type Environment = Readonly<Record<string, string | undefined>>;
export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
export type AppConfig = Readonly<{
  nodeEnv: 'development' | 'test' | 'production';
  host: string;
  port: number;
  logLevel: LogLevel;
  apiDocsEnabled: boolean;
  publicPublishingEnabled: boolean;
  databaseUrl: string;
  databasePoolMax: number;
  attachmentStorageDir: string;
}>;

export type IdentityConfig = Readonly<{
  origin: string;
  secret: string;
  secureCookies: boolean;
}>;

/** Identity settings are required by the server/operator, not offline foundation tests. */
export function readIdentityConfig(env: Environment, config: AppConfig): IdentityConfig {
  const secret = env.AUTH_SECRET;
  if (!secret || secret.length < 32 || /\s/.test(secret)) {
    throw new Error('AUTH_SECRET must contain at least 32 characters without whitespace');
  }
  const production = config.nodeEnv === 'production';
  const rawOrigin = env.APP_ORIGIN ?? (production ? '' : `http://127.0.0.1:${config.port}`);
  let origin: string;
  try {
    const url = new URL(rawOrigin);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash || (production && url.protocol !== 'https:')) {
      throw new Error('invalid');
    }
    origin = url.origin;
  } catch {
    throw new Error('APP_ORIGIN must be an HTTP origin, using HTTPS in production');
  }
  return Object.freeze({ origin, secret, secureCookies: production || origin.startsWith('https:') });
}

function integer(name: string, raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = raw ?? String(fallback);
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return parsed;
}

function boolean(name: string, raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`${name} must be true or false`);
}

/** Pure configuration parsing. Errors name the setting, never its secret value. */
export function readConfig(env: Environment): AppConfig {
  const nodeEnv = env.NODE_ENV ?? 'development';
  if (nodeEnv !== 'development' && nodeEnv !== 'test' && nodeEnv !== 'production') {
    throw new Error('NODE_ENV must be development, test, or production');
  }
  const logLevel = env.LOG_LEVEL ?? 'info';
  if (!['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'].includes(logLevel)) {
    throw new Error('LOG_LEVEL is invalid');
  }
  const host = env.HOST ?? '127.0.0.1';
  if (host.length === 0 || /\s/.test(host)) throw new Error('HOST must be a nonempty host without whitespace');
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  try {
    const url = new URL(databaseUrl);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.pathname.length < 2) {
      throw new Error('invalid');
    }
  } catch {
    throw new Error('DATABASE_URL must be a PostgreSQL URL with a host and database');
  }
  return Object.freeze({
    nodeEnv,
    host,
    port: integer('PORT', env.PORT, 3000, 1, 65535),
    logLevel: logLevel as LogLevel,
    apiDocsEnabled: boolean('API_DOCS_ENABLED', env.API_DOCS_ENABLED, nodeEnv === 'development'),
    publicPublishingEnabled: boolean('PUBLIC_PUBLISHING_ENABLED', env.PUBLIC_PUBLISHING_ENABLED, false),
    databaseUrl,
    attachmentStorageDir: env.ATTACHMENT_STORAGE_DIR ?? 'var/private-attachments',
    databasePoolMax: integer('DB_POOL_MAX', env.DB_POOL_MAX, 5, 1, 100),
  });
}
