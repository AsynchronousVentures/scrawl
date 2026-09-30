// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'vite';
import type { ViteDevServer } from 'vite';
import { readDemoConfig, readPrivateDemoEnvironment } from './demo-config.js';

export function readDemoWebPort(args: readonly string[], apiPort: number) {
  if (args.length === 0) {
    if (apiPort === 5173) throw new Error('Demo frontend and API ports must differ');
    return 5173;
  }
  if (args.length !== 2 || args[0] !== '--port' || !/^\d+$/.test(args[1] ?? '')) {
    throw new Error('Demo frontend accepts only --port');
  }
  const port = Number(args[1]);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || port === apiPort) {
    throw new Error('Demo frontend port must be valid and differ from the API port');
  }
  return port;
}

async function main() {
  const { config, identity } = readDemoConfig(await readPrivateDemoEnvironment());
  const port = readDemoWebPort(process.argv.slice(2), config.port);
  const origin = `http://127.0.0.1:${port}`;
  const apiOrigin = `http://127.0.0.1:${config.port}`;
  const root = fileURLToPath(new URL('../', import.meta.url));
  const http = createHttpServer();
  let vite: ViteDevServer | undefined;
  let stopping = false;
  let requestStop = () => { stopping = true; };
  const stopped = new Promise<void>((done) => {
    requestStop = () => { stopping = true; done(); };
  });
  process.once('SIGINT', requestStop);
  process.once('SIGTERM', requestStop);
  const api = spawn(process.execPath, ['--import', 'tsx', resolve(root, 'src/server.ts')], {
    cwd: root, stdio: 'inherit', env: {
      ...process.env, NODE_ENV: config.nodeEnv, HOST: config.host, PORT: String(config.port),
      LOG_LEVEL: config.logLevel, API_DOCS_ENABLED: String(config.apiDocsEnabled),
      PUBLIC_PUBLISHING_ENABLED: String(config.publicPublishingEnabled),
      ATTACHMENT_STORAGE_DIR: resolve(config.attachmentStorageDir),
      DB_POOL_MAX: String(config.databasePoolMax), DATABASE_URL: config.databaseUrl,
      APP_ORIGIN: origin, AUTH_SECRET: identity.secret,
    },
  });
  let apiClosed = false;
  const closed = new Promise<void>((done) => {
    api.once('close', () => { apiClosed = true; done(); });
  });
  const failedApi = () => {
    if (!stopping) {
      process.exitCode = 1;
      console.error('Demo development API stopped unexpectedly.');
      requestStop();
    }
  };
  api.once('error', failedApi);
  api.once('exit', failedApi);
  try {
    // Retry only readiness reads. Authentication and product writes are never retried.
    const deadline = Date.now() + 15_000;
    let ready = false;
    while (!stopping && Date.now() < deadline) {
      try {
        const response = await fetch(apiOrigin + '/health/ready', { signal: AbortSignal.timeout(1000) });
        if (response.ok) { ready = true; break; }
      } catch { /* The child may still be starting. */ }
      await delay(100);
    }
    if (stopping) return;
    if (!ready) throw new Error('Demo development API was not ready');
    const proxy = Object.fromEntries(['/api', '/health', '/openapi.json'].map((path) =>
      [path, { target: apiOrigin, changeOrigin: false }]));
    vite = await createServer({
      root: resolve(root, 'web'), configFile: resolve(root, 'web/vite.config.ts'),
      // Middleware mode leaves process and child cleanup to this composition root.
      server: { middlewareMode: true, hmr: { server: http }, host: '127.0.0.1', port, strictPort: true, cors: false, proxy },
    });
    if (stopping) return;
    http.on('request', vite.middlewares);
    await new Promise<void>((done, reject) => {
      http.once('error', reject);
      http.listen(port, '127.0.0.1', done);
    });
    console.log(`Demo B development is running at ${origin}.`);
    await stopped;
  } finally {
    stopping = true;
    try {
      await vite?.close();
      if (http.listening) await new Promise<void>((done, reject) => http.close(error => error ? reject(error) : done()));
    } finally {
      if (!apiClosed) api.kill('SIGTERM');
      await Promise.race([closed, delay(12_000, undefined, { ref: false })]);
      if (!apiClosed) { api.kill('SIGKILL'); await closed; }
      process.removeListener('SIGINT', requestStop);
      process.removeListener('SIGTERM', requestStop);
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error('Demo development refused configuration or failed to start.');
    process.exitCode = 1;
  });
}
