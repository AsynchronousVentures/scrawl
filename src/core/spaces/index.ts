// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import { randomUUID } from 'node:crypto';
import type { PrismaClient, Space } from '../../generated/prisma/client.js';
import type { Identity } from '../identity/index.js';
import { HttpProblem } from '../../http/problems.js';

function spaceDto(space: Space) {
  return {
    id: space.id, name: space.name, createdBy: space.createdBy,
    createdAt: space.createdAt.toISOString(), updatedAt: space.updatedAt.toISOString(), lockVersion: space.lockVersion,
  };
}

export function spaceEtag(space: { id: string; lockVersion: number }) {
  return `"space-${space.id}-v${space.lockVersion}"`;
}

export function createSpaces(prisma: PrismaClient, identity: Identity) {
  return {
    async create(headers: Headers, name: string) {
      if (!name.trim() || name.length > 200) throw new HttpProblem(400, 'INVALID_REQUEST');
      const principal = await identity.resolve(headers);
      return prisma.$transaction(async (tx) => {
        const actor = await identity.actor(principal, tx);
        if (actor.role !== 'administrator') throw new HttpProblem(403, 'ACCESS_DENIED');
        return spaceDto(await tx.space.create({ data: { id: randomUUID(), name: name.trim(), createdBy: actor.id } }));
      });
    },
    async list(headers: Headers, input: { limit?: number; cursor?: string } = {}) {
      const actor = await identity.me(headers);
      const limit = input.limit ?? 50;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new HttpProblem(400, 'INVALID_REQUEST');
      const spaces = await prisma.space.findMany({
        where: {
          ...(actor.role === 'administrator' ? {} : { memberships: { some: { userId: actor.id } } }),
          ...(input.cursor ? { id: { gt: input.cursor } } : {}),
        },
        orderBy: { id: 'asc' }, take: limit + 1,
      });
      const items = spaces.slice(0, limit).map(spaceDto);
      return { items, nextCursor: spaces.length > limit ? items.at(-1)!.id : null };
    },
    async read(headers: Headers, id: string) {
      const actor = await identity.me(headers);
      const space = await prisma.space.findFirst({ where: {
        id, ...(actor.role === 'administrator' ? {} : { memberships: { some: { userId: actor.id } } }),
      } });
      if (!space) throw new HttpProblem(404, 'NOT_FOUND');
      return spaceDto(space);
    },
    async changeMembership(headers: Headers, input: {
      spaceId: string; userId: string; role: 'reader' | 'editor' | null; expectedEtag: string | undefined;
    }) {
      const principal = await identity.resolve(headers);
      if ((await identity.actor(principal)).role !== 'administrator') throw new HttpProblem(404, 'NOT_FOUND');
      if (input.role !== null && input.role !== 'reader' && input.role !== 'editor') throw new HttpProblem(400, 'INVALID_REQUEST');
      return prisma.$transaction(async (tx) => {
        // Standard order: space lock, current actor/access, version check, membership mutation.
        await tx.$queryRaw`SELECT "id" FROM "Space" WHERE "id" = ${input.spaceId}::uuid FOR UPDATE`;
        if ((await identity.actor(principal, tx)).role !== 'administrator') throw new HttpProblem(404, 'NOT_FOUND');
        const space = await tx.space.findUnique({ where: { id: input.spaceId } });
        if (!space) throw new HttpProblem(404, 'NOT_FOUND');
        if (input.expectedEtag === undefined) throw new HttpProblem(428, 'PRECONDITION_REQUIRED');
        if (!/^"[^"\x00-\x20\x7f]*"$/.test(input.expectedEtag)) throw new HttpProblem(400, 'INVALID_PRECONDITION');
        if (input.expectedEtag !== spaceEtag(space)) throw new HttpProblem(412, 'PRECONDITION_FAILED');
        await identity.requireUser(tx, input.userId);
        if (input.role === null) {
          await tx.spaceMembership.deleteMany({ where: { spaceId: space.id, userId: input.userId } });
        } else {
          await tx.spaceMembership.upsert({
            where: { spaceId_userId: { spaceId: space.id, userId: input.userId } },
            create: { spaceId: space.id, userId: input.userId, role: input.role },
            update: { role: input.role },
          });
        }
        // Keep a conditional database write even though the row lock serializes these operations.
        const updated = await tx.space.updateMany({
          where: { id: space.id, lockVersion: space.lockVersion },
          data: { lockVersion: { increment: 1 } },
        });
        if (updated.count !== 1) throw new HttpProblem(412, 'PRECONDITION_FAILED');
        return spaceDto(await tx.space.findUniqueOrThrow({ where: { id: space.id } }));
      });
    },
  };
}
