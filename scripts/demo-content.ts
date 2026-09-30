// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import { validateContent } from '../src/core/documents/content.js';

const textProps = { textColor: 'default', backgroundColor: 'default', textAlignment: 'left' };

/** Synthetic native blocks, with stable IDs across successive versions of the same fixture. */
export function demoContent(lines: readonly string[]) {
  return validateContent({
    format: 'blocknote-json', schemaVersion: 1, editorVersion: '0.55.0',
    document: lines.map((text, index) => ({
      id: `demo-line-${index + 1}`, type: 'paragraph', props: textProps,
      content: [{ type: 'text', text, styles: {} }], children: [],
    })),
  }).content;
}

/** Native rich content used by both HTTP demos, including nested blocks and table cells. */
export function richDemoContent(lines: readonly string[]) {
  return validateContent({
    format: 'blocknote-json', schemaVersion: 1, editorVersion: '0.55.0',
    document: [
      ...demoContent(lines).document,
      {
        id: 'demo-rich-heading', type: 'heading', props: { ...textProps, level: 2 },
        content: [{ type: 'text', text: 'Rich blocks', styles: {} }], children: [],
      },
      {
        id: 'demo-rich-text', type: 'paragraph', props: textProps,
        content: [
          { type: 'text', text: 'Keep ', styles: {} },
          { type: 'text', text: 'formatting', styles: { bold: true, italic: true, underline: true } },
          { type: 'text', text: ' and ', styles: {} },
          { type: 'text', text: 'highlights', styles: { textColor: 'green', backgroundColor: 'yellow' } },
          { type: 'text', text: '; remove ', styles: {} },
          { type: 'text', text: 'obsolete steps', styles: { strike: true } },
          { type: 'text', text: '. See the ', styles: {} },
          {
            type: 'link', href: 'https://www.blocknotejs.org/docs/foundations/document-structure',
            content: [{ type: 'text', text: 'native document format', styles: {} }],
          },
          { type: 'text', text: ' through ', styles: {} },
          { type: 'text', text: 'editor.document', styles: { code: true } },
          { type: 'text', text: '.', styles: {} },
        ], children: [],
      },
      {
        id: 'demo-rich-quote', type: 'quote', props: { textColor: 'default', backgroundColor: 'default' },
        content: [{ type: 'text', text: 'A saved revision is an immutable snapshot.', styles: {} }], children: [],
      },
      {
        id: 'demo-rich-bullet', type: 'bulletListItem', props: textProps,
        content: [{ type: 'text', text: 'Review the changes', styles: {} }],
        children: [{
          id: 'demo-rich-check', type: 'checkListItem', props: { ...textProps, checked: true },
          content: [{ type: 'text', text: 'Verify the native round trip', styles: {} }], children: [],
        }],
      },
      {
        id: 'demo-rich-numbered', type: 'numberedListItem', props: { ...textProps, start: 1 },
        content: [{ type: 'text', text: 'Save explicitly', styles: {} }], children: [],
      },
      {
        id: 'demo-rich-toggle', type: 'toggleListItem', props: textProps,
        content: [{ type: 'text', text: 'A smaller review', styles: {} }],
        children: [{
          id: 'demo-rich-nested-heading', type: 'heading', props: { ...textProps, level: 3 },
          content: [{ type: 'text', text: 'Nested review notes', styles: {} }], children: [],
        }, {
          id: 'demo-rich-nested-note', type: 'paragraph', props: textProps,
          content: [{ type: 'text', text: 'Nesting is preserved in saved content and the outline.', styles: {} }], children: [],
        }],
      },
      {
        id: 'demo-rich-table', type: 'table', props: { textColor: 'default' },
        content: {
          type: 'tableContent', columnWidths: [160, 160], headerRows: 1,
          rows: [
            { cells: ['Check', 'Result'].map(text => ({
              type: 'tableCell', props: { ...textProps, colspan: 1, rowspan: 1 },
              content: [{ type: 'text', text, styles: {} }],
            })) },
            { cells: ['Native blocks', 'Preserved'].map(text => ({
              type: 'tableCell', props: { ...textProps, colspan: 1, rowspan: 1 },
              content: [{ type: 'text', text, styles: {} }],
            })) },
          ],
        }, children: [],
      },
      {
        id: 'demo-rich-code', type: 'codeBlock', props: { language: 'text' },
        content: [{ type: 'text', text: 'Review -> Save -> Reload\nHistory remains unchanged by rejected writes.', styles: {} }],
        children: [],
      },
      { id: 'demo-rich-divider', type: 'divider', props: {}, children: [] },
    ],
  }).content;
}
