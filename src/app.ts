// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import type { AppConfig } from './config.js';
import { registerProblemHandlers } from './http/problems.js';
import { registerSystemRoutes } from './modules/system/routes.js';
import { registerAuthRoutes, registerCoreRoutes } from './http/core-routes.js';
import type { Core } from './core/index.js';
import { registerDocumentRoutes } from './http/document-routes.js';
import { registerSearchRoutes } from './http/search-routes.js';
import { registerAttachmentRoutes } from './http/attachment-routes.js';
import { registerPublishingRoutes } from './http/publishing-routes.js';
import type { Publishing } from './capabilities/publishing/index.js';
import { registerExportRoutes } from './http/export-routes.js';
import type { Exporting } from './capabilities/exporting/index.js';
import { registerFrontend } from './http/frontend.js';
import { registerLiveRoutes } from './http/live-routes.js';
import type { Collaboration } from './capabilities/collaboration/index.js';

type BuildOptions = {
  config: AppConfig;
  checkDatabase: () => Promise<void>;
  logging?: boolean;
  core?: Core;
  frontendRoot?: string;
  exporting?: Exporting;
  publishing?: Publishing;
  collaboration?: Collaboration;
};

/** Builds the HTTP application without opening a port or connecting a database. */
export async function buildApp({ config, checkDatabase, logging = true, core, frontendRoot, exporting, publishing, collaboration }: BuildOptions) {
  const app = Fastify({
    logger: logging ? {
      level: config.logLevel,
      redact: {
        paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
        remove: true,
      },
      serializers: {
        // Query strings can contain secrets, and slugs contain private names.
        // Log route patterns instead of caller URLs, headers or bodies.
        req: (request) => ({ method: request.method, url: request.routeOptions?.url ?? '/unmatched' }),
      },
    } : false,
    genReqId: () => randomUUID(),
    requestIdHeader: false,
    trustProxy: false,
    bodyLimit: 1024 * 1024,
    requestTimeout: 30_000,
    ajv: { customOptions: { removeAdditional: false } },
  });

  registerProblemHandlers(app);
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
    reply.header('cache-control', 'no-store');
  });

  // Register before routes: these schemas are the sole source for the live OpenAPI document.
  await app.register(swagger, {
    transformObject(document) {
      if ('swaggerObject' in document) return document.swaggerObject;
      // Swagger assumes every body schema is required; these routes normalize an absent body to {}.
      for (const operation of ['archive', 'unarchive']) {
        const body = document.openapiObject.paths?.[`/api/v1/documents/{id}/${operation}`]?.post?.requestBody;
        if (body && !('$ref' in body)) body.required = false;
      }
      const optionalLiveBodies = ['enrollLiveDocument', 'deleteLiveComment', 'deleteLiveCommentThread',
        'resolveLiveCommentThread', 'unresolveLiveCommentThread', 'removeLiveCommentReaction'];
      for (const path of Object.values(document.openapiObject.paths ?? {})) {
        for (const method of ['post', 'delete'] as const) {
          const operation = path?.[method];
          const body = operation?.requestBody;
          if (optionalLiveBodies.includes(operation?.operationId ?? '') && body && !('$ref' in body)) body.required = false;
        }
      }
      const upload = document.openapiObject.paths?.['/api/v1/documents/{id}/attachments']?.post?.requestBody;
      if (upload && !('$ref' in upload)) upload.content = { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } };
      return document.openapiObject;
    },
    openapi: {
      openapi: '3.0.3',
      info: {
        title: 'Scrawl API',
        version: '0.0.0',
        description: 'System health, local identity, authorized spaces, documents, and immutable revisions.',
      },
      tags: [
        { name: 'System', description: 'Operational health' },
        { name: 'Identity', description: 'Current authenticated user' },
        { name: 'Spaces', description: 'Authorized spaces and administrator membership changes' },
        { name: 'Documents', description: 'Authorized document content and lifecycle' },
        { name: 'Revisions', description: 'Immutable document history and restore' },
      ],
    },
  });
  await registerSystemRoutes(app, checkDatabase);
  if (core) {
    registerAuthRoutes(app, core);
    registerCoreRoutes(app, core);
    registerDocumentRoutes(app, core, collaboration);
    registerAttachmentRoutes(app, core);
    registerSearchRoutes(app, core);
  }
  if (exporting) registerExportRoutes(app, exporting);
  if (collaboration && core) registerLiveRoutes(app, collaboration);
  if (publishing) registerPublishingRoutes(app, publishing);
  if (config.apiDocsEnabled) {
    app.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger());
  }
  if (frontendRoot) await registerFrontend(app, frontendRoot);

  return app;
}
