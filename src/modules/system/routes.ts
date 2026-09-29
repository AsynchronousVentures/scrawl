// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import type { FastifyInstance } from 'fastify';
import { HttpProblem, problemSchema } from '../../http/problems.js';

export async function registerSystemRoutes(app: FastifyInstance, checkDatabase: () => Promise<void>) {
  app.get('/health/live', {
    schema: {
      operationId: 'getLiveness',
      tags: ['System'],
      summary: 'Process liveness; does not check dependencies',
      response: {
        200: {
          type: 'object', additionalProperties: false, required: ['status'],
          properties: { status: { type: 'string', enum: ['ok'] } },
        },
      },
    },
  }, async () => ({ status: 'ok' }));

  app.get('/health/ready', {
    schema: {
      operationId: 'getReadiness',
      tags: ['System'],
      summary: 'Readiness; checks the PostgreSQL connection',
      response: {
        200: {
          type: 'object', additionalProperties: false, required: ['status'],
          properties: { status: { type: 'string', enum: ['ready'] } },
        },
        503: {
          description: 'A required dependency is unavailable',
          content: { 'application/problem+json': { schema: problemSchema } },
        },
      },
    },
  }, async () => {
    try {
      await checkDatabase();
    } catch {
      throw new HttpProblem(503, 'DEPENDENCY_UNAVAILABLE');
    }
    return { status: 'ready' };
  });
}
