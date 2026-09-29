// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import assert from 'node:assert/strict';
import test from 'node:test';
import { readConfig } from '../src/config.js';

const base = { DATABASE_URL: 'postgresql://docs:example@localhost/docs' };

test('development defaults are local and explicit', () => {
  const config = readConfig(base);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 3000);
  assert.equal(config.apiDocsEnabled, true);
  assert.equal(config.databasePoolMax, 5);
});
test('production disables API docs by default', () => {
  assert.equal(readConfig({ ...base, NODE_ENV: 'production' }).apiDocsEnabled, false);
});
test('boolean false is not truthy', () => {
  assert.equal(readConfig({ ...base, API_DOCS_ENABLED: 'false' }).apiDocsEnabled, false);
});
test('invalid boolean rejected', () => {
  assert.throws(() => readConfig({ ...base, API_DOCS_ENABLED: 'yes' }), /API_DOCS_ENABLED/);
});
test('fractional port rejected', () => {
  assert.throws(() => readConfig({ ...base, PORT: '3000.5' }), /PORT/);
});
test('out of range ports rejected', () => {
  for (const PORT of ['0', '65536', '-1']) assert.throws(() => readConfig({ ...base, PORT }), /PORT/);
});
test('invalid pool size rejected', () => {
  assert.throws(() => readConfig({ ...base, DB_POOL_MAX: '0' }), /DB_POOL_MAX/);
});
test('missing database URL rejected', () => {
  assert.throws(() => readConfig({}), /DATABASE_URL/);
});
test('invalid database URL never appears in its error', () => {
  const secret = 'not-a-url-with-super-secret';
  assert.throws(() => readConfig({ DATABASE_URL: secret }), (error: unknown) => {
    assert(error instanceof Error);
    assert(!error.message.includes(secret));
    return true;
  });
});
test('only PostgreSQL URLs with a database name are accepted', () => {
  for (const DATABASE_URL of ['https://example.com/docs', 'postgresql://localhost/']) {
    assert.throws(() => readConfig({ DATABASE_URL }), /DATABASE_URL/);
  }
});
test('unknown environment and log level rejected', () => {
  assert.throws(() => readConfig({ ...base, NODE_ENV: 'prod' }), /NODE_ENV/);
  assert.throws(() => readConfig({ ...base, LOG_LEVEL: 'everything' }), /LOG_LEVEL/);
});
test('whitespace host rejected', () => {
  assert.throws(() => readConfig({ ...base, HOST: 'bad host' }), /HOST/);
});
