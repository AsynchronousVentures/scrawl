// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import { DefaultThreadStoreAuth } from '@blocknote/core/comments';
import { YjsThreadStore } from '@blocknote/core/yjs';
import type { Schema } from 'prosemirror-model';
import { Transform } from 'prosemirror-transform';
import { initProseMirrorDoc, relativePositionToAbsolutePosition, updateYFragment } from 'y-prosemirror';
import * as Y from 'yjs';
import { CONTENT_FORMAT, CONTENT_SCHEMA_VERSION, CONTENT_EDITOR_VERSION, validateContent } from '../documents/content.js';

export const COMMENT_LIMITS = { maxBodyBytes: 16 * 1024, maxParagraphs: 100, maxThreads: 500, maxCommentsPerThread: 200 } as const;
export class CommentError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409 | 413, readonly code: string) { super(code); }
}
function invalid(): never { throw new CommentError(400, 'INVALID_COMMENT_REQUEST'); }
function record(input: unknown, allowed: readonly string[]) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) return invalid();
  for (const key of Reflect.ownKeys(input)) {
    const field = Object.getOwnPropertyDescriptor(input, key);
    if (typeof key !== 'string' || !allowed.includes(key) || !field?.enumerable || !('value' in field)) return invalid();
  }
  return input as Record<string, unknown>;
}
function identifier(input: unknown) {
  if (typeof input !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input)) return invalid();
  return input;
}
function body(input: unknown) {
  const validated = validateContent({ format: CONTENT_FORMAT, schemaVersion: CONTENT_SCHEMA_VERSION,
    editorVersion: CONTENT_EDITOR_VERSION, document: input });
  if (Buffer.byteLength(JSON.stringify(validated.content.document)) > COMMENT_LIMITS.maxBodyBytes
    || validated.content.document.length > COMMENT_LIMITS.maxParagraphs) throw new CommentError(413, 'COMMENT_BODY_TOO_LARGE');
  if (!validated.plainText.trim()) return invalid();
  for (const block of validated.content.document) {
    if (block.type !== 'paragraph' || block.children.length) return invalid();
    for (const inline of block.content) {
      const runs = inline.type === 'link' ? inline.content : [inline];
      if (runs.some(run => 'textColor' in run.styles || 'backgroundColor' in run.styles)) return invalid();
    }
  }
  return validated.content.document;
}
function relative(input: unknown) {
  const fields = record(input, ['type', 'tname', 'item', 'assoc']);
  function id(value: unknown) {
    if (value === undefined || value === null) return null;
    const fields = record(value, ['client', 'clock']);
    if (!Number.isSafeInteger(fields.client) || !Number.isSafeInteger(fields.clock)
      || (fields.client as number) < 0 || (fields.clock as number) < 0) return invalid();
    return Y.createID(fields.client as number, fields.clock as number);
  }
  const type = id(fields.type), item = id(fields.item);
  const tname = fields.tname === undefined || fields.tname === null ? null : fields.tname;
  if (tname !== null && tname !== 'document' || !type && !tname
    || fields.assoc !== undefined && fields.assoc !== -1 && fields.assoc !== 0 && fields.assoc !== 1) return invalid();
  return new Y.RelativePosition(type, tname, item, fields.assoc as number | undefined);
}
function requireAllowed(allowed: boolean) { if (!allowed) throw new CommentError(403, 'COMMENT_ACTION_DENIED'); }

/** Server-only native store operations. The caller supplies an authorized actor and a private clone. */
export async function applyComment(document: Y.Doc, schema: Schema, actorId: string, input: unknown) {
  const type = record(input, ['type', 'body', 'threadId', 'commentId', 'softDelete', 'emoji', 'selection']).type;
  const allowed = {
    create: ['type', 'body'], reply: ['type', 'threadId', 'body'], edit: ['type', 'threadId', 'commentId', 'body'],
    'delete-comment': ['type', 'threadId', 'commentId', 'softDelete'], 'delete-thread': ['type', 'threadId'],
    resolve: ['type', 'threadId'], unresolve: ['type', 'threadId'],
    'add-reaction': ['type', 'threadId', 'commentId', 'emoji'], 'delete-reaction': ['type', 'threadId', 'commentId', 'emoji'],
    anchor: ['type', 'threadId', 'selection'],
  } as const;
  if (typeof type !== 'string' || !Object.hasOwn(allowed, type)) return invalid();
  const fields = record(input, allowed[type as keyof typeof allowed]);
  const threads = document.getMap<unknown>('threads'), auth = new DefaultThreadStoreAuth(actorId, 'editor');
  const store = new YjsThreadStore(actorId, threads, auth);
  if (type === 'create') {
    if (threads.size >= COMMENT_LIMITS.maxThreads) throw new CommentError(413, 'TOO_MANY_COMMENT_THREADS');
    return store.createThread({ initialComment: { body: body(fields.body) } });
  }
  const threadId = identifier(fields.threadId);
  const rawThread = threads.get(threadId);
  if (!(rawThread instanceof Y.Map) || rawThread.get('deletedAt')) throw new CommentError(404, 'COMMENT_NOT_FOUND');
  const thread = store.getThread(threadId);
  const fragment = document.getXmlFragment('document');
  function changeAnchors(remove = false) {
    const { doc, meta } = initProseMirrorDoc(fragment, schema), transform = new Transform(doc);
    doc.descendants((node, position) => {
      if (!node.isText) return;
      for (const mark of node.marks) if (mark.type.name === 'comment' && mark.attrs.threadId === threadId) {
        transform.removeMark(position, position + node.nodeSize, mark);
        if (!remove) transform.addMark(position, position + node.nodeSize,
          schema.marks.comment!.create({ threadId, orphan: store.getThread(threadId).resolved }));
      }
    });
    document.transact(() => updateYFragment(document, fragment, transform.doc, meta));
  }
  if (type === 'reply') {
    if (thread.comments.length >= COMMENT_LIMITS.maxCommentsPerThread) throw new CommentError(413, 'TOO_MANY_COMMENTS');
    return store.addComment({ threadId, comment: { body: body(fields.body) } });
  }
  if (type === 'delete-thread') { requireAllowed(auth.canDeleteThread(thread)); await store.deleteThread({ threadId }); changeAnchors(true); return null; }
  if (type === 'resolve' || type === 'unresolve') {
    requireAllowed(type === 'resolve' ? auth.canResolveThread(thread) : auth.canUnresolveThread(thread));
    await (type === 'resolve' ? store.resolveThread({ threadId }) : store.unresolveThread({ threadId }));
    changeAnchors(); return null;
  }
  if (type === 'anchor') {
    requireAllowed(thread.comments[0]?.userId === actorId);
    const selection = record(fields.selection, ['anchor', 'head']);
    const { doc, meta } = initProseMirrorDoc(fragment, schema);
    const positions = [relative(selection.anchor), relative(selection.head)].map(position => {
      // Deleted endpoint identities must not silently anchor a different passage.
      if (position.item && (Y.getState(document.store, position.item.client) <= position.item.clock
        || Y.getItem(document.store, position.item).deleted)) throw new CommentError(409, 'COMMENT_SELECTION_STALE');
      return relativePositionToAbsolutePosition(document, fragment, position, meta.mapping);
    });
    if (positions.some(position => position === null)) throw new CommentError(409, 'COMMENT_SELECTION_STALE');
    const from = Math.min(...positions as number[]), to = Math.max(...positions as number[]);
    if (from < 0 || to > doc.content.size || from === to || !doc.textBetween(from, to)) throw new CommentError(409, 'COMMENT_SELECTION_STALE');
    let anchored = false;
    doc.descendants(node => { if (node.marks.some(mark => mark.type.name === 'comment' && mark.attrs.threadId === threadId)) anchored = true; });
    if (anchored) throw new CommentError(409, 'COMMENT_ALREADY_ANCHORED');
    const transform = new Transform(doc).addMark(from, to, schema.marks.comment!.create({ threadId, orphan: thread.resolved }));
    document.transact(() => updateYFragment(document, fragment, transform.doc, meta));
    return null;
  }
  const commentId = identifier(fields.commentId), comment = thread.comments.find(comment => comment.id === commentId && !comment.deletedAt);
  if (!comment) throw new CommentError(404, 'COMMENT_NOT_FOUND');
  if (type === 'edit') {
    requireAllowed(auth.canUpdateComment(comment));
    await store.updateComment({ threadId, commentId, comment: { body: body(fields.body) } }); return null;
  }
  if (type === 'delete-comment') {
    if (fields.softDelete !== undefined && typeof fields.softDelete !== 'boolean') return invalid();
    requireAllowed(auth.canDeleteComment(comment));
    await store.deleteComment({ threadId, commentId, softDelete: fields.softDelete === true });
    // The pinned decoder omits thread.deletedAt. Read the official stored field
    // rather than letting a deleted thread accept replies or retain live anchors.
    if (!threads.has(threadId) || rawThread.get('deletedAt')) changeAnchors(true);
    return null;
  }
  const emoji = fields.emoji;
  if (typeof emoji !== 'string' || emoji.length > 32 || !/[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u.test(emoji)
    || [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(emoji)].length !== 1) return invalid();
  requireAllowed(type === 'add-reaction' ? auth.canAddReaction(comment, emoji) : auth.canDeleteReaction(comment, emoji));
  await (type === 'add-reaction' ? store.addReaction({ threadId, commentId, emoji }) : store.deleteReaction({ threadId, commentId, emoji }));
  return null;
}
