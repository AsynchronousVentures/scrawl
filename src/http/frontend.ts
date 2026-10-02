// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import staticFiles from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import { slugSchema } from './slugs.js';

/** Backend-only workflows work without a frontend build. A present build must be valid. */
export async function frontendRootIfBuilt(root: string) {
  try {
    if (!(await stat(join(root, 'index.html'))).isFile()) throw new Error('Frontend build is invalid');
    return root;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function registerFrontend(app: FastifyInstance, root: string) {
  // Restrict static serving to generated assets. API errors never become an HTML shell.
  await app.register(staticFiles, {
    root: join(root, 'assets'), prefix: '/assets/', schemaHide: true,
    cacheControl: false, index: false, dotfiles: 'deny',
    setHeaders(reply) { reply.header('x-content-type-options', 'nosniff'); },
  });
  app.get('/', { schema: { hide: true } }, async (_request, reply) => {
    // Native editor actions open external pages. Keep those pages from retaining
    // an opener capable of navigating this private application tab.
    return reply.header('cross-origin-opener-policy', 'same-origin')
      .header('x-content-type-options', 'nosniff').sendFile('index.html', root, { cacheControl: false });
  });
  app.get('/publications/:publicId', { schema: { hide: true, params: {
    type: 'object', required: ['publicId'], additionalProperties: false,
    properties: { publicId: { type: 'string', format: 'uuid' } },
  } } }, async (_request, reply) => {
    return reply.header('cross-origin-opener-policy', 'same-origin')
      .header('x-content-type-options', 'nosniff').sendFile('index.html', root, { cacheControl: false });
  });
  for (const path of ['/spaces/:spaceSlug', '/spaces/:spaceSlug/documents/:documentSlug']) {
    app.get(path, { schema: { hide: true, params: {
      type: 'object', additionalProperties: false,
      required: path.includes(':documentSlug') ? ['spaceSlug', 'documentSlug'] : ['spaceSlug'],
      properties: { spaceSlug: slugSchema, documentSlug: slugSchema },
    } } }, async (_request, reply) => reply.header('cross-origin-opener-policy', 'same-origin')
      .header('x-content-type-options', 'nosniff').sendFile('index.html', root, { cacheControl: false }));
  }
}
