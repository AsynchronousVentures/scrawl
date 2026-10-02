// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { buildApp } from '../src/app.js';
import { readConfig } from '../src/config.js';

const config = readConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgresql://unused@localhost/unused' });

test('liveness works without accessing a dependency', async (t) => {
  const app = await buildApp({ config, logging: false, checkDatabase: async () => { throw new Error('must not run'); } });
  t.after(() => app.close());
  const result = await app.inject('/health/live');
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.json(), { status: 'ok' });
});
test('readiness succeeds after a database check', async (t) => {
  let called = false;
  const app = await buildApp({ config, logging: false, checkDatabase: async () => { called = true; } });
  t.after(() => app.close());
  const result = await app.inject('/health/ready');
  assert.equal(result.statusCode, 200);
  assert.equal(called, true);
});
test('dependency errors return sanitized problem details', async (t) => {
  const app = await buildApp({ config, logging: false, checkDatabase: async () => { throw new Error('private-db-password'); } });
  t.after(() => app.close());
  const result = await app.inject('/health/ready');
  assert.equal(result.statusCode, 503);
  assert.match(String(result.headers['content-type']), /^application\/problem\+json/);
  assert.equal(result.json().code, 'DEPENDENCY_UNAVAILABLE');
  assert(!result.body.includes('private-db-password'));
});
test('document routes are not pretending to be implemented', async (t) => {
  const app = await buildApp({ config, logging: false, checkDatabase: async () => {} });
  t.after(() => app.close());
  assert.equal((await app.inject('/api/v1/documents')).statusCode, 404);
});
test('unknown routes use the standard error shape without echoing query strings', async (t) => {
  const app = await buildApp({ config, logging: false, checkDatabase: async () => {} });
  t.after(() => app.close());
  const result = await app.inject('/missing?token=secret-value');
  assert.equal(result.json().code, 'NOT_FOUND');
  assert(!result.body.includes('secret-value'));
});
test('request IDs are server generated', async (t) => {
  const app = await buildApp({ config, logging: false, checkDatabase: async () => {} });
  t.after(() => app.close());
  const result = await app.inject({ url: '/health/live', headers: { 'x-request-id': 'untrusted' } });
  assert.match(String(result.headers['x-request-id']), /^[0-9a-f-]{36}$/);
  assert.notEqual(result.headers['x-request-id'], 'untrusted');
});
test('documentation can be disabled', async (t) => {
  const app = await buildApp({ config, logging: false, checkDatabase: async () => {} });
  t.after(() => app.close());
  assert.equal((await app.inject('/openapi.json')).statusCode, 404);
});
test('OpenAPI includes only implemented routes', async (t) => {
  const app = await buildApp({ config: { ...config, apiDocsEnabled: true }, logging: false, checkDatabase: async () => {} });
  t.after(() => app.close());
  const result = await app.inject('/openapi.json');
  assert.equal(result.statusCode, 200);
  assert.deepEqual(Object.keys(result.json().paths).sort(), ['/health/live', '/health/ready']);
});
test('request schemas reject unknown fields', async (t) => {
  const app = await buildApp({ config, logging: false, checkDatabase: async () => {} });
  // Test-only route; this is never registered by the production composition root.
  app.post('/validation-probe', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['title'], properties: { title: { type: 'string' } } } },
  }, async () => ({ ok: true }));
  t.after(() => app.close());
  const result = await app.inject({ method: 'POST', url: '/validation-probe', payload: { title: 'Title', secret: 'private-value' } });
  assert.equal(result.statusCode, 400);
  assert.equal(result.json().code, 'INVALID_REQUEST');
  assert(!result.body.includes('private-value'));
});
test('unexpected errors do not leak details', async (t) => {
  const app = await buildApp({ config, logging: false, checkDatabase: async () => {} });
  app.get('/error-probe', async () => { throw new Error('sensitive-query-or-token'); });
  t.after(() => app.close());
  const result = await app.inject('/error-probe');
  assert.equal(result.statusCode, 500);
  assert.equal(result.json().code, 'INTERNAL_ERROR');
  assert(!result.body.includes('sensitive-query-or-token'));
});
test('non-Error throws return sanitized internal problems', async (t) => {
  const app = await buildApp({ config, logging: false, checkDatabase: async () => {} });
  app.get('/error-probe', async () => { throw 'sensitive-thrown-value'; });
  t.after(() => app.close());
  const result = await app.inject('/error-probe');
  assert.equal(result.statusCode, 500);
  assert.equal(result.json().code, 'INTERNAL_ERROR');
  assert(!result.body.includes('sensitive-thrown-value'));
});
test('oversized bodies return sanitized request problems', async (t) => {
  const app = await buildApp({ config, logging: false, checkDatabase: async () => {} });
  app.post('/body-probe', async () => ({ ok: true }));
  t.after(() => app.close());
  const result = await app.inject({ method: 'POST', url: '/body-probe', payload: { text: 'x'.repeat(1024 * 1024) } });
  assert.equal(result.statusCode, 413);
  assert.equal(result.json().code, 'REQUEST_REJECTED');
});
test('logs omit credentials, private slugs, query strings, bodies and error details', () => {
  // Capture the real logger in a separate process without replacing its serializers.
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import { buildApp } from './src/app.ts';
    import { readConfig } from './src/config.ts';
    const app = await buildApp({
      config: readConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgresql://unused@localhost/unused' }),
      checkDatabase: async () => {},
    });
    app.post('/log-probe', async (_request, reply) => {
      reply.header('set-cookie', 'session=response-cookie-secret');
      const error = new Error('error-message-secret');
      error.name = 'error-name-secret';
      throw error;
    });
    app.get('/slug-log-probe/:slug', async () => ({ ok: true }));
    await app.inject({
      method: 'POST', url: '/log-probe?token=query-secret',
      headers: { authorization: 'Bearer authorization-secret', cookie: 'session=request-cookie-secret' },
      payload: { text: 'body-secret' },
    });
    await app.inject('/slug-log-probe/private-document-title-secret');
    await app.inject('/missing-private-document-title-secret');
    await app.close();
  `], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const logs = child.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert(logs.some((line) => line.req?.url === '/log-probe'));
  assert(logs.some((line) => line.req?.url === '/slug-log-probe/:slug'));
  assert(logs.some((line) => line.msg === 'Unhandled request error'));
  assert(!`${child.stdout}${child.stderr}`.includes('-secret'));
});
