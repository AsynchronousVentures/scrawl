// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import { mkdir, writeFile } from 'node:fs/promises';
import { buildApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { randomBytes } from 'node:crypto';
import { createDatabase } from '../src/db/client.js';
import { createPublishing } from '../src/capabilities/publishing/index.js';
import { createExporting } from '../src/capabilities/exporting/index.js';
import { createCore } from '../src/core/index.js';
import { createCollaboration } from '../src/capabilities/collaboration/index.js';

const config = readConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgresql://unused@localhost/unused' });
const database = createDatabase(config, () => {});
const identity = { origin: 'http://127.0.0.1:3000', secret: randomBytes(32).toString('hex'), secureCookies: false };
const core = createCore(database.prisma, identity);
// Generate implemented optional routes without opening sockets or claiming a database lease.
const collaboration = createCollaboration(core, {
  assertHeld() { throw new Error('OpenAPI generation must not execute live operations'); },
  lost: new Promise<void>(() => {}),
}, identity.origin);
const app = await buildApp({
  config,
  core, publishing: createPublishing(core.documents, core.identity, { enabled: false }), exporting: createExporting(core.documents, core.attachments, { origin: identity.origin }),
  collaboration,
  checkDatabase: async () => { throw new Error('OpenAPI generation must not access the database'); },
  logging: false,
});
try {
  await app.ready();
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/openapi.json', JSON.stringify(app.swagger(), null, 2) + '\n');
} finally {
  await collaboration.close(app.server);
  await app.close();
  await database.close();
}
