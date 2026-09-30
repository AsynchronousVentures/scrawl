// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyInstance } from 'fastify';
import type { Core } from '../core/index.js';
import { SEARCH_LIMITS } from '../core/search/index.js';
import { problemSchema } from './problems.js';

export function registerSearchRoutes(app: FastifyInstance, core: Core) {
  app.get<{ Querystring: { q: string; spaceId?: string; limit?: number } }>('/api/v1/search', { schema: {
    operationId: 'searchDocuments', tags: ['Search'],
    description: 'Search current authorized nonarchived documents. Plain words use the language-neutral simple configuration; results are ranked and bounded, without counts or historical content.',
    querystring: {
      type: 'object', additionalProperties: false, required: ['q'], properties: {
        q: { type: 'string', minLength: 1, maxLength: SEARCH_LIMITS.maxQueryLength, pattern: '\\S' },
        spaceId: { type: 'string', format: 'uuid' },
        limit: { type: 'integer', minimum: 1, maximum: SEARCH_LIMITS.maxResults },
      },
    },
    response: {
      200: { type: 'object', additionalProperties: false, required: ['items'], properties: {
        items: { type: 'array', maxItems: SEARCH_LIMITS.maxResults, items: {
          type: 'object', additionalProperties: false, required: ['id', 'spaceId', 'title', 'excerpt'], properties: {
            id: { type: 'string', format: 'uuid' }, spaceId: { type: 'string', format: 'uuid' },
            title: { type: 'string' }, excerpt: { type: 'string', maxLength: SEARCH_LIMITS.maxExcerptLength },
          },
        } },
      } }, '4xx': problemSchema, '5xx': problemSchema,
    },
  } }, request => core.search.find(fromNodeHeaders(request.headers), {
    query: request.query.q,
    ...(request.query.spaceId === undefined ? {} : { spaceId: request.query.spaceId }),
    ...(request.query.limit === undefined ? {} : { limit: request.query.limit }),
  }));
}
