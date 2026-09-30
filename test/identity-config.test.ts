// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import assert from 'node:assert/strict';
import test from 'node:test';
import { readConfig, readIdentityConfig } from '../src/config.js';

const config = readConfig({ DATABASE_URL: 'postgresql://unused@localhost/unused' });
const secret = 'x'.repeat(32);

test('identity requires a secret without including its value in errors', () => {
  for (const AUTH_SECRET of [undefined, 'short-secret', 'a'.repeat(31) + ' ']) {
    assert.throws(() => readIdentityConfig({ AUTH_SECRET }, config), (e: unknown) => {
      assert(e instanceof Error);
      assert.match(e.message, /AUTH_SECRET/);
      assert(!e.message.includes('short-secret'));
      return true;
    });
  }
});
test('development identity defaults to the local origin; HTTPS enables secure cookies', () => {
  assert.equal(readIdentityConfig({ AUTH_SECRET: secret }, config).origin, 'http://127.0.0.1:3000');
  assert.equal(readIdentityConfig({ AUTH_SECRET: secret }, config).secureCookies, false);
  assert.equal(readIdentityConfig({ AUTH_SECRET: secret, APP_ORIGIN: 'https://scrawl.example.test' }, config).secureCookies, true);
});
test('identity rejects credential-bearing URLs, paths, queries and non-HTTP origins', () => {
  for (const APP_ORIGIN of ['https://user:private@scrawl.example.test', 'https://scrawl.example.test/path',
    'https://scrawl.example.test?token=private', 'https://scrawl.example.test#fragment', 'file:///tmp/example']) {
    assert.throws(() => readIdentityConfig({ AUTH_SECRET: secret, APP_ORIGIN }, config), (e: unknown) => {
      assert(e instanceof Error);
      assert(!e.message.includes('private'));
      return true;
    });
  }
});
test('production identity requires an explicit HTTPS origin and uses secure cookies', () => {
  const production = { ...config, nodeEnv: 'production' as const };
  assert.throws(() => readIdentityConfig({ AUTH_SECRET: secret }, production), /APP_ORIGIN/);
  assert.throws(() => readIdentityConfig({ AUTH_SECRET: secret, APP_ORIGIN: 'http://localhost:3000' }, production), /APP_ORIGIN/);
  assert.equal(readIdentityConfig({ AUTH_SECRET: secret, APP_ORIGIN: 'https://scrawl.example.test' }, production).secureCookies, true);
});
