// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import { Schema, type Node as NativeNode } from 'prosemirror-model';

export const CONTENT_LIMITS = {
  maxBytes: 256 * 1024,
  maxDepth: 32,
  maxNodes: 10_000,
  maxMarks: 4,
  maxHrefLength: 2048,
  maxLanguageLength: 64,
} as const;

export type ContentMark = { type: 'bold' | 'italic' | 'code' }
  | { type: 'link'; attrs: { href: string } };

export type DocumentNode = { type: 'doc'; content?: ContentNode[] };
export type ContentNode = DocumentNode
  | { type: 'text'; text: string; marks?: ContentMark[] }
  | { type: 'hardBreak'; marks?: ContentMark[] }
  | { type: 'paragraph' | 'bulletList' | 'listItem'; content?: ContentNode[] }
  | { type: 'heading'; attrs: { level: number }; content?: ContentNode[] }
  | { type: 'orderedList'; attrs: { start: number }; content?: ContentNode[] }
  | { type: 'codeBlock'; attrs: { language: string | null }; content?: ContentNode[] };

export type ContentEnvelope = {
  format: 'prosemirror-json';
  schemaVersion: 1;
  document: DocumentNode;
};

export class ContentValidationError extends Error {
  constructor(readonly status: 400 | 413, readonly code: string) {
    super(code);
    this.name = 'ContentValidationError';
  }
}

function invalid(): never {
  throw new ContentValidationError(400, 'INVALID_CONTENT');
}

function limit(code: string): never {
  throw new ContentValidationError(413, code);
}

function headingLevel(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 6) invalid();
  return value;
}

function listStart(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 2_147_483_647) invalid();
  return value;
}

function language(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string'
    || !/^[A-Za-z0-9_+.-]{1,64}$/.test(value)) invalid();
  return value;
}

function href(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0
    || value.length > CONTENT_LIMITS.maxHrefLength
    || /[\s\u0000-\u001f\u007f-\u009f]/u.test(value)
    || /%(?:0[0-9a-f]|1[0-9a-f]|7f)|%c2%(?:8[0-9a-f]|9[0-9a-f])/i.test(value)
    || value.includes('\\') || unpairedSurrogate(value)) invalid();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    invalid();
  }
  if (url.username || url.password) invalid();
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    if (!/^https?:\/\//i.test(value) || !url.hostname) invalid();
  } else if (url.protocol === 'mailto:') {
    if (!url.pathname || value.slice('mailto:'.length).startsWith('//')) invalid();
  } else {
    invalid();
  }
  return value;
}

/** The same headless model can be imported by a future browser editor. */
export const contentSchema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    heading: {
      content: 'inline*', group: 'block', defining: true,
      attrs: { level: { default: 1, validate: headingLevel } },
    },
    text: { group: 'inline' },
    bulletList: { content: 'listItem+', group: 'block' },
    orderedList: {
      content: 'listItem+', group: 'block',
      attrs: { start: { default: 1, validate: listStart } },
    },
    listItem: { content: 'paragraph block*', defining: true },
    codeBlock: {
      content: 'text*', group: 'block', marks: '', code: true, defining: true,
      attrs: { language: { default: null, validate: language } },
    },
    hardBreak: { inline: true, group: 'inline', selectable: false },
  },
  marks: {
    bold: {},
    italic: {},
    code: { code: true },
    link: { attrs: { href: { validate: href } }, inclusive: false },
  },
});

function object(input: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) invalid();
  const prototype: unknown = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string' || !allowed.includes(key)) invalid();
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) invalid();
  }
  return input as Record<string, unknown>;
}

function attributes(input: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return 'attrs' in input ? object(input.attrs, keys) : {};
}

function array(input: unknown, maximum: number, tooMany: () => never): unknown[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) invalid();
  if (input.length > maximum) tooMany();
  for (const key of Reflect.ownKeys(input)) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(key)
      || Number(key) >= input.length) invalid();
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) invalid();
  }
  return input;
}

function marks(input: unknown, traversal: Traversal): ContentMark[] {
  const values = array(input, CONTENT_LIMITS.maxMarks, invalid);
  const result: ContentMark[] = [];
  const names = new Set<string>();
  for (const value of values) {
    const mark = object(value, ['type', 'attrs']);
    if (typeof mark.type !== 'string' || names.has(mark.type)) invalid();
    names.add(mark.type);
    switch (mark.type) {
      case 'bold':
      case 'italic':
      case 'code':
        attributes(mark, []);
        result.push({ type: mark.type });
        break;
      case 'link': {
        const target = href(attributes(mark, ['href']).href);
        scalarBytes(target, traversal);
        result.push({ type: 'link', attrs: { href: target } });
        break;
      }
      default:
        invalid();
    }
  }
  const ranks = ['bold', 'italic', 'code', 'link'];
  return result.sort((left, right) => ranks.indexOf(left.type) - ranks.indexOf(right.type));
}

type Traversal = { nodes: number; scalarBytes: number; active: WeakSet<object> };

function scalarBytes(value: string, traversal: Traversal): void {
  traversal.scalarBytes += new TextEncoder().encode(value).byteLength;
  if (traversal.scalarBytes > CONTENT_LIMITS.maxBytes) limit('CONTENT_TOO_LARGE');
}

function unpairedSurrogate(value: string): boolean {
  return /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(value);
}

function node(input: unknown, depth: number, traversal: Traversal): ContentNode {
  if (depth > CONTENT_LIMITS.maxDepth) limit('CONTENT_TOO_DEEP');
  if (++traversal.nodes > CONTENT_LIMITS.maxNodes) limit('CONTENT_TOO_MANY_NODES');
  const value = object(input, ['type', 'attrs', 'content', 'text', 'marks']);
  if (traversal.active.has(value)) invalid();
  traversal.active.add(value);
  try {
    if (value.type === 'text' || value.type === 'hardBreak') {
      if ('content' in value) invalid();
      attributes(value, []);
      const applied = 'marks' in value ? marks(value.marks, traversal) : [];
      const marked = applied.length ? { marks: applied } : {};
      if (value.type === 'hardBreak') {
        if ('text' in value) invalid();
        return { type: 'hardBreak', ...marked };
      }
      if (typeof value.text !== 'string' || value.text.length === 0) invalid();
      if (value.text.length > CONTENT_LIMITS.maxBytes) limit('CONTENT_TOO_LARGE');
      // PostgreSQL JSONB cannot represent NUL or unpaired UTF-16 surrogates.
      if (value.text.includes('\u0000') || unpairedSurrogate(value.text)) invalid();
      scalarBytes(value.text, traversal);
      return { type: 'text', text: value.text, ...marked };
    }
    if ('text' in value || 'marks' in value) invalid();
    let content: ContentNode[] = [];
    if ('content' in value) {
      const children = array(value.content, CONTENT_LIMITS.maxNodes, () => limit('CONTENT_TOO_MANY_NODES'));
      for (const child of children) content.push(node(child, depth + 1, traversal));
    }
    const children = content.length ? { content } : {};
    switch (value.type) {
      case 'doc':
      case 'paragraph':
      case 'bulletList':
      case 'listItem':
        attributes(value, []);
        return { type: value.type, ...children };
      case 'heading': {
        const attrs = attributes(value, ['level']);
        return { type: 'heading', attrs: { level: headingLevel('level' in attrs ? attrs.level : 1) }, ...children };
      }
      case 'orderedList': {
        const attrs = attributes(value, ['start']);
        return { type: 'orderedList', attrs: { start: listStart('start' in attrs ? attrs.start : 1) }, ...children };
      }
      case 'codeBlock': {
        const attrs = attributes(value, ['language']);
        const name = language('language' in attrs ? attrs.language : null);
        if (name !== null) scalarBytes(name, traversal);
        return { type: 'codeBlock', attrs: { language: name }, ...children };
      }
      default:
        invalid();
    }
  } finally {
    traversal.active.delete(value);
  }
}

function document(input: unknown): DocumentNode {
  const parsed = node(input, 1, { nodes: 0, scalarBytes: 0, active: new WeakSet() });
  if (parsed.type !== 'doc') invalid();
  return parsed;
}

function checkBytes(input: unknown): void {
  if (new TextEncoder().encode(JSON.stringify(input)).byteLength > CONTENT_LIMITS.maxBytes) {
    limit('CONTENT_TOO_LARGE');
  }
}

function plainText(native: NativeNode): string {
  // Text-block separators retain empty paragraphs and list contents without
  // inventing bullets or rendering HTML. Code and hard breaks retain newlines.
  const blocks: string[] = [];
  native.descendants(child => {
    if (!child.isTextblock) return;
    blocks.push(child.textBetween(0, child.content.size, '', '\n'));
    return false;
  });
  return blocks.join('\n');
}

export function validateContent(input: unknown): { content: ContentEnvelope; plainText: string } {
  const envelope = object(input, ['format', 'schemaVersion', 'document']);
  if (envelope.format !== 'prosemirror-json' || envelope.schemaVersion !== 1 || !('document' in envelope)) invalid();
  const parsed = document(envelope.document);
  // Strict preflight occurs before native decoding: fromJSON otherwise drops
  // unknown attributes and coalesces text before resource limits are checked.
  checkBytes(input);
  let native: NativeNode;
  try {
    native = contentSchema.nodeFromJSON(parsed);
    native.check();
  } catch {
    invalid();
  }
  // The library's toJSON return type is unsafe. Revalidate it at this boundary
  // rather than exposing that type or casting it into the persistence contract.
  const serialized: unknown = native.toJSON();
  const content: ContentEnvelope = {
    format: 'prosemirror-json', schemaVersion: 1, document: document(serialized),
  };
  checkBytes(content);
  return { content, plainText: plainText(native) };
}
