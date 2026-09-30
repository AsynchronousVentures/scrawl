// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import sharp from 'sharp';
import { createExporting, EXPORT_MEDIA_LIMIT } from '../src/capabilities/exporting/index.js';
import { HttpProblem } from '../src/http/problems.js';
import { validateContent } from '../src/core/documents/content.js';
import { richDemoContent } from '../scripts/demo-content.js';

const documentId = '11111111-1111-4111-8111-111111111111';
const revisionId = '22222222-2222-4222-8222-222222222222';
const attachmentId = '33333333-3333-4333-8333-333333333333';
const attachmentUrl = `/api/v1/attachments/${attachmentId}/content`;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgaGD4DwAChAGA+gVWHQAAAABJRU5ErkJggg==', 'base64');

function documentAccess(content: ReturnType<typeof richDemoContent>) {
  const revision = { id: revisionId, documentId, revisionNumber: 2, title: 'Synthetic rich export',
    authorId: 'synthetic-author-id', createdAt: '2026-01-01T00:00:00.000Z', changeNote: null,
    content, plainText: validateContent(content).plainText };
  return {
    async exportNative() {
      return { format: 'scrawl-document' as const, exportVersion: 1 as const,
        document: { id: documentId, spaceId: '44444444-4444-4444-8444-444444444444',
          createdAt: revision.createdAt, createdBy: revision.authorId },
        revision: { id: revision.id, revisionNumber: revision.revisionNumber, title: revision.title,
          authorId: revision.authorId, createdAt: revision.createdAt }, content };
    },
    async readRevision(_headers: Headers, id: string, selected: string) {
      if (id !== documentId || selected !== revisionId) throw new HttpProblem(404, 'NOT_FOUND');
      return revision;
    },
  };
}

test('official rich PDF/DOCX output embeds private images without external network access', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'scrawl-export-render-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const image = join(directory, 'synthetic.png');
  await writeFile(image, png);
  const content = validateContent({ ...richDemoContent(['Synthetic rich body']), document: [
    ...richDemoContent(['Synthetic rich body']).document,
    { id: 'private-image', type: 'image', props: { url: attachmentUrl, name: 'Synthetic image', caption: 'Private image caption' } },
    { id: 'private-file', type: 'file', props: { url: attachmentUrl, name: 'Private file link', caption: 'Private file caption' } },
    { id: 'private-inline', type: 'paragraph', content: [{ type: 'link', href: attachmentUrl,
      content: [{ type: 'text', text: 'Private inline link', styles: {} }] }] },
    { id: 'private-table', type: 'table', content: { type: 'tableContent', rows: [{ cells: [
      [{ type: 'link', href: attachmentUrl, content: [{ type: 'text', text: 'Private table link', styles: {} }] }],
    ] }] } },
    { id: 'custom-colors', type: 'paragraph', content: [{ type: 'text', text: 'Custom color retained',
      styles: { textColor: '#123456', backgroundColor: '#abcdef' } }] },
  ] }).content;
  const baseline = JSON.stringify(content);
  const exporting = createExporting(documentAccess(content), {
    async read() { return { path: image, mimeType: 'image/png', size: png.length, name: 'Synthetic image', documentId }; },
  }, { origin: 'http://127.0.0.1:3000' });
  const originalFetch = globalThis.fetch;
  let externalRequests = 0;
  t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (!String(input).startsWith('data:')) {
      externalRequests++;
      throw new Error('External network requests are forbidden');
    }
    return originalFetch(input, init);
  });

  const docx = await exporting.download(new Headers(), documentId, 'docx', revisionId);
  assert.equal(docx.mimeType, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(docx.bytes.subarray(0, 2).toString(), 'PK');
  const archive = await JSZip.loadAsync(docx.bytes);
  const xml = await archive.file('word/document.xml')!.async('text');
  for (const text of ['Synthetic rich export', 'Synthetic rich body', 'Rich blocks', 'Nested review notes', 'Check', 'Result',
    'Native blocks', 'Preserved', 'Private image caption', 'Private file caption', 'Custom color retained']) assert(xml.includes(text));
  for (const element of ['<w:tbl>', '<w:b/>', '<w:i/>', '<w:u ', '<w:strike/>', '<w:numPr>', '<w:drawing>', '<w14:checkbox>']) {
    assert(xml.includes(element), `DOCX retains ${element}`);
  }
  assert(xml.includes('w:val="123456"'));
  assert(xml.includes('w:fill="abcdef"'));
  const relations = await archive.file('word/_rels/document.xml.rels')!.async('text');
  assert(relations.includes(`http://127.0.0.1:3000${attachmentUrl}`));
  assert(!relations.includes(`Target="${attachmentUrl}"`), 'Every private attachment link uses the configured origin');
  assert(relations.includes('https://www.blocknotejs.org/docs'));
  const embedded = archive.file(/^word\/media\//);
  assert.equal(embedded.length, 1, 'One private image is embedded');
  assert.deepEqual(await embedded[0]!.async('nodebuffer'), png);
  assert.equal(archive.file(/^word\/fonts\//).length, 2, 'Official Inter/Geist fonts survive the Node adapter');
  const metadata = await archive.file('docProps/core.xml')!.async('text');
  assert(metadata.includes('Synthetic rich export'));
  assert(metadata.includes(revisionId));

  const pdf = await exporting.download(new Headers(), documentId, 'pdf');
  assert.equal(pdf.mimeType, 'application/pdf');
  assert.equal(pdf.bytes.subarray(0, 5).toString(), '%PDF-');
  const loading = getDocument({ data: new Uint8Array(pdf.bytes), useSystemFonts: false });
  const parsed = await loading.promise;
  try {
    assert(parsed.numPages > 0);
    const metadata = await parsed.getMetadata();
    assert('Title' in metadata.info);
    assert.equal(metadata.info.Title, 'Synthetic rich export');
    let text = '';
    let images = 0;
    const links: string[] = [];
    for (let number = 1; number <= parsed.numPages; number++) {
      const page = await parsed.getPage(number);
      const content = await page.getTextContent();
      text += content.items.map(item => 'str' in item ? item.str : '').join(' ') + ' ';
      const operations = await page.getOperatorList();
      images += operations.fnArray.filter(operation => operation === OPS.paintImageXObject
        || operation === OPS.paintInlineImageXObject).length;
      for (const annotation of await page.getAnnotations()) if (typeof annotation.url === 'string') links.push(annotation.url);
      assert(await page.getStructTree(), 'PDF contains a tagged structure tree');
    }
    for (const expected of ['Synthetic rich export', 'Synthetic rich body', 'Rich blocks', 'Nested review notes', 'Native blocks',
      'Private image caption', 'Private file caption', 'Custom color retained']) assert(text.includes(expected));
    assert(images > 0, 'Private image is a real PDF image object');
    assert(links.includes(`http://127.0.0.1:3000${attachmentUrl}`));
    assert.equal(links.filter(link => link === `http://127.0.0.1:3000${attachmentUrl}`).length, 3,
      'File, inline and table attachment links stay usable outside the application');
    assert(links.includes('https://www.blocknotejs.org/docs/foundations/document-structure'));
  } finally { await loading.destroy(); }
  assert.equal(externalRequests, 0);
  assert.equal(JSON.stringify(content), baseline, 'Rendering does not change immutable native content');
});

test('export refuses external media, mismatched attachment ownership and excess embedded bytes', async () => {
  const content = (url: string) => validateContent({ ...richDemoContent(['Synthetic safety fixture']), document: [
    { id: 'private-image', type: 'image', props: { url, name: 'Synthetic image' } },
  ] }).content;
  const source = { path: '/unused', mimeType: 'image/png', size: png.length, name: 'Synthetic image', documentId };
  const error = (status: number, code: string) => (value: unknown) => value instanceof HttpProblem
    && value.status === status && value.code === code;
  for (const format of ['docx', 'pdf'] as const) {
    const external = createExporting(documentAccess(content('https://example.test/private-image.png')), {
      async read() { assert.fail('External media must fail before any attachment lookup'); },
    }, { origin: 'http://127.0.0.1:3000' });
    await assert.rejects(external.download(new Headers(), documentId, format), error(422, 'EXPORT_EXTERNAL_MEDIA_UNSUPPORTED'));
    const foreign = createExporting(documentAccess(content(attachmentUrl)), {
      async read() { return { ...source, documentId: '55555555-5555-4555-8555-555555555555' }; },
    }, { origin: 'http://127.0.0.1:3000' });
    await assert.rejects(foreign.download(new Headers(), documentId, format), error(404, 'NOT_FOUND'));
    const foreignLinkContent = validateContent({ ...richDemoContent(['Synthetic foreign link']), document: [
      { id: 'foreign-inline', type: 'paragraph', content: [{ type: 'link', href: attachmentUrl,
        content: [{ type: 'text', text: 'Foreign attachment link', styles: {} }] }] },
    ] }).content;
    const foreignLink = createExporting(documentAccess(foreignLinkContent), {
      async read() { return { ...source, documentId: '55555555-5555-4555-8555-555555555555' }; },
    }, { origin: 'http://127.0.0.1:3000' });
    await assert.rejects(foreignLink.download(new Headers(), documentId, format), error(404, 'NOT_FOUND'));
    const oversized = createExporting(documentAccess(content(attachmentUrl)), {
      async read() { return { ...source, size: EXPORT_MEDIA_LIMIT + 1 }; },
    }, { origin: 'http://127.0.0.1:3000' });
    await assert.rejects(oversized.download(new Headers(), documentId, format), error(413, 'EXPORT_MEDIA_TOO_LARGE'));
    const unsupported = createExporting(documentAccess(content(attachmentUrl)), {
      async read() { return { ...source, mimeType: 'image/svg+xml' }; },
    }, { origin: 'http://127.0.0.1:3000' });
    await assert.rejects(unsupported.download(new Headers(), documentId, format), error(422, 'EXPORT_IMAGE_FORMAT_UNSUPPORTED'));
    const unsupportedColor = validateContent({ ...richDemoContent(['Synthetic color']), document: [
      { id: 'custom-color', type: 'paragraph', content: [{ type: 'text', text: 'Custom color', styles: { textColor: 'rgb(1, 2, 3)' } }] },
    ] }).content;
    const colors = createExporting(documentAccess(unsupportedColor), { async read() { return source; } }, { origin: 'http://127.0.0.1:3000' });
    await assert.rejects(colors.download(new Headers(), documentId, format), error(422, 'EXPORT_COLOR_UNSUPPORTED'));
  }
});

test('private WebP images use the existing decoder for PNG-compatible PDF/DOCX views', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'scrawl-export-webp-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const webp = await sharp(png).webp({ lossless: true }).toBuffer();
  const image = join(directory, 'synthetic.webp');
  await writeFile(image, webp);
  const content = validateContent({ ...richDemoContent(['Synthetic WebP fixture']), document: [
    { id: 'private-webp', type: 'image', props: { url: attachmentUrl, name: 'Synthetic WebP', caption: 'Private WebP caption' } },
  ] }).content;
  const exporting = createExporting(documentAccess(content), {
    async read() { return { path: image, mimeType: 'image/webp', size: webp.length, name: 'Synthetic WebP', documentId }; },
  }, { origin: 'http://127.0.0.1:3000' });
  const docx = await exporting.download(new Headers(), documentId, 'docx');
  const zip = await JSZip.loadAsync(docx.bytes);
  const embedded = await zip.file(/^word\/media\//)[0]!.async('nodebuffer');
  assert.deepEqual(embedded.subarray(0, 8), png.subarray(0, 8), 'DOCX embeds PNG bytes');
  assert.equal((await sharp(embedded).metadata()).format, 'png');
  const pdf = await exporting.download(new Headers(), documentId, 'pdf');
  assert.equal(pdf.bytes.subarray(0, 5).toString(), '%PDF-');
  const loading = getDocument({ data: new Uint8Array(pdf.bytes), useSystemFonts: false });
  const parsed = await loading.promise;
  try {
    const page = await parsed.getPage(1);
    assert((await page.getTextContent()).items.some(item => 'str' in item && item.str === 'Private WebP caption'));
    const operations = await page.getOperatorList();
    assert(operations.fnArray.includes(OPS.paintImageXObject));
  } finally { await loading.destroy(); }
});
