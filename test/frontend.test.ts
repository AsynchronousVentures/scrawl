// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { frontendRootIfBuilt } from '../src/http/frontend.js';

const config = readConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgresql://unused@localhost/unused' });

test('built frontend serves private/public shells and assets without changing API errors or OpenAPI', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'scrawl-frontend-'));
  const root = join(directory, 'web');
  await mkdir(join(root, 'assets'), { recursive: true });
  await writeFile(join(root, 'index.html'), '<!doctype html><title>Scrawl shell</title>');
  await writeFile(join(root, 'assets', 'app.js'), 'console.log("Scrawl asset");');
  await writeFile(join(root, 'private.txt'), 'SYNTHETIC-PRIVATE-SERVER-FILE');
  await writeFile(join(root, 'assets', '.hidden'), 'SYNTHETIC-PRIVATE-SERVER-FILE');
  t.after(() => rm(directory, { recursive: true }));
  const app = await buildApp({ config: { ...config, apiDocsEnabled: false }, frontendRoot: root,
    checkDatabase: async () => {}, logging: false,
  });
  t.after(() => app.close());

  await t.test('HTML and assets retain no-store and server-generated request IDs', async () => {
    for (const [url, type, text] of [
      ['/?space=synthetic', /text\/html/, 'Scrawl shell'],
      ['/spaces/demo-handbook', /text\/html/, 'Scrawl shell'],
      ['/spaces/demo-handbook/documents/getting-started', /text\/html/, 'Scrawl shell'],
      ['/publications/00000000-0000-4000-8000-000000000001', /text\/html/, 'Scrawl shell'],
      ['/assets/app.js', /(?:text|application)\/javascript/, 'Scrawl asset'],
    ] as const) {
      const result = await app.inject(url);
      assert.equal(result.statusCode, 200);
      assert.match(String(result.headers['content-type']), type);
      if (!url.startsWith('/assets/')) assert.equal(result.headers['cross-origin-opener-policy'], 'same-origin');
      assert.equal(result.headers['cache-control'], 'no-store');
      assert.equal(result.headers['x-content-type-options'], 'nosniff');
      assert.match(String(result.headers['x-request-id']), /^[0-9a-f-]{36}$/);
      assert(result.body.includes(text));
    }
    const head = await app.inject({ method: 'HEAD', url: '/' });
    assert.equal(head.statusCode, 200);
    assert.equal(head.body, '');
  });

  await t.test('API, auth, health, missing assets, and unsupported web routes keep problem responses', async () => {
    for (const url of ['/api/auth/sign-up/email', '/api/v1/publishing', '/health/missing', '/openapi.json',
      '/assets/missing.js', '/documents/synthetic', '/private.txt']) {
      const result = await app.inject(url);
      assert.equal(result.statusCode, 404);
      assert.match(String(result.headers['content-type']), /application\/problem\+json/);
      assert.equal(result.json().code, 'NOT_FOUND');
      assert.equal(result.headers['cache-control'], 'no-store');
      assert(!result.body.includes('Scrawl shell'));
    }
    assert.equal((await app.inject({ method: 'POST', url: '/' })).statusCode, 404);
  });

  await t.test('static paths cannot read other build files or hidden files', async () => {
    for (const url of ['/assets/%2e%2e/private.txt', '/assets/.hidden', '/assets/%2e%2e/%2e%2e/private.txt']) {
      const result = await app.inject(url);
      assert(result.statusCode >= 400 && result.statusCode < 500);
      assert(!result.body.includes('SYNTHETIC-PRIVATE-SERVER-FILE'));
    }
  });

  await t.test('frontend routes stay out of generated OpenAPI', async () => {
    const spec = app.swagger();
    assert.deepEqual(Object.keys(spec.paths ?? {}).sort(), ['/health/live', '/health/ready']);
  });
});

test('frontend composition distinguishes an absent build from an invalid one', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'scrawl-frontend-build-'));
  t.after(() => rm(directory, { recursive: true }));
  assert.equal(await frontendRootIfBuilt(directory), undefined);
  await mkdir(join(directory, 'index.html'));
  await assert.rejects(frontendRootIfBuilt(directory), /Frontend build is invalid/);
  await rm(join(directory, 'index.html'), { recursive: true });
  await writeFile(join(directory, 'index.html'), '<!doctype html>');
  assert.equal(await frontendRootIfBuilt(directory), directory);
});
