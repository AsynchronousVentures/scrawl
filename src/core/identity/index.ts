// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import type { PrismaClient, Prisma } from '../../generated/prisma/client.js';
import type { IdentityConfig } from '../../config.js';
import { HttpProblem } from '../../http/problems.js';
import { createAuth } from './auth.js';

export type Principal = Readonly<{ userId: string; sessionId: string }>;

export function createIdentity(prisma: PrismaClient, config: IdentityConfig) {
  const auth = createAuth(prisma, config);

  async function resolve(headers: Headers): Promise<Principal> {
    const session = await auth.api.getSession({ headers, query: { disableCookieCache: true } });
    if (!session) throw new HttpProblem(401, 'AUTHENTICATION_REQUIRED');
    return { userId: session.user.id, sessionId: session.session.id };
  }

  // Recheck the session/role after acquiring a transaction lock, including time spent waiting.
  async function actor(principal: Principal, db: Prisma.TransactionClient = prisma) {
    const session = await db.session.findUnique({ where: { id: principal.sessionId }, include: { user: true } });
    if (!session || session.userId !== principal.userId || session.expiresAt <= new Date()
      || (session.user.banned && (!session.user.banExpires || session.user.banExpires > new Date()))) {
      throw new HttpProblem(401, 'AUTHENTICATION_REQUIRED');
    }
    const { id, name, email, role } = session.user;
    if (role !== 'administrator' && role !== 'member') throw new HttpProblem(403, 'ACCESS_DENIED');
    return { id, name, email, role };
  }

  return {
    handle: auth.handler,
    origin: config.origin,
    resolve,
    actor,
    async lockActor(db: Prisma.TransactionClient, principal: Principal) {
      // Document/space locks precede these locks. Account recovery and logout
      // must finish session deletion before a later live operation is accepted.
      await db.$queryRaw`SELECT "id" FROM "user" WHERE "id" = ${principal.userId} FOR SHARE`;
      await db.$queryRaw`SELECT "id" FROM "session" WHERE "id" = ${principal.sessionId} FOR SHARE`;
      return actor(principal, db);
    },
    async me(headers: Headers) { return actor(await resolve(headers)); },
    async requireUser(db: Prisma.TransactionClient, userId: string) {
      if (!await db.user.findUnique({ where: { id: userId }, select: { id: true } })) {
        throw new HttpProblem(404, 'NOT_FOUND');
      }
    },
  };
}

export type Identity = ReturnType<typeof createIdentity>;
