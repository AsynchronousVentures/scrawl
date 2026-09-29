// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import { readConfig } from './config.js';
import { createDatabase } from './db/client.js';
import { buildApp } from './app.js';

async function main(): Promise<void> {
  // Only this composition root reads the environment.
  const config = readConfig(process.env);
  const database = createDatabase(config, () => {
    console.error('An idle database connection failed');
  });
  const app = await buildApp({ config, checkDatabase: () => database.ping() });
  app.addHook('onClose', async () => database.close());

  let stopping = false;
  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    const timeout = setTimeout(() => process.exit(1), 10_000);
    timeout.unref();
    try {
      await app.close();
      clearTimeout(timeout);
    } catch {
      app.log.error('Graceful shutdown failed');
      process.exitCode = 1;
    }
  };
  process.once('SIGTERM', () => { void shutdown(); });
  process.once('SIGINT', () => { void shutdown(); });
  try {
    await app.listen({ host: config.host, port: config.port });
  } catch {
    await app.close();
    throw new Error('API startup failed');
  }
}

main().catch((error: unknown) => {
  // Configuration errors are already sanitized by readConfig.
  console.error(error instanceof Error ? error.message : 'API startup failed');
  process.exitCode = 1;
});
