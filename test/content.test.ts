// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultBlockSpecs } from '@blocknote/core';
import { ServerBlockNoteEditor } from '@blocknote/server-util';
import {
  CONTENT_LIMITS, CONTENT_FORMAT, CONTENT_SCHEMA_VERSION, CONTENT_EDITOR_VERSION,
  ContentValidationError, contentSchema, validateContent, isSafeLinkUrl, isSafeMediaUrl,
} from '../src/core/documents/content.js';
import { validateContent as validateBrowserContent } from '../src/shared/content.js';

function envelope(document: unknown) {
  return { format: CONTENT_FORMAT, schemaVersion: CONTENT_SCHEMA_VERSION, editorVersion: CONTENT_EDITOR_VERSION, document };
}
function paragraph(text: string, id = 'paragraph') {
  return { id, type: 'paragraph', content: [{ type: 'text', text, styles: {} }] };
}
function rejects(input: unknown, status: 400 | 413 = 400, code?: string): void {
  assert.throws(() => validateContent(input), (error: unknown) => {
    assert(error instanceof ContentValidationError);
    assert.equal(error.status, status);
    if (code) assert.equal(error.code, code);
    assert.equal(error.message, error.code);
    return true;
  });
}

function tableFixture() {
  return { id: 'table', type: 'table', content: {
    type: 'tableContent', columnWidths: [180, null], headerRows: 1,
    rows: [
      { cells: [{ type: 'tableCell', props: { colspan: 2, backgroundColor: 'yellow', textAlignment: 'center' },
        content: [{ type: 'text', text: 'Merged heading', styles: { bold: true } }] }] },
      { cells: [
        { type: 'tableCell', props: { textColor: 'blue' }, content: [{ type: 'text', text: 'Left', styles: {} }] },
        { type: 'tableCell', props: {}, content: [{ type: 'link', href: 'https://example.test/table',
          content: [{ type: 'text', text: 'Right', styles: { underline: true } }] }] },
      ] },
    ],
  } };
}

test('every standard native block and all seven native styles survive the headless server round trip', () => {
  const blocks: unknown[] = Object.keys(defaultBlockSpecs).map((type, index) => {
    if (type === 'table') return tableFixture();
    if (['audio', 'file', 'image', 'video'].includes(type)) return {
      id: type, type, props: { url: `https://example.test/synthetic.${type}`, caption: `Synthetic ${type}` },
    };
    if (type === 'divider') return { id: type, type };
    return { id: type, type, content: [{ type: 'text', text: `Synthetic ${index}`, styles: type === 'codeBlock' ? {} : {
      bold: true, italic: true, underline: true, strike: true, textColor: '#aabbcc', backgroundColor: 'rgb(12 34 56)',
    } }] };
  });
  blocks.push({ id: 'inline-code', type: 'paragraph', content: [{ type: 'text', text: 'Code', styles: { code: true } }] });
  const checked = validateContent(envelope(blocks));
  assert.equal(new Set(checked.content.document.map(block => block.type)).size, 14);
  assert.equal(checked.content.editorVersion, '0.55.0');
  const engine = ServerBlockNoteEditor.create({ schema: contentSchema });
  const native = engine._blocksToProsemirrorNode(checked.content.document);
  native.check();
  assert.deepEqual(validateContent({ ...checked.content, document: engine._prosemirrorNodeToBlocks(native) }), checked);
  assert.deepEqual(validateBrowserContent(checked.content), checked, 'Browser and server canonical snapshots agree');
  assert(checked.plainText.includes('Merged heading\nLeft\tRight'));
  assert(!checked.plainText.includes('https://example.test'));
});

test('native defaults normalize without losing IDs, nested blocks or table cell geometry', () => {
  const input = envelope([{ id: 'heading', type: 'heading', props: { level: 6, isToggleable: true }, children: [
    { id: 'numbered', type: 'numberedListItem', props: { start: 7 }, children: [paragraph('Nested', 'nested')] },
  ] }, tableFixture(), { id: 'code', type: 'codeBlock', props: { language: 'typescript' }, content: [{ type: 'text', text: 'const example = 1;\n', styles: {} }] }]);
  const checked = validateContent(input);
  const heading = checked.content.document[0];
  assert.equal(heading?.type, 'heading');
  if (heading?.type !== 'heading') throw new Error('Expected native heading');
  assert.equal(heading.props.level, 6);
  assert.equal(heading.props.isToggleable, true);
  assert.equal(heading.children[0]?.id, 'numbered');
  const table = checked.content.document[1];
  if (table?.type !== 'table') throw new Error('Expected native table');
  const cell = table.content.rows[0]?.cells[0];
  if (!cell || Array.isArray(cell)) throw new Error('Expected advanced native cell');
  assert.equal(cell.props.colspan, 2);
  assert.equal(cell.props.backgroundColor, 'yellow');
  assert.deepEqual(table.content.columnWidths, [180, undefined]);
  assert.deepEqual(validateContent(JSON.parse(JSON.stringify(checked.content))), checked);
});

test('canonical serialization orders styles and coalesces equivalent adjacent text and links', () => {
  const input = envelope([{ id: 'paragraph', type: 'paragraph', content: [
    { type: 'text', text: 'first ', styles: { italic: true, bold: true } },
    { type: 'text', text: 'second', styles: { bold: true, italic: true } },
    { type: 'link', href: 'https://example.test', content: [{ type: 'text', text: 'linked ', styles: {} }] },
    { type: 'link', href: 'https://example.test', content: [{ type: 'text', text: 'label', styles: {} }] },
  ] }]);
  const checked = validateContent(input);
  const block = checked.content.document[0];
  if (block?.type !== 'paragraph') throw new Error('Expected paragraph');
  assert.deepEqual(block.content, [
    { type: 'text', text: 'first second', styles: { bold: true, italic: true } },
    { type: 'link', href: 'https://example.test', content: [{ type: 'text', text: 'linked label', styles: {} }] },
  ]);
  assert.deepEqual(validateContent(checked.content), checked);
});

test('native merged table cells preserve vertical spans and reject invalid empty native rows', () => {
  const checked = validateContent(envelope([{ id: 'vertical-table', type: 'table', content: {
    type: 'tableContent', rows: [
      { cells: [{ type: 'tableCell', props: { rowspan: 2 }, content: [{ type: 'text', text: 'Vertical', styles: {} }] }, []] },
      { cells: [[{ type: 'text', text: 'Lower right', styles: {} }]] },
    ],
  } }]));
  const table = checked.content.document[0];
  if (table?.type !== 'table') throw new Error('Expected table');
  const cell = table.content.rows[0]?.cells[0];
  if (!cell || Array.isArray(cell)) throw new Error('Expected native cell');
  assert.equal(cell.props.rowspan, 2);
  assert.equal(table.content.rows[1]?.cells.length, 1);
  assert.deepEqual(validateContent(JSON.parse(JSON.stringify(checked.content))), checked);
  rejects(envelope([{ id: 'invalid-empty-row', type: 'table', content: { type: 'tableContent', rows: [
    { cells: [{ type: 'tableCell', props: { rowspan: 2 }, content: [] }] }, { cells: [] },
  ] } }]));
});

test('plain text retains blank blocks, newlines, Unicode, captions, lists and table labels', () => {
  const checked = validateContent(envelope([
    { id: 'empty', type: 'paragraph' }, paragraph('😀 café\n', 'unicode'),
    { id: 'list', type: 'checkListItem', props: { checked: true }, content: [{ type: 'text', text: 'List', styles: {} }], children: [paragraph('Child', 'child')] },
    { id: 'code', type: 'codeBlock', content: [{ type: 'text', text: 'line 1\n\nline 3\t', styles: {} }] },
    { id: 'image', type: 'image', props: { url: 'https://example.test/image.png', caption: 'Caption' } },
  ]));
  assert.equal(checked.plainText, '\n😀 café\n\nList\nChild\nline 1\n\nline 3\t\nCaption');
});

test('strict native envelope, blocks, properties and styles reject unsupported data', () => {
  for (const invalid of [
    null, [], 'content', {}, envelope([]), envelope({ type: 'doc' }),
    { ...envelope([paragraph('text')]), format: 'prosemirror-json' },
    { ...envelope([paragraph('text')]), schemaVersion: 2 },
    { ...envelope([paragraph('text')]), editorVersion: 'future' },
    { ...envelope([paragraph('text')]), extra: 'secret' },
    envelope([{ ...paragraph('text'), id: '' }]), envelope([paragraph('text'), paragraph('duplicate')]),
    envelope([{ ...paragraph('text'), type: 'unknown' }]), envelope([{ ...paragraph('text'), extra: 'secret' }]),
    envelope([{ ...paragraph('text'), props: { hidden: true } }]), envelope([{ ...paragraph('text'), children: null }]),
    envelope([{ ...paragraph('text'), content: null }]),
    envelope([{ id: 'p', type: 'paragraph', content: [{ type: 'text', text: 'text', styles: { fontSize: 90 } }] }]),
    envelope([{ id: 'p', type: 'paragraph', content: [{ type: 'text', text: 'text', styles: { bold: 'yes' } }] }]),
    envelope([{ id: 'p', type: 'paragraph', content: [{ type: 'text', text: 'text', styles: { textColor: 'url(https://example.test)' } }] }]),
  ]) rejects(invalid);
});

test('native property values and geometry are checked before permissive decoding', () => {
  for (const level of [0, 7, 1.5, null, '1']) rejects(envelope([{ id: 'heading', type: 'heading', props: { level } }]));
  for (let level = 1; level <= 6; level++) validateContent(envelope([{ id: 'heading', type: 'heading', props: { level } }]));
  for (const start of [0, -1, 1.5, 2_147_483_648, null, '1']) rejects(envelope([{ id: 'list', type: 'numberedListItem', props: { start } }]));
  for (const props of [{ checked: 'yes' }, { textAlignment: 'diagonal' }]) rejects(envelope([{ id: 'check', type: 'checkListItem', props }]));
  for (const widths of [[-1, null], [Number.NaN, null], [150]]) rejects(envelope([{ ...tableFixture(), content: { ...tableFixture().content, columnWidths: widths } }]));
  rejects(envelope([{ id: 'table', type: 'table', content: { type: 'tableContent', rows: [{ cells: [[]] }, { cells: [[], []] }] } }]));
  rejects(envelope([{ id: 'table', type: 'table', content: { type: 'tableContent', rows: [{ cells: [{ type: 'tableCell', props: { rowspan: 2 }, content: [] }] }] } }]));
  rejects(envelope([{ ...tableFixture(), content: { ...tableFixture().content, headerRows: 3 } }]));
});

test('the native plain code block and exclusive inline code marks are not silently rewritten', () => {
  rejects(envelope([{ id: 'code', type: 'codeBlock', content: [{ type: 'text', text: 'marked', styles: { bold: true } }] }]));
  rejects(envelope([{ id: 'p', type: 'paragraph', content: [{ type: 'link', href: 'https://example.test', content: [{ type: 'text', text: 'linked code', styles: { code: true } }] }] }]));
  rejects(envelope([{ id: 'p', type: 'paragraph', content: [{ type: 'text', text: 'mixed code', styles: { bold: true, code: true } }] }]));
});

test('links and linked media accept safe normal URLs and reject dangerous values without fetching', () => {
  function link(href: unknown) { return envelope([{ id: 'link', type: 'paragraph', content: [{ type: 'link', href, content: [{ type: 'text', text: 'Label', styles: {} }] }] }]); }
  for (const href of ['http://example.test/docs', 'https://example.test/é?q=%F0%9F%98%80', 'mailto:reader@example.test?subject=Hello%20reader']) {
    assert(isSafeLinkUrl(href)); validateContent(link(href));
  }
  for (const href of ['', null, 'javascript:alert(1)', 'data:text/html,test', 'file:///etc/passwd', '/relative', '//example.test',
    'https:example.test', 'https://user:password@example.test', ' https://example.test', 'https://example.test/with space',
    'https://example.test/%0asecret', 'https://example.test/%C2%85secret', 'https://example.test/\\secret', 'mailto:',
    'mailto://user:password@example.test', 'https://example.test/' + 'x'.repeat(2048), 'https://example.test/\ud800']) rejects(link(href));
  for (const url of ['', 'https://example.test/image.png']) {
    assert(isSafeMediaUrl(url)); validateContent(envelope([{ id: 'image', type: 'image', props: { url } }]));
  }
  for (const url of ['mailto:reader@example.test', 'javascript:alert(1)', 'data:image/png,fixture', 'blob:https://example.test/id']) {
    assert(!isSafeMediaUrl(url)); rejects(envelope([{ id: 'image', type: 'image', props: { url } }]));
  }
});

test('UTF-8 native snapshot size is enforced at the exact serialized boundary', () => {
  const canonical = validateContent(envelope([paragraph('x')])).content;
  const overhead = Buffer.byteLength(JSON.stringify(canonical)) - 1;
  const maximum = { ...canonical, document: [{ ...canonical.document[0]!, content: [{ type: 'text', text: 'x'.repeat(CONTENT_LIMITS.maxBytes - overhead), styles: {} }] }] };
  assert.equal(Buffer.byteLength(JSON.stringify(maximum)), CONTENT_LIMITS.maxBytes);
  validateContent(maximum);
  rejects({ ...maximum, document: [{ ...maximum.document[0]!, content: [{ type: 'text', text: 'x'.repeat(CONTENT_LIMITS.maxBytes - overhead + 1), styles: {} }] }] }, 413, 'CONTENT_TOO_LARGE');
  rejects(envelope([paragraph('😀'.repeat(CONTENT_LIMITS.maxBytes / 4))]), 413, 'CONTENT_TOO_LARGE');
});

test('native default expansion cannot exceed serialized size limits', () => {
  const input = envelope([paragraph('x')]);
  const overhead = Buffer.byteLength(JSON.stringify(input)) - 1;
  const maximum = envelope([paragraph('x'.repeat(CONTENT_LIMITS.maxBytes - overhead))]);
  assert.equal(Buffer.byteLength(JSON.stringify(maximum)), CONTENT_LIMITS.maxBytes);
  rejects(maximum, 413, 'CONTENT_TOO_LARGE');
});

test('aggregate scalar bytes are bounded before serializing a large direct core input', () => {
  rejects(envelope(Array.from({ length: 1000 }, (_, index) => paragraph('x'.repeat(100_000), `large-${index}`))), 413, 'CONTENT_TOO_LARGE');
});

test('native child depth and submitted node count are bounded before normalization', () => {
  function nested(depth: number): unknown {
    let block: unknown = paragraph('Leaf', 'leaf');
    for (let index = 1; index < depth; index++) block = { id: `nested-${index}`, type: 'bulletListItem', children: [block] };
    return envelope([block]);
  }
  validateContent(nested(CONTENT_LIMITS.maxDepth));
  rejects(nested(CONTENT_LIMITS.maxDepth + 1), 413, 'CONTENT_TOO_DEEP');
  rejects(envelope(Array.from({ length: CONTENT_LIMITS.maxNodes + 1 }, (_, index) => paragraph('', `node-${index}`))), 413, 'CONTENT_TOO_MANY_NODES');
  rejects(envelope([{ id: 'paragraph', type: 'paragraph', content: Array.from({ length: CONTENT_LIMITS.maxNodes }, () => ({ type: 'text', text: '', styles: {} })) }]), 413, 'CONTENT_TOO_MANY_NODES');
});

test('cycles, accessors, sparse arrays and invalid database text fail without submitted details', () => {
  const cyclic = { id: 'cyclic', type: 'paragraph', children: [] as unknown[] };
  cyclic.children.push(cyclic);
  rejects(envelope([cyclic])); rejects(envelope([new Date()])); rejects(envelope(Array(1)));
  for (const invalid of ['NUL\u0000secret', 'unpaired\ud800secret', 'unpaired\udc00secret']) rejects(envelope([paragraph(invalid)]));
  const accessor = Object.defineProperty({}, 'format', { enumerable: true, get: () => { throw new Error('secret'); } });
  rejects(accessor);
  const customArray = Object.assign([paragraph('text')], { toJSON: () => { throw new Error('secret'); } });
  rejects(envelope(customArray));
  rejects(envelope([{ id: 'p', type: 'paragraph', content: [{ type: 'link', href: 'https://example.test', content: [{ type: 'link', href: 'https://example.test', content: [] }] }] }]));
  assert.throws(() => validateContent(envelope([{ id: 'p', type: 'private-secret-block' }])), (error: unknown) => {
    assert(error instanceof ContentValidationError); assert(!error.message.includes('private-secret')); return true;
  });
});
