// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyInstance } from 'fastify';
import type { Core } from '../core/index.js';
import { documentEtag } from '../core/documents/index.js';
import { problemSchema } from './problems.js';

const contentSchema = {
  type: 'object', additionalProperties: false, required: ['format', 'schemaVersion', 'document'],
  properties: {
    format: { type: 'string', enum: ['prosemirror-json'] },
    schemaVersion: { type: 'integer', enum: [1] },
    // Core validates the exact native node/mark schema; preserve its validated JSON in responses.
    document: { type: 'object', additionalProperties: true },
  },
} as const;
const titleSchema = { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' } as const;
const changeNoteSchema = { type: 'string', maxLength: 2000 } as const;
const revisionProperties = {
  id: { type: 'string', format: 'uuid' }, documentId: { type: 'string', format: 'uuid' },
  revisionNumber: { type: 'integer', minimum: 1 }, title: { type: 'string' },
  authorId: { type: 'string' }, createdAt: { type: 'string', format: 'date-time' },
  changeNote: { type: ['string', 'null'] },
} as const;
const revisionSummarySchema = {
  type: 'object', additionalProperties: false,
  required: ['id', 'documentId', 'revisionNumber', 'title', 'authorId', 'createdAt', 'changeNote'],
  properties: revisionProperties,
} as const;
const revisionSchema = {
  ...revisionSummarySchema,
  required: [...revisionSummarySchema.required, 'content', 'plainText'],
  properties: { ...revisionProperties, content: contentSchema, plainText: { type: 'string' } },
} as const;
const documentProperties = {
  id: { type: 'string', format: 'uuid' }, spaceId: { type: 'string', format: 'uuid' },
  currentRevisionNumber: { type: 'integer', minimum: 1 }, lockVersion: { type: 'integer', minimum: 1 },
  createdAt: { type: 'string', format: 'date-time' }, createdBy: { type: 'string' },
  updatedAt: { type: 'string', format: 'date-time' },
  archivedAt: { type: ['string', 'null'], format: 'date-time' }, archivedBy: { type: ['string', 'null'] },
} as const;
const documentRequired = [
  'id', 'spaceId', 'currentRevisionNumber', 'lockVersion', 'createdAt', 'createdBy', 'updatedAt', 'archivedAt', 'archivedBy',
] as const;
const documentSchema = {
  type: 'object', additionalProperties: false, required: [...documentRequired, 'revision'],
  properties: { ...documentProperties, revision: revisionSchema },
} as const;
const documentSummarySchema = {
  type: 'object', additionalProperties: false, required: [...documentRequired, 'title'],
  properties: { ...documentProperties, title: { type: 'string' } },
} as const;
const documentParams = {
  type: 'object', additionalProperties: false, required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
} as const;
const revisionParams = {
  ...documentParams, required: ['id', 'revisionId'],
  properties: { ...documentParams.properties, revisionId: { type: 'string', format: 'uuid' } },
} as const;
const preconditionHeaders = {
  type: 'object', properties: {
    'if-match': {
      type: 'string', maxLength: 200,
      description: 'One strong ETag from this document; missing is 428, stale is 412.',
    },
  },
} as const;
const limitSchema = { type: 'integer', minimum: 1, maximum: 100 } as const;
const errors = { '4xx': problemSchema, '5xx': problemSchema };

export function registerDocumentRoutes(app: FastifyInstance, core: Core) {
  app.post<{ Params: { id: string }; Body: unknown }>('/api/v1/spaces/:id/documents', { schema: {
    operationId: 'createDocument', tags: ['Documents'], params: documentParams,
    body: { type: 'object', additionalProperties: false, required: ['title', 'content'], properties: {
      title: titleSchema, content: contentSchema, changeNote: changeNoteSchema,
    } },
    response: { 201: documentSchema, ...errors },
  } }, async (request, reply) => {
    const document = await core.documents.create(fromNodeHeaders(request.headers), request.params.id, request.body);
    return reply.code(201).header('etag', documentEtag(document))
      .header('location', `/api/v1/documents/${document.id}`).send(document);
  });

  app.get<{ Params: { id: string }; Querystring: { limit?: number; cursor?: string; includeArchived?: boolean } }>(
    '/api/v1/spaces/:id/documents', { schema: {
      operationId: 'listDocuments', tags: ['Documents'], params: documentParams,
      querystring: { type: 'object', additionalProperties: false, properties: {
        limit: limitSchema, cursor: { type: 'string', format: 'uuid' }, includeArchived: { type: 'boolean' },
      } },
      response: { 200: {
        type: 'object', additionalProperties: false, required: ['items', 'nextCursor'], properties: {
          items: { type: 'array', items: documentSummarySchema }, nextCursor: { type: ['string', 'null'] },
        },
      }, ...errors },
    } }, (request) => core.documents.list(fromNodeHeaders(request.headers), request.params.id, request.query),
  );

  app.get<{ Params: { id: string } }>('/api/v1/documents/:id', { schema: {
    operationId: 'readDocument', tags: ['Documents'], params: documentParams,
    response: { 200: documentSchema, ...errors },
  } }, async (request, reply) => {
    const document = await core.documents.read(fromNodeHeaders(request.headers), request.params.id);
    return reply.header('etag', documentEtag(document)).send(document);
  });

  app.patch<{ Params: { id: string }; Body: unknown }>('/api/v1/documents/:id', { schema: {
    operationId: 'updateDocument', tags: ['Documents'], params: documentParams, headers: preconditionHeaders,
    body: { type: 'object', additionalProperties: false, anyOf: [{ required: ['title'] }, { required: ['content'] }],
      properties: { title: titleSchema, content: contentSchema, changeNote: changeNoteSchema },
    },
    response: { 200: documentSchema, ...errors },
  } }, async (request, reply) => {
    const document = await core.documents.update(
      fromNodeHeaders(request.headers), request.params.id, request.body, request.headers['if-match'],
    );
    return reply.header('etag', documentEtag(document)).send(document);
  });

  app.get<{ Params: { id: string }; Querystring: { limit?: number; cursor?: number } }>(
    '/api/v1/documents/:id/revisions', { schema: {
      operationId: 'listDocumentRevisions', tags: ['Revisions'], params: documentParams,
      querystring: { type: 'object', additionalProperties: false, properties: {
        limit: limitSchema, cursor: { type: 'integer', minimum: 1 },
      } },
      response: { 200: {
        type: 'object', additionalProperties: false, required: ['items', 'nextCursor'], properties: {
          items: { type: 'array', items: revisionSummarySchema }, nextCursor: { type: ['integer', 'null'], minimum: 1 },
        },
      }, ...errors },
    } }, (request) => core.documents.listRevisions(fromNodeHeaders(request.headers), request.params.id, request.query),
  );

  app.get<{ Params: { id: string; revisionId: string } }>('/api/v1/documents/:id/revisions/:revisionId', { schema: {
    operationId: 'readDocumentRevision', tags: ['Revisions'], params: revisionParams,
    response: { 200: revisionSchema, ...errors },
  } }, (request) => core.documents.readRevision(fromNodeHeaders(request.headers), request.params.id, request.params.revisionId));

  app.post<{ Params: { id: string }; Body: unknown }>('/api/v1/documents/:id/restore', { schema: {
    operationId: 'restoreDocumentRevision', tags: ['Revisions'], params: documentParams, headers: preconditionHeaders,
    body: { type: 'object', additionalProperties: false, required: ['revisionId'], properties: {
      revisionId: { type: 'string', format: 'uuid' }, changeNote: changeNoteSchema,
    } },
    response: { 200: documentSchema, ...errors },
  } }, async (request, reply) => {
    const document = await core.documents.restore(
      fromNodeHeaders(request.headers), request.params.id, request.body, request.headers['if-match'],
    );
    return reply.header('etag', documentEtag(document)).send(document);
  });

  for (const operation of ['archive', 'unarchive'] as const) {
    app.post<{ Params: { id: string }; Body: unknown }>(`/api/v1/documents/:id/${operation}`, {
      // Lifecycle operations accept no body or an empty object, never submitted state/actor fields.
      preValidation: async (request) => { if (request.body === undefined) request.body = {}; },
      schema: {
        operationId: operation === 'archive' ? 'archiveDocument' : 'unarchiveDocument', tags: ['Documents'],
        params: documentParams, headers: preconditionHeaders,
        body: { type: 'object', additionalProperties: false, properties: {}, description: 'Optional empty object.' },
        response: { 200: documentSchema, ...errors },
      },
    }, async (request, reply) => {
      const document = await core.documents[operation](
        fromNodeHeaders(request.headers), request.params.id, request.headers['if-match'],
      );
      return reply.header('etag', documentEtag(document)).send(document);
    });
  }
}
