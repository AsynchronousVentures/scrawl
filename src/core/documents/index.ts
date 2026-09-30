// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import { randomUUID } from 'node:crypto';
import type { Document, DocumentRevision, Prisma, PrismaClient } from '../../generated/prisma/client.js';
import type { Identity } from '../identity/index.js';
import type { Spaces } from '../spaces/index.js';
import type { Attachments } from '../attachments/index.js';
import { HttpProblem } from '../../http/problems.js';
import { ContentValidationError, validateContent } from './content.js';

type Head = Document & { head: DocumentRevision };
type RevisionMetadata = Pick<DocumentRevision, 'id' | 'documentId' | 'revisionNumber' | 'title' | 'authorId' | 'createdAt' | 'changeNote'>;
type Actor = Awaited<ReturnType<Identity['actor']>>;

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

function revisionDto(revision: DocumentRevision) {
  return { ...revisionSummary(revision), content: content({
    format: revision.contentFormat, schemaVersion: revision.contentSchemaVersion,
    editorVersion: revision.contentEditorVersion, document: revision.body,
  }).content, plainText: revision.plainText };
}

function documentSummary(document: Document & { head: Pick<DocumentRevision, 'title'> }) {
  return {
    id: document.id, spaceId: document.spaceId, currentRevisionNumber: document.currentRevisionNumber,
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
  async function authorizeDocument(headers: Headers, id: string) {
    const principal = await identity.resolve(headers);
    const target = await prisma.document.findUnique({ where: { id }, select: { spaceId: true } });
    if (!target) throw new HttpProblem(404, 'NOT_FOUND');
    await spaces.authorize(prisma, principal, target.spaceId);
  }

  async function readHead(headers: Headers, id: string) {
    await authorizeDocument(headers, id);
    return prisma.document.findUniqueOrThrow({ where: { id }, include: { head: true } });
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
      const document = await tx.document.findUniqueOrThrow({ where: { id }, include: { head: true } });
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
    return tx.document.findUniqueOrThrow({ where: { id: document.id }, include: { head: true } });
  }

  async function lifecycle(headers: Headers, id: string, expectedEtag: string | undefined, archive: boolean) {
    return mutate(headers, id, expectedEtag, async (tx, document, actor) => {
      if (Boolean(document.archivedAt) === archive) return document;
      await tx.document.update({ where: { id: document.id }, data: {
        archivedAt: archive ? new Date() : null, archivedBy: archive ? actor.id : null,
        lockVersion: { increment: 1 },
      } });
      return tx.document.findUniqueOrThrow({ where: { id: document.id }, include: { head: true } });
    });
  }

  return {
    async create(headers: Headers, spaceId: string, input: unknown) {
      const principal = await identity.resolve(headers);
      const fields = record(input, ['title', 'content', 'changeNote']);
      const snapshot = { title: title(fields.title), content: content(fields.content), changeNote: changeNote(fields.changeNote) };
      return prisma.$transaction(async (tx) => {
        const actor = await spaces.lockForWrite(tx, principal, spaceId);
        const document = await tx.document.create({ data: {
          id: randomUUID(), spaceId, currentRevisionNumber: 1, createdBy: actor.id,
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
        return documentDto(await tx.document.findUniqueOrThrow({ where: { id: document.id }, include: { head: true } }));
      });
    },
    async list(headers: Headers, spaceId: string, input: { limit?: number; cursor?: string; includeArchived?: boolean } = {}) {
      await spaces.authorize(prisma, await identity.resolve(headers), spaceId);
      const limit = pageLimit(input.limit);
      if (input.includeArchived !== undefined && typeof input.includeArchived !== 'boolean') throw new HttpProblem(400, 'INVALID_REQUEST');
      const documents = await prisma.document.findMany({
        where: { spaceId, ...(input.includeArchived ? {} : { archivedAt: null }), ...(input.cursor ? { id: { gt: input.cursor } } : {}) },
        include: { head: { select: { title: true } } }, orderBy: { id: 'asc' }, take: limit + 1,
      });
      const items = documents.slice(0, limit).map(documentSummary);
      return { items, nextCursor: documents.length > limit ? items.at(-1)!.id : null };
    },
    async read(headers: Headers, id: string) { return documentDto(await readHead(headers, id)); },
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
