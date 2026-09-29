// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import { mkdir, writeFile } from 'node:fs/promises';
import { buildApp } from '../src/app.js';
import { readConfig } from '../src/config.js';

const app = await buildApp({
  config: readConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgresql://unused@localhost/unused' }),
  checkDatabase: async () => { throw new Error('OpenAPI generation must not access the database'); },
  logging: false,
});
try {
  await app.ready();
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/openapi.json', JSON.stringify(app.swagger(), null, 2) + '\n');
} finally {
  await app.close();
}
