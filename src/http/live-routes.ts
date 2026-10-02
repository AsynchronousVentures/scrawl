// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Collaboration } from '../capabilities/collaboration/index.js';
import { documentEtag } from '../core/documents/index.js';
import { documentSchema } from './document-routes.js';
import { problemSchema } from './problems.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const sequence = { type: 'string', pattern: '^(0|[1-9][0-9]{0,18})$' } as const;
const etagHeaders = { type: 'object', properties: {
  'if-match': { type: 'string', maxLength: 200, description: 'Current strong document ETag. Missing is 428; stale is 412.' },
} } as const;
const parameters = { type: 'object', additionalProperties: false, required: ['id'], properties: { id: uuid } } as const;
const errors = { '4xx': problemSchema, '5xx': problemSchema };
const emptyBody = { type: 'object', additionalProperties: false, properties: {} } as const;
// Swagger interprets type:null as no response entity. This is JSON null,
// because the supplied REST client parses every successful response as JSON.
const nullResponse = { type: ['object', 'null'], enum: [null], additionalProperties: false } as const;
// The official REST store sends application/json even on its bodyless commands.
// Only these commands accept an empty entity; malformed nonempty JSON still fails.
const emptyJsonBody = {
  onRequest: async (request: FastifyRequest) => {
    if (!request.headers['transfer-encoding'] && (!request.headers['content-length'] || request.headers['content-length'] === '0')
      && request.headers['content-type']?.split(';')[0] === 'application/json') delete request.headers['content-type'];
  },
  preValidation: async (request: FastifyRequest) => { if (request.body === undefined) request.body = {}; },
};
const metadataSchema = {
  type: 'object', additionalProperties: false,
  required: ['documentId', 'epoch', 'sequence', 'schemaVersion', 'documentEtag', 'canWrite'],
  properties: { documentId: uuid, epoch: uuid, sequence, schemaVersion: { type: 'integer', enum: [1] },
    documentEtag: { type: 'string' }, canWrite: { type: 'boolean' } },
} as const;
const commentBody = { type: 'array', minItems: 1, maxItems: 100,
  items: { type: 'object', additionalProperties: true } } as const;
const commentInput = { type: 'object', additionalProperties: false, required: ['body'], properties: { body: commentBody } } as const;
const date = { type: 'string', format: 'date-time' } as const;
const commentSchema = {
  type: 'object', additionalProperties: false,
  required: ['type', 'id', 'userId', 'createdAt', 'updatedAt', 'reactions'],
  properties: { type: { type: 'string', enum: ['comment'] }, id: uuid, userId: { type: 'string' },
    createdAt: date, updatedAt: date, deletedAt: date, body: commentBody,
    metadata: { type: 'object', additionalProperties: false },
    reactions: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['emoji', 'createdAt', 'userIds'], properties: {
        emoji: { type: 'string' }, createdAt: date, userIds: { type: 'array', items: { type: 'string' } },
      } } },
  },
} as const;
const threadSchema = {
  type: 'object', additionalProperties: false,
  required: ['type', 'id', 'createdAt', 'updatedAt', 'comments', 'resolved'],
  properties: { type: { type: 'string', enum: ['thread'] }, id: uuid, createdAt: date, updatedAt: date,
    comments: { type: 'array', items: commentSchema }, resolved: { type: 'boolean' },
    resolvedUpdatedAt: date, resolvedBy: { type: 'string' }, deletedAt: date,
    metadata: { type: 'object', additionalProperties: false },
  },
} as const;
const relativePosition = { type: 'object', additionalProperties: false, properties: {
  type: { type: ['object', 'null'], additionalProperties: false, required: ['client', 'clock'], properties: {
    client: { type: 'integer', minimum: 0 }, clock: { type: 'integer', minimum: 0 },
  } },
  item: { type: ['object', 'null'], additionalProperties: false, required: ['client', 'clock'], properties: {
    client: { type: 'integer', minimum: 0 }, clock: { type: 'integer', minimum: 0 },
  } },
  tname: { type: ['string', 'null'], enum: ['document', null] }, assoc: { type: 'integer', enum: [-1, 0, 1] },
} } as const;

/** Optional prepared capability. No live state bytes or authentication records cross this HTTP boundary. */
export function registerLiveRoutes(app: FastifyInstance, collaboration: Collaboration) {
  const base = '/api/v1/documents/:id/live';
  app.post<{ Params: { id: string }; Body: { userIds: string[] } }>(`${base}/users`, { schema: {
    operationId: 'resolveLiveDocumentUsers', tags: ['Collaboration'], params: parameters,
    body: { type: 'object', additionalProperties: false, required: ['userIds'], properties: {
      userIds: { type: 'array', maxItems: 128, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 128 } },
    } },
    response: { 200: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'name'],
      properties: { id: { type: 'string' }, name: { type: 'string' } } } }, ...errors },
  } }, request => collaboration.users(fromNodeHeaders(request.headers), request.params.id, request.body.userIds));
  app.get<{ Params: { id: string } }>(base, { schema: {
    operationId: 'readLiveDocument', tags: ['Collaboration'], params: parameters,
    response: { 200: metadataSchema, ...errors },
  } }, request => collaboration.read(fromNodeHeaders(request.headers), request.params.id));
  app.post<{ Params: { id: string } }>(base, { ...emptyJsonBody, schema: {
    operationId: 'enrollLiveDocument', tags: ['Collaboration'], params: parameters, headers: etagHeaders,
    body: emptyBody, response: { 200: metadataSchema, ...errors },
  } }, async (request, reply) => {
    const room = await collaboration.enroll(fromNodeHeaders(request.headers), request.params.id, request.headers['if-match']);
    return reply.header('etag', room.documentEtag).send(room);
  });
  for (const operation of ['checkpoint', 'restore'] as const) {
    app.post<{ Params: { id: string; epoch: string }; Body: { sequence?: string; revisionId?: string; changeNote?: string } }>(
      `${base}/:epoch/${operation}`, { schema: {
        operationId: operation === 'checkpoint' ? 'checkpointLiveDocument' : 'restoreLiveDocument', tags: ['Collaboration'],
        params: { ...parameters, required: ['id', 'epoch'], properties: { id: uuid, epoch: uuid } }, headers: etagHeaders,
        // Omitted sequence is deliberately handled by the core as 428.
        body: { type: 'object', additionalProperties: false, ...(operation === 'restore' ? { required: ['revisionId'] } : {}),
          properties: { sequence, changeNote: { type: 'string', maxLength: 2000 }, ...(operation === 'restore' ? { revisionId: uuid } : {}) } },
        response: { 200: operation === 'checkpoint' ? documentSchema : {
          type: 'object', additionalProperties: false, required: ['document', 'room'],
          properties: { document: documentSchema, room: metadataSchema },
        }, ...errors },
      } }, async (request, reply) => {
        const input = { ...request.body, epoch: request.params.epoch };
        const headers = fromNodeHeaders(request.headers);
        if (operation === 'checkpoint') {
          const saved = await collaboration.checkpoint(headers, request.params.id, request.params.epoch, input, request.headers['if-match']);
          return reply.header('etag', documentEtag(saved)).send(saved);
        }
        const saved = await collaboration.restore(headers, request.params.id, request.params.epoch, input, request.headers['if-match']);
        return reply.header('etag', documentEtag(saved.document)).send(saved);
      });
  }
  type Params = { id: string; epoch: string; threadId: string; commentId: string; emoji: string };
  type Body = { initialComment?: { body: unknown }; comment?: { body: unknown }; emoji?: string;
    selection?: { prosemirror?: { anchor: number; head: number }; yjs: { anchor: unknown; head: unknown } } };
  const routes = [
    { method: 'POST', path: '', operationId: 'createLiveCommentThread', response: threadSchema,
      body: { type: 'object', additionalProperties: false, required: ['initialComment'], properties: { initialComment: commentInput } },
      command: (_p: Params, b: Body) => ({ type: 'create', body: b.initialComment?.body }) },
    { method: 'POST', path: '/:threadId/comments', operationId: 'replyToLiveCommentThread', response: commentSchema,
      body: { type: 'object', additionalProperties: false, required: ['comment'], properties: { comment: commentInput } },
      command: (p: Params, b: Body) => ({ type: 'reply', threadId: p.threadId, body: b.comment?.body }) },
    { method: 'PUT', path: '/:threadId/comments/:commentId', operationId: 'editLiveComment', response: nullResponse,
      body: { type: 'object', additionalProperties: false, required: ['comment'], properties: { comment: commentInput } },
      command: (p: Params, b: Body) => ({ type: 'edit', threadId: p.threadId, commentId: p.commentId, body: b.comment?.body }) },
    { method: 'DELETE', path: '/:threadId/comments/:commentId', operationId: 'deleteLiveComment', response: nullResponse,
      command: (p: Params, _b: Body, soft?: boolean) => ({ type: 'delete-comment', threadId: p.threadId, commentId: p.commentId, softDelete: soft ?? false }) },
    { method: 'DELETE', path: '/:threadId', operationId: 'deleteLiveCommentThread', response: nullResponse,
      command: (p: Params) => ({ type: 'delete-thread', threadId: p.threadId }) },
    ...(['resolve', 'unresolve'] as const).map(type => ({ method: 'POST' as const, path: `/:threadId/${type}`,
      operationId: type === 'resolve' ? 'resolveLiveCommentThread' : 'unresolveLiveCommentThread', response: nullResponse,
      command: (p: Params) => ({ type, threadId: p.threadId }) })),
    { method: 'POST', path: '/:threadId/comments/:commentId/reactions', operationId: 'reactToLiveComment', response: nullResponse,
      body: { type: 'object', additionalProperties: false, required: ['emoji'], properties: { emoji: { type: 'string', minLength: 1, maxLength: 32 } } },
      command: (p: Params, b: Body) => ({ type: 'add-reaction', threadId: p.threadId, commentId: p.commentId, emoji: b.emoji }) },
    { method: 'DELETE', path: '/:threadId/comments/:commentId/reactions/:emoji', operationId: 'removeLiveCommentReaction', response: nullResponse,
      command: (p: Params) => ({ type: 'delete-reaction', threadId: p.threadId, commentId: p.commentId, emoji: p.emoji }) },
    { method: 'POST', path: '/:threadId/addToDocument', operationId: 'anchorLiveCommentThread', response: nullResponse,
      body: { type: 'object', additionalProperties: false, required: ['selection'], properties: {
        selection: { type: 'object', additionalProperties: false, required: ['yjs'], properties: {
          yjs: { type: 'object', additionalProperties: false, required: ['anchor', 'head'], properties: { anchor: relativePosition, head: relativePosition } },
          prosemirror: { type: 'object', additionalProperties: false, required: ['anchor', 'head'], properties: {
            anchor: { type: 'integer', minimum: 0 }, head: { type: 'integer', minimum: 0 },
          } },
        } },
      } },
      command: (p: Params, b: Body) => ({ type: 'anchor', threadId: p.threadId, selection: b.selection?.yjs }) },
  ];
  for (const route of routes) {
    const names = ['id', 'epoch', ...[...route.path.matchAll(/:([a-zA-Z]+)/g)].map(match => match[1]!)];
    app.route<{ Params: Params; Body: Body; Querystring: { soft?: boolean } }>({
      method: route.method as 'POST' | 'PUT' | 'DELETE', url: `${base}/:epoch/threads${route.path}`,
      ...(!('body' in route) ? emptyJsonBody : {}),
      schema: { operationId: route.operationId, tags: ['Comments'],
        params: { type: 'object', additionalProperties: false, required: names,
          properties: Object.fromEntries(names.map(name => [name, name === 'emoji' ? { type: 'string', minLength: 1, maxLength: 32 } : uuid])) },
        body: 'body' in route ? route.body : emptyBody,
        querystring: { type: 'object', additionalProperties: false, properties:
          route.operationId === 'deleteLiveComment' ? { soft: { type: 'boolean' } } : {} },
        response: { 200: route.response, ...errors },
      },
      handler: request => collaboration.comment(fromNodeHeaders(request.headers), request.params.id, request.params.epoch,
        route.command(request.params, request.body, request.query.soft)),
    });
  }
}
