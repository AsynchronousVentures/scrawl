// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import {
  BlockNoteEditor, BlockNoteSchema, blockToNode, defaultBlockSpecs, defaultStyleSpecs, docToBlocks,
  type Block, type InlineContent, type DefaultBlockSchema, type DefaultInlineContentSchema, type DefaultStyleSchema, type PropSchema,
} from '@blocknote/core';

// BlockNote 0.55 infers heading's optional schema-entry slot as possibly
// undefined, although the default runtime schema always contains it. Normalize
// that library typing boundary without changing any native blocks or props.
export type NativeBlockSchema = {
  [K in keyof DefaultBlockSchema]: Omit<DefaultBlockSchema[K], 'propSchema'> & {
    propSchema: { [P in keyof DefaultBlockSchema[K]['propSchema']]-?: Exclude<DefaultBlockSchema[K]['propSchema'][P], undefined> };
  };
};
export type NativeBlock = Block<NativeBlockSchema, DefaultInlineContentSchema, DefaultStyleSchema>;
export const contentSchema = BlockNoteSchema.create() as BlockNoteSchema<NativeBlockSchema, DefaultInlineContentSchema, DefaultStyleSchema>;

export const CONTENT_FORMAT = 'blocknote-json' as const;
export const CONTENT_SCHEMA_VERSION = 1 as const;
export const CONTENT_EDITOR_VERSION = '0.55.0' as const;
export const CONTENT_LIMITS = {
  maxBytes: 256 * 1024, maxDepth: 32, maxNodes: 10_000, maxMarks: 7,
  maxHrefLength: 2048, maxLanguageLength: 128,
} as const;

export type ContentEnvelope = {
  format: typeof CONTENT_FORMAT;
  schemaVersion: typeof CONTENT_SCHEMA_VERSION;
  editorVersion: typeof CONTENT_EDITOR_VERSION;
  document: NativeBlock[];
};

export class ContentValidationError extends Error {
  constructor(readonly status: 400 | 413, readonly code: string) {
    super(code);
    this.name = 'ContentValidationError';
  }
}

function invalid(): never { throw new ContentValidationError(400, 'INVALID_CONTENT'); }
function limit(code: string): never { throw new ContentValidationError(413, code); }

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

function array(input: unknown): unknown[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) invalid();
  if (input.length > CONTENT_LIMITS.maxNodes) limit('CONTENT_TOO_MANY_NODES');
  for (const key of Reflect.ownKeys(input)) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(key)
      || Number(key) >= input.length) invalid();
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) invalid();
  }
  if (Object.keys(input).length !== input.length) invalid();
  return input;
}

type Traversal = { nodes: number; scalarBytes: number; ids: Set<string>; active: WeakSet<object> };

function count(traversal: Traversal): void {
  if (++traversal.nodes > CONTENT_LIMITS.maxNodes) limit('CONTENT_TOO_MANY_NODES');
}

function text(input: unknown, traversal: Traversal, maximum = CONTENT_LIMITS.maxBytes): string {
  if (typeof input !== 'string') invalid();
  if (input.length > maximum) limit('CONTENT_TOO_LARGE');
  // PostgreSQL JSONB cannot retain NUL or an unpaired UTF-16 surrogate.
  if (input.includes('\u0000') || /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(input)) invalid();
  traversal.scalarBytes += new TextEncoder().encode(input).byteLength;
  if (traversal.scalarBytes > CONTENT_LIMITS.maxBytes) limit('CONTENT_TOO_LARGE');
  return input;
}

function safeUrl(value: string, media: boolean): boolean {
  if (media && value === '') return true;
  if (!value || value.length > CONTENT_LIMITS.maxHrefLength
    || /[\s\u0000-\u001f\u007f-\u009f\\]/u.test(value)
    || /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(value)
    || /%(?:0[0-9a-f]|1[0-9a-f]|7f)|%c2%(?:8[0-9a-f]|9[0-9a-f])/i.test(value)) return false;
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.username || url.password) return false;
  if (url.protocol === 'http:' || url.protocol === 'https:') return /^https?:\/\//i.test(value) && Boolean(url.hostname);
  return !media && url.protocol === 'mailto:' && Boolean(url.pathname)
    && !value.slice('mailto:'.length).startsWith('//');
}

export function isSafeLinkUrl(value: string): boolean { return safeUrl(value, false); }
export function isSafeMediaUrl(value: string): boolean { return safeUrl(value, true); }

function color(input: unknown, traversal: Traversal): string {
  const value = text(input, traversal, 128);
  // Native named/theme/custom CSS colors remain usable; executable CSS and
  // remote-resource expressions are never stored as presentation values.
  if (!value || /[;{}<>\\\u0000-\u001f\u007f-\u009f]/u.test(value)
    || /(?:url|expression)\s*\(/i.test(value)) invalid();
  return value;
}

function properties(input: unknown, schema: Readonly<Record<string, PropSchema[string] | undefined>>, traversal: Traversal): Record<string, unknown> {
  const submitted = input === undefined ? {} : object(input, Object.keys(schema));
  const result: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(schema)) {
    if (!spec) continue;
    const value = submitted[name] === undefined ? spec.default : submitted[name];
    if (value === undefined) continue;
    const expected = 'type' in spec ? spec.type : typeof spec.default;
    if (typeof value !== expected || (spec.values && !spec.values.some(candidate => candidate === value))) invalid();
    if (typeof value === 'string') {
      if (name === 'backgroundColor' || name === 'textColor') result[name] = color(value, traversal);
      else {
        result[name] = text(value, traversal, name === 'language' ? CONTENT_LIMITS.maxLanguageLength : CONTENT_LIMITS.maxBytes);
        if (name === 'url' && !isSafeMediaUrl(value)) invalid();
      }
    } else if (typeof value === 'number') {
      if (!Number.isFinite(value)) invalid();
      if (name === 'start' && (!Number.isInteger(value) || value < 1 || value > 2_147_483_647)) invalid();
      if (name === 'previewWidth' && (value <= 0 || value > 100_000)) invalid();
      result[name] = value;
    } else result[name] = value;
  }
  return result;
}

function styles(input: unknown, traversal: Traversal): Record<string, true | string> {
  const submitted = input === undefined ? {} : object(input, Object.keys(defaultStyleSpecs));
  const result: Record<string, true | string> = {};
  for (const [name, spec] of Object.entries(defaultStyleSpecs)) {
    const value = submitted[name];
    if (value === undefined) continue;
    if (spec.config.propSchema === 'boolean') {
      if (typeof value !== 'boolean') invalid();
      if (value) result[name] = true;
    } else result[name] = color(value, traversal);
  }
  return result;
}

function inline(input: unknown, traversal: Traversal, plain = false, linked = false): unknown[] {
  const result: unknown[] = [];
  for (const item of array(input === undefined ? [] : input)) {
    count(traversal);
    const value = object(item, ['type', 'text', 'styles', 'href', 'content']);
    if (value.type === 'text') {
      if ('href' in value || 'content' in value) invalid();
      const applied = styles(value.styles, traversal);
      if (plain && Object.keys(applied).length) invalid();
      result.push({ type: 'text', text: text(value.text, traversal), styles: applied });
    } else if (value.type === 'link' && !plain && !linked) {
      if ('text' in value || 'styles' in value) invalid();
      const href = text(value.href, traversal);
      if (!isSafeLinkUrl(href)) invalid();
      const content = inline(value.content, traversal, false, true);
      result.push({ type: 'link', href, content });
    } else invalid();
  }
  return result;
}

const cellProps: PropSchema = {
  backgroundColor: { default: 'default' }, textColor: { default: 'default' },
  textAlignment: { default: 'left', values: ['left', 'center', 'right', 'justify'] },
  colspan: { default: 1 }, rowspan: { default: 1 },
};

function table(input: unknown, traversal: Traversal): unknown {
  count(traversal);
  const value = object(input, ['type', 'columnWidths', 'headerRows', 'headerCols', 'rows']);
  if (value.type !== 'tableContent') invalid();
  const widths = array(value.columnWidths === undefined ? [] : value.columnWidths).map(width => {
    if (width === null || width === undefined) return undefined;
    if (typeof width !== 'number' || !Number.isFinite(width) || width <= 0 || width > 100_000) invalid();
    return width;
  });
  const rows = array(value.rows).map(item => {
    count(traversal);
    const row = object(item, ['cells']);
    const cells = array(row.cells).map(item => {
      count(traversal);
      if (Array.isArray(item)) return { type: 'tableCell', props: properties(undefined, cellProps, traversal), content: inline(item, traversal) };
      const cell = object(item, ['type', 'props', 'content']);
      if (cell.type !== 'tableCell') invalid();
      const props = properties(cell.props, cellProps, traversal);
      for (const name of ['colspan', 'rowspan']) {
        const span = props[name];
        if (typeof span !== 'number' || !Number.isInteger(span) || span < 1 || span > CONTENT_LIMITS.maxNodes) invalid();
      }
      return { type: 'tableCell', props, content: inline(cell.content, traversal) };
    });
    return { cells };
  });
  if (!rows.length) invalid();
  const columns = rows[0]!.cells.reduce((total, cell) => total + Number(cell.props.colspan), 0);
  if (!columns) invalid();
  if (columns * rows.length > CONTENT_LIMITS.maxNodes) limit('CONTENT_TOO_MANY_NODES');
  if (widths.length && widths.length !== columns) invalid();
  for (const name of ['headerRows', 'headerCols'] as const) {
    const size = value[name];
    if (size !== undefined && (!Number.isInteger(size) || Number(size) < 0
      || Number(size) > (name === 'headerRows' ? rows.length : columns))) invalid();
  }
  // ProseMirror permits structurally ragged tables. Refuse invalid geometry
  // before repair commands can silently rewrite submitted cells.
  const occupied = Array.from({ length: rows.length }, () => Array<boolean>(columns).fill(false));
  rows.forEach((row, rowIndex) => {
    let column = 0;
    for (const cell of row.cells) {
      while (occupied[rowIndex]![column]) column++;
      const colspan = Number(cell.props.colspan), rowspan = Number(cell.props.rowspan);
      if (column + colspan > columns || rowIndex + rowspan > rows.length) invalid();
      for (let y = rowIndex; y < rowIndex + rowspan; y++) for (let x = column; x < column + colspan; x++) {
        if (occupied[y]![x]) invalid();
        occupied[y]![x] = true;
      }
      column += colspan;
    }
  });
  if (occupied.some(row => row.some(cell => !cell))) invalid();
  return { type: 'tableContent', columnWidths: widths.length ? widths : Array(columns).fill(undefined),
    ...(value.headerRows === undefined ? {} : { headerRows: value.headerRows }),
    ...(value.headerCols === undefined ? {} : { headerCols: value.headerCols }), rows };
}

function block(input: unknown, depth: number, traversal: Traversal): NativeBlock {
  if (depth > CONTENT_LIMITS.maxDepth) limit('CONTENT_TOO_DEEP');
  count(traversal);
  const value = object(input, ['id', 'type', 'props', 'content', 'children']);
  if (traversal.active.has(value)) invalid();
  traversal.active.add(value);
  try {
    const id = text(value.id, traversal, 200);
    if (!id || /[\u0000-\u001f\u007f-\u009f]/u.test(id) || traversal.ids.has(id)) invalid();
    traversal.ids.add(id);
    if (typeof value.type !== 'string' || !Object.hasOwn(defaultBlockSpecs, value.type)) invalid();
    const type = value.type as keyof typeof defaultBlockSpecs;
    const spec = defaultBlockSpecs[type].config;
    const props = properties(value.props, spec.propSchema, traversal);
    let content: unknown;
    if (spec.content === 'inline' || spec.content === 'plain') content = inline(value.content, traversal, spec.content === 'plain');
    else if (spec.content === 'table') content = table(value.content, traversal);
    else if (value.content !== undefined) invalid();
    const children = array(value.children === undefined ? [] : value.children).map(child => block(child, depth + 1, traversal));
    // The official dynamic block-spec registry was exhaustively validated;
    // TypeScript cannot infer its discriminated union from an unknown type.
    return { id, type, props, ...(content === undefined ? {} : { content }), children } as NativeBlock;
  } finally { traversal.active.delete(value); }
}

let engine: BlockNoteEditor<NativeBlockSchema, DefaultInlineContentSchema, DefaultStyleSchema> | undefined;

function stable(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      return Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)));
    }
    return item;
  });
}

type NativeInline = InlineContent<DefaultInlineContentSchema, DefaultStyleSchema>;

function inlineMeaning(content: NativeInline[]): { text: string; styles: unknown; href: string | null }[] {
  const runs: { text: string; styles: unknown; href: string | null }[] = [];
  for (const item of content) {
    for (const text of item.type === 'text' ? [item] : item.content) {
      if (!text.text) continue;
      const href = item.type === 'link' ? item.href : null;
      const previous = runs.at(-1);
      if (previous && previous.href === href && stable(previous.styles) === stable(text.styles)) previous.text += text.text;
      else runs.push({ text: text.text, styles: text.styles, href });
    }
  }
  return runs;
}

function meaning(blocks: NativeBlock[]): unknown[] {
  return blocks.map(block => {
    let content: unknown;
    if (Array.isArray(block.content)) content = inlineMeaning(block.content);
    else if (block.content?.type === 'tableContent') {
      const table = block.content;
      content = {
        columnWidths: table.columnWidths,
        rows: table.rows.map((row, rowIndex) => row.cells.map((cell, cellIndex) => ({
          props: Array.isArray(cell) ? undefined : cell.props,
          content: inlineMeaning(Array.isArray(cell) ? cell : cell.content),
          header: rowIndex < (table.headerRows ?? 0) || cellIndex < (table.headerCols ?? 0),
        }))),
      };
    }
    return { id: block.id, type: block.type, props: block.props, children: meaning(block.children), content };
  });
}

function canonicalDocument(blocks: NativeBlock[]): NativeBlock[] {
  try {
    engine ??= BlockNoteEditor.create({ schema: contentSchema });
    const schema = engine.pmSchema;
    const group = schema.nodes.blockGroup!.createChecked(null, blocks.map(item => blockToNode(item, schema)));
    const document = schema.topNodeType.createChecked(null, group);
    document.check();
    const canonical = docToBlocks<NativeBlockSchema, DefaultInlineContentSchema, DefaultStyleSchema>(document);
    // Defaults, text coalescing and equivalent table-header encodings may
    // normalize. Actual text, styles, links, block props and cell geometry may
    // never disappear through a permissive native decoder.
    if (stable(meaning(blocks)) !== stable(meaning(canonical))) invalid();
    return canonical;
  } catch { invalid(); }
}

/** Read a known native editor snapshot without imposing save-size limits. */
export function extractPlainText(blocks: NativeBlock[]): string {
  const lines: string[] = [];
  for (const block of blocks) {
    if (Array.isArray(block.content)) lines.push(block.content.map(item => item.type === 'text'
      ? item.text : item.content.map(text => text.text).join('')).join(''));
    else if (block.content?.type === 'tableContent') lines.push(block.content.rows.map(row => row.cells.map(cell => {
      const content = Array.isArray(cell) ? cell : cell.content;
      return content.map(item => item.type === 'text' ? item.text : item.content.map(text => text.text).join('')).join('');
    }).join('\t')).join('\n'));
    else if ('caption' in block.props && block.props.caption) lines.push(block.props.caption);
    if (block.children.length) lines.push(extractPlainText(block.children));
  }
  return lines.join('\n');
}

export function validateContent(input: unknown): { content: ContentEnvelope; plainText: string } {
  const envelope = object(input, ['format', 'schemaVersion', 'editorVersion', 'document']);
  if (envelope.format !== CONTENT_FORMAT || envelope.schemaVersion !== CONTENT_SCHEMA_VERSION
    || envelope.editorVersion !== CONTENT_EDITOR_VERSION) invalid();
  const traversal: Traversal = { nodes: 1, scalarBytes: 0, ids: new Set(), active: new WeakSet() };
  const blocks = array(envelope.document).map(item => block(item, 1, traversal));
  if (!blocks.length) invalid();
  if (new TextEncoder().encode(JSON.stringify(envelope)).byteLength > CONTENT_LIMITS.maxBytes) limit('CONTENT_TOO_LARGE');
  const content: ContentEnvelope = { format: CONTENT_FORMAT, schemaVersion: CONTENT_SCHEMA_VERSION,
    editorVersion: CONTENT_EDITOR_VERSION, document: canonicalDocument(blocks) };
  if (new TextEncoder().encode(JSON.stringify(content)).byteLength > CONTENT_LIMITS.maxBytes) limit('CONTENT_TOO_LARGE');
  return { content, plainText: extractPlainText(content.document) };
}
