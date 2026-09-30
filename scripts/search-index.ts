// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import pg from 'pg';
import { pathToFileURL } from 'node:url';
import { readConfig, type AppConfig } from '../src/config.js';

/** Host-only maintenance. Rebuild derived GIN state without touching snapshots. */
export async function rebuildSearchIndex(config: AppConfig): Promise<void> {
  const target = new URL(config.databaseUrl);
  const schema = target.searchParams.get('schema') ?? 'public';
  if (config.nodeEnv === 'production' || !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)
    || !/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error('Search maintenance requires a local non-production target');
  const connection = new pg.Client({ connectionString: config.databaseUrl,
    options: `-c search_path=${schema}`, connectionTimeoutMillis: 2_000,
    query_timeout: 300_000, statement_timeout: 300_000,
  });
  try {
    await connection.connect();
    await connection.query('REINDEX INDEX CONCURRENTLY "DocumentRevision_searchVector_idx"');
  } finally { await connection.end(); }
}

async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== 'rebuild') throw new Error('Use rebuild');
  await rebuildSearchIndex(readConfig(process.env));
  console.log('Derived document search index rebuilt. Document content and revision history were unchanged.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error('Search index maintenance failed. Check the command, local non-production configuration, and applied migrations.');
    process.exitCode = 1;
  });
}
