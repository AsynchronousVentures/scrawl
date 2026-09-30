// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import type { AppConfig } from '../config.js';

export function createDatabase(config: AppConfig, onIdleError: () => void) {
  const schema = new URL(config.databaseUrl).searchParams.get('schema') ?? 'public';
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error('DATABASE_URL schema must be a lowercase SQL identifier');
  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: config.databasePoolMax,
    connectionTimeoutMillis: 2_000,
    idleTimeoutMillis: 30_000,
    query_timeout: 3_000,
    statement_timeout: 3_000,
    options: `-c search_path=${schema}`,
  });
  pool.on('error', onIdleError);
  // Prisma and readiness share the existing pool; this function owns its shutdown.
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema }), log: [], errorFormat: 'minimal' });
  return {
    pool,
    prisma,
    async ping(): Promise<void> { await prisma.$queryRaw`SELECT 1`; },
    async close(): Promise<void> {
      await prisma.$disconnect();
      await pool.end();
    },
  };
}
