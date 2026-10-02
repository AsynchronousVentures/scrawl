// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import { createReadStream } from 'node:fs';
import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyInstance } from 'fastify';
import type { Publishing } from '../capabilities/publishing/index.js';
import { documentEtag } from '../core/documents/index.js';
import { problemSchema } from './problems.js';

const errors = { '4xx': problemSchema, '5xx': problemSchema };
const noQuery = { type: 'object', additionalProperties: false, properties: {} } as const;
const privateParams = { type: 'object', additionalProperties: false, required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } } } as const;
const publicParams = { type: 'object', additionalProperties: false, required: ['publicId'],
  properties: { publicId: { type: 'string', format: 'uuid' } } } as const;
const preconditions = { type: 'object', properties: { 'if-match': { type: 'string', maxLength: 200,
  description: 'The current strong document ETag. Missing is 428, stale is 412.' } } } as const;
const statusSchema = {
  type: 'object', additionalProperties: false, required: ['publication', 'lockVersion'], properties: {
    lockVersion: { type: 'integer', minimum: 1 },
    publication: { type: ['object', 'null'], additionalProperties: false,
      required: ['publicId', 'revisionId', 'revisionNumber', 'publishedAt', 'active'], properties: {
        publicId: { type: 'string', format: 'uuid' }, revisionId: { type: 'string', format: 'uuid' },
        revisionNumber: { type: 'integer', minimum: 1 }, publishedAt: { type: 'string', format: 'date-time' },
        active: { type: 'boolean', description: 'Grant and lifecycle are valid. The global publishing switch may still pause public access.' },
      },
    },
  },
} as const;
// Public schemas expose the approved content only, independently of private DTOs.
const publicSchema = {
  type: 'object', additionalProperties: false, required: ['title', 'content', 'publishedAt'], properties: {
    title: { type: 'string' }, publishedAt: { type: 'string', format: 'date-time' },
    content: { type: 'object', additionalProperties: false, required: ['format', 'schemaVersion', 'editorVersion', 'document'],
      properties: {
        format: { type: 'string', enum: ['blocknote-json'] }, schemaVersion: { type: 'integer', enum: [1] },
        editorVersion: { type: 'string', enum: ['0.55.0'] },
        document: { type: 'array', items: { type: 'object', additionalProperties: true } },
      },
    },
  },
} as const;

export function registerPublishingRoutes(app: FastifyInstance, publishing: Publishing) {
  app.get('/api/v1/publishing', { schema: { operationId: 'getPublishingAvailability', tags: ['Publishing'],
    querystring: noQuery,
    response: { 200: { type: 'object', additionalProperties: false, required: ['enabled', 'mayPublish'], properties: {
      enabled: { type: 'boolean' }, mayPublish: { type: 'boolean' },
    } }, ...errors },
  } }, request => publishing.availability(fromNodeHeaders(request.headers)));

  app.get<{ Params: { id: string } }>('/api/v1/documents/:id/publication', { schema: {
    operationId: 'readDocumentPublication', tags: ['Publishing'], params: privateParams, querystring: noQuery,
    response: { 200: statusSchema, ...errors },
  } }, async (request, reply) => {
    const result = await publishing.status(fromNodeHeaders(request.headers), request.params.id);
    return reply.header('etag', documentEtag(result)).send({ publication: result.publication, lockVersion: result.lockVersion });
  });

  app.post<{ Params: { id: string }; Body: unknown }>('/api/v1/documents/:id/publication', { schema: {
    operationId: 'publishDocumentRevision', tags: ['Publishing'], params: privateParams, querystring: noQuery, headers: preconditions,
    description: 'An administrator explicitly approves one immutable revision. Literal content and links become public; private saves never advance the grant.',
    body: { type: 'object', additionalProperties: false, required: ['revisionId'], properties: {
      revisionId: { type: 'string', format: 'uuid' },
    } },
    response: { 200: statusSchema, ...errors },
  } }, async (request, reply) => {
    const result = await publishing.publish(fromNodeHeaders(request.headers), request.params.id, request.body, request.headers['if-match']);
    return reply.header('etag', documentEtag(result)).send({ publication: result.value, lockVersion: result.lockVersion });
  });

  app.delete<{ Params: { id: string } }>('/api/v1/documents/:id/publication', { schema: {
    operationId: 'unpublishDocument', tags: ['Publishing'], params: privateParams, querystring: noQuery, headers: preconditions,
    description: 'Revoke future public reads under the document ETag. Copies already downloaded cannot be erased.',
    response: { 200: statusSchema, ...errors },
  } }, async (request, reply) => {
    const result = await publishing.unpublish(fromNodeHeaders(request.headers), request.params.id, request.headers['if-match']);
    return reply.header('etag', documentEtag(result)).send({ publication: result.value, lockVersion: result.lockVersion });
  });

  app.get<{ Params: { publicId: string } }>('/api/public/publications/:publicId', { schema: {
    operationId: 'readPublicPublication', tags: ['Publishing'], params: publicParams, querystring: noQuery,
    description: 'Anonymous approved title/content only. No private head, navigation, source identifiers, authors or history.',
    response: { 200: publicSchema, ...errors },
  } }, async (request, reply) => reply.header('cache-control', 'no-store').header('x-content-type-options', 'nosniff')
    .send(await publishing.read(request.params.publicId)));

  app.get<{ Params: { publicId: string; attachmentId: string } }>('/api/public/publications/:publicId/attachments/:attachmentId', { schema: {
    operationId: 'readPublicAttachment', tags: ['Publishing'],
    params: { ...publicParams, required: ['publicId', 'attachmentId'], properties: {
      ...publicParams.properties, attachmentId: { type: 'string', format: 'uuid' },
    } }, querystring: noQuery,
    description: 'Anonymous immutable bytes from this active grant and its selected revision allowlist only.',
    response: { 200: { type: 'string', format: 'binary' }, ...errors },
  } }, async (request, reply) => {
    const file = await publishing.attachment(request.params.publicId, request.params.attachmentId);
    const inline = /^(?:image\/(?:png|jpeg|gif|webp)|audio\/|video\/)/.test(file.mimeType);
    return reply.header('cache-control', 'no-store').header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "sandbox; default-src 'none'")
      .header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename="attachment"; filename*=UTF-8''${encodeURIComponent(file.name)}`)
      .type(file.mimeType).send(createReadStream(file.path));
  });
}
