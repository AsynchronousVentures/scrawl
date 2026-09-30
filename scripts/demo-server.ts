// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readIdentityConfig } from '../src/config.js';
import { readDemoConfig, readPrivateDemoEnvironment } from './demo-config.js';

/** An explicit private HTTPS preview changes only runtime origin, never fixture targets. */
export function privateDemoOrigin(args: readonly string[]) {
  if (args.length === 0) return undefined;
  if (args.length !== 2 || args[0] !== '--origin' || !args[1]) throw new Error('Invalid demo server arguments');
  let origin: URL;
  try { origin = new URL(args[1]); }
  catch { throw new Error('Invalid private preview origin'); }
  if (origin.protocol !== 'https:' || !origin.hostname.endsWith('.ts.net')
    || origin.hostname === '.ts.net' || origin.username || origin.password || origin.port === '0'
    || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('Demo preview requires a private Tailscale HTTPS origin');
  }
  return origin.origin;
}

async function main() {
  const env = await readPrivateDemoEnvironment();
  const { config, identity: localIdentity } = readDemoConfig(env);
  const origin = privateDemoOrigin(process.argv.slice(2));
  const identity = origin ? readIdentityConfig({ ...env, APP_ORIGIN: origin }, config) : localIdentity;
  // Copy only settings consumed by the existing server composition root.
  Object.assign(process.env, {
    NODE_ENV: config.nodeEnv, HOST: config.host, PORT: String(config.port),
    LOG_LEVEL: config.logLevel, API_DOCS_ENABLED: String(config.apiDocsEnabled),
    DB_POOL_MAX: String(config.databasePoolMax), DATABASE_URL: config.databaseUrl,
    APP_ORIGIN: identity.origin, AUTH_SECRET: identity.secret,
  });
  await import('../src/server.js');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error('Demo server refused the private development configuration.');
    process.exitCode = 1;
  });
}
