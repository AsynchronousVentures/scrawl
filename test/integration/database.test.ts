// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import assert from 'node:assert/strict';
import test from 'node:test';
import { readConfig } from '../../src/config.js';
import { createDatabase } from '../../src/db/client.js';
import { buildApp } from '../../src/app.js';

test('readiness exercises a real PostgreSQL connection', async (t) => {
  // Explicit suite: missing environment/dependencies should FAIL, not silently skip.
  const config = readConfig(process.env);
  const database = createDatabase(config, () => {});
  t.after(() => database.close());
  const app = await buildApp({ config, logging: false, checkDatabase: () => database.ping() });
  t.after(() => app.close());
  const result = await app.inject('/health/ready');
  assert.equal(result.statusCode, 200);
  assert.equal(result.json().status, 'ready');
});
