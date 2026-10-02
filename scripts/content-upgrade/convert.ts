// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import { createHash } from 'node:crypto';
import type { Node } from 'prosemirror-model';
import { validateContent } from '../../src/core/documents/content.js';
import { contentSchema, validateContent as validateLegacy } from './legacy-prosemirror.js';

/** Finite encoding upgrade only. Never imported by the application or browser. */
export function convertLegacyContent(input: unknown, revisionId: string) {
  const before = validateLegacy(input);
  const native = contentSchema.nodeFromJSON(before.content.document);
  function id(path: string) {
    return createHash('sha256').update(`${revisionId}:${path}`).digest('hex').slice(0, 32);
  }
  function inline(node: Node) {
    const result: unknown[] = [];
    node.forEach(child => {
      if (child.type.name !== 'text' && child.type.name !== 'hardBreak') throw new Error('Unsupported legacy inline content');
      const styles: Record<string, boolean> = {};
      let target: string | undefined;
      for (const mark of child.marks) {
        if (mark.type.name === 'link') {
          const href: unknown = mark.attrs.href;
          if (typeof href !== 'string') throw new Error('Invalid legacy link');
          target = href;
        } else if (['bold', 'italic', 'code'].includes(mark.type.name)) styles[mark.type.name] = true;
        else throw new Error('Unsupported legacy mark');
      }
      const text = { type: 'text', text: child.type.name === 'hardBreak' ? '\n' : child.text, styles };
      result.push(target ? { type: 'link', href: target, content: [text] } : text);
    });
    return result;
  }
  function blocks(node: Node, path: string): unknown[] {
    const result: unknown[] = [];
    node.forEach((child, _offset, index) => {
      const key = `${path}.${index}`;
      if (child.type.name === 'bulletList' || child.type.name === 'orderedList') {
        child.forEach((item, _itemOffset, itemIndex) => {
          const first = item.firstChild;
          if (!first || first.type.name !== 'paragraph') throw new Error('Unrepresentable legacy list item');
          const children: unknown[] = [];
          item.forEach((nested, _nestedOffset, nestedIndex) => {
            if (nestedIndex === 0) return;
            // Native list items own their remaining blocks as nested children.
            children.push(...blocks(contentSchema.node('doc', null, [nested]), `${key}.${itemIndex}.${nestedIndex}`));
          });
          result.push({ id: id(`${key}.${itemIndex}`), type: child.type.name === 'bulletList' ? 'bulletListItem' : 'numberedListItem',
            props: child.type.name === 'orderedList' && itemIndex === 0 && child.attrs.start !== 1
              ? { start: child.attrs.start as unknown } : {}, content: inline(first), children });
        });
      } else if (['paragraph', 'heading', 'codeBlock'].includes(child.type.name)) {
        result.push({ id: id(key), type: child.type.name, props: child.type.name === 'heading'
          ? { level: child.attrs.level as unknown } : child.type.name === 'codeBlock'
            ? { language: (child.attrs.language as unknown) ?? 'text' } : {}, content: inline(child), children: [] });
      } else throw new Error('Unrepresentable legacy block');
    });
    return result;
  }
  const converted = validateContent({ format: 'blocknote-json', schemaVersion: 1, editorVersion: '0.55.0', document: blocks(native, 'root') });
  if (converted.plainText !== before.plainText) throw new Error('Legacy text would change during conversion');
  return converted;
}
