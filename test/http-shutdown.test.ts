// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { connect, type Socket } from 'node:net';
import test from 'node:test';
import { buildApp } from '../src/app.js';
import { readConfig } from '../src/config.js';

const config = readConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgresql://unused@localhost/unused' });

test('shutdown closes a connection with incomplete headers before any HTTP request was accepted', async t => {
  const app = await buildApp({ config, logging: false, checkDatabase: async () => {} });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address(); assert(address && typeof address !== 'string');
  const accepted = once(app.server, 'connection');
  const client = connect(address.port, '127.0.0.1'); client.on('error', () => {});
  let closing: Promise<void> | undefined;
  t.after(async () => { client.destroy(); await (closing ?? app.close()); });
  const [socket] = await accepted as [Socket];
  let requests = 0; app.server.on('request', () => { requests++; });
  const received = once(socket, 'data');
  client.write('GET /health/live HTTP/1.1\r\nHost: localhost\r\n');
  await received; assert.equal(requests, 0);
  closing = app.close();
  let timeout: NodeJS.Timeout | undefined;
  const finished = await Promise.race([closing.then(() => true), new Promise<boolean>(resolve => { timeout = setTimeout(() => resolve(false), 1000); })]);
  clearTimeout(timeout);
  assert.equal(finished, true, 'An unaccepted partial request must not keep shutdown waiting');
  assert.equal(requests, 0);
});

test('shutdown lets an accepted HTTP operation finish and return its response', async t => {
  const app = await buildApp({ config, logging: false, checkDatabase: async () => {} });
  let entered!: () => void, release!: () => void;
  const accepted = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  app.post('/held-operation', async () => { entered(); await gate; return { accepted: true }; });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address(); assert(address && typeof address !== 'string');
  let closing: Promise<void> | undefined, closed = false;
  const response = new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
    const client = request({ host: '127.0.0.1', port: address.port, path: '/held-operation', method: 'POST', headers: { 'content-type': 'application/json' } }, reply => {
      let body = ''; reply.setEncoding('utf8'); reply.on('data', chunk => { body += chunk; });
      reply.on('end', () => resolve({ status: reply.statusCode, body })); reply.on('error', reject);
    });
    client.on('error', reject); client.end('{}');
  });
  t.after(async () => { release(); await response.catch(() => {}); await (closing ?? app.close()); });
  await accepted;
  closing = app.close().then(() => { closed = true; });
  // This event-loop turn permits closing to run, without releasing the operation.
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(closed, false, 'Accepted work must drain before closing');
  release();
  assert.deepEqual(await response, { status: 200, body: '{"accepted":true}' });
  let timeout: NodeJS.Timeout | undefined;
  const finished = await Promise.race([closing.then(() => true), new Promise<boolean>(resolve => { timeout = setTimeout(() => resolve(false), 1000); })]);
  clearTimeout(timeout);
  assert.equal(finished, true, 'A completed response must not leave shutdown waiting on keep-alive');
  assert.equal(closed, true);
});

test('shutdown drains every accepted pipelined operation before ending its socket', { timeout: 5000 }, async t => {
  const app = await buildApp({ config, logging: false, checkDatabase: async () => {} });
  let calls = 0, entered!: () => void, releaseFirst!: () => void, releaseSecond!: () => void;
  const accepted = new Promise<void>(resolve => { entered = resolve; });
  const first = new Promise<void>(resolve => { releaseFirst = resolve; });
  const second = new Promise<void>(resolve => { releaseSecond = resolve; });
  app.post('/held-operation', async () => {
    const index = ++calls; if (calls === 2) entered();
    await (index === 1 ? first : second); return { index };
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address(); assert(address && typeof address !== 'string');
  const client = connect(address.port, '127.0.0.1'); client.on('error', () => {});
  let closing: Promise<void> | undefined, closed = false, bytes = '', firstReceived!: () => void;
  const receivedFirst = new Promise<void>(resolve => { firstReceived = resolve; });
  client.setEncoding('utf8'); client.on('data', data => { bytes += data; if (bytes.includes('{"index":1}')) firstReceived(); });
  t.after(async () => { releaseFirst(); releaseSecond(); client.destroy(); await (closing ?? app.close()); });
  client.write(('POST /held-operation HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: keep-alive\r\n\r\n{}').repeat(2));
  await accepted; closing = app.close().then(() => { closed = true; });
  releaseFirst(); await receivedFirst;
  assert.equal(closed, false, 'The second accepted operation is still pending');
  const ended = new Promise<void>(resolve => client.once('end', resolve));
  releaseSecond();
  let timeout: NodeJS.Timeout | undefined;
  const finished = await Promise.race([Promise.all([closing, ended]).then(() => true), new Promise<boolean>(resolve => { timeout = setTimeout(() => resolve(false), 1000); })]);
  clearTimeout(timeout);
  assert.equal(finished, true, 'The drained pipeline must close without waiting for keep-alive');
  assert.equal(bytes.match(/HTTP\/1.1 200 OK/g)?.length, 2);
  assert(bytes.includes('{"index":1}')); assert(bytes.includes('{"index":2}'));
});

test('shutdown rejects new connections while an earlier pre-close operation drains', { timeout: 5000 }, async t => {
  const app = await buildApp({ config, logging: false, checkDatabase: async () => {} });
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  app.addHook('preClose', async () => { entered(); await gate; });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address(); assert(address && typeof address !== 'string');
  let requests = 0; app.server.on('request', () => { requests++; });
  const closing = app.close(); await started;
  const client = connect(address.port, '127.0.0.1'); client.on('error', () => {});
  t.after(async () => { release(); client.destroy(); await closing; });
  const closed = new Promise<void>(resolve => client.once('close', () => resolve()));
  client.once('connect', () => client.write('GET /health/live HTTP/1.1\r\nHost: localhost\r\n\r\n'));
  await closed; assert.equal(requests, 0);
  release(); await closing;
});
