// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { DefaultInlineContentSchema, DefaultStyleSchema } from '@blocknote/core';
import { useCreateBlockNote, useEditorState } from '@blocknote/react';
import { BlockNoteView } from '@blocknote/shadcn';
import { contentSchema, isSafeLinkUrl, validateContent, type ContentEnvelope, type NativeBlock, type NativeBlockSchema } from '@scrawl/content';

type Heading = { id: string; text: string; level: number; depth: number };

function documentHeadings(blocks: NativeBlock[], depth = 0): Heading[] {
  return blocks.flatMap(block => {
    const own = block.type === 'heading' ? [{
      id: block.id,
      text: block.content.map(part => part.type === 'text' ? part.text
        : part.content.map(text => text.text).join('')).join('') || 'Untitled section',
      level: block.props.level,
      depth,
    }] : [];
    return [...own, ...documentHeadings(block.children, depth + 1)];
  });
}

export function Editor({ initialContent, editable, onChange, onValidationChange, header, label = 'Document body' }: {
  initialContent: ContentEnvelope;
  editable: boolean;
  onChange: (content: ContentEnvelope) => void;
  onValidationChange?: (error: string | null) => void;
  header?: ReactNode;
  label?: string;
}) {
  const identifier = `editor-${useId().replace(/[^a-zA-Z0-9_-]/g, '-')}`;
  const container = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onChange, onValidationChange });
  callbacks.current = { onChange, onValidationChange };
  const [error, setError] = useState<string | null>(null);
  const [activeHeading, setActiveHeading] = useState<string | null>(null);
  const [outlineOpen, setOutlineOpen] = useState(true);
  // Saving changes the comparison baseline, not this editor or its undo stack.
  // The parent remounts for an intentional navigation, restore, or discard.
  const [initial] = useState(() => validateContent(initialContent).content);
  const editor = useCreateBlockNote({
    schema: contentSchema,
    initialContent: initial.document,
    domAttributes: {
      editor: {
        role: 'textbox', 'aria-label': label, 'aria-multiline': 'true',
        'aria-describedby': `${identifier}-error`,
      },
      // Native node views own their DOM. A supported attribute on the block
      // container gives section navigation a stable, programmatic focus target.
      blockContent: { tabindex: '-1' },
    },
    links: { isValidLink: isSafeLinkUrl },
    tables: { splitCells: true, cellBackgroundColor: true, cellTextColor: true, headers: true },
  });
  const headings = useEditorState({
    editor,
    on: 'change',
    selector: () => documentHeadings(editor.document),
  });

  function headingElement(id: string) {
    // Main content, conflict comparison, and history can render the same IDs.
    const block = container.current?.querySelector(`[data-id="${CSS.escape(id)}"]`);
    return block?.querySelector<HTMLElement>('h1,h2,h3,h4,h5,h6') ?? null;
  }

  useEffect(() => {
    const contenteditable = container.current?.querySelector<HTMLElement>('[role="textbox"]');
    contenteditable?.setAttribute('aria-readonly', String(!editable));
  }, [editable, editor]);
  useEffect(() => {
    const narrow = matchMedia('(max-width: 980px)');
    const resize = () => setOutlineOpen(!narrow.matches);
    resize(); narrow.addEventListener('change', resize);
    return () => narrow.removeEventListener('change', resize);
  }, []);
  useEffect(() => {
    const update = () => {
      let selected = headings[0]?.id ?? null;
      for (const heading of headings) {
        if ((headingElement(heading.id)?.getBoundingClientRect().top ?? Infinity) < 160) selected = heading.id;
      }
      setActiveHeading(selected);
    };
    update(); window.addEventListener('scroll', update, { passive: true, capture: true });
    return () => window.removeEventListener('scroll', update, true);
  }, [headings]);

  return <div className="editor-layout">
    <div className="editor-content">
      {header}
      <p id={`${identifier}-error`} className="editor-error" role="alert" hidden={!error}>{error}</p>
      <div ref={container} className="editor-mount">
        <BlockNoteView<NativeBlockSchema, DefaultInlineContentSchema, DefaultStyleSchema>
          editor={editor} theme="dark" editable={editable} onChange={(current, { getChanges }) => {
          // The library also emits updates when editability changes during Save.
          // Those are not user edits and must not clear failure/access notices.
          if (getChanges().length === 0) return;
          const content: ContentEnvelope = {
            format: 'blocknote-json', schemaVersion: 1, editorVersion: '0.55.0', document: current.document,
          };
          // Keep the full local snapshot even when it cannot be saved. Invalid
          // edits remain dirty and recoverable with the library's undo or discard.
          callbacks.current.onChange(content);
          let message: string | null = null;
          try { validateContent(content); }
          catch { message = 'This document cannot be saved because its content is invalid or exceeds the document limits. Your complete local edits are retained. Undo the change or discard your unsaved edits.'; }
          setError(message);
          callbacks.current.onValidationChange?.(message);
        }} />
      </div>
    </div>
    <details className="editor-outline" open={outlineOpen} onToggle={event => setOutlineOpen(event.currentTarget.open)}>
      <summary>On this page</summary>
      <nav aria-label="On this page">
        {headings.length ? headings.map(heading => <a key={heading.id}
          href={`#${identifier}-${heading.id}`}
          className={heading.level > 2 || heading.depth > 0 ? 'outline-subheading' : undefined}
          aria-current={activeHeading === heading.id ? 'location' : undefined}
          onClick={event => {
            event.preventDefault();
            const target = headingElement(heading.id);
            if (!target) return;
            let ancestor = target.closest('.bn-block-outer')?.parentElement?.closest('.bn-block-outer');
            while (ancestor && container.current?.contains(ancestor)) {
              ancestor.querySelector<HTMLButtonElement>(':scope > .bn-block > .bn-block-content .bn-toggle-wrapper[data-show-children="false"] > .bn-toggle-button')?.click();
              ancestor = ancestor.parentElement?.closest('.bn-block-outer') ?? null;
            }
            requestAnimationFrame(() => {
              const section = headingElement(heading.id)?.closest<HTMLElement>('.bn-block-content');
              section?.scrollIntoView({ behavior: 'instant', block: 'start' });
              section?.focus({ preventScroll: true });
            });
            setActiveHeading(heading.id);
          }}>{heading.text}</a>) : <small>No headings in this document.</small>}
      </nav>
    </details>
  </div>;
}
