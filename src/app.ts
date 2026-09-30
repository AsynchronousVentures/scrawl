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

type BuildOptions = {
  config: AppConfig;
  checkDatabase: () => Promise<void>;
  logging?: boolean;
  core?: Core;
};

/** Builds the HTTP application without opening a port or connecting a database. */
export async function buildApp({ config, checkDatabase, logging = true, core }: BuildOptions) {
  const app = Fastify({
    logger: logging ? {
      level: config.logLevel,
      redact: {
        paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
        remove: true,
      },
      serializers: {
        // Query strings can contain secrets; omit them and all request headers/body.
        req: (request) => ({ method: request.method, url: request.url.split('?')[0] ?? '' }),
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
    openapi: {
      openapi: '3.0.3',
      info: {
        title: 'Scrawl API',
        version: '0.0.0',
        description: 'System health, local identity, and authorized space access.',
      },
      tags: [
        { name: 'System', description: 'Operational health' },
        { name: 'Identity', description: 'Current authenticated user' },
        { name: 'Spaces', description: 'Authorized spaces and administrator membership changes' },
      ],
    },
  });
  await registerSystemRoutes(app, checkDatabase);
  if (core) {
    registerAuthRoutes(app, core);
    registerCoreRoutes(app, core);
  }
  if (config.apiDocsEnabled) {
    app.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger());
  }

  return app;
}
