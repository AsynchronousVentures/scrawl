// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileTypeFromBuffer } from 'file-type';
import sharp from 'sharp';
import type { PrismaClient, Prisma } from '../../generated/prisma/client.js';
import type { Identity } from '../identity/index.js';
import type { Spaces } from '../spaces/index.js';
import { HttpProblem } from '../../http/problems.js';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 100 * 1024 * 1024;
const allowedTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'audio/mpeg', 'audio/ogg', 'audio/flac', 'audio/wav', 'audio/x-wav', 'video/mp4', 'video/webm']);
const attachmentUrl = /^\/api\/v1\/attachments\/([0-9a-f-]{36})\/content$/i;

/** Only traverses content that has already passed the native parser. */
export function attachmentReferences(content: unknown): string[] {
  const ids = new Set<string>();
  function visit(value: unknown) {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if ((key === 'url' || key === 'href') && typeof child === 'string') {
        const match = attachmentUrl.exec(child); if (match) ids.add(match[1]!.toLowerCase());
      } else visit(child);
    }
  }
  visit(content); return [...ids];
}

async function mediaType(bytes: Buffer, name: string) {
  let detected: Awaited<ReturnType<typeof fileTypeFromBuffer>>;
  try { detected = await fileTypeFromBuffer(bytes); } catch { throw new HttpProblem(400, 'INVALID_ATTACHMENT'); }
  if (!detected && /\.(?:txt|md|csv|log)$/i.test(name)) {
    try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new HttpProblem(400, 'INVALID_ATTACHMENT'); }
    if (bytes.includes(0)) throw new HttpProblem(400, 'INVALID_ATTACHMENT');
    return 'text/plain';
  }
  if (!detected || !allowedTypes.has(detected.mime)) throw new HttpProblem(415, 'UNSUPPORTED_ATTACHMENT');
  if (detected.mime.startsWith('image/')) {
    try {
      // Decode, rather than trusting a header that could describe truncated bytes.
      // Animated frames count toward the same total pixel budget.
      await sharp(bytes, { limitInputPixels: 40_000_000, failOn: 'warning', animated: true }).stats();
    } catch { throw new HttpProblem(400, 'INVALID_ATTACHMENT'); }
  }
  return detected.mime;
}

export function createAttachments(prisma: PrismaClient, identity: Identity, spaces: Spaces, storageRoot: string) {
  const root = resolve(storageRoot);
  async function ownedReferences(tx: Prisma.TransactionClient, documentId: string, parsedContent: unknown) {
    const ids = attachmentReferences(parsedContent);
    if (ids.length && await tx.attachment.count({ where: { id: { in: ids }, documentId } }) !== ids.length) {
      throw new HttpProblem(400, 'INVALID_ATTACHMENT_REFERENCE');
    }
    return ids;
  }
  return {
    async validateReferences(tx: Prisma.TransactionClient, documentId: string, parsedContent: unknown) {
      await ownedReferences(tx, documentId, parsedContent);
    },
    /** Caller owns the transaction and records files before writes for rollback cleanup. */
    async copyReferences(tx: Prisma.TransactionClient, sourceId: string, targetId: string,
      parsedContent: unknown, actorId: string, written: string[]) {
      const ids = await ownedReferences(tx, sourceId, parsedContent);
      const files = await tx.attachment.findMany({ where: { documentId: sourceId, id: { in: ids } } });
      if (files.reduce((total, file) => total + file.size, 0) > MAX_DOCUMENT_BYTES) {
        throw new HttpProblem(413, 'ATTACHMENT_QUOTA_EXCEEDED');
      }
      const replacements = new Map<string, string>();
      for (const source of files) {
        if (source.size > MAX_UPLOAD_BYTES) throw new HttpProblem(413, 'ATTACHMENT_TOO_LARGE');
        const bytes = await readFile(join(root, source.id));
        if (bytes.length !== source.size || createHash('sha256').update(bytes).digest('hex') !== source.sha256) {
          throw new HttpProblem(500, 'ATTACHMENT_UNAVAILABLE');
        }
        const id = randomUUID();
        await mkdir(root, { recursive: true, mode: 0o700 });
        const file = await open(join(root, id), 'wx', 0o600);
        written.push(id);
        try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
        await tx.attachment.create({ data: { id, documentId: targetId, name: source.name,
          mimeType: source.mimeType, size: source.size, sha256: source.sha256, createdBy: actorId } });
        replacements.set(source.id, id);
      }
      function rewrite(value: unknown): unknown {
        if (Array.isArray(value)) return value.map(rewrite);
        if (!value || typeof value !== 'object') return value;
        return Object.fromEntries(Object.entries(value).map(([key, child]) => {
          const source = (key === 'url' || key === 'href') && typeof child === 'string'
            ? attachmentUrl.exec(child)?.[1]?.toLowerCase() : undefined;
          return [key, source ? `/api/v1/attachments/${replacements.get(source)!}/content` : rewrite(child)];
        }));
      }
      return rewrite(parsedContent);
    },
    async removeRolledBackCopies(ids: readonly string[]) {
      // Preserve bytes when commit acknowledgement or the confirming read is uncertain.
      for (const id of ids) {
        const persisted = await prisma.attachment.findUnique({ where: { id } }).catch(() => undefined);
        if (persisted === null) await unlink(join(root, id)).catch(() => {});
      }
    },
    async upload(headers: Headers, documentId: string, name: string, bytes: Buffer) {
      const principal = await identity.resolve(headers);
      if (!name || name.length > 200 || /[\u0000-\u001f\u007f/\\]/.test(name)) throw new HttpProblem(400, 'INVALID_ATTACHMENT');
      if (!bytes.length || bytes.length > MAX_UPLOAD_BYTES) throw new HttpProblem(413, 'ATTACHMENT_TOO_LARGE');
      const target = await prisma.document.findUnique({ where: { id: documentId }, select: { spaceId: true } });
      if (!target) throw new HttpProblem(404, 'NOT_FOUND');
      // Authorize before inspecting untrusted media, then recheck under the write locks.
      await spaces.authorize(prisma, principal, target.spaceId, true);
      const mimeType = await mediaType(bytes, name);
      const id = randomUUID(), path = join(root, id);
      let written = false;
      try {
        return await prisma.$transaction(async tx => {
          const actor = await spaces.lockForWrite(tx, principal, target.spaceId);
          await tx.$queryRaw`SELECT "id" FROM "Document" WHERE "id" = ${documentId}::uuid FOR UPDATE`;
          const document = await tx.document.findUniqueOrThrow({ where: { id: documentId } });
          if (document.archivedAt) throw new HttpProblem(409, 'DOCUMENT_ARCHIVED');
          const total = await tx.attachment.aggregate({ where: { documentId }, _sum: { size: true } });
          if ((total._sum.size ?? 0) + bytes.length > MAX_DOCUMENT_BYTES) throw new HttpProblem(413, 'ATTACHMENT_QUOTA_EXCEEDED');
          await mkdir(root, { recursive: true, mode: 0o700 });
          const file = await open(path, 'wx', 0o600);
          written = true;
          try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
          await tx.attachment.create({ data: { id, documentId, name, mimeType, size: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'), createdBy: actor.id } });
          return { id, name, mimeType, size: bytes.length, url: `/api/v1/attachments/${id}/content` };
        }, { timeout: 15_000 });
      } catch (error) {
        // A connection failure can make commit acknowledgement ambiguous. Keep
        // private bytes unless a new read confirms their metadata was rolled back.
        if (written) {
          const persisted = await prisma.attachment.findUnique({ where: { id } }).catch(() => undefined);
          if (persisted === null) await unlink(path).catch(() => {});
        }
        throw error;
      }
    },
    async read(headers: Headers, id: string) {
      const principal = await identity.resolve(headers);
      const attachment = await prisma.attachment.findUnique({ where: { id }, include: { document: { select: { spaceId: true } } } });
      if (!attachment) throw new HttpProblem(404, 'NOT_FOUND');
      await spaces.authorize(prisma, principal, attachment.document.spaceId);
      return { path: join(root, attachment.id), mimeType: attachment.mimeType, size: attachment.size,
        name: attachment.name, documentId: attachment.documentId };
    },
    /** The core publication gateway supplies metadata from its scoped grant query. */
    publicationFile(approved: { id: string; name: string; mimeType: string; size: number; documentId: string }) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(approved.id)) {
        throw new HttpProblem(404, 'NOT_FOUND');
      }
      return { ...approved, path: join(root, approved.id) };
    },
    async reference(tx: Prisma.TransactionClient, documentId: string, revisionId: string, parsedContent: unknown) {
      const ids = await ownedReferences(tx, documentId, parsedContent);
      if (!ids.length) return;
      await tx.revisionAttachment.createMany({ data: ids.map(attachmentId => ({ documentId, revisionId, attachmentId })) });
    },
  };
}
export type Attachments = ReturnType<typeof createAttachments>;
