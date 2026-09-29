// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import { STATUS_CODES } from 'node:http';
import type { FastifyInstance } from 'fastify';

export const problemSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'title', 'status', 'code', 'requestId'],
  properties: {
    type: { type: 'string' },
    title: { type: 'string' },
    status: { type: 'integer' },
    code: { type: 'string' },
    requestId: { type: 'string' },
  },
} as const;

export class HttpProblem extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
    this.name = 'HttpProblem';
    if (!Number.isInteger(status) || status < 400 || status > 599) {
      throw new Error('HttpProblem status must be an HTTP error status');
    }
  }
}

export function problem(status: number, code: string, requestId: string) {
  return { type: 'about:blank', title: STATUS_CODES[status] ?? 'Request failed', status, code, requestId };
}

export function registerProblemHandlers(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    let status = 500;
    let code = 'INTERNAL_ERROR';
    if (error instanceof HttpProblem) {
      status = error.status;
      code = error.code;
    } else if (error instanceof Error && 'validation' in error && error.validation) {
      status = 400;
      code = 'INVALID_REQUEST';
    } else if (error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number'
      && error.statusCode >= 400 && error.statusCode < 500) {
      status = error.statusCode;
      code = 'REQUEST_REJECTED';
    } else {
      // Do not serialize errors, SQL, submitted content, tokens, or connection strings.
      request.log.error('Unhandled request error');
    }
    return reply.code(status).type('application/problem+json').send(problem(status, code, request.id));
  });
  app.setNotFoundHandler((request, reply) => {
    return reply.code(404).type('application/problem+json').send(problem(404, 'NOT_FOUND', request.id));
  });
}
