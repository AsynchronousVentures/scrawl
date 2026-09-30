// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import { randomUUID } from 'node:crypto';
import type { Documents } from '../../core/documents/index.js';
import type { Identity } from '../../core/identity/index.js';
import { HttpProblem } from '../../http/problems.js';

type DocumentAccess = Pick<Documents, 'readRevision' | 'mutatePublication' | 'publicationStatus'
  | 'publicationSnapshot' | 'publicationAttachment'>;
type IdentityAccess = Pick<Identity, 'me'>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Grant writes are capability-owned, inside the core's authorized transaction. */
export function createPublishing(documents: DocumentAccess, identity: IdentityAccess, options: { enabled: boolean }) {
  const enabled = options.enabled;
  return {
    async availability(headers: Headers) {
      const actor = await identity.me(headers);
      return { enabled, mayPublish: enabled && actor.role === 'administrator' };
    },
    async status(headers: Headers, documentId: string) {
      return documents.publicationStatus(headers, documentId);
    },
    async publish(headers: Headers, documentId: string, input: unknown, expectedEtag?: string) {
      if (!enabled) throw new HttpProblem(404, 'NOT_FOUND');
      if (!input || typeof input !== 'object' || Array.isArray(input)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(input) as object | null)
        || Object.keys(input).length !== 1 || !('revisionId' in input)
        || Object.values(Object.getOwnPropertyDescriptors(input)).some(field => !('value' in field))
        || typeof input.revisionId !== 'string' || !uuid.test(input.revisionId)) {
        throw new HttpProblem(400, 'INVALID_REQUEST');
      }
      // Resolve the caller-selected identity, never infer a newer private head.
      // The mutation operation rechecks ownership, role and availability under locks.
      const selected = await documents.readRevision(headers, documentId, input.revisionId);
      return documents.mutatePublication(headers, documentId, expectedEtag, selected.revisionNumber, async context => {
        if (context.revisionId !== selected.id || context.revisionNumber === null) throw new HttpProblem(404, 'NOT_FOUND');
        const now = new Date();
        const grant = await context.tx.publication.upsert({ where: { documentId }, create: {
          id: randomUUID(), documentId, revisionNumber: context.revisionNumber,
          approvedAvailabilityVersion: context.availabilityVersion, active: true,
          publisherId: context.publisherId, publishedAt: now,
        }, update: {
          revisionNumber: context.revisionNumber, approvedAvailabilityVersion: context.availabilityVersion,
          active: true, publisherId: context.publisherId, publishedAt: now,
        } });
        return { publicId: grant.id, revisionId: selected.id, revisionNumber: grant.revisionNumber,
          publishedAt: grant.publishedAt.toISOString(), active: true };
      });
    },
    async unpublish(headers: Headers, documentId: string, expectedEtag?: string) {
      if (!enabled) throw new HttpProblem(404, 'NOT_FOUND');
      return documents.mutatePublication(headers, documentId, expectedEtag, null, async context => {
        const existing = await context.tx.publication.findUnique({ where: { documentId },
          select: { id: true, revisionNumber: true, publishedAt: true, revision: { select: { id: true } } } });
        if (!existing) return null;
        await context.tx.publication.update({ where: { documentId }, data: { active: false } });
        return { publicId: existing.id, revisionId: existing.revision.id, revisionNumber: existing.revisionNumber,
          publishedAt: existing.publishedAt.toISOString(), active: false };
      });
    },
    async read(publicId: string) { return documents.publicationSnapshot(publicId, enabled); },
    async attachment(publicId: string, attachmentId: string) {
      return documents.publicationAttachment(publicId, attachmentId, enabled);
    },
  };
}

export type Publishing = ReturnType<typeof createPublishing>;
