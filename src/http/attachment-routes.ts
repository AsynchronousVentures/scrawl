// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors
import { createReadStream } from 'node:fs';
import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyInstance } from 'fastify';
import type { Core } from '../core/index.js';
import { MAX_UPLOAD_BYTES } from '../core/attachments/index.js';
import { HttpProblem, problemSchema } from './problems.js';

const params = { type: 'object', required: ['id'], additionalProperties: false,
  properties: { id: { type: 'string', format: 'uuid' } } } as const;
export function registerAttachmentRoutes(app: FastifyInstance, core: Core) {
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: MAX_UPLOAD_BYTES }, (_request, body, done) => done(null, body));
  app.post<{ Params: { id: string }; Body: Buffer }>('/api/v1/documents/:id/attachments', {
    bodyLimit: MAX_UPLOAD_BYTES,
    schema: { operationId: 'uploadDocumentAttachment', tags: ['Documents'], params,
      consumes: ['application/octet-stream'], body: { description: 'Bounded raw file bytes; filename in x-file-name.' },
      headers: { type: 'object', required: ['x-file-name'], properties: { 'x-file-name': { type: 'string', maxLength: 1800 } } },
      response: { 201: { type: 'object', additionalProperties: false, required: ['id', 'name', 'mimeType', 'size', 'url'],
        properties: { id: { type: 'string', format: 'uuid' }, name: { type: 'string' }, mimeType: { type: 'string' },
          size: { type: 'integer' }, url: { type: 'string' } } }, '4xx': problemSchema, '5xx': problemSchema },
    },
  }, async (request, reply) => {
    let name: string;
    try { name = decodeURIComponent(String(request.headers['x-file-name'])); } catch { throw new HttpProblem(400, 'INVALID_ATTACHMENT'); }
    if (!Buffer.isBuffer(request.body)) throw new HttpProblem(400, 'INVALID_ATTACHMENT');
    const attachment = await core.attachments.upload(fromNodeHeaders(request.headers), request.params.id, name, request.body);
    return reply.code(201).send(attachment);
  });
  app.get<{ Params: { id: string } }>('/api/v1/attachments/:id/content', { schema: {
    operationId: 'readAttachmentContent', tags: ['Documents'], params,
    response: { 200: { type: 'string', format: 'binary' }, '4xx': problemSchema, '5xx': problemSchema },
  } }, async (request, reply) => {
    const attachment = await core.attachments.read(fromNodeHeaders(request.headers), request.params.id);
    const inline = /^(?:image\/(?:png|jpeg|gif|webp)|audio\/|video\/)/.test(attachment.mimeType);
    return reply.header('x-content-type-options', 'nosniff').header('content-security-policy', "sandbox; default-src 'none'")
      .header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename="attachment"; filename*=UTF-8''${encodeURIComponent(attachment.name)}`)
      .type(attachment.mimeType).send(createReadStream(attachment.path));
  });
}
