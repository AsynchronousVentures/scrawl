// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { COLORS_DEFAULT, type DefaultInlineContentSchema, type DefaultStyleSchema, type InlineContent } from '@blocknote/core';
import { DOCXExporter, docxDefaultSchemaMappings } from '@blocknote/xl-docx-exporter';
import { PDFExporter, loadDefaultBodyFonts, typstDefaultSchemaMappings } from '@blocknote/xl-pdf-exporter';
import sharp from 'sharp';
import type { createDocuments } from '../../core/documents/index.js';
import type { Attachments } from '../../core/attachments/index.js';
import { HttpProblem } from '../../http/problems.js';
import { contentSchema, validateContent, type NativeBlock, type NativeBlockSchema } from '../../shared/content.js';

type DocumentAccess = Pick<ReturnType<typeof createDocuments>, 'exportNative' | 'readRevision'>;
type AttachmentAccess = Pick<Attachments, 'read'>;

export type ExportFormat = 'pdf' | 'docx';
export const EXPORT_MEDIA_LIMIT = 20 * 1024 * 1024;
const attachmentPattern = /^\/api\/v1\/attachments\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/content$/i;
const require = createRequire(import.meta.url);
let wasm: Promise<Buffer> | undefined;

class ServerDOCXExporter extends DOCXExporter<NativeBlockSchema, DefaultStyleSchema, DefaultInlineContentSchema> {
  protected override async getFonts() {
    // 0.55's browser font adapter imports "buffer/", unsupported by Node ESM.
    // The official PDF loader supplies the same pinned Inter/Geist font bytes.
    const fonts = await loadDefaultBodyFonts();
    const inter = fonts[0];
    const mono = fonts[4];
    if (!inter || !mono) throw new Error('Bundled export fonts are unavailable');
    return [{ name: 'Inter', data: Buffer.from(inter) }, { name: 'GeistMono', data: Buffer.from(mono) }];
  }
}

/** Authorized immutable snapshots and document-owned bytes are the only inputs. */
export function createExporting(documents: DocumentAccess, attachments: AttachmentAccess, options: { origin: string }) {
  const origin = new URL(options.origin).origin;

  return {
    async download(headers: Headers, documentId: string, format: ExportFormat, revisionId?: string) {
      if (format !== 'pdf' && format !== 'docx') throw new HttpProblem(400, 'INVALID_REQUEST');
      const snapshot = revisionId === undefined
        ? await documents.exportNative(headers, documentId).then((value) => ({ ...value.revision, content: value.content }))
        : await documents.readRevision(headers, documentId, revisionId);
      const blocks = structuredClone(snapshot.content.document);
      const colors = { ...COLORS_DEFAULT };
      const images = new Map<string, Blob>();
      const checked = new Map<string, Awaited<ReturnType<AttachmentAccess['read']>>>();
      let mediaBytes = 0;

      async function attachment(url: string) {
        const id = attachmentPattern.exec(url)?.[1];
        if (!id) throw new HttpProblem(422, 'EXPORT_EXTERNAL_MEDIA_UNSUPPORTED');
        const cached = checked.get(id);
        if (cached) return cached;
        const value = await attachments.read(headers, id);
        // A readable attachment from another document is still not part of this snapshot.
        if (value.documentId !== documentId) throw new HttpProblem(404, 'NOT_FOUND');
        checked.set(id, value);
        return value;
      }

      function collectColors(value: unknown): void {
        if (typeof value !== 'object' || value === null) return;
        for (const [key, field] of Object.entries(value)) {
          if ((key === 'textColor' || key === 'backgroundColor') && typeof field === 'string') {
            if (field === 'default' || Object.hasOwn(colors, field)) continue;
            if (!/^#[0-9a-f]{6}$/i.test(field)) throw new HttpProblem(422, 'EXPORT_COLOR_UNSUPPORTED');
            colors[field] = { text: field, background: field };
          } else if (typeof field === 'object') collectColors(field);
        }
      }

      async function prepareInline(content: InlineContent<DefaultInlineContentSchema, DefaultStyleSchema>[]): Promise<void> {
        for (const item of content) {
          if (item.type !== 'link' || !attachmentPattern.test(item.href)) continue;
          await attachment(item.href);
          item.href = new URL(item.href, origin).href;
        }
      }

      async function prepare(list: NativeBlock[]): Promise<void> {
        for (const [index, block] of list.entries()) {
          if (Array.isArray(block.content)) await prepareInline(block.content);
          else if (block.content?.type === 'tableContent') {
            for (const row of block.content.rows) {
              for (const cell of row.cells) await prepareInline(Array.isArray(cell) ? cell : cell.content);
            }
          }
          if (block.type === 'image' || block.type === 'file' || block.type === 'audio' || block.type === 'video') {
            const url = block.props.url;
            if (url) {
              const source = await attachment(url);
              if (block.type === 'image') {
                if (!images.has(url)) {
                  if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(source.mimeType)) {
                    throw new HttpProblem(422, 'EXPORT_IMAGE_FORMAT_UNSUPPORTED');
                  }
                  if (mediaBytes + source.size > EXPORT_MEDIA_LIMIT) throw new HttpProblem(413, 'EXPORT_MEDIA_TOO_LARGE');
                  const bytes = await readFile(source.path);
                  if (bytes.length !== source.size) throw new HttpProblem(409, 'ATTACHMENT_UNAVAILABLE');
                  // Office and Typst have inconsistent WebP support. Reuse the
                  // attachment decoder for a lossless PNG view, leaving stored bytes intact.
                  const embedded = source.mimeType === 'image/webp'
                    ? await sharp(bytes, { limitInputPixels: 40_000_000, failOn: 'warning' }).png().toBuffer() : bytes;
                  mediaBytes += embedded.length;
                  if (mediaBytes > EXPORT_MEDIA_LIMIT) throw new HttpProblem(413, 'EXPORT_MEDIA_TOO_LARGE');
                  images.set(url, new Blob([embedded], { type: source.mimeType === 'image/webp' ? 'image/png' : source.mimeType }));
                }
              } else {
                // Office/PDF cannot play these blocks. Native mappings preserve their
                // names and captions as links that still require Scrawl authorization.
                const href = new URL(url, origin).href;
                if (block.type === 'file') list[index] = { ...block, props: { ...block.props, url: href } };
                if (block.type === 'audio') list[index] = { ...block, props: { ...block.props, url: href } };
                if (block.type === 'video') list[index] = { ...block, props: { ...block.props, url: href } };
              }
            }
          }
          await prepare(block.children);
        }
      }

      collectColors(blocks);
      await prepare(blocks);
      function containsId(list: NativeBlock[], id: string): boolean {
        return list.some(block => block.id === id || containsId(block.children, id));
      }
      let titleId = randomUUID();
      while (containsId(blocks, titleId)) titleId = randomUUID();
      // A rendered document includes its title on the page, independently of
      // file metadata. This heading belongs only to the export presentation.
      const title = validateContent({ ...snapshot.content, document: [{ id: titleId, type: 'heading', props: { level: 1 },
        content: [{ type: 'text', text: snapshot.title, styles: {} }] }] }).content.document[0]!;
      blocks.unshift(title);
      const resolveFileUrl = async (url: string): Promise<Blob> => {
        const image = images.get(url);
        if (!image) throw new HttpProblem(422, 'EXPORT_MEDIA_UNAVAILABLE');
        return image;
      };
      let bytes: Buffer;
      if (format === 'docx') {
        const exporter = new ServerDOCXExporter(contentSchema, docxDefaultSchemaMappings, { resolveFileUrl, colors });
        const blob = await exporter.toBlob(blocks, {
          sectionOptions: {},
          documentOptions: { title: snapshot.title,
            subject: `Scrawl document ${documentId}, revision ${snapshot.revisionNumber} (${snapshot.id})` },
        });
        bytes = Buffer.from(await blob.arrayBuffer());
      } else {
        wasm ??= readFile(require.resolve('@blocknote/xl-typst-compiler/wasm'));
        const exporter = new PDFExporter(contentSchema, typstDefaultSchemaMappings, { resolveFileUrl, colors, wasm: await wasm });
        // Scrawl does not yet collect document language, so no PDF/UA claim is made.
        const result = await exporter.toPDF(blocks, { title: snapshot.title, tryDeclarePdfUA: false });
        if (result.error) throw new HttpProblem(422, 'EXPORT_RENDER_FAILED');
        bytes = Buffer.from(result.bytes);
      }
      // Compilation can take time. Do not return private bytes after an intervening
      // session expiry or access revocation, even if the initial snapshot was readable.
      await documents.readRevision(headers, documentId, snapshot.id);
      return {
        bytes,
        mimeType: format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        filename: `scrawl-document-${documentId}-revision-${snapshot.revisionNumber}.${format}`,
      };
    },
  };
}

export type Exporting = ReturnType<typeof createExporting>;
