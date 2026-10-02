// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyInstance } from 'fastify';
import type { Core } from '../core/index.js';
import { HttpProblem, problemSchema } from './problems.js';
import { slugSchema } from './slugs.js';

const errors = { '4xx': problemSchema, '5xx': problemSchema };
const params = { type: 'object', additionalProperties: false, required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } } } as const;
const stateSchema = { type: 'object', additionalProperties: false, required: ['favorited'],
  properties: { favorited: { type: 'boolean' } } } as const;

export function registerFavoriteRoutes(app: FastifyInstance, core: Core) {
  app.get<{ Querystring: { limit?: number; cursor?: string } }>('/api/v1/favorites', { schema: {
    operationId: 'listFavorites', tags: ['Favorites'],
    description: 'Personal, currently authorized nonarchived saved documents. Current session/role/grants are checked inside the bounded title query.',
    querystring: { type: 'object', additionalProperties: false, properties: {
      limit: { type: 'integer', minimum: 1, maximum: 100 }, cursor: { type: 'string', format: 'uuid' },
    } },
    response: { 200: { type: 'object', additionalProperties: false, required: ['items', 'nextCursor'], properties: {
      nextCursor: { anyOf: [{ type: 'string', format: 'uuid' }, { type: 'null' }] },
      items: { type: 'array', maxItems: 100, items: { type: 'object', additionalProperties: false,
        required: ['id', 'spaceId', 'spaceName', 'spaceSlug', 'slug', 'title'], properties: {
          id: { type: 'string', format: 'uuid' }, spaceId: { type: 'string', format: 'uuid' }, spaceName: { type: 'string' },
          spaceSlug: slugSchema, slug: slugSchema, title: { type: 'string', maxLength: 200 },
        } } },
    } }, ...errors },
  } }, request => core.favorites.list(fromNodeHeaders(request.headers), request.query));
  app.get<{ Params: { id: string } }>('/api/v1/documents/:id/favorite', { schema: {
    operationId: 'readDocumentFavorite', tags: ['Favorites'], params, response: { 200: stateSchema, ...errors },
  } }, request => core.favorites.read(fromNodeHeaders(request.headers), request.params.id));
  app.put<{ Params: { id: string }; Body: { favorited: boolean } }>('/api/v1/documents/:id/favorite', {
    preValidation: async request => {
      // Keep JSON booleans strict before the shared query-friendly AJV coercion.
      const body: unknown = request.body;
      if (!body || typeof body !== 'object' || !('favorited' in body) || typeof body.favorited !== 'boolean') {
        throw new HttpProblem(400, 'INVALID_REQUEST');
      }
    }, schema: {
    operationId: 'setDocumentFavorite', tags: ['Favorites'], params, body: stateSchema,
    description: 'Idempotent personal navigation preference. Readers may set it; document content, revisions, ETag and space grants stay unchanged. Archived documents can only be removed.',
    response: { 200: stateSchema, ...errors },
  } }, request => core.favorites.set(fromNodeHeaders(request.headers), request.params.id, request.body.favorited));
}
