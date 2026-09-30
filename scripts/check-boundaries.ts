// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import { glob, readFile } from 'node:fs/promises';
import { dirname, normalize } from 'node:path';

const violations: string[] = [];
for await (const file of glob(['src/**/*.ts', 'web/src/**/*.{ts,tsx}'], { exclude: ['src/generated/**'] })) {
  const imports = [...(await readFile(file, 'utf8')).matchAll(/\b(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)['"]([^'"]+)['"]/g)];
  for (const match of imports) {
    const imported = match[1]!;
    const target = normalize(`${dirname(file)}/${imported}`);
    if ((file.startsWith('src/http/') || file.startsWith('src/modules/'))
      && (target.startsWith('src/generated/') || target.startsWith('src/db/'))) {
      violations.push(`${file}: HTTP modules cannot import database clients/models`);
    }
    if (file.startsWith('src/core/') && imported === 'fastify') {
      violations.push(`${file}: core operations cannot depend on Fastify`);
    }
    if ((file.startsWith('src/core/spaces/') || file.startsWith('src/core/documents/')) && target.startsWith('src/core/identity/')
      && target !== 'src/core/identity/index.js') {
      violations.push(`${file}: core modules must use the identity module's exported operations`);
    }
    if (file.startsWith('src/core/documents/') && target.startsWith('src/core/spaces/')
      && target !== 'src/core/spaces/index.js') {
      violations.push(`${file}: documents must use the space module's exported operations`);
    }
    if (file.startsWith('src/shared/') && (imported.startsWith('node:')
      || imported === '@blocknote/server-util'
      || imported.startsWith('@prisma/') || imported === 'prisma' || imported === 'pg' || imported === 'fastify'
      || (imported.startsWith('.') && !target.startsWith('src/shared/'))
      || target.startsWith('src/db/') || target.startsWith('src/generated/') || target.startsWith('src/http/')
      || target.startsWith('src/core/') || target.startsWith('src/modules/'))) {
      violations.push(`${file}: shared content validation cannot import server dependencies`);
    }
    if (file.startsWith('web/src/') && (imported.startsWith('node:')
      || imported === '@blocknote/server-util'
      || imported.startsWith('@prisma/') || imported === 'prisma' || imported === 'pg' || imported === 'fastify'
      || imported.startsWith('src/') || imported.startsWith('/')
      || (imported.startsWith('@scrawl/') && imported !== '@scrawl/content')
      || (imported.startsWith('.') && !target.startsWith('web/')))) {
      violations.push(`${file}: frontend imports must use browser packages, web files, or the public content contract`);
    }
  }
}
if (violations.length) throw new Error(violations.join('\n'));
console.log('Implemented module import boundaries passed.');
