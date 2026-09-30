// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CONTENT_LIMITS, ContentValidationError, contentSchema, validateContent,
  type ContentEnvelope, type ContentNode,
} from '../src/core/documents/content.js';

function envelope(content: unknown) {
  return { format: 'prosemirror-json', schemaVersion: 1, document: { type: 'doc', content } };
}

function paragraph(text: string) {
  return { type: 'paragraph' as const, content: [{ type: 'text' as const, text }] };
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

test('all supported nodes and marks survive the native headless round trip', () => {
  const input = envelope([
    { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Heading' }] },
    {
      type: 'paragraph', content: [
        { type: 'text', text: 'All marks', marks: [
          { type: 'bold' }, { type: 'italic' }, { type: 'code' },
          { type: 'link', attrs: { href: 'https://example.test/docs?view=1#intro' } },
        ] },
        { type: 'hardBreak', marks: [{ type: 'bold' }] },
        { type: 'text', text: 'Next line' },
      ],
    },
    { type: 'paragraph' },
    { type: 'bulletList', content: [
      { type: 'listItem', content: [paragraph('Bullet one')] },
      { type: 'listItem', content: [paragraph('Bullet two'), {
        type: 'orderedList', attrs: { start: 7 }, content: [
          { type: 'listItem', content: [paragraph('Nested item')] },
        ],
      }] },
    ] },
    { type: 'codeBlock', attrs: { language: 'typescript' }, content: [
      { type: 'text', text: 'const example = 1;\nexample;' },
    ] },
  ]);
  const result = validateContent(input);
  assert.deepEqual(result.content, input);
  assert.equal(result.plainText,
    'Heading\nAll marks\nNext line\n\nBullet one\nBullet two\nNested item\nconst example = 1;\nexample;');
  const native = contentSchema.nodeFromJSON(result.content.document);
  native.check();
  const serialized: unknown = JSON.parse(JSON.stringify(native.toJSON()));
  assert.deepEqual(serialized, result.content.document);
  assert.deepEqual(validateContent({ ...result.content, document: native.toJSON() }), result);
});

test('native-created content is accepted and default attributes are canonical', () => {
  const native = contentSchema.node('doc', null, [
    contentSchema.node('heading', { level: 6 }, [contentSchema.text('Native heading')]),
    contentSchema.node('paragraph', null, [contentSchema.text('Native marks', [
      contentSchema.mark('bold'), contentSchema.mark('italic'),
      contentSchema.mark('code'), contentSchema.mark('link', { href: 'mailto:user@example.test' }),
    ])]),
    contentSchema.node('codeBlock'),
  ]);
  native.check();
  const result = validateContent({ format: 'prosemirror-json', schemaVersion: 1, document: native.toJSON() });
  const serialized: unknown = JSON.parse(JSON.stringify(native.toJSON()));
  assert.deepEqual(result.content.document, serialized);
  assert.equal(result.plainText, 'Native heading\nNative marks\n');
  const defaults = validateContent(envelope([
    { type: 'heading', content: [{ type: 'text', text: 'Default' }] },
    { type: 'orderedList', content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }] },
    { type: 'codeBlock' },
  ]));
  assert.deepEqual(defaults.content.document.content, [
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Default' }] },
    { type: 'orderedList', attrs: { start: 1 }, content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }] },
    { type: 'codeBlock', attrs: { language: null } },
  ]);
});

test('canonical serialization sorts marks and coalesces equivalent adjacent text', () => {
  const input = envelope([{ type: 'paragraph', content: [
    { type: 'text', text: 'first ', marks: [{ type: 'italic' }, { type: 'bold' }] },
    { type: 'text', text: 'second', marks: [{ type: 'bold' }, { type: 'italic' }] },
  ] }]);
  const { content, plainText } = validateContent(input);
  assert.deepEqual(content.document.content, [{ type: 'paragraph', content: [
    { type: 'text', text: 'first second', marks: [{ type: 'bold' }, { type: 'italic' }] },
  ] }]);
  assert.equal(plainText, 'first second');
  assert.deepEqual(validateContent(content).content, content);
});

test('plain text preserves blank blocks, hard breaks, code, Unicode, and list content', () => {
  const result = validateContent(envelope([
    { type: 'paragraph' },
    { type: 'paragraph', content: [{ type: 'text', text: '😀 café' }, { type: 'hardBreak' }] },
    { type: 'paragraph' },
    { type: 'codeBlock', content: [{ type: 'text', text: 'line 1\n\nline 3\t' }] },
    { type: 'orderedList', attrs: { start: 123 }, content: [
      { type: 'listItem', content: [paragraph('List item'), paragraph('Extra paragraph')] },
    ] },
  ]));
  assert.equal(result.plainText, '\n😀 café\n\n\nline 1\n\nline 3\t\nList item\nExtra paragraph');
});

test('strict envelope, node, mark, and attribute validation rejects unsupported data', () => {
  const fixtures: unknown[] = [
    null, [], 'content', {},
    { ...envelope([paragraph('text')]), format: 'html' },
    { ...envelope([paragraph('text')]), schemaVersion: 2 },
    { ...envelope([paragraph('text')]), extra: 'secret' },
    { format: 'prosemirror-json', schemaVersion: 1, document: paragraph('text') },
    envelope([]),
    envelope([{ type: 'image', attrs: { src: 'https://example.test/image' } }]),
    envelope([{ ...paragraph('text'), extra: 'secret' }]),
    envelope([{ ...paragraph('text'), attrs: { class: 'secret' } }]),
    envelope([{ type: 'paragraph', content: [{ type: 'text', text: 'text', attrs: { color: 'secret' } }] }]),
    envelope([{ type: 'paragraph', content: [{ type: 'text', text: 'text', content: [] }] }]),
    envelope([{ type: 'paragraph', content: [{ type: 'text', text: '' }] }]),
    envelope([{ type: 'paragraph', content: [{ type: 'text', text: 'text', marks: null }] }]),
    envelope([{ type: 'paragraph', content: [{ type: 'text', text: 'text', marks: [{ type: 'underline' }] }] }]),
    envelope([{ type: 'paragraph', content: [{ type: 'text', text: 'text', marks: [{ type: 'bold', attrs: { class: 'secret' } }] }] }]),
    envelope([{ type: 'paragraph', content: [{ type: 'text', text: 'text', marks: [{ type: 'bold', extra: 'secret' }] }] }]),
    envelope([{ type: 'paragraph', content: [{ type: 'text', text: 'text', marks: [{ type: 'bold' }, { type: 'bold' }] }] }]),
    envelope([{ type: 'paragraph', content: [{ type: 'text', text: 'text', marks: [{ type: 'link', attrs: { href: 'https://example.test', title: 'secret' } }] }] }]),
    envelope([{ type: 'paragraph', marks: [] }]),
    envelope([{ type: 'hardBreak', text: 'secret' }]),
    envelope([{ type: 'codeBlock', attrs: { language: 'typescript', extra: 'secret' } }]),
  ];
  for (const fixture of fixtures) rejects(fixture);
});

test('native schema rejects malformed nesting and marks in code blocks', () => {
  for (const content of [
    [{ type: 'text', text: 'outside paragraph' }],
    [{ type: 'paragraph', content: [{ type: 'heading', content: [] }] }],
    [{ type: 'bulletList', content: [] }],
    [{ type: 'orderedList', content: [paragraph('not a list item')] }],
    [{ type: 'listItem', content: [paragraph('outside list')] }],
    [{ type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'codeBlock' }] }] }],
    [{ type: 'codeBlock', content: [{ type: 'hardBreak' }] }],
    [{ type: 'codeBlock', content: [{ type: 'text', text: 'marked', marks: [{ type: 'bold' }] }] }],
    [{ type: 'doc', content: [paragraph('nested document')] }],
  ]) rejects(envelope(content));
});

test('heading, ordered-list, and language attributes have bounded concrete values', () => {
  for (const level of [0, 7, 1.5, null, '1']) rejects(envelope([{ type: 'heading', attrs: { level } }]));
  for (let level = 1; level <= 6; level++) {
    assert.equal(validateContent(envelope([{ type: 'heading', attrs: { level } }])).content.document.content?.[0]?.type, 'heading');
  }
  for (const start of [0, -1, 1.5, 2_147_483_648, null, '1']) {
    rejects(envelope([{ type: 'orderedList', attrs: { start }, content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }] }]));
  }
  for (const language of ['', 'with spaces', '../path/to/language', 'x'.repeat(65), 1]) {
    rejects(envelope([{ type: 'codeBlock', attrs: { language } }]));
  }
  for (const language of [null, 'c++', 'objective-c', 'x'.repeat(64)]) {
    validateContent(envelope([{ type: 'codeBlock', attrs: { language } }]));
  }
});

test('links allow only bounded absolute HTTP, HTTPS, and mailto URLs', () => {
  function link(href: unknown) {
    return envelope([{ type: 'paragraph', content: [{
      type: 'text', text: 'Link', marks: [{ type: 'link', attrs: { href } }],
    }] }]);
  }
  for (const href of [
    'http://example.test/docs', 'https://example.test/é?q=%F0%9F%98%80',
    'mailto:reader@example.test?subject=Hello%20reader',
  ]) validateContent(link(href));
  for (const href of [
    '', null, 'javascript:alert(1)', 'data:text/html,test', 'file:///etc/passwd',
    '/relative', '//example.test', 'https:example.test', 'https://user:password@example.test',
    'https://user%40name@example.test', ' https://example.test', 'https://example.test/with space',
    'https://example.test/\nsecret', 'https://example.test/\u0085secret',
    'https://example.test/%0asecret', 'https://example.test/%00secret', 'https://example.test/%7Fsecret',
    'https://example.test/%C2%85secret', 'https://example.test/\\secret',
    'mailto:', 'mailto://user:password@example.test', 'mailto:reader@example.test?subject=%0Dsecret',
    'https://example.test/' + 'x'.repeat(2048), 'https://example.test/\ud800',
  ]) rejects(link(href));
});

test('UTF-8 serialized envelope size is enforced at the exact byte boundary', () => {
  const single = envelope([paragraph('x')]);
  const overhead = new TextEncoder().encode(JSON.stringify(single)).byteLength - 1;
  const maximum = envelope([paragraph('x'.repeat(CONTENT_LIMITS.maxBytes - overhead))]);
  assert.equal(new TextEncoder().encode(JSON.stringify(maximum)).byteLength, CONTENT_LIMITS.maxBytes);
  validateContent(maximum);
  rejects(envelope([paragraph('x'.repeat(CONTENT_LIMITS.maxBytes - overhead + 1))]), 413, 'CONTENT_TOO_LARGE');
  rejects(envelope([paragraph('😀'.repeat(CONTENT_LIMITS.maxBytes / 4))]), 413, 'CONTENT_TOO_LARGE');
  rejects(envelope([paragraph('x'.repeat(CONTENT_LIMITS.maxBytes + 1))]), 413, 'CONTENT_TOO_LARGE');
});

test('canonical defaults cannot expand content past the serialized size limit', () => {
  const input = envelope([{ type: 'heading', content: [{ type: 'text', text: 'x' }] }]);
  const overhead = new TextEncoder().encode(JSON.stringify(input)).byteLength - 1;
  const submitted = envelope([{ type: 'heading', content: [{
    type: 'text', text: 'x'.repeat(CONTENT_LIMITS.maxBytes - overhead),
  }] }]);
  assert.equal(new TextEncoder().encode(JSON.stringify(submitted)).byteLength, CONTENT_LIMITS.maxBytes);
  rejects(submitted, 413, 'CONTENT_TOO_LARGE');
});

test('aggregate scalar bytes are bounded before serializing direct core inputs', () => {
  const input = envelope(Array.from({ length: 1000 }, () => paragraph('x'.repeat(100_000))));
  // A top-level serializer would allocate about 100MB. Preflight stops after
  // the third text value, before constructing or serializing the whole tree.
  rejects(input, 413, 'CONTENT_TOO_LARGE');
});

test('depth counts the root and rejects the first node beyond the limit', () => {
  function nested(leaf: ContentNode): ContentEnvelope {
    let block = leaf;
    for (let index = 0; index < 15; index++) {
      block = { type: 'bulletList', content: [{
        type: 'listItem', content: [{ type: 'paragraph' }, block],
      }] };
    }
    return { format: 'prosemirror-json', schemaVersion: 1, document: { type: 'doc', content: [block] } };
  }
  validateContent(nested({ type: 'paragraph' }));
  rejects(nested(paragraph('text')), 413, 'CONTENT_TOO_DEEP');
});

test('node count includes root and text before native text coalescing', () => {
  validateContent(envelope(Array.from({ length: CONTENT_LIMITS.maxNodes - 1 }, () => ({ type: 'paragraph' }))));
  rejects(envelope(Array.from({ length: CONTENT_LIMITS.maxNodes }, () => ({ type: 'paragraph' }))), 413, 'CONTENT_TOO_MANY_NODES');
  // Adjacent native text nodes would merge into one, but submitted nodes still count.
  rejects(envelope([{ type: 'paragraph', content: Array.from({ length: CONTENT_LIMITS.maxNodes - 1 }, () => ({
    type: 'text', text: 'x',
  })) }]), 413, 'CONTENT_TOO_MANY_NODES');
});

test('cycles and non-JSON direct callers fail safely without submitted details', () => {
  const cyclic: { type: string; content: unknown[] } = { type: 'paragraph', content: [] };
  cyclic.content.push(cyclic);
  rejects(envelope([cyclic]));
  rejects(envelope([new Date()]));
  rejects(envelope([{ type: 'paragraph', content: [undefined] }]));
  rejects(envelope([{ type: 'paragraph', content: Array(1) }]));
  rejects(envelope([paragraph('NUL\u0000secret')]));
  rejects(envelope([paragraph('unpaired\ud800secret')]));
  rejects(envelope([paragraph('unpaired\udc00secret')]));
  const accessor = Object.defineProperty({}, 'format', { enumerable: true, get: () => { throw new Error('secret'); } });
  rejects(accessor);
  const customArray = Object.assign([paragraph('text')], { toJSON: () => { throw new Error('secret'); } });
  rejects(envelope(customArray));
  assert.throws(() => validateContent(envelope([{ type: 'private-secret-node' }])), (error: unknown) => {
    assert(error instanceof ContentValidationError);
    assert(!error.message.includes('private-secret'));
    return true;
  });
});
