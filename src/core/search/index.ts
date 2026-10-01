// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import type { PrismaClient } from '../../generated/prisma/client.js';
import type { Identity } from '../identity/index.js';
import { HttpProblem } from '../../http/problems.js';

export type SearchInput = { query: string; spaceId?: string; limit?: number };
export type SearchResult = { id: string; spaceId: string; spaceName: string; title: string; excerpt: string };
export const SEARCH_LIMITS = { maxQueryLength: 200, maxResults: 50, defaultResults: 20, maxExcerptLength: 320 } as const;

export function parseSearchInput(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpProblem(400, 'INVALID_REQUEST');
  if (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) throw new HttpProblem(400, 'INVALID_REQUEST');
  for (const key of Reflect.ownKeys(input)) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (typeof key !== 'string' || !['query', 'spaceId', 'limit'].includes(key)
      || !descriptor?.enumerable || !('value' in descriptor)) throw new HttpProblem(400, 'INVALID_REQUEST');
  }
  const fields = input as Record<string, unknown>;
  if (typeof fields.query !== 'string' || !fields.query.trim()
    || fields.query.length > SEARCH_LIMITS.maxQueryLength || fields.query.includes('\u0000')
    || /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(fields.query)) {
    throw new HttpProblem(400, 'INVALID_REQUEST');
  }
  const spaceId = fields.spaceId;
  if (spaceId !== undefined && (typeof spaceId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(spaceId))) {
    throw new HttpProblem(400, 'INVALID_REQUEST');
  }
  const limit = fields.limit === undefined ? SEARCH_LIMITS.defaultResults : fields.limit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > SEARCH_LIMITS.maxResults) {
    throw new HttpProblem(400, 'INVALID_REQUEST');
  }
  return { query: fields.query.trim(), spaceId: spaceId ?? null, limit };
}

type SearchRow = {
  authenticated: boolean; id: string | null; spaceId: string | null;
  spaceName: string | null; title: string | null; excerpt: string | null;
};

export function createSearch(prisma: PrismaClient, identity: Identity) {
  return {
    async find(headers: Headers, input: SearchInput): Promise<{ items: SearchResult[] }> {
      const principal = await identity.resolve(headers);
      await identity.actor(principal);
      const query = parseSearchInput(input);
      // This is an explicit authorized current-document read model. The SQL
      // rechecks session, current role and membership in the same statement as
      // matching, before ranking, snippets or limits can expose hidden content.
      const rows = await prisma.$queryRaw<SearchRow[]>`
        WITH actor AS (
          SELECT u."id", u."role" FROM "session" s
          JOIN "user" u ON u."id" = s."userId"
          WHERE s."id" = ${principal.sessionId} AND s."userId" = ${principal.userId}
            AND s."expiresAt" > statement_timestamp()
            AND (u."banned" IS NOT TRUE OR u."banExpires" <= statement_timestamp())
            AND u."role" IN ('administrator', 'member')
        ), query AS (
          SELECT plainto_tsquery('simple'::regconfig, ${query.query}) AS value
        )
        SELECT EXISTS(SELECT 1 FROM actor) AS authenticated,
          result."id", result."spaceId", result."spaceName", result."title", result."excerpt"
        FROM (SELECT 1) anchor
        LEFT JOIN LATERAL (
          SELECT d."id", d."spaceId", space."name" AS "spaceName", r."title",
            left(ts_headline('simple'::regconfig, r."plainText", query.value,
              'StartSel="", StopSel="", MaxFragments=1, MaxWords=40, MinWords=10'), ${SEARCH_LIMITS.maxExcerptLength}) AS excerpt,
            ts_rank_cd(r."searchVector", query.value) AS rank
          FROM actor CROSS JOIN query CROSS JOIN "Document" d
          JOIN "Space" space ON space."id" = d."spaceId"
          JOIN "DocumentRevision" r ON r."documentId" = d."id"
            AND r."revisionNumber" = d."currentRevisionNumber"
          WHERE d."archivedAt" IS NULL
            AND (${query.spaceId}::uuid IS NULL OR d."spaceId" = ${query.spaceId}::uuid)
            AND (actor."role" = 'administrator' OR EXISTS (
              SELECT 1 FROM "SpaceMembership" membership
              WHERE membership."spaceId" = d."spaceId" AND membership."userId" = actor."id"
                AND membership."role" IN ('reader', 'editor')
            ))
            AND r."searchVector" @@ query.value
          ORDER BY rank DESC, d."id" ASC
          LIMIT ${query.limit}
        ) result ON TRUE
        ORDER BY result.rank DESC NULLS LAST, result."id" ASC
      `;
      if (!rows[0]?.authenticated) throw new HttpProblem(401, 'AUTHENTICATION_REQUIRED');
      const items: SearchResult[] = [];
      for (const row of rows) {
        if (row.id === null) continue;
        if (row.spaceId === null || row.spaceName === null || row.title === null || row.excerpt === null) throw new Error('Invalid search read model');
        // Excerpts are bounded text, never generated HTML. Clients must render
        // them as text even when a document literally contains HTML/code.
        items.push({ id: row.id, spaceId: row.spaceId, spaceName: row.spaceName, title: row.title, excerpt: row.excerpt.trim() });
      }
      return { items };
    },
  };
}
