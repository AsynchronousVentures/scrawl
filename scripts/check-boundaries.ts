// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import { glob, readFile } from 'node:fs/promises';
import { dirname, normalize } from 'node:path';

const violations: string[] = [];
for await (const file of glob('src/**/*.ts', { exclude: ['src/generated/**'] })) {
  const imports = [...(await readFile(file, 'utf8')).matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)];
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
    if (file === 'src/core/documents/content.ts' && (imported.startsWith('node:')
      || target.startsWith('src/db/') || target.startsWith('src/generated/') || target.startsWith('src/http/'))) {
      violations.push(`${file}: shared content validation cannot import server dependencies`);
    }
  }
}
if (violations.length) throw new Error(violations.join('\n'));
console.log('Implemented module import boundaries passed.');
