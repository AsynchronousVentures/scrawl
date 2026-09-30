// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import Heading from '@tiptap/extension-heading';
import { BulletList, OrderedList, ListItem } from '@tiptap/extension-list';
import CodeBlock from '@tiptap/extension-code-block';
import HardBreak from '@tiptap/extension-hard-break';
import Bold from '@tiptap/extension-bold';
import Italic from '@tiptap/extension-italic';
import Code from '@tiptap/extension-code';
import Link from '@tiptap/extension-link';
import { UndoRedo } from '@tiptap/extensions/undo-redo';
import { contentSchema } from '@scrawl/content';
import { validLink } from './clipboard.js';

// Extend the official editing behavior only where its default JSON differs from
// Scrawl's existing contract. No StarterKit, extra nodes, or global attributes.
export const restrictedExtensions = [
  Document,
  Paragraph,
  Text,
  Heading.extend({
    addAttributes() {
      return { level: { ...contentSchema.nodes.heading!.spec.attrs!.level!, rendered: false } };
    },
  }),
  BulletList.configure({ keepMarks: true }),
  OrderedList.extend({
    // This extension also ships automatic numbered/lettered text conversion as
    // a paste plugin, independently of Tiptap's enablePasteRules option.
    addProseMirrorPlugins() { return []; },
    addAttributes() {
      return {
        start: {
          ...contentSchema.nodes.orderedList!.spec.attrs!.start!,
          parseHTML: element => Number(element.getAttribute('start') ?? 1),
        },
      };
    },
  }).configure({ keepMarks: true }),
  ListItem,
  CodeBlock.extend({
    addAttributes() {
      return {
        language: {
          ...contentSchema.nodes.codeBlock!.spec.attrs!.language!, rendered: false,
          parseHTML: element => element.querySelector('code')?.getAttribute('data-language') ?? null,
        },
      };
    },
    parseHTML() { return [{ tag: 'pre', preserveWhitespace: 'full', contentElement: 'code' }]; },
    renderHTML({ node }) {
      return ['pre', ['code', node.attrs.language === null ? {} : { 'data-language': node.attrs.language }, 0]];
    },
  }),
  HardBreak,
  Bold.extend({ priority: 104 }),
  Italic.extend({ priority: 103 }),
  Code.extend({ priority: 102, excludes: 'code' }),
  Link.extend({
    priority: 101,
    inclusive: false,
    addAttributes() {
      return {
        href: {
          ...contentSchema.marks.link!.spec.attrs!.href!, isRequired: true,
          parseHTML: element => element.getAttribute('href'),
        },
      };
    },
  }).configure({
    autolink: false, linkOnPaste: false, openOnClick: false,
    HTMLAttributes: { target: '_blank', rel: 'noopener noreferrer' },
    isAllowedUri: validLink,
  }),
  UndoRedo,
];
