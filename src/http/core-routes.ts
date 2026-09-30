// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import { fromNodeHeaders } from 'better-auth/node';
import { STATUS_CODES } from 'node:http';
import type { FastifyInstance } from 'fastify';
import type { Core } from '../core/index.js';
import { spaceEtag } from '../core/spaces/index.js';
import { HttpProblem, problemSchema } from './problems.js';

const userSchema = {
  type: 'object', additionalProperties: false, required: ['id', 'email', 'name', 'role'],
  properties: {
    id: { type: 'string' }, email: { type: 'string' }, name: { type: 'string' },
    role: { type: 'string', enum: ['administrator', 'member'] },
  },
} as const;
const spaceSchema = {
  type: 'object', additionalProperties: false,
  required: ['id', 'name', 'createdBy', 'createdAt', 'updatedAt', 'lockVersion'],
  properties: {
    id: { type: 'string', format: 'uuid' }, name: { type: 'string' }, createdBy: { type: 'string' },
    createdAt: { type: 'string', format: 'date-time' }, updatedAt: { type: 'string', format: 'date-time' },
    lockVersion: { type: 'integer', minimum: 1 },
  },
} as const;
const errors = { '4xx': problemSchema, '5xx': problemSchema };
const spaceParams = {
  type: 'object', additionalProperties: false, required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
} as const;
const memberParams = {
  ...spaceParams, required: ['id', 'userId'],
  properties: { ...spaceParams.properties, userId: { type: 'string', minLength: 1, maxLength: 128 } },
} as const;
const preconditionHeaders = {
  type: 'object', properties: {
    'if-match': { type: 'string', maxLength: 200, description: 'One strong ETag from this space; missing is 428, stale is 412.' },
  },
} as const;

export function registerCoreRoutes(app: FastifyInstance, core: Core) {
  app.get('/api/v1/me', { schema: {
    operationId: 'getMe', tags: ['Identity'], response: { 200: userSchema, ...errors },
  } }, (request) => core.identity.me(fromNodeHeaders(request.headers)));

  app.post<{ Body: { name: string } }>('/api/v1/spaces', { schema: {
    operationId: 'createSpace', tags: ['Spaces'],
    body: { type: 'object', additionalProperties: false, required: ['name'], properties: {
      name: { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' },
    } },
    response: { 201: spaceSchema, ...errors },
  } }, async (request, reply) => {
    const space = await core.spaces.create(fromNodeHeaders(request.headers), request.body.name);
    return reply.code(201).header('etag', spaceEtag(space)).header('location', `/api/v1/spaces/${space.id}`).send(space);
  });

  app.get<{ Querystring: { limit?: number; cursor?: string } }>('/api/v1/spaces', { schema: {
    operationId: 'listSpaces', tags: ['Spaces'],
    querystring: { type: 'object', additionalProperties: false, properties: {
      limit: { type: 'integer', minimum: 1, maximum: 100 }, cursor: { type: 'string', format: 'uuid' },
    } },
    response: { 200: { type: 'object', additionalProperties: false, required: ['items', 'nextCursor'], properties: {
      items: { type: 'array', items: spaceSchema }, nextCursor: { type: ['string', 'null'] },
    } }, ...errors },
  } }, (request) => core.spaces.list(fromNodeHeaders(request.headers), request.query));

  app.get<{ Params: { id: string } }>('/api/v1/spaces/:id', { schema: {
    operationId: 'readSpace', tags: ['Spaces'], params: spaceParams, response: { 200: spaceSchema, ...errors },
  } }, async (request, reply) => {
    const space = await core.spaces.read(fromNodeHeaders(request.headers), request.params.id);
    return reply.header('etag', spaceEtag(space)).send(space);
  });

  app.put<{ Params: { id: string; userId: string }; Body: { role: 'reader' | 'editor' } }>(
    '/api/v1/spaces/:id/members/:userId', { schema: {
      operationId: 'grantSpaceMembership', tags: ['Spaces'], params: memberParams, headers: preconditionHeaders,
      body: { type: 'object', additionalProperties: false, required: ['role'], properties: {
        role: { type: 'string', enum: ['reader', 'editor'] },
      } },
      response: { 200: spaceSchema, ...errors },
    } }, async (request, reply) => {
      const space = await core.spaces.changeMembership(fromNodeHeaders(request.headers), {
        spaceId: request.params.id, userId: request.params.userId,
        role: request.body.role, expectedEtag: request.headers['if-match'],
      });
      return reply.header('etag', spaceEtag(space)).send(space);
    },
  );
  app.delete<{ Params: { id: string; userId: string } }>('/api/v1/spaces/:id/members/:userId', { schema: {
    operationId: 'revokeSpaceMembership', tags: ['Spaces'], params: memberParams, headers: preconditionHeaders,
    response: { 200: spaceSchema, ...errors },
  } }, async (request, reply) => {
    const space = await core.spaces.changeMembership(fromNodeHeaders(request.headers), {
      spaceId: request.params.id, userId: request.params.userId,
      role: null, expectedEtag: request.headers['if-match'],
    });
    return reply.header('etag', spaceEtag(space)).send(space);
  });
}

export function registerAuthRoutes(app: FastifyInstance, core: Core) {
  // Expose only the local session loop. Host provisioning/recovery never has an HTTP route.
  const endpoints = [
    { method: 'POST', path: '/sign-in/email', schema: {
      type: 'object', additionalProperties: false, required: ['user'], properties: {
        user: userSchema, redirect: { type: 'boolean' }, url: { type: 'string' },
      },
    } },
    { method: 'POST', path: '/sign-out', schema: {
      type: 'object', additionalProperties: false, required: ['success'], properties: { success: { type: 'boolean' } },
    } },
    { method: 'GET', path: '/get-session', schema: {
      type: ['object', 'null'], additionalProperties: false, required: ['user', 'session'], properties: {
        user: userSchema,
        session: { type: 'object', additionalProperties: false, required: ['expiresAt'], properties: {
          expiresAt: { type: 'string', format: 'date-time' },
        } },
      },
    } },
  ] as const;
  for (const endpoint of endpoints) {
    app.route({
      method: endpoint.method, url: `/api/auth${endpoint.path}`,
      schema: { hide: true, response: { 200: endpoint.schema } },
      async handler(request, reply) {
        const headers = fromNodeHeaders(request.headers);
        // Derive rate-limit identity from Fastify's unproxied peer, never caller forwarding headers.
        headers.set('x-scrawl-client-ip', request.ip);
        const response = await core.identity.handle(new Request(new URL(request.url, core.identity.origin), {
          method: request.method, headers,
          ...(request.body ? { body: JSON.stringify(request.body) } : {}),
        }));
        if (response.status >= 500) throw new HttpProblem(500, 'AUTHENTICATION_FAILED');
        reply.statusCode = response.status;
        for (const [name, value] of response.headers) {
          if (name !== 'set-cookie') reply.header(name, value);
        }
        const cookies = response.headers.getSetCookie();
        if (cookies.length) reply.header('set-cookie', cookies);
        if (!response.headers.get('content-type')?.includes('application/json')) {
          throw new HttpProblem(response.status, response.status === 429 ? 'RATE_LIMITED' : 'AUTHENTICATION_REJECTED');
        }
        // Serialization allowlists keep raw session tokens out of JSON; credentials travel in HttpOnly cookies.
        const payload: unknown = await response.json();
        if (response.status >= 400) {
          const code = payload && typeof payload === 'object' && 'code' in payload && typeof payload.code === 'string'
            ? payload.code : 'AUTHENTICATION_REJECTED';
          return reply.send({ code, message: STATUS_CODES[response.status] ?? 'Authentication failed' });
        }
        return reply.send(payload);
      },
    });
  }

  // Product mutations use cookies too, so require the configured origin for browser writes.
  app.addHook('preHandler', async (request) => {
    if (!request.url.startsWith('/api/v1/') || ['GET', 'HEAD'].includes(request.method)) return;
    if (request.headers.origin !== core.identity.origin
      || request.headers['sec-fetch-site'] === 'cross-site') {
      throw new HttpProblem(403, 'ORIGIN_REJECTED');
    }
  });
}
