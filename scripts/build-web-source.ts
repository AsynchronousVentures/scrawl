// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import { execFile } from 'node:child_process';
import { copyFile, lstat, mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const output = resolve('web/dist/assets');
await mkdir(output, { recursive: true });
// Package the actual checkout that produced this build, including uncommitted source.
// An explicit source inventory excludes private environments, generated data and fixtures.
const { stdout } = await execute('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
const files = stdout.split('\0').filter(Boolean).filter(path =>
  /^(?:src\/(?!generated\/)|web\/(?!dist\/|node_modules\/)|scripts\/|test\/|docs\/|prisma\/|\.github\/)/.test(path)
  || /^(?:AGENTS\.md|LICENSE|README\.md|CONTRIBUTING\.md|VALIDATION\.md|THIRD_PARTY_NOTICES\.md|package(?:-lock)?\.json|tsconfig(?:\.build)?\.json|prisma\.config\.ts|playwright\.config\.ts|compose(?:\.demo)?\.yaml|\.env\.example|\.gitignore|\.node-version)$/.test(path));
for (const path of files) {
  if (path.startsWith('-') || path.split('/').some(part => part === '..')
    || /(?:^|\/)(?:\.env(?:\.|$)|artifacts|node_modules|generated|dist)(?:\/|$)/.test(path) && path !== '.env.example') {
    throw new Error('Unsafe source archive path');
  }
  if (!(await lstat(path)).isFile()) throw new Error('Source archives require regular source files');
}
const manifest = resolve(output, 'source-files.txt');
try {
  await writeFile(manifest, files.join('\n')+'\n');
  await execute('tar', ['-czf', resolve(output, 'scrawl-source.tar.gz'), '-T', manifest]);
} finally { await rm(manifest, { force: true }); }
await copyFile('LICENSE', resolve(output, 'LICENSE.txt'));
await copyFile('THIRD_PARTY_NOTICES.md', resolve(output, 'THIRD_PARTY_NOTICES.txt'));
console.log('Built licenses and exact-checkout source archive. No private fixture files included.');
