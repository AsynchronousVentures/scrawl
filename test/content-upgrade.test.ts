// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import assert from 'node:assert/strict';
import test from 'node:test';
import { convertLegacyContent } from '../scripts/content-upgrade/convert.js';

test('finite legacy conversion preserves text, links, marks, lists, nested blocks and code language', () => {
  const input = { format: 'prosemirror-json', schemaVersion: 1, document: { type: 'doc', content: [
    { type: 'heading', attrs: { level: 6 }, content: [{ type: 'text', text: 'Legacy title', marks: [{ type: 'italic' }] }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Linked text', marks: [
      { type: 'bold' }, { type: 'italic' }, { type: 'link', attrs: { href: 'https://example.test/kept' } },
    ] }, { type: 'hardBreak', marks: [
      { type: 'bold' }, { type: 'italic' }, { type: 'link', attrs: { href: 'https://example.test/kept' } },
    ] }, { type: 'text', text: 'Second line' }] },
    { type: 'orderedList', attrs: { start: 7 }, content: [{ type: 'listItem', content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'List text' }] },
      { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Nested text' }] }] }] },
    ] }] },
    { type: 'codeBlock', attrs: { language: 'typescript' }, content: [{ type: 'text', text: 'const kept = true;\n' }] },
  ] } };
  const converted = convertLegacyContent(input, 'legacy-revision-id');
  assert.equal(converted.plainText, 'Legacy title\nLinked text\nSecond line\nList text\nNested text\nconst kept = true;\n');
  assert.deepEqual(convertLegacyContent(input, 'legacy-revision-id'), converted, 'Stable IDs make repeated dry runs deterministic');
  const [heading, paragraph, list, code] = converted.content.document;
  assert.equal(heading?.type, 'heading');
  if (heading?.type === 'heading') assert.equal(heading.props.level, 6);
  if (paragraph?.type !== 'paragraph') throw new Error('Expected paragraph');
  assert.deepEqual(paragraph.content[0], { type: 'link', href: 'https://example.test/kept',
    content: [{ type: 'text', text: 'Linked text\n', styles: { bold: true, italic: true } }] });
  assert.equal(list?.type, 'numberedListItem');
  if (list?.type === 'numberedListItem') assert.equal(list.props.start, 7);
  assert.equal(list?.children[0]?.type, 'bulletListItem');
  if (code?.type !== 'codeBlock') throw new Error('Expected code block');
  assert.equal(code.props.language, 'typescript');
  assert.deepEqual(input.document.content[0]?.attrs, { level: 6 }, 'Original payload is not mutated');
});

test('legacy conversion refuses unknown content rather than dropping it', () => {
  assert.throws(() => convertLegacyContent({ format: 'prosemirror-json', schemaVersion: 1,
    document: { type: 'doc', content: [{ type: 'unknown-real-content', text: 'Keep me' }] },
  }, 'revision'), /INVALID_CONTENT/);
});

test('legacy formatting that the native schema cannot represent is refused rather than stripped', () => {
  const input = { format: 'prosemirror-json', schemaVersion: 1, document: { type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'Preserve original marks', marks: [
      { type: 'code' }, { type: 'link', attrs: { href: 'https://example.test/kept' } },
    ] }] },
  ] } };
  assert.throws(() => convertLegacyContent(input, 'legacy-code-link'), /INVALID_CONTENT/);
});
