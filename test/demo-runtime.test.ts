// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import assert from 'node:assert/strict';
import test from 'node:test';
import { privateDemoOrigin } from '../scripts/demo-server.js';
import { readDemoWebPort } from '../scripts/demo-dev.js';

test('demo server runtime origin override permits only an explicit private HTTPS preview', () => {
  assert.equal(privateDemoOrigin([]), undefined);
  assert.equal(privateDemoOrigin(['--origin', 'https://scrawl.synthetic-tailnet.ts.net']),
    'https://scrawl.synthetic-tailnet.ts.net');
  assert.equal(privateDemoOrigin(['--origin', 'https://scrawl.synthetic-tailnet.ts.net:8447']),
    'https://scrawl.synthetic-tailnet.ts.net:8447');
  for (const origin of ['https://example.test', 'http://scrawl.synthetic-tailnet.ts.net',
    'https://scrawl.synthetic-tailnet.ts.net:0', 'https://scrawl.synthetic-tailnet.ts.net:65536',
    'https://scrawl.synthetic-tailnet.ts.net:-1', 'https://scrawl.synthetic-tailnet.ts.net:invalid',
    'https://scrawl.synthetic-tailnet.ts.net/path',
    'https://scrawl.synthetic-tailnet.ts.net?token=synthetic', 'https://scrawl.synthetic-tailnet.ts.net#fragment',
    'https://synthetic-password@scrawl.synthetic-tailnet.ts.net', 'https://scrawl.synthetic-tailnet.ts.net.attacker.test',
    'not-an-origin']) {
    assert.throws(() => privateDemoOrigin(['--origin', origin]));
  }
  for (const args of [['--origin'], ['--port', '3100'], ['--origin', 'https://scrawl.synthetic-tailnet.ts.net', '--other']]) {
    assert.throws(() => privateDemoOrigin(args));
  }
});

test('demo development permits a separate explicit loopback port and refuses invalid arguments', () => {
  assert.equal(readDemoWebPort([], 3100), 5173);
  assert.equal(readDemoWebPort(['--port', '5300'], 3100), 5300);
  assert.throws(() => readDemoWebPort([], 5173));
  for (const args of [['--port', '0'], ['--port', '65536'], ['--port', '3100'], ['--port', '-1'],
    ['--port', '1.5'], ['--port'], ['--host', '0.0.0.0'], ['--port', '5300', '--other']]) {
    assert.throws(() => readDemoWebPort(args, 3100));
  }
});
