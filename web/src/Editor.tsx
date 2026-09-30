// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Extension, type Editor as TiptapEditor } from '@tiptap/core';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import { Plugin } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import * as Toolbar from '@radix-ui/react-toolbar';
import * as Popover from '@radix-ui/react-popover';
import { Bold, Italic, Code, Link, List, ListOrdered, Undo2, Redo2, Unlink, X } from 'lucide-react';
import { CONTENT_LIMITS, validateContent, type ContentEnvelope } from '@scrawl/content';
import { restrictedExtensions } from './editor/extensions.js';
import { supportedHTML, validLink } from './editor/clipboard.js';
import 'prosemirror-view/style/prosemirror.css';

type Heading = { id: string; text: string; level: number };

export function Editor({ initialContent, editable, onChange, onValidationChange, header, label = 'Document body' }: {
  initialContent: ContentEnvelope;
  editable: boolean;
  onChange: (content: ContentEnvelope) => void;
  onValidationChange?: (error: string | null) => void;
  header?: ReactNode;
  label?: string;
}) {
  const identifier = `editor-${useId().replace(/[^a-zA-Z0-9_-]/g, '-')}`;
  // Saved baseline updates do not replace local content or Tiptap undo history.
  // The parent remounts only for an intentional replacement or discard.
  const [initial] = useState(() => validateContent(initialContent).content);
  const callbacks = useRef({ onChange, onValidationChange });
  const mayEdit = useRef(editable);
  const editorRef = useRef<TiptapEditor | null>(null);
  const plainPaste = useRef(false);
  const linkInput = useRef<HTMLInputElement>(null);
  const linkSelection = useRef<{ from: number; to: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeHeading, setActiveHeading] = useState<string | null>(null);
  const [outlineOpen, setOutlineOpen] = useState(true);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkValue, setLinkValue] = useState('');
  const [linkError, setLinkError] = useState<string | null>(null);
  const [editingLink, setEditingLink] = useState(false);
  callbacks.current = { onChange, onValidationChange };
  mayEdit.current = editable;

  function validation(message: string | null) {
    setError(message);
    callbacks.current.onValidationChange?.(message);
  }

  function redrawAcceptedState() {
    // Browser input can change contenteditable DOM before its transaction.
    queueMicrotask(() => {
      const current = editorRef.current;
      if (current && !current.isDestroyed) current.view.updateState(current.state);
    });
  }

  const [extensions] = useState(() => [
    ...restrictedExtensions,
    Extension.create({
      name: 'scrawlContentGuard',
      addProseMirrorPlugins() {
        return [new Plugin({
          filterTransaction(transaction) {
            if (!transaction.docChanged) return true;
            if (!mayEdit.current) { redrawAcceptedState(); return false; }
            try {
              validateContent({ format: 'prosemirror-json', schemaVersion: 1, document: transaction.doc.toJSON() });
              return true;
            } catch {
              validation('This edit was rejected because the content is unsupported or exceeds its size, depth, or node limit. Your previous document is retained.');
              redrawAcceptedState();
              return false;
            }
          },
        })];
      },
    }),
  ]);

  const editor = useEditor({
    extensions,
    content: initial.document,
    editable,
    // This Vite app renders only in the browser. Creating the editor immediately
    // gives useEditorState a real initial snapshot, before any edit or focus.
    immediatelyRender: true,
    injectCSS: false,
    shouldRerenderOnTransaction: false,
    enableContentCheck: true,
    enableInputRules: false,
    enablePasteRules: false,
    enableCoreExtensions: { textDirection: false },
    editorProps: {
      attributes: {
        role: 'textbox', 'aria-label': label, 'aria-multiline': 'true',
        'aria-readonly': String(!editable), 'aria-describedby': `${identifier}-error`, tabindex: '0',
      },
      decorations(state) {
        const headings: Decoration[] = [];
        state.doc.descendants((node, position) => {
          if (node.type.name === 'heading') headings.push(Decoration.node(position, position + node.nodeSize, {
            id: `${identifier}-heading-${position}`, tabindex: '-1',
          }));
        });
        return DecorationSet.create(state.doc, headings);
      },
      handleKeyDown: (_view, event) => {
        plainPaste.current = (event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'v';
        return false;
      },
      handleDOMEvents: {
        paste: (view, event) => {
          const plain = plainPaste.current;
          plainPaste.current = false;
          if (rejectClipboard(event.clipboardData, event, plain)) return true;
          if (plain && event.clipboardData) {
            event.preventDefault();
            view.pasteText(event.clipboardData.getData('text/plain'), event);
            return true;
          }
          return false;
        },
        drop: (_view, event) => rejectClipboard(event.dataTransfer, event),
      },
      // ProseMirror classifies rapid repeated clicks independently of clicks in
      // the toolbar/popover. Existing links remain editable for each click kind.
      handleClick: editClickedLink,
      handleDoubleClick: editClickedLink,
      handleTripleClick: editClickedLink,
    },
    onUpdate({ editor: current }) {
      const content = validateContent({ format: 'prosemirror-json', schemaVersion: 1, document: current.getJSON() }).content;
      validation(null);
      callbacks.current.onChange(content);
    },
  });
  editorRef.current = editor;

  const selection = useEditorState({
    editor,
    selector: ({ editor: current }) => {
      if (!current) return null;
      const parent = current.state.selection.$from.parent;
      let list: string | null = null, start = 1;
      for (let depth = current.state.selection.$from.depth; depth > 0; depth--) {
        const ancestor = current.state.selection.$from.node(depth);
        if (ancestor.type.name === 'bulletList' || ancestor.type.name === 'orderedList') {
          list = ancestor.type.name; start = Number(ancestor.attrs.start ?? 1); break;
        }
      }
      const headings: Heading[] = [];
      current.state.doc.descendants((node, position) => {
        if (node.type.name === 'heading') headings.push({ id: `${identifier}-heading-${position}`, text: node.textContent || 'Untitled section', level: Number(node.attrs.level) });
      });
      return {
        block: parent.type.name === 'heading' ? `heading-${String(parent.attrs.level)}` : parent.type.name,
        bold: current.isActive('bold'), italic: current.isActive('italic'), code: current.isActive('code'),
        link: current.isActive('link'), list, start,
        language: typeof parent.attrs.language === 'string' ? parent.attrs.language : '',
        undo: current.can().undo(), redo: current.can().redo(), headings,
      };
    },
  });
  const headings = selection?.headings ?? [];

  useEffect(() => {
    if (editor && editor.isEditable !== editable) editor.setEditable(editable, false);
    if (!editable) setLinkOpen(false);
  }, [editor, editable]);
  useEffect(() => {
    const narrow = matchMedia('(max-width: 980px)');
    const resize = () => setOutlineOpen(!narrow.matches);
    resize(); narrow.addEventListener('change', resize);
    return () => narrow.removeEventListener('change', resize);
  }, []);
  useEffect(() => {
    const update = () => {
      let selected = headings[0]?.id ?? null;
      for (const heading of headings) if ((document.getElementById(heading.id)?.getBoundingClientRect().top ?? Infinity) < 160) selected = heading.id;
      setActiveHeading(selected);
    };
    update(); window.addEventListener('scroll', update, { passive: true, capture: true });
    return () => window.removeEventListener('scroll', update, true);
  }, [headings]);

  function rejectClipboard(transfer: DataTransfer | null, event: ClipboardEvent | DragEvent, plain = false) {
    if (!transfer) return false;
    const html = transfer.getData('text/html'), text = transfer.getData('text/plain');
    if (transfer.files.length || new TextEncoder().encode(plain ? text : html || text).byteLength > CONTENT_LIMITS.maxBytes
      || (!plain && html && !supportedHTML(html))) {
      event.preventDefault();
      validation('Paste was rejected. Unsupported formatting, files, links, or oversized content cannot be inserted. Use plain-text paste for text only.');
      return true;
    }
    return false;
  }

  function block(value: string) {
    if (!editor || !editable) return;
    if (/^heading-[1-6]$/.test(value)) {
      const level = Number(value.slice(8));
      if (level === 1 || level === 2 || level === 3 || level === 4 || level === 5 || level === 6) editor.chain().focus().setHeading({ level }).run();
    } else if (value === 'codeBlock') editor.chain().focus().setCodeBlock().run();
    else editor.chain().focus().setParagraph().run();
  }

  function openLink() {
    const current = editorRef.current;
    if (!current || !mayEdit.current) return;
    // Radix owns focus while this form is open. Tiptap's deferred focus() would
    // steal focus after keyboard activation and dismiss the popover immediately.
    current.commands.extendMarkRange('link');
    const { from, to } = current.state.selection;
    linkSelection.current = { from, to };
    const href: unknown = current.getAttributes('link').href;
    setEditingLink(current.isActive('link'));
    setLinkValue(typeof href === 'string' ? href : '');
    setLinkError(null);
    setLinkOpen(true);
  }

  function editClickedLink(view: EditorView, position: number, event: MouseEvent) {
    const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!mayEdit.current || !anchor || !view.dom.contains(anchor)) return false;
    event.preventDefault();
    editorRef.current?.commands.setTextSelection(position);
    openLink();
    return true;
  }

  function applyLink(remove = false) {
    if (!editor || !editable || !linkSelection.current) return;
    if (!remove && !validLink(linkValue)) {
      setLinkError('Use an absolute HTTP, HTTPS, or mailto URL without spaces, credentials, or control characters.');
      linkInput.current?.focus();
      return;
    }
    const chain = editor.chain().focus().setTextSelection(linkSelection.current).extendMarkRange('link');
    if (remove) chain.unsetLink().run();
    else chain.setLink({ href: linkValue }).run();
    setLinkOpen(false);
  }

  const codeBlock = selection?.block === 'codeBlock';

  return <div className="editor-layout">
    <div className="editor-content">
      {header}
      {editable && <>
        <Toolbar.Root className="editor-toolbar" aria-label="Document formatting" loop>
          <select aria-label="Text style" value={selection?.block ?? 'paragraph'} onChange={event => block(event.target.value)} disabled={!editor}>
            <option value="paragraph">Paragraph</option>
            {[1, 2, 3, 4, 5, 6].map(level => <option key={level} value={`heading-${level}`}>Heading {level}</option>)}
            <option value="codeBlock">Code block</option>
          </select>
          <Toolbar.Separator className="editor-toolbar-separator" />
          <Toolbar.Button aria-label="Bold" title="Bold (Ctrl/Cmd+B)" aria-pressed={selection?.bold ?? false} disabled={!editor || codeBlock} onMouseDown={event => event.preventDefault()} onClick={() => editor?.chain().focus().toggleBold().run()}><Bold size={17} aria-hidden="true" /></Toolbar.Button>
          <Toolbar.Button aria-label="Italic" title="Italic (Ctrl/Cmd+I)" aria-pressed={selection?.italic ?? false} disabled={!editor || codeBlock} onMouseDown={event => event.preventDefault()} onClick={() => editor?.chain().focus().toggleItalic().run()}><Italic size={17} aria-hidden="true" /></Toolbar.Button>
          <Toolbar.Button aria-label="Inline code" title="Inline code (Ctrl/Cmd+E)" aria-pressed={selection?.code ?? false} disabled={!editor || codeBlock} onMouseDown={event => event.preventDefault()} onClick={() => editor?.chain().focus().toggleCode().run()}><Code size={17} aria-hidden="true" /></Toolbar.Button>
          <Popover.Root open={linkOpen} onOpenChange={open => open ? openLink() : setLinkOpen(false)}>
            <Toolbar.Button asChild>
              <Popover.Trigger aria-label="Link" title="Add or edit link" aria-pressed={selection?.link ?? false} disabled={!editor || codeBlock} onMouseDown={event => event.preventDefault()}><Link size={17} aria-hidden="true" /></Popover.Trigger>
            </Toolbar.Button>
            <Popover.Portal>
              <Popover.Content className="editor-link-editor" aria-label="Edit link" align="start" sideOffset={8} collisionPadding={12}
                onOpenAutoFocus={event => { event.preventDefault(); linkInput.current?.focus(); }}
                onCloseAutoFocus={event => { event.preventDefault(); if (editor && !editor.isDestroyed && linkSelection.current) editor.chain().focus().setTextSelection(linkSelection.current).run(); }}>
                <form onSubmit={event => { event.preventDefault(); applyLink(); }}>
                  <div className="editor-link-heading"><h2>{editingLink ? 'Edit link' : 'Add link'}</h2><Popover.Close type="button" aria-label="Close link editor" className="icon-button"><X size={16} aria-hidden="true" /></Popover.Close></div>
                  <label htmlFor={`${identifier}-url`}>Link URL</label>
                  <input id={`${identifier}-url`} ref={linkInput} value={linkValue} onChange={event => { setLinkValue(event.target.value); setLinkError(null); }} maxLength={CONTENT_LIMITS.maxHrefLength} placeholder="https://example.test" autoComplete="off" spellCheck={false} aria-invalid={Boolean(linkError)} aria-describedby={`${identifier}-link-help${linkError ? ` ${identifier}-link-error` : ''}`} />
                  <p id={`${identifier}-link-help`} className="editor-link-help">{linkSelection.current?.from === linkSelection.current?.to ? 'Select document text to add a link.' : 'HTTP, HTTPS, or mailto. Applies to selected text.'}</p>
                  {linkError && <p id={`${identifier}-link-error`} className="editor-link-error" role="alert">{linkError}</p>}
                  <div className="editor-link-actions">
                    {editingLink && <button type="button" className="editor-remove-link" onClick={() => applyLink(true)}><Unlink size={15} aria-hidden="true" />Remove link</button>}
                    <Popover.Close type="button">Cancel</Popover.Close>
                    <button type="submit" className="primary" disabled={!linkSelection.current || linkSelection.current.from === linkSelection.current.to}>Apply link</button>
                  </div>
                </form>
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
          <Toolbar.Separator className="editor-toolbar-separator" />
          <Toolbar.Button aria-label="Bulleted list" title="Bulleted list" aria-pressed={selection?.list === 'bulletList'} disabled={!editor} onMouseDown={event => event.preventDefault()} onClick={() => editor?.chain().focus().toggleBulletList().run()}><List size={17} aria-hidden="true" /></Toolbar.Button>
          <Toolbar.Button aria-label="Numbered list" title="Numbered list" aria-pressed={selection?.list === 'orderedList'} disabled={!editor} onMouseDown={event => event.preventDefault()} onClick={() => editor?.chain().focus().toggleOrderedList().run()}><ListOrdered size={17} aria-hidden="true" /></Toolbar.Button>
          <Toolbar.Separator className="editor-toolbar-separator" />
          <Toolbar.Button aria-label="Undo" title="Undo (Ctrl/Cmd+Z)" disabled={!selection?.undo} onMouseDown={event => event.preventDefault()} onClick={() => editor?.chain().focus().undo().run()}><Undo2 size={17} aria-hidden="true" /></Toolbar.Button>
          <Toolbar.Button aria-label="Redo" title="Redo (Ctrl/Cmd+Shift+Z)" disabled={!selection?.redo} onMouseDown={event => event.preventDefault()} onClick={() => editor?.chain().focus().redo().run()}><Redo2 size={17} aria-hidden="true" /></Toolbar.Button>
        </Toolbar.Root>
        {codeBlock && <label className="editor-note">Code language <input aria-label="Code language" value={selection?.language ?? ''} maxLength={64} onChange={event => editor?.commands.updateAttributes('codeBlock', { language: event.target.value || null })} /></label>}
        {selection?.list === 'orderedList' && <label className="editor-note">List starts at <input aria-label="Numbered list start" type="number" min="1" max="2147483647" value={selection.start} onChange={event => { const start = Number(event.target.value); if (Number.isInteger(start) && start >= 1 && start <= 2_147_483_647) editor?.commands.updateAttributes('orderedList', { start }); }} /></label>}
      </>}
      <p id={`${identifier}-error`} className="editor-error" role="alert" hidden={!error}>{error}</p>
      <EditorContent className="editor-mount" editor={editor} />
    </div>
    <details className="editor-outline" open={outlineOpen} onToggle={event => setOutlineOpen(event.currentTarget.open)}>
      <summary>On this page</summary>
      <nav aria-label="On this page">
        {headings.length ? headings.map(heading => <a key={heading.id} href={`#${heading.id}`} className={heading.level > 2 ? 'outline-subheading' : undefined} aria-current={activeHeading === heading.id ? 'location' : undefined} onClick={event => { event.preventDefault(); const target = document.getElementById(heading.id); target?.scrollIntoView({ behavior: 'instant', block: 'start' }); target?.focus({ preventScroll: true }); }}>{heading.text}</a>) : <small>No headings in this document.</small>}
      </nav>
    </details>
  </div>;
}
