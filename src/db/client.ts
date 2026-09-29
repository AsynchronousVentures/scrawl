// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import pg from 'pg';
import type { AppConfig } from '../config.js';

export function createDatabase(config: AppConfig, onIdleError: () => void) {
  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: config.databasePoolMax,
    connectionTimeoutMillis: 2_000,
    idleTimeoutMillis: 30_000,
    query_timeout: 3_000,
    statement_timeout: 3_000,
  });
  pool.on('error', onIdleError);
  return {
    pool,
    async ping(): Promise<void> { await pool.query('SELECT 1'); },
    async close(): Promise<void> { await pool.end(); },
  };
}
