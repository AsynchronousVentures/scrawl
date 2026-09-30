// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import { parseArgs } from 'node:util';
import { Writable } from 'node:stream';
import { createInterface } from 'node:readline/promises';
import { readConfig, readIdentityConfig } from '../src/config.js';
import { createDatabase } from '../src/db/client.js';
import { createOperator } from '../src/core/identity/operator.js';

async function passwordPrompt(): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Operator commands require an interactive terminal');
  // Readline controls the terminal; its echo and history never reach the real output.
  const muted = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const prompt = createInterface({ input: process.stdin, output: muted, terminal: true, historySize: 0 });
  const abort = new AbortController();
  prompt.on('SIGINT', () => abort.abort());
  try {
    process.stdout.write('Password (12 to 128 characters): ');
    const password = await prompt.question('', { signal: abort.signal });
    process.stdout.write('\nConfirm password: ');
    const confirmation = await prompt.question('', { signal: abort.signal });
    process.stdout.write('\n');
    if (password !== confirmation) throw new Error('Passwords do not match');
    if (password.length < 12 || password.length > 128) throw new Error('Password must contain 12 to 128 characters');
    return password;
  } finally {
    prompt.close();
    muted.destroy();
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true, options: { email: { type: 'string' }, name: { type: 'string' } },
  });
  const command = positionals[0];
  if (positionals.length !== 1 || !['bootstrap', 'provision', 'recover'].includes(command ?? '')
    || !values.email || (command !== 'recover' && !values.name) || (command === 'recover' && values.name)) {
    throw new Error('Use bootstrap/provision --email --name, or recover --email');
  }
  const config = readConfig(process.env);
  const identityConfig = readIdentityConfig(process.env, config);
  const password = await passwordPrompt();
  const database = createDatabase(config, () => { console.error('Database connection failed'); });
  try {
    const operator = createOperator(database.prisma, identityConfig);
    const result = command === 'recover'
      ? await operator.recover(values.email, password)
      : command === 'bootstrap'
        ? await operator.bootstrap({ email: values.email, name: values.name!, password })
        : await operator.provision({ email: values.email, name: values.name!, password });
    process.stdout.write(JSON.stringify(result) + '\n');
  } finally {
    await database.close();
  }
}

main().catch(() => {
  // Parsing, library and database errors can contain arguments; do not echo them.
  console.error('Operator command failed. Check the command, terminal, configuration, and account state.');
  process.exitCode = 1;
});
