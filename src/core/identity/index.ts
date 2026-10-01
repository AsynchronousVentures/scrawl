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

  async function lockActors(db: Prisma.TransactionClient, principals: readonly Principal[]) {
    const users = [...new Set(principals.map(principal => principal.userId))];
    const sessions = [...new Set(principals.map(principal => principal.sessionId))];
    // Match recovery's user-before-session order. Stable batch ordering also
    // covers several connections belonging to the same account.
    await db.$queryRaw`SELECT "id" FROM "user" WHERE "id" = ANY(${users}::text[]) ORDER BY "id" FOR SHARE`;
    await db.$queryRaw`SELECT "id" FROM "session" WHERE "id" = ANY(${sessions}::text[]) ORDER BY "id" FOR SHARE`;
  }

  return {
    handle: auth.handler,
    origin: config.origin,
    resolve,
    actor,
    async connectionSession(principal: Principal) {
      await actor(principal);
      const session = await prisma.session.findUnique({ where: { id: principal.sessionId }, select: { expiresAt: true } });
      if (!session || session.expiresAt <= new Date()) throw new HttpProblem(401, 'AUTHENTICATION_REQUIRED');
      return { expiresAt: session.expiresAt.getTime() };
    },
    lockActors,
    async me(headers: Headers) { return actor(await resolve(headers)); },
    async requireUser(db: Prisma.TransactionClient, userId: string) {
      if (!await db.user.findUnique({ where: { id: userId }, select: { id: true } })) {
        throw new HttpProblem(404, 'NOT_FOUND');
      }
    },
  };
}

export type Identity = ReturnType<typeof createIdentity>;
