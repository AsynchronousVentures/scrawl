// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import type { PrismaClient } from '../../generated/prisma/client.js';
import type { Identity } from '../identity/index.js';
import type { Spaces } from '../spaces/index.js';
import { HttpProblem } from '../../http/problems.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type FavoriteSummary = { id: string; spaceId: string; spaceName: string; spaceSlug: string; slug: string; title: string };
type FavoriteRow = { authenticated: boolean; id: string | null; spaceId: string | null;
  spaceName: string | null; spaceSlug: string | null; slug: string | null; title: string | null };

export function createFavorites(prisma: PrismaClient, identity: Identity, spaces: Spaces) {
  async function state(headers: Headers, id: string, change: { favorited: boolean } | null) {
    if (!uuid.test(id)) throw new HttpProblem(400, 'INVALID_REQUEST');
    const principal = await identity.resolve(headers);
    const target = await prisma.document.findUnique({ where: { id }, select: { spaceId: true } });
    if (!target) throw new HttpProblem(404, 'NOT_FOUND');
    return prisma.$transaction(async tx => {
      await spaces.lockForRead(tx, principal, target.spaceId);
      // Serialize opposite favorite commands without updating document versions.
      if (change) await tx.$queryRaw`SELECT "id" FROM "Document" WHERE "id" = ${id}::uuid FOR UPDATE`;
      else await tx.$queryRaw`SELECT "id" FROM "Document" WHERE "id" = ${id}::uuid FOR SHARE`;
      await identity.lockActors(tx, [principal]);
      const actor = await spaces.authorize(tx, principal, target.spaceId);
      const document = await tx.document.findUniqueOrThrow({ where: { id }, select: { archivedAt: true } });
      if (change?.favorited && document.archivedAt) throw new HttpProblem(409, 'DOCUMENT_ARCHIVED');
      if (change?.favorited) {
        await tx.documentFavorite.upsert({ where: { userId_documentId: { userId: actor.id, documentId: id } },
          create: { userId: actor.id, documentId: id }, update: {} });
      } else if (change) await tx.documentFavorite.deleteMany({ where: { userId: actor.id, documentId: id } });
      const favorited = Boolean(await tx.documentFavorite.findUnique({ where: { userId_documentId: { userId: actor.id, documentId: id } },
        select: { documentId: true } }));
      await identity.actor(principal, tx);
      return { favorited };
    });
  }

  return {
    read(headers: Headers, id: string) { return state(headers, id, null); },
    set(headers: Headers, id: string, favorited: unknown) {
      if (typeof favorited !== 'boolean') throw new HttpProblem(400, 'INVALID_REQUEST');
      return state(headers, id, { favorited });
    },
    async list(headers: Headers, input: { limit?: number; cursor?: string } = {}) {
      const limit = input.limit ?? 20, cursor = input.cursor ?? null;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (cursor !== null && !uuid.test(cursor))) {
        throw new HttpProblem(400, 'INVALID_REQUEST');
      }
      const principal = await identity.resolve(headers); await identity.actor(principal);
      // Recheck the current session, role and grants inside the actual title query.
      const rows = await prisma.$queryRaw<FavoriteRow[]>`
        WITH actor AS (
          SELECT u."id", u."role" FROM "session" s JOIN "user" u ON u."id" = s."userId"
          WHERE s."id" = ${principal.sessionId} AND s."userId" = ${principal.userId}
            AND s."expiresAt" > statement_timestamp()
            AND (u."banned" IS NOT TRUE OR u."banExpires" <= statement_timestamp())
            AND u."role" IN ('administrator', 'member')
        )
        SELECT EXISTS(SELECT 1 FROM actor) AS authenticated, result.*
        FROM (SELECT 1) anchor LEFT JOIN LATERAL (
          SELECT d."id", d."spaceId", space."name" AS "spaceName", space."slug" AS "spaceSlug", d."slug", r."title"
          FROM actor JOIN "DocumentFavorite" f ON f."userId" = actor."id"
          JOIN "Document" d ON d."id" = f."documentId" JOIN "Space" space ON space."id" = d."spaceId"
          JOIN "DocumentRevision" r ON r."documentId" = d."id" AND r."revisionNumber" = d."currentRevisionNumber"
          WHERE d."archivedAt" IS NULL AND (${cursor}::uuid IS NULL OR d."id" > ${cursor}::uuid)
            AND (actor."role" = 'administrator' OR EXISTS (
              SELECT 1 FROM "SpaceMembership" membership WHERE membership."spaceId" = d."spaceId"
                AND membership."userId" = actor."id" AND membership."role" IN ('reader', 'editor')
            ))
          ORDER BY d."id" LIMIT ${limit + 1}
        ) result ON TRUE ORDER BY result."id" NULLS LAST
      `;
      if (!rows[0]?.authenticated) throw new HttpProblem(401, 'AUTHENTICATION_REQUIRED');
      const items: FavoriteSummary[] = [];
      for (const row of rows) {
        if (row.id === null) continue;
        if (row.spaceId === null || row.spaceName === null || row.spaceSlug === null || row.slug === null || row.title === null) {
          throw new Error('Invalid favorite read model');
        }
        items.push({ id: row.id, spaceId: row.spaceId, spaceName: row.spaceName, spaceSlug: row.spaceSlug, slug: row.slug, title: row.title });
      }
      return { items: items.slice(0, limit), nextCursor: items.length > limit ? items[limit - 1]!.id : null };
    },
  };
}
