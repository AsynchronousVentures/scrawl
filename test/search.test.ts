// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { parseSearchInput, SEARCH_LIMITS } from '../src/core/search/index.js';
import { HttpProblem } from '../src/http/problems.js';
import { rebuildSearchIndex } from '../scripts/search-index.js';
import { readConfig } from '../src/config.js';

test('search core accepts bounded plain queries and closes its request contract', () => {
  assert.deepEqual(parseSearchInput({ query: '  Native café  ' }), { query: 'Native café', spaceId: null, limit: SEARCH_LIMITS.defaultResults });
  const spaceId = randomUUID();
  assert.deepEqual(parseSearchInput({ query: 'x'.repeat(200), spaceId, limit: 50 }), { query: 'x'.repeat(200), spaceId, limit: 50 });
  for (const input of [null, [], {}, { query: '' }, { query: '   ' }, { query: 'x'.repeat(201) },
    { query: 'secret\u0000value' }, { query: 'secret\ud800value' }, { query: 'secret\udc00value' },
    { query: 'text', limit: 0 }, { query: 'text', limit: 51 }, { query: 'text', limit: 1.5 }, { query: 'text', limit: null },
    { query: 'text', spaceId: 'secret-invalid-space' }, { query: 'text', currentRevisionNumber: 10 },
    Object.defineProperty({}, 'query', { enumerable: true, get() { throw new Error('secret'); } }),
  ]) assert.throws(() => parseSearchInput(input), (error: unknown) => {
    assert(error instanceof HttpProblem);
    assert.equal(error.status, 400); assert.equal(error.code, 'INVALID_REQUEST');
    assert(!error.message.includes('secret')); return true;
  });
});

test('search maintenance refuses production and remote targets before opening a connection', async () => {
  for (const environment of [
    { NODE_ENV: 'production', DATABASE_URL: 'postgresql://operator:synthetic-password@127.0.0.1/scrawl' },
    { NODE_ENV: 'development', DATABASE_URL: 'postgresql://operator:synthetic-password@example.test/scrawl' },
    { NODE_ENV: 'test', DATABASE_URL: 'postgresql://operator:synthetic-password@127.0.0.1/scrawl?schema=unsafe-schema' },
  ]) await assert.rejects(rebuildSearchIndex(readConfig(environment)), (error: unknown) => {
    assert(error instanceof Error); assert(!error.message.includes('synthetic-password')); return true;
  });
});
