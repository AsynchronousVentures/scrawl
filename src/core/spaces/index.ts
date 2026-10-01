// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import { randomUUID } from 'node:crypto';
import type { PrismaClient, Prisma, Space } from '../../generated/prisma/client.js';
import type { Identity, Principal } from '../identity/index.js';
import { HttpProblem } from '../../http/problems.js';
import { availableSlug, slugify, validSlug } from '../slugs.js';

function spaceDto(space: Space, access: 'reader' | 'editor') {
  return {
    id: space.id, name: space.name, slug: space.slug, createdBy: space.createdBy,
    createdAt: space.createdAt.toISOString(), updatedAt: space.updatedAt.toISOString(), lockVersion: space.lockVersion,
    access,
  };
}

export function spaceEtag(space: { id: string; lockVersion: number }) {
  return `"space-${space.id}-v${space.lockVersion}"`;
}

export function createSpaces(prisma: PrismaClient, identity: Identity) {
  async function read(headers: Headers, where: { id: string } | { slug: string }) {
    const actor = await identity.me(headers);
    const space = await prisma.space.findFirst({ where: {
      ...where, ...(actor.role === 'administrator' ? {} : { memberships: { some: { userId: actor.id } } }),
    }, include: { memberships: { where: { userId: actor.id }, select: { role: true } } } });
    if (!space) throw new HttpProblem(404, 'NOT_FOUND');
    return spaceDto(space,
      actor.role === 'administrator' || space.memberships.some((membership) => membership.role === 'editor') ? 'editor' : 'reader');
  }

  // Narrow cross-module access operation. Documents never query membership tables directly.
  async function access(db: Prisma.TransactionClient, principal: Principal, spaceId: string) {
    const actor = await identity.actor(principal, db);
    const space = await db.space.findUnique({ where: { id: spaceId }, select: {
      id: true, memberships: { where: { userId: actor.id }, select: { role: true } },
    } });
    if (!space || (actor.role !== 'administrator' && !space.memberships.length)) {
      throw new HttpProblem(404, 'NOT_FOUND');
    }
    return { actor, canWrite: actor.role === 'administrator' || space.memberships.some(membership => membership.role === 'editor') };
  }
  async function authorize(db: Prisma.TransactionClient, principal: Principal, spaceId: string, write = false) {
    const permission = await access(db, principal, spaceId);
    if (write && !permission.canWrite) throw new HttpProblem(404, 'NOT_FOUND');
    return permission.actor;
  }

  return {
    access,
    authorize,
    async memberIds(db: Prisma.TransactionClient, spaceId: string, userIds: readonly string[]) {
      const members = await db.spaceMembership.findMany({ where: { spaceId, userId: { in: [...userIds] } }, select: { userId: true } });
      return members.map(member => member.userId);
    },
    async lockForRead(db: Prisma.TransactionClient, principal: Principal, spaceId: string) {
      // Membership changes take an exclusive lock on this same space row.
      await db.$queryRaw`SELECT "id" FROM "Space" WHERE "id" = ${spaceId}::uuid FOR SHARE`;
      return authorize(db, principal, spaceId);
    },
    async lockForWrite(db: Prisma.TransactionClient, principal: Principal, spaceId: string) {
      await db.$queryRaw`SELECT "id" FROM "Space" WHERE "id" = ${spaceId}::uuid FOR UPDATE`;
      return authorize(db, principal, spaceId, true);
    },
    async create(headers: Headers, name: string) {
      if (!name.trim() || name.length > 200) throw new HttpProblem(400, 'INVALID_REQUEST');
      const principal = await identity.resolve(headers);
      return prisma.$transaction(async (tx) => {
        // Space names form an installation-wide namespace. Only space creates
        // take this advisory lock; existing space/document lock order is unchanged.
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(1935897196, 1)::text`;
        const actor = await identity.actor(principal, tx);
        if (actor.role !== 'administrator') throw new HttpProblem(403, 'ACCESS_DENIED');
        const base = slugify(name, 'space');
        const occupied = await tx.space.findMany({ where: { OR: [{ slug: base }, { slug: { startsWith: `${base}-` } }] }, select: { slug: true } });
        const slug = availableSlug(base, occupied.map(space => space.slug));
        return spaceDto(await tx.space.create({ data: { id: randomUUID(), name: name.trim(), slug, createdBy: actor.id } }), 'editor');
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
        include: { memberships: { where: { userId: actor.id }, select: { role: true } } },
        orderBy: { id: 'asc' }, take: limit + 1,
      });
      const items = spaces.slice(0, limit).map((space) => spaceDto(space,
        actor.role === 'administrator' || space.memberships.some((membership) => membership.role === 'editor') ? 'editor' : 'reader'));
      return { items, nextCursor: spaces.length > limit ? items.at(-1)!.id : null };
    },
    read(headers: Headers, id: string) { return read(headers, { id }); },
    readBySlug(headers: Headers, slug: string) {
      if (!validSlug(slug)) throw new HttpProblem(400, 'INVALID_REQUEST');
      return read(headers, { slug });
    },
    async listMembers(headers: Headers, input: { spaceId: string; limit?: number; cursor?: string }) {
      const limit = input.limit ?? 50;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100 || input.cursor !== undefined && (!input.cursor || input.cursor.length > 128)) {
        throw new HttpProblem(400, 'INVALID_REQUEST');
      }
      const principal = await identity.resolve(headers);
      return prisma.$transaction(async db => {
        // Reads share the same space lock as grant/revoke and hold current
        // actor credentials stable while projecting the member page.
        await db.$queryRaw`SELECT "id" FROM "Space" WHERE "id" = ${input.spaceId}::uuid FOR SHARE`;
        await identity.lockActors(db, [principal]);
        if ((await identity.actor(principal, db)).role !== 'administrator') throw new HttpProblem(404, 'NOT_FOUND');
        const space = await db.space.findUnique({ where: { id: input.spaceId }, select: { id: true, lockVersion: true } });
        if (!space) throw new HttpProblem(404, 'NOT_FOUND');
        const members = await db.spaceMembership.findMany({ where: {
          spaceId: space.id, ...(input.cursor ? { userId: { gt: input.cursor } } : {}),
        }, orderBy: { userId: 'asc' }, take: limit + 1 });
        const page = members.slice(0, limit);
        const profiles = new Map((await identity.memberProfiles(db, principal, page.map(member => member.userId))).map(user => [user.id, user]));
        const items = page.map(member => {
          const user = profiles.get(member.userId);
          if (!user || member.role !== 'reader' && member.role !== 'editor') throw new HttpProblem(500, 'INVALID_MEMBER_PROFILE');
          return { user, role: member.role };
        });
        return { spaceId: space.id, lockVersion: space.lockVersion, items, nextCursor: members.length > limit ? page.at(-1)!.userId : null };
      });
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
        return spaceDto(await tx.space.findUniqueOrThrow({ where: { id: space.id } }), 'editor');
      });
    },
  };
}

export type Spaces = ReturnType<typeof createSpaces>;
