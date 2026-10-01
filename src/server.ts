// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import { readConfig, readIdentityConfig } from './config.js';
import { createDatabase } from './db/client.js';
import { buildApp } from './app.js';
import { createPublishing } from './capabilities/publishing/index.js';
import { createExporting } from './capabilities/exporting/index.js';
import { createCore } from './core/index.js';
import { fileURLToPath } from 'node:url';
import { frontendRootIfBuilt } from './http/frontend.js';
import { claimLiveOwner } from './db/live-owner.js';
import { createCollaboration } from './capabilities/collaboration/index.js';

async function main(): Promise<void> {
  // Only this composition root reads the environment.
  const config = readConfig(process.env);
  const identityConfig = readIdentityConfig(process.env, config);
  const frontendRoot = await frontendRootIfBuilt(fileURLToPath(new URL('../web/dist/', import.meta.url)));
  const database = createDatabase(config, () => {
    console.error('An idle database connection failed');
  });
  const core = createCore(database.prisma, identityConfig, { attachmentStorageDir: config.attachmentStorageDir });
  let owner: Awaited<ReturnType<typeof claimLiveOwner>> | undefined;
  try { if (config.collaborationEnabled) owner = await claimLiveOwner(database.pool); }
  catch { await database.close(); throw new Error('Collaboration ownership unavailable'); }
  const collaboration = owner ? createCollaboration(core, owner, identityConfig.origin) : undefined;
  const app = await buildApp({ config, core, publishing: createPublishing(core.documents, core.identity, { enabled: config.publicPublishingEnabled }), exporting: createExporting(core.documents, core.attachments, { origin: identityConfig.origin }), checkDatabase: async () => { owner?.assertHeld(); await database.ping(); owner?.assertHeld(); },
    ...(frontendRoot ? { frontendRoot } : {}),
    ...(collaboration ? { collaboration } : {}),
  }).catch(async () => {
    await collaboration?.close(); await owner?.close(); await database.close();
    throw new Error('API composition failed');
  });
  if (collaboration && owner) {
    collaboration.attach(app.server);
    // WebSocket shutdown must precede HTTP server closing, which otherwise waits on upgrades.
    app.addHook('preClose', async () => collaboration.close(app.server));
  }
  app.addHook('onClose', async () => { await owner?.close(); await database.close(); });

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
  void owner?.lost.then(() => { process.exitCode = 1; void shutdown(); });
  try {
    await app.listen({ host: config.host, port: config.port });
  } catch {
    await app.close();
    throw new Error('API startup failed');
  }
}

main().catch(() => {
  console.error('API startup failed; check configuration and database');
  process.exitCode = 1;
});
