// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import { readDemoConfig, readPrivateDemoEnvironment } from './demo-config.js';

try {
  const env = await readPrivateDemoEnvironment();
  const { config, identity } = readDemoConfig(env);
  // Copy only settings consumed by the existing server composition root.
  Object.assign(process.env, {
    NODE_ENV: config.nodeEnv, HOST: config.host, PORT: String(config.port),
    LOG_LEVEL: config.logLevel, API_DOCS_ENABLED: String(config.apiDocsEnabled),
    DB_POOL_MAX: String(config.databasePoolMax), DATABASE_URL: config.databaseUrl,
    APP_ORIGIN: identity.origin, AUTH_SECRET: identity.secret,
  });
  await import('../src/server.js');
} catch {
  console.error('Demo server refused the private development configuration.');
  process.exitCode = 1;
}
