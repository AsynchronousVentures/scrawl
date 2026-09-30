// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import { CONTENT_LIMITS, contentSchema, validateContent } from '@scrawl/content';

export function validLink(href: string): boolean {
  try {
    validateContent({
      format: 'prosemirror-json', schemaVersion: 1,
      document: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'link', marks: [{ type: 'link', attrs: { href } }] }] }] },
    });
    return true;
  } catch {
    return false;
  }
}

/** Inspect inert markup before Tiptap's parser can silently omit unsupported data. */
export function supportedHTML(html: string): boolean {
  const allowed = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'PRE', 'CODE', 'BR', 'STRONG', 'B', 'EM', 'I', 'A']);
  const parsed = document.createElement('template');
  parsed.innerHTML = html;
  for (const element of parsed.content.querySelectorAll('*')) {
    if (!allowed.has(element.tagName)) return false;
    for (const attribute of element.attributes) {
      const name = attribute.name;
      // Native copy/paste includes slice context, not persisted JSON attributes.
      if (name === 'data-pm-slice' && supportedSlice(attribute.value)) continue;
      if (element.tagName === 'A' && name === 'href') continue;
      if (element.tagName === 'A' && name === 'target' && attribute.value === '_blank') continue;
      if (element.tagName === 'A' && name === 'rel' && attribute.value === 'noopener noreferrer') continue;
      if (element.tagName === 'OL' && name === 'start' && /^[1-9][0-9]*$/.test(attribute.value)) continue;
      if (element.tagName === 'CODE' && name === 'data-language' && /^[A-Za-z0-9_+.-]{1,64}$/.test(attribute.value)) continue;
      return false;
    }
    if (element.tagName === 'A' && !validLink(element.getAttribute('href') ?? '')) return false;
    if (element.tagName === 'PRE') {
      if (element.children.length !== 1 || element.firstElementChild?.tagName !== 'CODE'
        || element.firstElementChild.children.length || [...element.childNodes].some(child => child.nodeType === Node.TEXT_NODE && child.textContent?.trim())) return false;
    }
    if (element.tagName === 'CODE' && element.hasAttribute('data-language') && element.parentElement?.tagName !== 'PRE') return false;
  }
  return true;
}

function supportedSlice(value: string): boolean {
  const match = /^(\d+) (\d+) (\[.*\])$/.exec(value);
  if (!match || value.length > CONTENT_LIMITS.maxDepth * 160
    || Number(match[1]) > CONTENT_LIMITS.maxDepth || Number(match[2]) > CONTENT_LIMITS.maxDepth) return false;
  try {
    const context: unknown = JSON.parse(match[3]!);
    if (!Array.isArray(context) || context.length % 2 || context.length > CONTENT_LIMITS.maxDepth * 2) return false;
    for (let index = 0; index < context.length; index += 2) {
      const name: unknown = context[index], attrs: unknown = context[index + 1];
      if (typeof name !== 'string' || !['doc', 'paragraph', 'heading', 'bulletList', 'orderedList', 'listItem', 'codeBlock'].includes(name)) return false;
      if (attrs === null) continue;
      if (typeof attrs !== 'object' || Array.isArray(attrs)) return false;
      const supplied = attrs as Record<string, unknown>;
      const definitions = contentSchema.spec.nodes.get(name)?.attrs ?? {};
      if (Object.keys(supplied).some(key => !Object.hasOwn(definitions, key))) return false;
      for (const [key, definition] of Object.entries(definitions)) {
        if (typeof definition.validate === 'function') definition.validate(key in supplied ? supplied[key] : definition.default);
      }
    }
    return true;
  } catch {
    return false;
  }
}
