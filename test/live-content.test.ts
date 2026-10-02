// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import assert from 'node:assert/strict';
import test from 'node:test';
import * as Y from 'yjs';
import { YjsThreadStore } from '@blocknote/core/yjs';
import { DefaultThreadStoreAuth } from '@blocknote/core/comments';
import { demoContent, richDemoContent } from '../scripts/demo-content.js';
import { validateContent } from '../src/core/documents/content.js';
import { createLiveState, readLiveState, prepareLiveUpdate, LIVE_LIMITS, LiveContentError } from '../src/core/live/content.js';

function open(state: Uint8Array) {
  const document = new Y.Doc({ gc: false });
  document.getXmlFragment('document'); document.getMap('metadata'); document.getMap('threads');
  Y.applyUpdate(document, state);
  return document;
}
function change(state: Uint8Array, operation: (document: Y.Doc) => void) {
  const document = open(state);
  try {
    const vector = Y.encodeStateVector(document);
    operation(document);
    return Y.encodeStateAsUpdate(document, vector);
  } finally { document.destroy(); }
}
function bodyText(document: Y.Doc): Y.XmlText {
  const pending = [...document.getXmlFragment('document').toArray()];
  while (pending.length) {
    const node = pending.shift()!;
    if (node instanceof Y.XmlText) return node;
    assert(node instanceof Y.XmlElement);
    pending.unshift(...node.toArray());
  }
  throw new Error('Synthetic live body has no text');
}
function reject(operation: () => unknown, status = 400, code?: string) {
  assert.throws(operation, (error: unknown) => {
    assert(error instanceof LiveContentError); assert.equal(error.status, status);
    if (code) assert.equal(error.code, code);
    assert.equal(error.message, error.code); return true;
  });
}
const content = demoContent(['Synthetic body']);

test('native live enrollment and encoded-state reload preserve rich blocks without regenerating CRDT identities', () => {
  const rich = richDemoContent(['Synthetic rich body']), state = createLiveState('Handbook', rich);
  const projected = readLiveState(state);
  assert.equal(projected.title, 'Handbook');
  assert.deepEqual(projected.content, rich);
  assert.deepEqual(readLiveState(state), projected);
  const client = open(state);
  try {
    const noChange = prepareLiveUpdate(state, Y.encodeStateAsUpdate(client, Y.encodeStateVector(client)));
    assert.deepEqual(noChange.state, state);
    assert.deepEqual(noChange.content, rich);
  } finally { client.destroy(); }
});

test('standard media and advanced native table geometry survive live state and checkpoint projection', () => {
  const native = validateContent({ ...content, document: [
    ...richDemoContent(['Rich content']).document,
    ...['image', 'video', 'audio', 'file'].map(type => ({ id: `media-${type}`, type, props: {
      url: `https://example.test/synthetic.${type}`, name: 'Synthetic file', caption: 'Fixture caption',
    } })),
    { id: 'merged-table', type: 'table', content: { type: 'tableContent', columnWidths: [180, null], headerRows: 1, rows: [
      { cells: [{ type: 'tableCell', props: { colspan: 2, backgroundColor: 'yellow', textAlignment: 'center' },
        content: [{ type: 'text', text: 'Merged heading', styles: { bold: true } }] }] },
      { cells: [[{ type: 'text', text: 'Left', styles: {} }], [{ type: 'text', text: 'Right', styles: {} }]] },
    ] } },
  ] }).content;
  const state = createLiveState('Media and geometry', native);
  assert.deepEqual(readLiveState(state).content, native);
  const accepted = prepareLiveUpdate(state, change(state, doc => bodyText(doc).insert(0, 'Saved ')));
  assert.deepEqual(accepted.content.document.slice(1), native.document.slice(1));
});

test('concurrent native body and character-based title updates converge and survive encoded-state reload', () => {
  const state = createLiveState('Handbook', content), pristine = state.slice();
  const first = change(state, doc => {
    bodyText(doc).insert(bodyText(doc).length, ' first editor', { bold: {} });
    const title = doc.getMap('metadata').get('title'); assert(title instanceof Y.Text); title.insert(title.length, ' A');
  });
  const second = change(state, doc => {
    bodyText(doc).insert(bodyText(doc).length, ' second editor', { italic: {} });
    const title = doc.getMap('metadata').get('title'); assert(title instanceof Y.Text); title.insert(title.length, ' B');
  });
  const accepted = prepareLiveUpdate(state, first), merged = prepareLiveUpdate(accepted.state, second);
  assert.match(merged.plainText, /first editor/); assert.match(merged.plainText, /second editor/);
  assert.match(merged.title, / A/); assert.match(merged.title, / B/);
  assert.deepEqual(readLiveState(merged.state), { title: merged.title, content: merged.content, plainText: merged.plainText });
  assert.deepEqual(state, pristine);
  const repeated = prepareLiveUpdate(merged.state, second);
  assert.deepEqual(repeated.state, merged.state);
});

test('blank live titles are allowed while editing, but replacement, formatting and invalid database text fail', () => {
  const state = createLiveState('Handbook', content);
  const blank = prepareLiveUpdate(state, change(state, doc => {
    const title = doc.getMap('metadata').get('title'); assert(title instanceof Y.Text); title.delete(0, title.length);
  }));
  assert.equal(blank.title, '');
  reject(() => prepareLiveUpdate(state, change(state, doc => doc.getMap('metadata').set('title', new Y.Text('Replacement')))));
  reject(() => prepareLiveUpdate(state, change(state, doc => {
    const title = doc.getMap('metadata').get('title'); assert(title instanceof Y.Text); title.format(0, 1, { bold: true });
  })));
  reject(() => prepareLiveUpdate(state, change(state, doc => {
    const title = doc.getMap('metadata').get('title'); assert(title instanceof Y.Text); title.setAttribute('unknown', 'hidden');
  })));
  reject(() => createLiveState('x'.repeat(201), content));
  reject(() => createLiveState('NUL\0title', content));
  reject(() => createLiveState('Surrogate\ud800', content));
});

test('official private comment marks project to unchanged native content and client thread changes are refused', async () => {
  const doc = open(createLiveState('Handbook', content));
  try {
    const store = new YjsThreadStore('synthetic-author', doc.getMap('threads'), new DefaultThreadStoreAuth('synthetic-author', 'editor'));
    const thread = await store.createThread({ initialComment: { body: content.document } });
    bodyText(doc).format(0, 9, { comment: { threadId: thread.id, orphan: false } });
    const state = Y.encodeStateAsUpdate(doc), projected = readLiveState(state);
    assert.deepEqual(projected.content, content);
    assert(!JSON.stringify(projected).includes(thread.id));
    const bodyOnly = prepareLiveUpdate(state, change(state, client => bodyText(client).insert(bodyText(client).length, ' peer edit')));
    assert.match(bodyOnly.plainText, /peer edit/);
    reject(() => prepareLiveUpdate(state, change(state, client => {
      const value = client.getMap('threads').get(thread.id); assert(value instanceof Y.Map); value.set('resolved', true);
    })), 403, 'PROTECTED_COMMENT_MUTATION');
    reject(() => prepareLiveUpdate(state, change(state, client => client.getMap('threads').delete(thread.id))), 403, 'PROTECTED_COMMENT_MUTATION');
    assert.deepEqual(readLiveState(state), projected);
  } finally { doc.destroy(); }
});

test('deleted and shadowed comment writes cannot bypass visible-JSON equality', () => {
  const state = createLiveState('Handbook', content);
  for (const gc of [false, true]) {
    const hidden = change(state, doc => {
      doc.gc = gc;
      const threads = doc.getMap('threads'); threads.set('forged', new Y.Map([['userId', 'forged-author']])); threads.delete('forged');
      assert.deepEqual(threads.toJSON(), {});
    });
    reject(() => prepareLiveUpdate(state, hidden), 403, 'PROTECTED_COMMENT_MUTATION');
  }
  const shadow = change(state, doc => {
    doc.getMap('threads').set('same', 'first forged value'); doc.getMap('threads').set('same', 'second forged value'); doc.getMap('threads').delete('same');
  });
  reject(() => prepareLiveUpdate(state, shadow), 403, 'PROTECTED_COMMENT_MUTATION');
});

test('incomplete insert and delete dependencies are rejected before they can surface in a later trusted operation', () => {
  const state = createLiveState('Handbook', content), doc = open(state);
  try {
    const title = doc.getMap('metadata').get('title'); assert(title instanceof Y.Text);
    title.insert(title.length, ' dependency');
    const vector = Y.encodeStateVector(doc);
    title.insert(title.length, ' deferred');
    const missingInsert = Y.encodeStateAsUpdate(doc, vector);
    reject(() => prepareLiveUpdate(state, missingInsert), 400, 'INCOMPLETE_LIVE_UPDATE');
    const beforeDelete = Y.encodeStateVector(doc); title.delete(title.length - 8, 8);
    reject(() => prepareLiveUpdate(state, Y.encodeStateAsUpdate(doc, beforeDelete)), 400, 'INCOMPLETE_LIVE_UPDATE');
  } finally { doc.destroy(); }
});

test('unknown roots and hidden metadata keys are rejected instead of being silently dropped', () => {
  const state = createLiveState('Handbook', content);
  reject(() => prepareLiveUpdate(state, change(state, doc => doc.getMap('credentials').set('value', 'synthetic'))));
  reject(() => prepareLiveUpdate(state, change(state, doc => {
    const map = doc.getMap('metadata'); map.set('unknown', 'hidden'); map.delete('unknown');
  })));
});

test('unknown live nodes, attributes, marks, dangling comments and unsafe links fail before native projection', () => {
  const state = createLiveState('Handbook', content);
  const operations: ((doc: Y.Doc) => void)[] = [
    doc => doc.getXmlFragment('document').insert(0, [new Y.XmlElement('unsupported')]),
    // A malicious JavaScript client can insert hooks despite the TypeScript API.
    doc => doc.getXmlFragment('document').insert(0, [new Y.XmlHook('unsupported') as unknown as Y.XmlElement]),
    doc => { const group = doc.getXmlFragment('document').get(0); assert(group instanceof Y.XmlElement); group.setAttribute('unknown', 'ignored'); },
    doc => bodyText(doc).format(0, 3, { unsupported: {} }),
    doc => bodyText(doc).format(0, 3, { comment: { threadId: 'missing', orphan: false } }),
    doc => bodyText(doc).format(0, 3, { 'comment--invalid': { threadId: 'missing', orphan: false } }),
    doc => bodyText(doc).format(0, 3, { 'bold--AAAAAAAA': {} }),
    doc => bodyText(doc).format(0, 3, { link: { href: 'javascript:alert(1)' } }),
    doc => bodyText(doc).format(0, 3, { link: { href: 'https://example.test', target: '_self' } }),
  ];
  for (const operation of operations) reject(() => prepareLiveUpdate(state, change(state, operation)));
  assert.deepEqual(readLiveState(state).content, content);
});

test('malformed and oversized frames/state are rejected with sanitized errors and retained input', () => {
  const state = createLiveState('Handbook', content), pristine = state.slice();
  reject(() => readLiveState(new Uint8Array([255])));
  reject(() => prepareLiveUpdate(state, new Uint8Array([255])));
  reject(() => prepareLiveUpdate(state, new Uint8Array(LIVE_LIMITS.maxUpdateBytes + 1)), 413, 'LIVE_UPDATE_TOO_LARGE');
  reject(() => readLiveState(new Uint8Array(LIVE_LIMITS.maxStateBytes + 1)), 413, 'LIVE_STATE_TOO_LARGE');
  const oversized = change(state, doc => bodyText(doc).insert(bodyText(doc).length, 'x'.repeat(270_000)));
  reject(() => prepareLiveUpdate(state, oversized), 413);
  assert.deepEqual(state, pristine);
  assert.deepEqual(validateContent(readLiveState(state).content).content, content);
});
