// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import assert from 'node:assert/strict';
import test from 'node:test';
import * as Y from 'yjs';
import { DefaultThreadStoreAuth } from '@blocknote/core/comments';
import { YjsThreadStore } from '@blocknote/core/yjs';
import { demoContent, richDemoContent } from '../scripts/demo-content.js';
import { createLiveState, readLiveState, prepareLiveComment, prepareLiveUpdate, LiveContentError } from '../src/core/live/content.js';

const body = demoContent(['A private comment']).document;
const initial = createLiveState('Synthetic handbook', richDemoContent(['A private paragraph']));
function open(state: Uint8Array) {
  const doc = new Y.Doc({ gc: false });
  doc.getXmlFragment('document'); doc.getMap('metadata'); doc.getMap('threads'); Y.applyUpdate(doc, state);
  return doc;
}
function texts(doc: Y.Doc) {
  const nodes = [...doc.getXmlFragment('document').toArray()], result: Y.XmlText[] = [];
  while (nodes.length) {
    const node = nodes.shift()!;
    if (node instanceof Y.XmlText) result.push(node);
    else { assert(node instanceof Y.XmlElement); nodes.unshift(...node.toArray()); }
  }
  return result;
}
function thread(state: Uint8Array, id: string) {
  const doc = open(state);
  try { return new YjsThreadStore('observer', doc.getMap('threads'), new DefaultThreadStoreAuth('observer', 'editor')).getThread(id); }
  finally { doc.destroy(); }
}
function marks(doc: Y.Doc) {
  const result: Record<string, unknown>[] = [];
  for (const text of texts(doc)) {
    const delta: unknown[] = text.toDelta();
    for (const part of delta) {
      assert(part && typeof part === 'object');
      if (!('attributes' in part) || !part.attributes || typeof part.attributes !== 'object') continue;
      for (const [name, mark] of Object.entries(part.attributes)) {
        if (!/^comment(?:--[a-zA-Z0-9+/=]{8})?$/.test(name)) continue;
        assert(mark && typeof mark === 'object'); result.push(mark as Record<string, unknown>);
      }
    }
  }
  return result;
}
async function create(state = initial) {
  const result = await prepareLiveComment(state, 'author', { type: 'create', body });
  assert(result.result?.type === 'thread');
  return { state: result.state, threadId: result.result.id, commentId: result.result.comments[0]!.id };
}
async function denied(operation: Promise<unknown>, status: number, code?: string) {
  await assert.rejects(operation, (error: unknown) => {
    assert(error instanceof LiveContentError); assert.equal(error.status, status);
    if (code) assert.equal(error.code, code); return true;
  });
}
function selection(state: Uint8Array) {
  const doc = open(state);
  try {
    const nodes = texts(doc), first = nodes[0]!, last = nodes[1]!;
    // The official REST store serializes nested Y.ID instances into plain JSON.
    const anchor: unknown = JSON.parse(JSON.stringify(Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(first, 1))));
    const head: unknown = JSON.parse(JSON.stringify(Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(last, Math.min(4, last.length)))));
    return { anchor, head };
  } finally { doc.destroy(); }
}

test('official server comments derive provenance and preserve native title/body and input state', async () => {
  const pristine = initial.slice(), created = await create();
  const stored = thread(created.state, created.threadId), comment = stored.comments[0]!;
  assert.equal(comment.userId, 'author'); assert(comment.createdAt instanceof Date); assert.equal(comment.metadata, undefined);
  assert.deepEqual(comment.body, body); assert.deepEqual(readLiveState(created.state), readLiveState(initial));
  assert.deepEqual(initial, pristine);
});

test('comment requests reject forged fields, unsupported composer content, unsafe URLs and oversized bodies', async () => {
  for (const input of [
    { type: 'create', body, userId: 'forged' }, { type: 'create', body, metadata: { author: 'forged' } },
    { type: 'create', body: [{ id: 'heading', type: 'heading', content: 'Unsupported composer block' }] },
    { type: 'create', body: [{ id: 'color', type: 'paragraph', content: [{ type: 'text', text: 'Color', styles: { textColor: 'red' } }] }] },
    { type: 'create', body: [{ id: 'nested', type: 'paragraph', content: 'Parent', children: body }] },
    { type: 'create', body: [{ id: 'unsafe', type: 'paragraph', content: [{ type: 'link', href: 'javascript:alert(1)', content: [{ type: 'text', text: 'Bad', styles: {} }] }] }] },
    { type: 'create', body: demoContent(['   ']).document },
  ]) await denied(prepareLiveComment(initial, 'author', input), 400);
  await denied(prepareLiveComment(initial, 'author', { type: 'create', body: demoContent(['x'.repeat(17_000)]).document }), 413);
});

test('supplied author policies protect edits and reactions while editors may remove comments', async () => {
  const created = await create(), { threadId, commentId } = created;
  await denied(prepareLiveComment(created.state, 'peer', { type: 'edit', threadId, commentId, body }), 403);
  let result = await prepareLiveComment(created.state, 'peer', { type: 'reply', threadId, body });
  assert(result.result?.type === 'comment'); assert.equal(result.result.userId, 'peer');
  result = await prepareLiveComment(result.state, 'author', { type: 'edit', threadId, commentId, body: demoContent(['Revised private comment']).document });
  for (const emoji of ['👍🏽', '🇨🇦', '1️⃣', '👩‍💻']) {
    result = await prepareLiveComment(result.state, 'author', { type: 'add-reaction', threadId, commentId, emoji });
    await denied(prepareLiveComment(result.state, 'peer', { type: 'delete-reaction', threadId, commentId, emoji }), 403);
    result = await prepareLiveComment(result.state, 'author', { type: 'delete-reaction', threadId, commentId, emoji });
  }
  assert.equal(thread(result.state, threadId).comments[0]!.reactions.length, 0);
  result = await prepareLiveComment(result.state, 'peer', { type: 'delete-comment', threadId, commentId });
  assert.equal(thread(result.state, threadId).comments.length, 1);
  assert.deepEqual(readLiveState(result.state), readLiveState(initial));
});

test('relative anchors span native blocks, survive concurrent insertions and retain existing CRDT identities', async () => {
  const created = await create(), selected = selection(created.state), client = open(created.state);
  let originalIds: unknown[];
  let updated: Uint8Array;
  try {
    const before = Y.encodeStateVector(client); originalIds = texts(client).map(text => text._item!.id);
    texts(client)[0]!.insert(0, 'Concurrent peer ');
    updated = prepareLiveUpdate(created.state, Y.encodeStateAsUpdate(client, before)).state;
  } finally { client.destroy(); }
  const anchored = await prepareLiveComment(updated, 'author', { type: 'anchor', threadId: created.threadId, selection: selected });
  assert.deepEqual(readLiveState(anchored.state), readLiveState(updated));
  const doc = open(anchored.state);
  try {
    assert.deepEqual(texts(doc).map(text => text._item!.id), originalIds);
    assert(marks(doc).some(mark => mark.threadId === created.threadId));
  } finally { doc.destroy(); }
  await denied(prepareLiveComment(anchored.state, 'author', { type: 'anchor', threadId: created.threadId, selection: selected }), 409, 'COMMENT_ALREADY_ANCHORED');
  await denied(prepareLiveComment(updated, 'peer', { type: 'anchor', threadId: created.threadId, selection: selected }), 403);
});

test('unknown, foreign and deleted selection identities fail without falling back to absolute offsets', async () => {
  const created = await create(), selected = selection(created.state);
  const foreign = selection(createLiveState('Other document', richDemoContent(['Other private body'])));
  await denied(prepareLiveComment(created.state, 'author', { type: 'anchor', threadId: created.threadId, selection: foreign }), 409);
  const doc = open(created.state);
  let deleted: Uint8Array;
  try { const vector = Y.encodeStateVector(doc); texts(doc)[0]!.delete(0, 3); deleted = prepareLiveUpdate(created.state, Y.encodeStateAsUpdate(doc, vector)).state; }
  finally { doc.destroy(); }
  await denied(prepareLiveComment(deleted, 'author', { type: 'anchor', threadId: created.threadId, selection: selected }), 409);
  await denied(prepareLiveComment(created.state, 'author', { type: 'anchor', threadId: created.threadId,
    selection: { anchor: { tname: 'metadata' }, head: selected.head } }), 400);
});

test('resolve/unresolve uses native orphan marks and deleting the last comment removes dangling anchors', async () => {
  const created = await create();
  let result = await prepareLiveComment(created.state, 'author', { type: 'anchor', threadId: created.threadId, selection: selection(created.state) });
  result = await prepareLiveComment(result.state, 'peer', { type: 'resolve', threadId: created.threadId });
  assert.equal(thread(result.state, created.threadId).resolvedBy, 'peer');
  const doc = open(result.state);
  try { assert(marks(doc).some(mark => mark.orphan === true)); }
  finally { doc.destroy(); }
  result = await prepareLiveComment(result.state, 'author', { type: 'unresolve', threadId: created.threadId });
  assert.equal(thread(result.state, created.threadId).resolved, false);
  result = await prepareLiveComment(result.state, 'peer', { type: 'delete-comment', threadId: created.threadId, commentId: created.commentId, softDelete: true });
  const deleted = open(result.state);
  try {
    const rawThread = deleted.getMap('threads').get(created.threadId);
    assert(rawThread instanceof Y.Map); assert.equal(typeof rawThread.get('deletedAt'), 'number');
    assert.equal(marks(deleted).length, 0);
  } finally { deleted.destroy(); }
  await denied(prepareLiveComment(result.state, 'author', { type: 'reply', threadId: created.threadId, body }), 404);
  assert.deepEqual(readLiveState(result.state), readLiveState(initial));
});

test('overlapping native comment anchors survive resolving and deleting a different thread', async () => {
  const first = await create(), selected = selection(first.state);
  const anchored = await prepareLiveComment(first.state, 'author', { type: 'anchor', threadId: first.threadId, selection: selected });
  const second = await create(anchored.state);
  let result = await prepareLiveComment(second.state, 'author', { type: 'anchor', threadId: second.threadId, selection: selected });
  const overlap = open(result.state);
  try { assert.deepEqual(new Set(marks(overlap).map(mark => mark.threadId)), new Set([first.threadId, second.threadId])); }
  finally { overlap.destroy(); }
  result = await prepareLiveComment(result.state, 'peer', { type: 'resolve', threadId: first.threadId });
  result = await prepareLiveComment(result.state, 'peer', { type: 'delete-thread', threadId: first.threadId });
  const retained = open(result.state);
  try { assert.deepEqual(new Set(marks(retained).map(mark => mark.threadId)), new Set([second.threadId])); }
  finally { retained.destroy(); }
  assert.deepEqual(readLiveState(result.state), readLiveState(initial));
});

test('bounded official thread and reply counts fail before changing the supplied state', async () => {
  const doc = open(initial), store = new YjsThreadStore('author', doc.getMap('threads'), new DefaultThreadStoreAuth('author', 'editor'));
  try {
    const first = await store.createThread({ initialComment: { body } });
    for (let i = 1; i < 200; i++) await store.addComment({ threadId: first.id, comment: { body } });
    let state = Y.encodeStateAsUpdate(doc);
    await denied(prepareLiveComment(state, 'author', { type: 'reply', threadId: first.id, body }), 413, 'TOO_MANY_COMMENTS');
    for (let i = 1; i < 500; i++) await store.createThread({ initialComment: { body } });
    state = Y.encodeStateAsUpdate(doc); const pristine = state.slice();
    await denied(prepareLiveComment(state, 'author', { type: 'create', body }), 413, 'TOO_MANY_COMMENT_THREADS');
    assert.deepEqual(state, pristine);
  } finally { doc.destroy(); }
});
