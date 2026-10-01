// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { BlockNoteEditorOptions, DefaultInlineContentSchema, DefaultStyleSchema } from '@blocknote/core';
import { EmbedTab, FilePanel, FilePanelController, useCreateBlockNote, useDictionary, useEditorState, type FilePanelProps } from '@blocknote/react';
import { BlockNoteView } from '@blocknote/shadcn';
import { withCollaboration } from '@blocknote/core/yjs';
import { PrivateComments, type CommentState } from './PrivateComments';
import type { LiveSession } from './live';
import { contentSchema, isSafeLinkUrl, validateContent, type ContentEnvelope, type NativeBlock, type NativeBlockSchema } from '@scrawl/content';

type Heading = { id: string; text: string; level: number; depth: number };
const UploadAvailability = createContext(false);

function DocumentFilePanel(props: FilePanelProps) {
  const available = useContext(UploadAvailability), dictionary = useDictionary();
  return <FilePanel<NativeBlockSchema, DefaultInlineContentSchema, DefaultStyleSchema> {...props}
    {...(available ? {} : { tabs: [{ name: dictionary.file_panel.embed.title, tabPanel: <EmbedTab blockId={props.blockId} /> }] })} />;
}

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

export function Editor({ initialContent, editable, onChange, onValidationChange, uploadFile, uploadAvailable = false, resolveFileUrl, header, label = 'Document body', live, onCommentStateChange }: {
  initialContent: ContentEnvelope;
  editable: boolean;
  onChange: (content: ContentEnvelope) => void;
  onValidationChange?: (error: string | null) => void;
  uploadFile?: (file: File) => Promise<string>;
  uploadAvailable?: boolean;
  resolveFileUrl?: (url: string) => Promise<string>;
  header?: ReactNode;
  label?: string;
  live?: LiveSession;
  onCommentStateChange?: (state: CommentState) => void;
}) {
  const identifier = `editor-${useId().replace(/[^a-zA-Z0-9_-]/g, '-')}`;
  const container = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onChange, onValidationChange, uploadFile, resolveFileUrl });
  callbacks.current = { onChange, onValidationChange, uploadFile, resolveFileUrl };
  const [error, setError] = useState<string | null>(null);
  const [activeHeading, setActiveHeading] = useState<string | null>(null);
  const [outlineOpen, setOutlineOpen] = useState(true);
  // Saving changes the comparison baseline, not this editor or its undo stack.
  // The parent remounts for an intentional navigation, restore, or discard.
  const [initial] = useState(() => validateContent(initialContent).content);
  const [initialEditable] = useState(editable);
  const [extensions] = useState(() => live?.extensions() ?? []);
  const options = {
    schema: contentSchema,
    initialContent: initial.document,
    domAttributes: {
      editor: {
        role: 'textbox', 'aria-label': label, 'aria-multiline': 'true',
        'aria-describedby': `${identifier}-error`,
      },
    },
    links: { isValidLink: isSafeLinkUrl },
    tables: { splitCells: true, cellBackgroundColor: true, cellTextColor: true, headers: true },
    // The supplied hook is readonly after creation. Its stable adapter consults
    // current authority after first Save without rebuilding native undo history.
    ...(uploadFile ? { uploadFile: async (file: File) => {
      const upload = callbacks.current.uploadFile;
      if (!upload) throw new Error('Attachment upload is unavailable');
      return upload(file);
    } } : {}),
    resolveFileUrl: async url => callbacks.current.resolveFileUrl?.(url) ?? url,
  } satisfies Partial<BlockNoteEditorOptions<NativeBlockSchema, DefaultInlineContentSchema, DefaultStyleSchema>>;
  const editor = useCreateBlockNote(live ? withCollaboration({ ...options, extensions,
    collaboration: { fragment: live.fragment, provider: { awareness: live.awareness }, user: { name: live.user.name, color: '#91ad95' } },
  }) : options);
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

  useLayoutEffect(() => {
    // BlockNote 0.55 remounts the view when its editable prop changes. Its link
    // UI can then receive an update before the new view exists. The public
    // setter locks the mounted editor without interrupting UI or undo history.
    editor.isEditable = editable;
    const contenteditable = container.current?.querySelector<HTMLElement>('[role="textbox"]');
    contenteditable?.setAttribute('aria-readonly', String(!editable));
    if (contenteditable) contenteditable.tabIndex = 0;
  }, [editable, editor]);
  useEffect(() => {
    const narrow = matchMedia('(max-width: 980px)');
    const resize = () => setOutlineOpen(!narrow.matches);
    resize(); narrow.addEventListener('change', resize);
    return () => narrow.removeEventListener('change', resize);
  }, []);
  useEffect(() => {
    const update = () => {
      let selected: string | null = null;
      for (const heading of headings) {
        const element = headingElement(heading.id);
        if (!element?.getClientRects().length) continue;
        selected ??= heading.id;
        if (element.getBoundingClientRect().top < 160) selected = heading.id;
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
        <UploadAvailability.Provider value={uploadAvailable}>
          <BlockNoteView<NativeBlockSchema, DefaultInlineContentSchema, DefaultStyleSchema>
          editor={editor} theme="dark" editable={initialEditable} filePanel={false} {...(live ? { comments: false } : {})} onChange={(current, { getChanges }) => {
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
          catch { message = live
            ? 'This document cannot be saved because its content is invalid or exceeds the limits. Your complete local work is retained. Undo your changes before reconnecting.'
            : 'This document cannot be saved because its content is invalid or exceeds the document limits. Your complete local edits are retained. Undo the change or discard your unsaved edits.'; }
          setError(message);
          callbacks.current.onValidationChange?.(message);
        }}>
          {editable && <FilePanelController filePanel={DocumentFilePanel} />}
          {live && <PrivateComments writable={editable} reactionStatus={live.snapshot().reactionStatus} {...(onCommentStateChange ? { onStateChange: onCommentStateChange } : {})} />}
        </BlockNoteView>
        </UploadAvailability.Provider>
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
              const destination = headingElement(heading.id);
              if (editor.isEditable) {
                editor.setTextCursorPosition(heading.id, 'start');
                editor.focus();
              } else if (destination) {
                // A read-only editor cannot accept a native editing cursor.
                // Move keyboard focus to the actual section instead.
                destination.tabIndex = -1; destination.focus({ preventScroll: true });
              }
              const section = destination?.closest<HTMLElement>('.bn-block-content');
              section?.scrollIntoView({ behavior: 'instant', block: 'start' });
            });
            setActiveHeading(heading.id);
          }}>{heading.text}</a>) : <small>No headings in this document.</small>}
      </nav>
    </details>
  </div>;
}
