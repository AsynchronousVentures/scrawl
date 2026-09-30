// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyInstance } from 'fastify';
import type { ExportFormat, Exporting } from '../capabilities/exporting/index.js';
import { problemSchema } from './problems.js';

export function registerExportRoutes(app: FastifyInstance, exporting: Exporting): void {
  app.get<{ Params: { id: string; format: ExportFormat }; Querystring: { revisionId?: string } }>(
    '/api/v1/documents/:id/exports/:format', { schema: {
      operationId: 'exportDocumentFile', tags: ['Documents'],
      description: 'Download an authorized current or selected immutable snapshot as PDF or DOCX. Private PNG/JPEG/GIF images are embedded, WebP is rendered as PNG, and other attachments remain authenticated links. External media is rejected, never fetched. This is a rendered snapshot, not a backup.',
      params: { type: 'object', additionalProperties: false, required: ['id', 'format'], properties: {
        id: { type: 'string', format: 'uuid' }, format: { type: 'string', enum: ['pdf', 'docx'] },
      } },
      querystring: { type: 'object', additionalProperties: false, properties: {
        revisionId: { type: 'string', format: 'uuid' },
      } },
      response: {
        200: { description: 'Binary document download.', content: {
          'application/pdf': { schema: { type: 'string', format: 'binary' } },
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document': {
            schema: { type: 'string', format: 'binary' },
          },
        } },
        400: problemSchema, 401: problemSchema, 404: problemSchema, 409: problemSchema,
        413: problemSchema, 422: problemSchema, 500: problemSchema,
      },
    } }, async (request, reply) => {
      const exported = await exporting.download(
        fromNodeHeaders(request.headers), request.params.id, request.params.format, request.query.revisionId,
      );
      return reply.header('content-disposition', `attachment; filename="${exported.filename}"`)
        .header('x-content-type-options', 'nosniff').type(exported.mimeType).send(exported.bytes);
    },
  );
}
