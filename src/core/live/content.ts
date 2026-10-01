// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import { createExtension, type DefaultInlineContentSchema, type DefaultStyleSchema } from '@blocknote/core';
import { CommentMark } from '@blocknote/core/comments';
import { ServerBlockNoteEditor } from '@blocknote/server-util';
import { yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror';
import type { Node } from 'prosemirror-model';
import * as Y from 'yjs';
import { applyComment, CommentError } from './comments.js';
import {
  CONTENT_FORMAT, CONTENT_SCHEMA_VERSION, CONTENT_EDITOR_VERSION, CONTENT_LIMITS,
  ContentValidationError, contentSchema, validateContent, type NativeBlockSchema,
} from '../documents/content.js';

export const LIVE_SCHEMA_VERSION = 1 as const;
export const LIVE_LIMITS = { maxUpdateBytes: 1024 * 1024, maxStateBytes: 8 * 1024 * 1024 } as const;

export class LiveContentError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409 | 413, readonly code: string) {
    super(code); this.name = 'LiveContentError';
  }
}

let engine: ServerBlockNoteEditor<NativeBlockSchema, DefaultInlineContentSchema, DefaultStyleSchema> | undefined;
function editor() {
  return engine ??= ServerBlockNoteEditor.create({ schema: contentSchema,
    extensions: [createExtension({ key: 'scrawl-live-comment-schema', tiptapExtensions: [CommentMark] })],
  });
}

function invalid(): never { throw new LiveContentError(400, 'INVALID_LIVE_CONTENT'); }
function failed(error: unknown): never {
  if (error instanceof LiveContentError) throw error;
  if (error instanceof ContentValidationError || error instanceof CommentError) throw new LiveContentError(error.status, error.code);
  return invalid();
}
function checked<T>(operation: () => T): T {
  try { return operation(); } catch (error) { return failed(error); }
}

function documentFrom(state: Uint8Array) {
  if (state.byteLength > LIVE_LIMITS.maxStateBytes) throw new LiveContentError(413, 'LIVE_STATE_TOO_LARGE');
  // Retain tombstones so hidden/deleted protected comment structures remain inspectable.
  const document = new Y.Doc({ gc: false });
  document.getXmlFragment('document'); document.getMap('metadata'); document.getMap('threads');
  try {
    Y.applyUpdate(document, state);
    if (document.store.pendingStructs || document.store.pendingDs) throw new LiveContentError(400, 'INCOMPLETE_LIVE_UPDATE');
    return document;
  } catch (error) { document.destroy(); throw error; }
}

function rootOf(document: Y.Doc, item: Y.Item) {
  let parent: Y.Item['parent'] = item.parent;
  let depth = 0;
  while (parent instanceof Y.AbstractType && parent._item) {
    if (++depth > 128) return invalid();
    parent = parent._item.parent;
  }
  for (const [name, root] of document.share) if (parent === root) return name;
  return invalid();
}

/** Compare CRDT structures, not visible JSON, which misses deleted or shadowed writes. */
function protectedThreads(document: Y.Doc) {
  const fingerprint: string[] = [];
  for (const [client, structs] of [...document.store.clients].sort(([a], [b]) => a - b)) {
    for (const item of structs) {
      if (!(item instanceof Y.Item) || rootOf(document, item) !== 'threads') continue;
      const encoder = new Y.UpdateEncoderV1();
      item.write(encoder, 0);
      fingerprint.push(`${client}:${item.id.clock}:${item.length}:${item.deleted}:${Buffer.from(encoder.toUint8Array()).toString('base64')}`);
    }
  }
  return fingerprint.join('\n');
}

function attributes(value: unknown, allowed: readonly string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !allowed.includes(key))) return invalid();
  return value as Record<string, unknown>;
}

function project(document: Y.Doc) {
  if ([...document.share.keys()].some(name => !['document', 'metadata', 'threads'].includes(name))) return invalid();
  if (document.store.pendingStructs || document.store.pendingDs) throw new LiveContentError(400, 'INCOMPLETE_LIVE_UPDATE');
  const metadata = document.getMap('metadata'), title = metadata.get('title');
  if (metadata._start || document.getMap('threads')._start || metadata.size !== 1 || !(title instanceof Y.Text) || title._map.size) return invalid();
  const titleText = title.toString();
  // Live character editing may temporarily leave a blank title. Checkpoint Save
  // still applies the existing nonempty document-title policy.
  if (titleText.length > 200 || titleText.includes('\0')
    || /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(titleText)
    || title.toDelta().some((part: unknown) => {
      const entry = attributes(part, ['insert', 'attributes']);
      return typeof entry.insert !== 'string' || entry.attributes !== undefined && Object.keys(attributes(entry.attributes, [])).length > 0;
    })) return invalid();
  for (const structs of document.store.clients.values()) for (const item of structs) {
    if (item instanceof Y.Item && rootOf(document, item) === 'metadata'
      && item.parent === metadata && item.parentSub !== 'title') return invalid();
  }
  const schema = editor().editor.pmSchema;
  let nodes = 0;
  function inspect(node: Y.XmlElement | Y.XmlText, depth: number) {
    if (++nodes > CONTENT_LIMITS.maxNodes * 4 || depth > CONTENT_LIMITS.maxDepth * 3 + 6) {
      throw new LiveContentError(413, 'LIVE_CONTENT_TOO_COMPLEX');
    }
    if (node instanceof Y.XmlElement) {
      const type = schema.nodes[node.nodeName];
      if (!type || node.nodeName === 'doc' || node.nodeName === 'text') return invalid();
      attributes(node.getAttributes(), Object.keys(type.spec.attrs ?? {}));
      for (const child of node.toArray()) {
        if (!(child instanceof Y.XmlElement) && !(child instanceof Y.XmlText)) return invalid();
        inspect(child, depth + 1);
      }
    } else {
      if (node._map.size) return invalid();
      const parts: unknown[] = node.toDelta();
      for (const value of parts) {
        const part = attributes(value, ['insert', 'attributes']);
        if (typeof part.insert !== 'string') return invalid();
        const allowed = Object.keys(schema.marks);
        // y-prosemirror encodes overlapping native marks with an eight-character
        // hash suffix. Only the official overlapping comment mark uses this seam.
        if (part.attributes && typeof part.attributes === 'object') {
          allowed.push(...Object.keys(part.attributes).filter(name => /^comment--[a-zA-Z0-9+/=]{8}$/.test(name)));
        }
        const formats = part.attributes === undefined ? {} : attributes(part.attributes, allowed);
        for (const [name, value] of Object.entries(formats)) {
          const markName = /^comment--[a-zA-Z0-9+/=]{8}$/.test(name) ? 'comment' : name;
          const mark = schema.marks[markName];
          if (!mark) return invalid();
          const attrs = attributes(value, Object.keys(mark.spec.attrs ?? {}));
          if (markName === 'comment' && (typeof attrs.threadId !== 'string' || !document.getMap('threads').has(attrs.threadId)
            || attrs.orphan !== undefined && typeof attrs.orphan !== 'boolean')) return invalid();
        }
      }
    }
  }
  const fragment = document.getXmlFragment('document');
  if (fragment._map.size) return invalid();
  for (const child of fragment.toArray()) {
    if (!(child instanceof Y.XmlElement)) return invalid();
    inspect(child, 0);
  }
  const node = yXmlFragmentToProseMirrorRootNode(fragment, schema);
  node.check();
  const validated = validateContent({ format: CONTENT_FORMAT, schemaVersion: CONTENT_SCHEMA_VERSION,
    editorVersion: CONTENT_EDITOR_VERSION, document: editor()._prosemirrorNodeToBlocks(node) });
  function withoutComments(value: Node): Node {
    const marks = value.marks.filter(mark => mark.type.name !== 'comment');
    return value.isText ? value.mark(marks)
      : value.type.createChecked(value.attrs, value.content.content.map(withoutComments), marks);
  }
  // Comment anchors intentionally stay live-only. Every other node, attribute
  // and mark must survive the existing native checkpoint representation.
  if (!withoutComments(node).eq(editor()._blocksToProsemirrorNode(validated.content.document))) return invalid();
  return { title: titleText, ...validated };
}

/** Enrollment only: derive initial state from an authorized immutable checkpoint. */
export function createLiveState(title: string, content: unknown) {
  return checked(() => {
    const validated = validateContent(content);
    const document = new Y.Doc({ gc: false });
    try {
      editor().blocksToYXmlFragment(validated.content.document, document.getXmlFragment('document'));
      const text = new Y.Text(); text.insert(0, title); document.getMap('metadata').set('title', text);
      document.getMap('threads'); project(document);
      const encoded = Y.encodeStateAsUpdate(document);
      if (encoded.byteLength > LIVE_LIMITS.maxStateBytes) throw new LiveContentError(413, 'LIVE_STATE_TOO_LARGE');
      return encoded;
    } finally { document.destroy(); }
  });
}

export function readLiveState(state: Uint8Array) {
  return checked(() => {
    const document = documentFrom(state);
    try { return project(document); } finally { document.destroy(); }
  });
}

/** Pure preparation: callers must authorize and commit before any application/fan-out. */
export function prepareLiveUpdate(state: Uint8Array, update: Uint8Array) {
  return checked(() => {
    if (update.byteLength > LIVE_LIMITS.maxUpdateBytes) throw new LiveContentError(413, 'LIVE_UPDATE_TOO_LARGE');
    const document = documentFrom(state);
    try {
      project(document);
      const before = protectedThreads(document), title = document.getMap('metadata').get('title');
      Y.applyUpdate(document, update);
      if (protectedThreads(document) !== before) throw new LiveContentError(403, 'PROTECTED_COMMENT_MUTATION');
      if (document.getMap('metadata').get('title') !== title) return invalid();
      const projected = project(document), encoded = Y.encodeStateAsUpdate(document);
      if (encoded.byteLength > LIVE_LIMITS.maxStateBytes) throw new LiveContentError(413, 'LIVE_STATE_TOO_LARGE');
      return { state: encoded, ...projected };
    } finally { document.destroy(); }
  });
}

/** Trusted comment commands use the supplied store on a clone, never on a broadcasting room. */
export async function prepareLiveComment(state: Uint8Array, actorId: string, input: unknown) {
  const document = checked(() => documentFrom(state));
  try {
    const before = project(document);
    const result = await applyComment(document, editor().editor.pmSchema, actorId, input);
    const projected = project(document), encoded = Y.encodeStateAsUpdate(document);
    if (JSON.stringify(before) !== JSON.stringify(projected)) return invalid();
    if (encoded.byteLength > LIVE_LIMITS.maxStateBytes) throw new LiveContentError(413, 'LIVE_STATE_TOO_LARGE');
    return { state: encoded, result, ...projected };
  } catch (error) { return failed(error); }
  finally { document.destroy(); }
}
