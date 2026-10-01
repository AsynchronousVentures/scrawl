// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import { randomUUID } from 'node:crypto';
import type { Document, DocumentLive, DocumentRevision, Prisma, PrismaClient } from '../../generated/prisma/client.js';
import type { Identity, Principal } from '../identity/index.js';
import type { Spaces } from '../spaces/index.js';
import { attachmentReferences, type Attachments } from '../attachments/index.js';
import { HttpProblem } from '../../http/problems.js';
import { ContentValidationError, validateContent } from './content.js';
import { availableSlug, slugify, validSlug } from '../slugs.js';
import { createLiveState, readLiveState, prepareLiveUpdate, prepareLiveComment, LiveContentError, LIVE_SCHEMA_VERSION } from '../live/content.js';

type Head = Document & { head: DocumentRevision; space: { slug: string } };
type RevisionMetadata = Pick<DocumentRevision, 'id' | 'documentId' | 'revisionNumber' | 'title' | 'authorId' | 'createdAt' | 'changeNote'>;
type Actor = Awaited<ReturnType<Identity['actor']>>;
export type LiveConnection = Readonly<{ connectionId: string; principal: Principal }>;

/** Internal coordinated persistence, never an HTTP or frontend contract. */
export type PublicationMutationContext = {
  tx: Prisma.TransactionClient;
  documentId: string;
  revisionId: string | null;
  revisionNumber: number | null;
  availabilityVersion: number;
  publisherId: string;
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const privateAttachmentUrl = /^\/api\/v1\/attachments\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/content$/i;

function publicContent(value: unknown, publicId: string): unknown {
  if (Array.isArray(value)) return value.map(child => publicContent(child, publicId));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => {
    const id = (key === 'url' || key === 'href') && typeof child === 'string' ? privateAttachmentUrl.exec(child)?.[1] : undefined;
    return [key, id ? `/api/public/publications/${publicId}/attachments/${id}` : publicContent(child, publicId)];
  }));
}

function content(input: unknown) {
  try { return validateContent(input); } catch (error) {
    if (error instanceof ContentValidationError) throw new HttpProblem(error.status, error.code);
    throw error;
  }
}

function record(input: unknown, allowed: readonly string[]) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some((key) => !allowed.includes(key))) throw new HttpProblem(400, 'INVALID_REQUEST');
  return input as Record<string, unknown>;
}

function invalidDatabaseText(value: string) {
  // PostgreSQL cannot persist NUL; unpaired UTF-16 would lose native round-trip fidelity.
  return value.includes('\u0000') || /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(value);
}

function title(input: unknown) {
  if (typeof input !== 'string' || !input.trim() || input.length > 200 || invalidDatabaseText(input)) throw new HttpProblem(400, 'INVALID_REQUEST');
  return input.trim();
}

function changeNote(input: unknown) {
  if (input === undefined) return null;
  if (typeof input !== 'string' || input.length > 2000 || invalidDatabaseText(input)) throw new HttpProblem(400, 'INVALID_REQUEST');
  return input;
}

function revisionSummary(revision: RevisionMetadata) {
  return {
    id: revision.id, documentId: revision.documentId, revisionNumber: revision.revisionNumber,
    title: revision.title, authorId: revision.authorId, createdAt: revision.createdAt.toISOString(), changeNote: revision.changeNote,
  };
}

export type Documents = ReturnType<typeof createDocuments>;

function revisionDto(revision: DocumentRevision) {
  return { ...revisionSummary(revision), content: content({
    format: revision.contentFormat, schemaVersion: revision.contentSchemaVersion,
    editorVersion: revision.contentEditorVersion, document: revision.body,
  }).content, plainText: revision.plainText };
}

function documentSummary(document: Document & { head: Pick<DocumentRevision, 'title'>; space: { slug: string } }) {
  return {
    id: document.id, slug: document.slug, spaceId: document.spaceId, spaceSlug: document.space.slug,
    currentRevisionNumber: document.currentRevisionNumber,
    lockVersion: document.lockVersion, title: document.head.title, createdAt: document.createdAt.toISOString(),
    createdBy: document.createdBy, updatedAt: document.updatedAt.toISOString(),
    archivedAt: document.archivedAt?.toISOString() ?? null, archivedBy: document.archivedBy,
  };
}

function documentDto(document: Head) {
  const { title: _title, ...metadata } = documentSummary(document);
  return { ...metadata, revision: revisionDto(document.head) };
}

export function documentEtag(document: { id: string; lockVersion: number }) {
  return `"doc-${document.id}-bn1-v${document.lockVersion}"`;
}

function precondition(document: Document, expectedEtag: string | undefined) {
  if (expectedEtag === undefined) throw new HttpProblem(428, 'PRECONDITION_REQUIRED');
  if (!/^"[^"\x00-\x20\x7f]*"$/.test(expectedEtag)) throw new HttpProblem(400, 'INVALID_PRECONDITION');
  if (expectedEtag !== documentEtag(document)) throw new HttpProblem(412, 'DOCUMENT_VERSION_CONFLICT');
}

function pageLimit(input: number | undefined) {
  const limit = input ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new HttpProblem(400, 'INVALID_REQUEST');
  return limit;
}

export function createDocuments(prisma: PrismaClient, identity: Identity, spaces: Spaces, attachments: Attachments) {
  async function liveOperation<T>(headers: Headers, id: string, mode: 'read' | 'enroll' | 'write',
    operation: (tx: Prisma.TransactionClient, document: Head, actor: Actor,
      recipients: { connectionId: string; canWrite: boolean }[], canWrite: boolean) => Promise<T>, connections: readonly LiveConnection[] = []) {
    if (connections.length > 128 || new Set(connections.map(connection => connection.connectionId)).size !== connections.length) {
      throw new HttpProblem(400, 'INVALID_LIVE_AUDIENCE');
    }
    const principal = await identity.resolve(headers);
    const target = await prisma.document.findUnique({ where: { id }, select: { spaceId: true } });
    if (!target) throw new HttpProblem(404, 'NOT_FOUND');
    return prisma.$transaction(async tx => {
      await spaces.lockForRead(tx, principal, target.spaceId);
      if (mode === 'read') await tx.$queryRaw`SELECT "id" FROM "Document" WHERE "id" = ${id}::uuid FOR SHARE`;
      else await tx.$queryRaw`SELECT "id" FROM "Document" WHERE "id" = ${id}::uuid FOR UPDATE`;
      await identity.lockActors(tx, [principal, ...connections.map(connection => connection.principal)]);
      const { actor, canWrite } = await spaces.access(tx, principal, target.spaceId);
      if (mode === 'write' && !canWrite) throw new HttpProblem(404, 'NOT_FOUND');
      const document = await tx.document.findUniqueOrThrow({ where: { id }, include: { head: true, space: { select: { slug: true } } } });
      if (document.archivedAt) throw new HttpProblem(409, 'DOCUMENT_ARCHIVED');
      const recipients: { connectionId: string; canWrite: boolean }[] = [];
      try {
        const result = await operation(tx, document, actor, recipients, canWrite);
        // Rows stay locked, but their lifetime can expire while SQL waits.
        // Fill the receipt and recheck the sender only after the write finishes.
        for (const connection of connections) {
          try {
            const permission = await spaces.access(tx, connection.principal, target.spaceId);
            recipients.push({ connectionId: connection.connectionId, canWrite: permission.canWrite });
          } catch (error) {
            // A revoked/expired recipient is omitted, not a reason to accept an
            // unchecked audience or to fail another authorized editor's update.
            if (!(error instanceof HttpProblem && [401, 403, 404].includes(error.status))) throw error;
          }
        }
        await identity.actor(principal, tx);
        return result;
      } catch (error) {
        if (error instanceof LiveContentError) throw new HttpProblem(error.status, error.code);
        throw error;
      }
    }, { timeout: 15_000, maxWait: 10_000 });
  }

  async function currentRoom(tx: Prisma.TransactionClient, document: Document) {
    if (!document.liveEpoch) throw new HttpProblem(409, 'LIVE_DOCUMENT_NOT_ENROLLED');
    const room = await tx.documentLive.findUniqueOrThrow({ where: {
      documentId_epoch: { documentId: document.id, epoch: document.liveEpoch },
    } });
    if (room.schemaVersion !== LIVE_SCHEMA_VERSION) throw new HttpProblem(409, 'LIVE_SCHEMA_UNSUPPORTED');
    return room;
  }
  function livePrecondition(room: DocumentLive, input: { epoch?: unknown; sequence?: unknown }, checkSequence: boolean) {
    if (input.epoch === undefined || checkSequence && input.sequence === undefined) throw new HttpProblem(428, 'PRECONDITION_REQUIRED');
    if (typeof input.epoch !== 'string' || !uuid.test(input.epoch)
      || checkSequence && (typeof input.sequence !== 'string' || !/^(?:0|[1-9][0-9]{0,18})$/.test(input.sequence))) {
      throw new HttpProblem(400, 'INVALID_PRECONDITION');
    }
    if (input.epoch !== room.epoch || checkSequence && input.sequence !== room.sequence.toString()) {
      throw new HttpProblem(412, 'LIVE_VERSION_CONFLICT');
    }
  }
  function roomSnapshot(document: Document, room: DocumentLive, canWrite: boolean) {
    return { documentId: document.id, epoch: room.epoch, sequence: room.sequence.toString(),
      schemaVersion: LIVE_SCHEMA_VERSION, canWrite, documentEtag: documentEtag(document), state: new Uint8Array(room.state) };
  }
  async function newRoom(tx: Prisma.TransactionClient, document: Head, lockVersion = document.lockVersion + 1) {
    const native = revisionDto(document.head).content;
    await attachments.validateReferences(tx, document.id, native.document);
    const state = createLiveState(document.head.title, native);
    const room = await tx.documentLive.create({ data: { documentId: document.id, epoch: randomUUID(), state: new Uint8Array(state) } });
    const updated = await tx.document.update({ where: { id: document.id }, data: {
      liveEpoch: room.epoch, lockVersion,
    } });
    return roomSnapshot(updated, room, true);
  }

  const live = {
    users(headers: Headers, id: string, userIds: readonly string[]) {
      if (userIds.length > 128 || userIds.some(value => typeof value !== 'string' || !value.length || value.length > 128)) {
        throw new HttpProblem(400, 'INVALID_REQUEST');
      }
      return liveOperation(headers, id, 'read', async (tx, document) => {
        await currentRoom(tx, document);
        const members = new Set(await spaces.memberIds(tx, document.spaceId, userIds));
        return (await identity.publicNames(tx, userIds)).filter(user => members.has(user.id) || user.role === 'administrator')
          .map(({ id, name }) => ({ id, name }));
      });
    },
    enroll(headers: Headers, id: string, expectedEtag?: string) {
      return liveOperation(headers, id, 'enroll', async (tx, document, _actor, _recipients, canWrite) => {
        precondition(document, expectedEtag);
        // Readers may initialize a server-derived representation, never authored content.
        const room = document.liveEpoch ? roomSnapshot(document, await currentRoom(tx, document), canWrite) : await newRoom(tx, document);
        return { ...room, canWrite };
      });
    },
    read(headers: Headers, id: string) {
      return liveOperation(headers, id, 'read', async (tx, document, _actor, _recipients, canWrite) =>
        roomSnapshot(document, await currentRoom(tx, document), canWrite));
    },
    authorizeConnections(headers: Headers, id: string, epoch: unknown, connections: readonly LiveConnection[]) {
      return liveOperation(headers, id, 'read', async (tx, document, _actor, recipients) => {
        const room = await currentRoom(tx, document);
        livePrecondition(room, { epoch }, false);
        return { epoch: room.epoch, sequence: room.sequence.toString(), documentEtag: documentEtag(document), recipients };
      }, connections);
    },
    update(headers: Headers, id: string, epoch: unknown, update: Uint8Array, connections: readonly LiveConnection[] = []) {
      return liveOperation(headers, id, 'write', async (tx, document, _actor, recipients) => {
        const room = await currentRoom(tx, document);
        livePrecondition(room, { epoch }, false);
        const prepared = prepareLiveUpdate(room.state, update);
        await attachments.validateReferences(tx, id, prepared.content.document);
        // Duplicate delivery is a no-op. A CRDT-only change still advances live
        // sequence, even when its native checkpoint content is unchanged.
        if (Buffer.from(prepared.state).equals(Buffer.from(room.state))) return { ...roomSnapshot(document, room, true), recipients };
        if (room.sequence === 9_223_372_036_854_775_807n) throw new HttpProblem(409, 'LIVE_SEQUENCE_EXHAUSTED');
        const saved = await tx.documentLive.update({ where: { documentId_epoch: { documentId: id, epoch: room.epoch } },
          data: { state: new Uint8Array(prepared.state), sequence: { increment: 1 } } });
        return { ...roomSnapshot(document, saved, true), recipients };
      }, connections);
    },
    comment(headers: Headers, id: string, epoch: unknown, input: unknown, connections: readonly LiveConnection[] = []) {
      return liveOperation(headers, id, 'write', async (tx, document, actor, recipients) => {
        const room = await currentRoom(tx, document);
        livePrecondition(room, { epoch }, false);
        const prepared = await prepareLiveComment(room.state, actor.id, input);
        await attachments.validateReferences(tx, id, prepared.content.document);
        // The command parser has already rejected accessors and unknown fields.
        // Live-only comment links need the same document ownership as body links.
        const commentBody: unknown = input && typeof input === 'object' ? Object.getOwnPropertyDescriptor(input, 'body')?.value : undefined;
        if (commentBody !== undefined) await attachments.validateReferences(tx, id, commentBody);
        if (room.sequence === 9_223_372_036_854_775_807n) throw new HttpProblem(409, 'LIVE_SEQUENCE_EXHAUSTED');
        const saved = await tx.documentLive.update({ where: { documentId_epoch: { documentId: id, epoch: room.epoch } },
          data: { state: new Uint8Array(prepared.state), sequence: { increment: 1 } } });
        return { ...roomSnapshot(document, saved, true), recipients, result: prepared.result };
      }, connections);
    },
    checkpoint(headers: Headers, id: string, input: unknown, expectedEtag?: string, connections: readonly LiveConnection[] = []) {
      const fields = record(input, ['epoch', 'sequence', 'changeNote']);
      const note = changeNote(fields.changeNote);
      return liveOperation(headers, id, 'write', async (tx, document, actor, recipients) => {
        precondition(document, expectedEtag);
        const room = await currentRoom(tx, document);
        livePrecondition(room, fields, true);
        const projected = readLiveState(room.state);
        const snapshot = { title: title(projected.title), content: content(projected.content), changeNote: note };
        const previous = content(revisionDto(document.head).content).content;
        const saved = snapshot.title === document.head.title && JSON.stringify(snapshot.content.content) === JSON.stringify(previous)
          ? document : await append(tx, document, actor, snapshot);
        return { document: documentDto(saved), recipients, epoch: room.epoch, sequence: room.sequence.toString() };
      }, connections);
    },
    restore(headers: Headers, id: string, input: unknown, expectedEtag?: string, connections: readonly LiveConnection[] = []) {
      const fields = record(input, ['epoch', 'sequence', 'revisionId', 'changeNote']);
      if (typeof fields.revisionId !== 'string' || !uuid.test(fields.revisionId)) throw new HttpProblem(400, 'INVALID_REQUEST');
      const revisionId = fields.revisionId, note = changeNote(fields.changeNote);
      return liveOperation(headers, id, 'write', async (tx, document, actor, recipients) => {
        precondition(document, expectedEtag);
        const room = await currentRoom(tx, document);
        livePrecondition(room, fields, true);
        const projected = readLiveState(room.state), previous = content(revisionDto(document.head).content).content;
        if (projected.title.trim() !== document.head.title || JSON.stringify(projected.content) !== JSON.stringify(previous)) {
          throw new HttpProblem(409, 'LIVE_CHECKPOINT_REQUIRED');
        }
        const revision = await tx.documentRevision.findFirst({ where: { id: revisionId, documentId: id } });
        if (!revision) throw new HttpProblem(404, 'NOT_FOUND');
        const restored = await append(tx, document, actor, {
          title: revision.title, content: content(revisionDto(revision).content), changeNote: note,
        });
        // Appending the restored checkpoint already advanced this operation's lock.
        const next = await newRoom(tx, restored, restored.lockVersion);
        const head = await tx.document.findUniqueOrThrow({ where: { id }, include: { head: true, space: { select: { slug: true } } } });
        return { document: documentDto(head), room: next, recipients };
      }, connections);
    },
  };
  async function authorizeDocument(headers: Headers, id: string) {
    const principal = await identity.resolve(headers);
    const target = await prisma.document.findUnique({ where: { id }, select: { spaceId: true } });
    if (!target) throw new HttpProblem(404, 'NOT_FOUND');
    await spaces.authorize(prisma, principal, target.spaceId);
  }

  async function readHead(headers: Headers, id: string) {
    await authorizeDocument(headers, id);
    return prisma.document.findUniqueOrThrow({ where: { id }, include: { head: true, space: { select: { slug: true } } } });
  }

  async function mutate(headers: Headers, id: string, expectedEtag: string | undefined,
    operation: (tx: Prisma.TransactionClient, document: Head, actor: Actor) => Promise<Head>) {
    const principal = await identity.resolve(headers);
    // Read only the immutable space pointer before locking, without disclosing document data.
    const target = await prisma.document.findUnique({ where: { id }, select: { spaceId: true } });
    if (!target) throw new HttpProblem(404, 'NOT_FOUND');
    return prisma.$transaction(async (tx) => {
      const actor = await spaces.lockForWrite(tx, principal, target.spaceId);
      await tx.$queryRaw`SELECT "id" FROM "Document" WHERE "id" = ${id}::uuid AND "spaceId" = ${target.spaceId}::uuid FOR UPDATE`;
      const document = await tx.document.findUniqueOrThrow({ where: { id }, include: { head: true, space: { select: { slug: true } } } });
      precondition(document, expectedEtag);
      return documentDto(await operation(tx, document, actor));
    });
  }

  async function append(tx: Prisma.TransactionClient, document: Head, actor: Actor,
    snapshot: { title: string; content: ReturnType<typeof content>; changeNote: string | null }) {
    const revisionNumber = document.currentRevisionNumber + 1;
    const revisionId = randomUUID();
    await tx.documentRevision.create({ data: {
      id: revisionId, documentId: document.id, revisionNumber, title: snapshot.title,
      contentFormat: snapshot.content.content.format, contentSchemaVersion: snapshot.content.content.schemaVersion,
      contentEditorVersion: snapshot.content.content.editorVersion,
      // JSON transport encodes native undefined table widths as null and omits
      // optional props. Persist that same representation, never library objects.
      body: JSON.parse(JSON.stringify(snapshot.content.content.document)) as Prisma.InputJsonValue,
      plainText: snapshot.content.plainText,
      authorId: actor.id, changeNote: snapshot.changeNote,
    } });
    await attachments.reference(tx, document.id, revisionId, snapshot.content.content.document);
    const updated = await tx.document.updateMany({
      where: { id: document.id, lockVersion: document.lockVersion },
      data: { currentRevisionNumber: revisionNumber, lockVersion: { increment: 1 } },
    });
    if (updated.count !== 1) throw new HttpProblem(412, 'DOCUMENT_VERSION_CONFLICT');
    return tx.document.findUniqueOrThrow({ where: { id: document.id }, include: { head: true, space: { select: { slug: true } } } });
  }

  async function lifecycle(headers: Headers, id: string, expectedEtag: string | undefined, archive: boolean) {
    return mutate(headers, id, expectedEtag, async (tx, document, actor) => {
      if (Boolean(document.archivedAt) === archive) return document;
      await tx.document.update({ where: { id: document.id }, data: {
        archivedAt: archive ? new Date() : null, archivedBy: archive ? actor.id : null,
        ...(archive ? { availabilityVersion: { increment: 1 } } : {}),
        lockVersion: { increment: 1 },
      } });
      return tx.document.findUniqueOrThrow({ where: { id: document.id }, include: { head: true, space: { select: { slug: true } } } });
    });
  }

  return {
    live,
    async publicationStatus(headers: Headers, id: string) {
      await authorizeDocument(headers, id);
      const document = await prisma.document.findUniqueOrThrow({ where: { id }, select: {
        id: true, lockVersion: true, archivedAt: true, availabilityVersion: true,
        publication: { select: { id: true, revisionNumber: true, publishedAt: true, active: true,
          approvedAvailabilityVersion: true, revision: { select: { id: true } } } },
      } });
      const grant = document.publication;
      return { id: document.id, lockVersion: document.lockVersion, publication: grant ? {
        publicId: grant.id, revisionId: grant.revision.id, revisionNumber: grant.revisionNumber,
        publishedAt: grant.publishedAt.toISOString(),
        active: grant.active && !document.archivedAt && grant.approvedAvailabilityVersion === document.availabilityVersion,
      } : null };
    },
    async mutatePublication<T>(headers: Headers, id: string, expectedEtag: string | undefined, revisionNumber: number | null,
      write: (context: PublicationMutationContext) => Promise<T>) {
      const principal = await identity.resolve(headers);
      if (revisionNumber !== null && (!Number.isInteger(revisionNumber) || revisionNumber < 1 || revisionNumber > 2_147_483_647)) {
        throw new HttpProblem(400, 'INVALID_REQUEST');
      }
      const target = await prisma.document.findUnique({ where: { id }, select: { spaceId: true } });
      if (!target) throw new HttpProblem(404, 'NOT_FOUND');
      return prisma.$transaction(async tx => {
        // Publication authority is stricter than editing; check it again after
        // the same space lock used by membership and document mutations.
        await tx.$queryRaw`SELECT "id" FROM "Space" WHERE "id" = ${target.spaceId}::uuid FOR UPDATE`;
        const actor = await spaces.authorize(tx, principal, target.spaceId);
        if (actor.role !== 'administrator') throw new HttpProblem(403, 'ACCESS_DENIED');
        await tx.$queryRaw`SELECT "id" FROM "Document" WHERE "id" = ${id}::uuid AND "spaceId" = ${target.spaceId}::uuid FOR UPDATE`;
        const document = await tx.document.findUniqueOrThrow({ where: { id } });
        precondition(document, expectedEtag);
        let revisionId: string | null = null;
        if (revisionNumber !== null) {
          if (document.archivedAt) throw new HttpProblem(409, 'DOCUMENT_ARCHIVED');
          const revision = await tx.documentRevision.findUnique({ where: {
            documentId_revisionNumber: { documentId: id, revisionNumber },
          } });
          if (!revision) throw new HttpProblem(404, 'NOT_FOUND');
          const snapshot = revisionDto(revision).content;
          const referencedIds = attachmentReferences(snapshot.document).sort();
          const storedIds = (await tx.revisionAttachment.findMany({ where: { revisionId: revision.id, documentId: id },
            select: { attachmentId: true } })).map(reference => reference.attachmentId).sort();
          if (JSON.stringify(referencedIds) !== JSON.stringify(storedIds)) throw new HttpProblem(400, 'INVALID_ATTACHMENT_REFERENCE');
          // Scoped public URLs are longer than private ones. Check the rendered
          // envelope before accepting a grant, using a same-length UUID here.
          content(publicContent(snapshot, revision.id));
          revisionId = revision.id;
        }
        const value = await write({ tx, documentId: id, revisionId, revisionNumber,
          availabilityVersion: document.availabilityVersion, publisherId: actor.id });
        const updated = await tx.document.updateMany({ where: { id, lockVersion: document.lockVersion },
          data: { lockVersion: { increment: 1 } } });
        if (updated.count !== 1) throw new HttpProblem(412, 'DOCUMENT_VERSION_CONFLICT');
        return { id, lockVersion: document.lockVersion + 1, value };
      });
    },
    async publicationSnapshot(publicId: string, enabled: boolean) {
      if (!enabled || !uuid.test(publicId)) throw new HttpProblem(404, 'NOT_FOUND');
      // This purpose-specific public projection deliberately never joins the
      // current private head or resolves private navigation and actor metadata.
      const rows = await prisma.$queryRaw<Array<{ title: string; body: Prisma.JsonValue; contentFormat: string;
        contentSchemaVersion: number; contentEditorVersion: string | null; publishedAt: Date; attachmentIds: string[] }>>`
        SELECT r."title", r."body", r."contentFormat", r."contentSchemaVersion", r."contentEditorVersion", p."publishedAt",
          ARRAY(SELECT ra."attachmentId" FROM "RevisionAttachment" ra
            WHERE ra."revisionId" = r."id" AND ra."documentId" = d."id" ORDER BY ra."attachmentId") AS "attachmentIds"
        FROM "Publication" p
        JOIN "Document" d ON d."id" = p."documentId"
        JOIN "DocumentRevision" r ON r."documentId" = p."documentId" AND r."revisionNumber" = p."revisionNumber"
        WHERE p."id" = ${publicId}::uuid AND p."active" = TRUE AND d."archivedAt" IS NULL
          AND p."approvedAvailabilityVersion" = d."availabilityVersion"
        LIMIT 1`;
      const selected = rows[0];
      if (!selected) throw new HttpProblem(404, 'NOT_FOUND');
      const native = content({ format: selected.contentFormat, schemaVersion: selected.contentSchemaVersion,
        editorVersion: selected.contentEditorVersion, document: selected.body }).content;
      if (JSON.stringify(attachmentReferences(native.document).sort()) !== JSON.stringify(selected.attachmentIds.sort())) {
        throw new HttpProblem(404, 'NOT_FOUND');
      }
      return { title: selected.title, content: content(publicContent(native, publicId)).content,
        publishedAt: selected.publishedAt.toISOString() };
    },
    async publicationAttachment(publicId: string, attachmentId: string, enabled: boolean) {
      if (!enabled || !uuid.test(publicId) || !uuid.test(attachmentId)) throw new HttpProblem(404, 'NOT_FOUND');
      const rows = await prisma.$queryRaw<Array<{ id: string; name: string; mimeType: string; size: number; documentId: string }>>`
        SELECT a."id", a."name", a."mimeType", a."size", a."documentId"
        FROM "Publication" p
        JOIN "Document" d ON d."id" = p."documentId"
        JOIN "DocumentRevision" r ON r."documentId" = p."documentId" AND r."revisionNumber" = p."revisionNumber"
        JOIN "RevisionAttachment" ra ON ra."revisionId" = r."id" AND ra."documentId" = d."id"
        JOIN "Attachment" a ON a."id" = ra."attachmentId" AND a."documentId" = d."id"
        WHERE p."id" = ${publicId}::uuid AND a."id" = ${attachmentId}::uuid
          AND p."active" = TRUE AND d."archivedAt" IS NULL
          AND p."approvedAvailabilityVersion" = d."availabilityVersion"
        LIMIT 1`;
      const approved = rows[0];
      if (!approved) throw new HttpProblem(404, 'NOT_FOUND');
      return attachments.publicationFile(approved);
    },
    async create(headers: Headers, spaceId: string, input: unknown) {
      const principal = await identity.resolve(headers);
      const fields = record(input, ['title', 'content', 'changeNote']);
      const snapshot = { title: title(fields.title), content: content(fields.content), changeNote: changeNote(fields.changeNote) };
      return prisma.$transaction(async (tx) => {
        const actor = await spaces.lockForWrite(tx, principal, spaceId);
        const base = slugify(snapshot.title, 'document');
        const occupied = await tx.document.findMany({ where: { spaceId, OR: [{ slug: base }, { slug: { startsWith: `${base}-` } }] }, select: { slug: true } });
        const slug = availableSlug(base, occupied.map(document => document.slug));
        const document = await tx.document.create({ data: {
          id: randomUUID(), slug, spaceId, currentRevisionNumber: 1, createdBy: actor.id,
        } });
        const revisionId = randomUUID();
        await tx.documentRevision.create({ data: {
          id: revisionId, documentId: document.id, revisionNumber: 1, title: snapshot.title,
          contentFormat: snapshot.content.content.format, contentSchemaVersion: snapshot.content.content.schemaVersion,
          contentEditorVersion: snapshot.content.content.editorVersion,
          body: JSON.parse(JSON.stringify(snapshot.content.content.document)) as Prisma.InputJsonValue,
          plainText: snapshot.content.plainText,
          authorId: actor.id, changeNote: snapshot.changeNote,
        } });
        await attachments.reference(tx, document.id, revisionId, snapshot.content.content.document);
        return documentDto(await tx.document.findUniqueOrThrow({ where: { id: document.id }, include: { head: true, space: { select: { slug: true } } } }));
      });
    },
    async list(headers: Headers, spaceId: string, input: { limit?: number; cursor?: string; includeArchived?: boolean } = {}) {
      await spaces.authorize(prisma, await identity.resolve(headers), spaceId);
      const limit = pageLimit(input.limit);
      if (input.includeArchived !== undefined && typeof input.includeArchived !== 'boolean') throw new HttpProblem(400, 'INVALID_REQUEST');
      const documents = await prisma.document.findMany({
        where: { spaceId, ...(input.includeArchived ? {} : { archivedAt: null }), ...(input.cursor ? { id: { gt: input.cursor } } : {}) },
        include: { head: { select: { title: true } }, space: { select: { slug: true } } }, orderBy: { id: 'asc' }, take: limit + 1,
      });
      const items = documents.slice(0, limit).map(documentSummary);
      return { items, nextCursor: documents.length > limit ? items.at(-1)!.id : null };
    },
    async read(headers: Headers, id: string) { return documentDto(await readHead(headers, id)); },
    async readBySlug(headers: Headers, spaceId: string, slug: string) {
      if (!validSlug(slug)) throw new HttpProblem(400, 'INVALID_REQUEST');
      await spaces.authorize(prisma, await identity.resolve(headers), spaceId);
      const target = await prisma.document.findUnique({ where: { spaceId_slug: { spaceId, slug } }, select: { id: true } });
      if (!target) throw new HttpProblem(404, 'NOT_FOUND');
      return documentDto(await readHead(headers, target.id));
    },
    async exportNative(headers: Headers, id: string) {
      const document = await readHead(headers, id);
      const revision = document.head;
      return {
        format: 'scrawl-document' as const, exportVersion: 1 as const,
        document: {
          id: document.id, spaceId: document.spaceId, createdAt: document.createdAt.toISOString(),
          createdBy: document.createdBy,
        },
        revision: {
          id: revision.id, revisionNumber: revision.revisionNumber, title: revision.title,
          createdAt: revision.createdAt.toISOString(), authorId: revision.authorId,
        },
        content: content(revisionDto(revision).content).content,
      };
    },
    async update(headers: Headers, id: string, input: unknown, expectedEtag?: string) {
      const fields = record(input, ['title', 'content', 'changeNote']);
      if (fields.title === undefined && fields.content === undefined) throw new HttpProblem(400, 'INVALID_REQUEST');
      const newTitle = fields.title === undefined ? undefined : title(fields.title);
      const newContent = fields.content === undefined ? undefined : content(fields.content);
      const note = changeNote(fields.changeNote);
      return mutate(headers, id, expectedEtag, async (tx, document, actor) => {
        if (document.archivedAt) throw new HttpProblem(409, 'DOCUMENT_ARCHIVED');
        if (document.liveEpoch) throw new HttpProblem(409, 'LIVE_DOCUMENT_REQUIRES_CHECKPOINT');
        const snapshot = { title: newTitle ?? document.head.title,
          content: newContent ?? content(revisionDto(document.head).content), changeNote: note };
        // Compare native canonical JSON, not PostgreSQL JSONB's object-key ordering.
        const oldContent = content(revisionDto(document.head).content).content;
        if (snapshot.title === document.head.title && JSON.stringify(snapshot.content.content) === JSON.stringify(oldContent)) return document;
        return append(tx, document, actor, snapshot);
      });
    },
    async listRevisions(headers: Headers, id: string, input: { limit?: number; cursor?: number } = {}) {
      await authorizeDocument(headers, id);
      const limit = pageLimit(input.limit);
      if (input.cursor !== undefined && (!Number.isInteger(input.cursor) || input.cursor < 1)) throw new HttpProblem(400, 'INVALID_REQUEST');
      const revisions = await prisma.documentRevision.findMany({
        where: { documentId: id, ...(input.cursor !== undefined ? { revisionNumber: { lt: input.cursor } } : {}) },
        select: { id: true, documentId: true, revisionNumber: true, title: true, authorId: true, createdAt: true, changeNote: true },
        orderBy: { revisionNumber: 'desc' }, take: limit + 1,
      });
      const items = revisions.slice(0, limit).map(revisionSummary);
      return { items, nextCursor: revisions.length > limit ? items.at(-1)!.revisionNumber : null };
    },
    async readRevision(headers: Headers, id: string, revisionId: string) {
      await authorizeDocument(headers, id);
      const revision = await prisma.documentRevision.findFirst({ where: { id: revisionId, documentId: id } });
      if (!revision) throw new HttpProblem(404, 'NOT_FOUND');
      return revisionDto(revision);
    },
    async restore(headers: Headers, id: string, input: unknown, expectedEtag?: string) {
      const fields = record(input, ['revisionId', 'changeNote']);
      if (typeof fields.revisionId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(fields.revisionId)) {
        throw new HttpProblem(400, 'INVALID_REQUEST');
      }
      const revisionId = fields.revisionId;
      const note = changeNote(fields.changeNote);
      return mutate(headers, id, expectedEtag, async (tx, document, actor) => {
        if (document.archivedAt) throw new HttpProblem(409, 'DOCUMENT_ARCHIVED');
        if (document.liveEpoch) throw new HttpProblem(409, 'LIVE_DOCUMENT_REQUIRES_CHECKPOINT');
        const revision = await tx.documentRevision.findFirst({ where: { id: revisionId, documentId: id } });
        if (!revision) throw new HttpProblem(404, 'NOT_FOUND');
        return append(tx, document, actor, {
          title: revision.title, content: content(revisionDto(revision).content), changeNote: note,
        });
      });
    },
    async archive(headers: Headers, id: string, expectedEtag?: string) { return lifecycle(headers, id, expectedEtag, true); },
    async unarchive(headers: Headers, id: string, expectedEtag?: string) { return lifecycle(headers, id, expectedEtag, false); },
  };
}
