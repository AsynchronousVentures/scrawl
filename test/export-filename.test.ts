// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import assert from 'node:assert/strict';
import test from 'node:test';
import { exportFilename } from '../src/shared/export-filename.js';
import { downloadFilename } from '../web/src/api/download.js';

test('snapshot filenames retain readable accented titles, revision numbers and the requested format', () => {
  assert.equal(exportFilename('Café operations / On-call guide', 12, 'pdf'), 'scrawl-cafe-operations-on-call-guide-revision-12.pdf');
  assert.equal(exportFilename('Release checklist', 3, 'json'), 'scrawl-release-checklist-revision-3.json');
  assert.equal(exportFilename('Older saved title', 1, 'docx'), 'scrawl-older-saved-title-revision-1.docx');
});

test('hostile titles cannot add paths, executable extensions, quoted headers or control bytes', () => {
  for (const title of ['../../secrets.exe', 'C:\\private\\report', 'Guide\r\nX-Injected: true', '"; filename="script.exe', '\0\t\n', 'CON', 'NUL', 'COM1']) {
    const filename = exportFilename(title, 2, 'docx');
    assert.match(filename, /^scrawl-[a-z0-9-]+-revision-2\.docx$/);
    assert(!/[\\/\r\n\0";:]/.test(filename));
  }
});

test('filename basenames remain bounded after normalization and truncation cannot leave a separator', () => {
  const filename = exportFilename('Résumé '.repeat(40), 2147483647, 'pdf');
  assert(Buffer.byteLength(filename) <= 117);
  assert.match(filename, /^scrawl-[a-z0-9](?:[a-z0-9-]*[a-z0-9])?-revision-2147483647\.pdf$/);
});

test('titles without an ASCII basename have a safe descriptive fallback without losing export provenance', () => {
  for (const title of ['日本語の手引き', '🚀', '...']) {
    assert.equal(exportFilename(title, 4, 'json'), 'scrawl-document-revision-4.json');
  }
});

test('download names use the response snapshot filename rather than local document state', () => {
  const response = new Response(null, { headers: { 'content-disposition': 'attachment; filename="scrawl-older-saved-title-revision-1.docx"' } });
  assert.equal(downloadFilename(response, 'docx'), 'scrawl-older-saved-title-revision-1.docx');
});

test('missing, unsafe, oversized or wrong-format response names fall back without blocking a valid export', () => {
  for (const value of ['', 'attachment; filename="../../private.pdf"', 'attachment; filename="script.exe"',
    'attachment; filename="quoted"name.pdf"', `attachment; filename="${'a'.repeat(122)}.pdf"`,
    'attachment; filename="scrawl-document-revision-1.docx"']) {
    const response = new Response(null, { headers: { 'content-disposition': value } });
    assert.equal(downloadFilename(response, 'pdf'), 'scrawl-document.pdf');
  }
});
