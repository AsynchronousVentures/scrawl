// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';

test('operator rejects password/role flags without echoing values and requires a terminal', () => {
  for (const extra of [['--password', 'argument-secret'], ['--role', 'administrator'], []]) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/operator.ts',
      'bootstrap', '--email', 'operator@example.test', '--name', 'Operator', ...extra], {
      encoding: 'utf8', env: { ...process.env, DATABASE_URL: 'postgresql://unused@localhost/unused', AUTH_SECRET: 'x'.repeat(32) },
    });
    assert.equal(result.status, 1);
    assert(!result.stdout.includes('argument-secret') && !result.stderr.includes('argument-secret'));
    assert.match(result.stderr, /Operator command failed/);
  }
});
