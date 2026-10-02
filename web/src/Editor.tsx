// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { BlockNoteEditorOptions, DefaultInlineContentSchema, DefaultStyleSchema } from '@blocknote/core';
import { EmbedTab, FilePanel, FilePanelController, useCreateBlockNote, useDictionary, useEditorState, type FilePanelProps } from '@blocknote/react';
import { BlockNoteView } from '@blocknote/shadcn';
import { withCollaboration } from '@blocknote/core/yjs';
import { PrivateComments, type CommentState } from './PrivateComments';
import type { LiveSession } from './live';
import { DocumentEnd } from './document-end';
import { SelectAll } from './select-all';
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

export function Editor({ initialContent, editable, disabled = false, onChange, onValidationChange, uploadFile, uploadAvailable = false, resolveFileUrl, header, label = 'Document body', live, onCommentStateChange, sectionLinks = false, onSectionNavigate }: {
  initialContent: ContentEnvelope;
  sectionLinks?: boolean;
  onSectionNavigate?: (hash: string) => void;
  editable: boolean;
  disabled?: boolean;
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
  const visitedSection = useRef<string | null>(null);
  const callbacks = useRef({ onChange, onValidationChange, uploadFile, resolveFileUrl });
  callbacks.current = { onChange, onValidationChange, uploadFile, resolveFileUrl };
  const [error, setError] = useState<string | null>(null);
  const [activeHeading, setActiveHeading] = useState<string | null>(null);
  const [outlineOpen, setOutlineOpen] = useState(() => !matchMedia('(max-width: 980px)').matches);
  // Saving changes the comparison baseline, not this editor or its undo stack.
  // The parent remounts for an intentional navigation, restore, or discard.
  const [initial] = useState(() => validateContent(initialContent).content);
  const active = editable && !disabled;
  const [extensions] = useState(() => [DocumentEnd, SelectAll, ...(live?.extensions() ?? [])]);
  const options = {
    schema: contentSchema,
    extensions,
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
    // current authority after loading permissions or first Save without
    // rebuilding native undo history. It must exist even on a readonly mount.
    uploadFile: async (file: File) => {
      const upload = callbacks.current.uploadFile;
      if (!upload) throw new Error('Attachment upload is unavailable');
      return upload(file);
    },
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

  function sectionId(id: string) { return sectionLinks ? `section-${id}` : `${identifier}-${id}`; }

  function visitHeading(id: string) {
    const target = headingElement(id);
    if (!target) return;
    let ancestor = target.closest('.bn-block-outer')?.parentElement?.closest('.bn-block-outer');
    while (ancestor && container.current?.contains(ancestor)) {
      ancestor.querySelector<HTMLButtonElement>(':scope > .bn-block > .bn-block-content .bn-toggle-wrapper[data-show-children="false"] > .bn-toggle-button')?.click();
      ancestor = ancestor.parentElement?.closest('.bn-block-outer') ?? null;
    }
    requestAnimationFrame(() => {
      const destination = headingElement(id);
      if (!destination?.isConnected) return;
      if (editor.isEditable) {
        editor.setTextCursorPosition(id, 'start'); editor.focus();
      } else if (destination) {
        destination.tabIndex = -1; destination.focus({ preventScroll: true });
      }
      destination?.closest<HTMLElement>('.bn-block-content')?.scrollIntoView({ behavior: 'instant', block: 'start' });
    });
    setActiveHeading(id);
  }

  useEffect(() => {
    for (const heading of headings) {
      const element = headingElement(heading.id);
      if (element) element.id = sectionId(heading.id);
    }
    if (!sectionLinks) return;
    const documentLocation = location.pathname + location.search;
    const follow = () => {
      if (location.pathname + location.search !== documentLocation) return;
      const hash = location.hash;
      // Native updates and heading edits must not move the user's editing cursor.
      if (hash === visitedSection.current) return;
      visitedSection.current = hash;
      let destination: string;
      try { destination = decodeURIComponent(hash.slice(1)); } catch { return; }
      const heading = headings.find(heading => sectionId(heading.id) === destination);
      if (heading) visitHeading(heading.id);
    };
    follow();
    window.addEventListener('hashchange', follow); window.addEventListener('popstate', follow);
    return () => { window.removeEventListener('hashchange', follow); window.removeEventListener('popstate', follow); };
  }, [headings, editor, sectionLinks, editable]);

  useLayoutEffect(() => {
    // Mode/authority changes use the native view prop so block controls such
    // as checkboxes remount with current authority. A temporary request lock
    // uses the setter, avoiding a view remount during native UI callbacks.
    // Both keep the same editor instance and its undo history.
    editor.isEditable = active;
    const contenteditable = container.current?.querySelector<HTMLElement>('[role="textbox"]');
    contenteditable?.setAttribute('aria-readonly', String(!active));
    if (contenteditable) contenteditable.tabIndex = 0;
  }, [active, editable, editor]);
  useEffect(() => {
    const narrow = matchMedia('(max-width: 980px)');
    const resize = () => setOutlineOpen(!narrow.matches);
    resize(); narrow.addEventListener('change', resize);
    return () => narrow.removeEventListener('change', resize);
  }, []);
  useEffect(() => {
    const update = () => {
      let selected: string | null = null, passedTop = false;
      const atEnd = window.scrollY > 0 && Math.ceil(window.scrollY + innerHeight) >= document.documentElement.scrollHeight;
      for (const heading of headings) {
        const element = headingElement(heading.id);
        if (!element?.getClientRects().length) continue;
        const top = element.getBoundingClientRect().top;
        selected ??= heading.id;
        if (top < 160 || atEnd && top < innerHeight) { selected = heading.id; passedTop = true; }
      }
      setActiveHeading(previous => {
        // A short page cannot put every linked section near the viewport top.
        // Keep the explicit destination while it is visible and no section
        // has crossed the scroll threshold; the next scroll still updates it.
        const target = previous ? headingElement(previous)?.getBoundingClientRect() : null;
        return !passedTop && target && target.top >= 0 && target.bottom <= innerHeight ? previous : selected;
      });
    };
    update(); window.addEventListener('scroll', update, { passive: true, capture: true });
    return () => window.removeEventListener('scroll', update, true);
  }, [headings]);

  return <div className="editor-layout">
    <div className="editor-content">
      {header}
      <p id={`${identifier}-error`} className="editor-error" role="alert" hidden={!error}>{error}</p>
      <div ref={container} className="editor-mount" inert={disabled}>
        <UploadAvailability.Provider value={uploadAvailable}>
          <BlockNoteView<NativeBlockSchema, DefaultInlineContentSchema, DefaultStyleSchema>
          editor={editor} theme="dark" editable={editable} filePanel={false}
          formattingToolbar={active} slashMenu={active} sideMenu={active} tableHandles={active} emojiPicker={active}
          {...(live ? { comments: false } : {})} onChange={(current, { getChanges }) => {
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
          {active && <FilePanelController filePanel={DocumentFilePanel} />}
          {live && <PrivateComments writable={active} reactionStatus={live.snapshot().reactionStatus} {...(onCommentStateChange ? { onStateChange: onCommentStateChange } : {})} />}
        </BlockNoteView>
        </UploadAvailability.Provider>
      </div>
    </div>
    <details className="editor-outline" open={outlineOpen} onToggle={event => setOutlineOpen(event.currentTarget.open)}>
      <summary>On this page</summary>
      <nav aria-label="On this page">
        {headings.length ? headings.map(heading => <a key={heading.id}
          href={`#${encodeURIComponent(sectionId(heading.id))}`}
          className={heading.level > 2 || heading.depth > 0 ? 'outline-subheading' : undefined}
          aria-current={activeHeading === heading.id ? 'location' : undefined}
          onClick={event => {
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            if (sectionLinks) {
              const hash = `#${encodeURIComponent(sectionId(heading.id))}`;
              visitedSection.current = hash;
              if (onSectionNavigate) onSectionNavigate(hash);
              else if (location.hash !== hash) location.hash = hash;
            }
            visitHeading(heading.id);
          }}>{heading.text}</a>) : <small>No headings in this document.</small>}
      </nav>
    </details>
  </div>;
}
