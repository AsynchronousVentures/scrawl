// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Schema, type MarkSpec, type NodeSpec, type Node as NativeNode } from 'prosemirror-model';
import { EditorState, type Command } from 'prosemirror-state';
import { Decoration, DecorationSet, EditorView } from 'prosemirror-view';
import { baseKeymap, newlineInCode, setBlockType, toggleMark } from 'prosemirror-commands';
import { history, undo, redo } from 'prosemirror-history';
import { keymap } from 'prosemirror-keymap';
import { liftListItem, sinkListItem, splitListItemKeepMarks, wrapInList } from 'prosemirror-schema-list';
import { CONTENT_LIMITS, contentSchema, validateContent, type ContentEnvelope } from '@scrawl/content';
import 'prosemirror-view/style/prosemirror.css';

// DOM representations belong to the editor. Grammar, attributes, validation,
// and mark ordering come from the same public content contract as the server.
const nodeDOM: Record<string, Pick<NodeSpec, 'toDOM' | 'parseDOM'>> = {
  paragraph: { toDOM: () => ['p', 0], parseDOM: [{ tag: 'p' }] },
  heading: {
    toDOM: node => [`h${String(node.attrs.level)}`, 0],
    parseDOM: [1, 2, 3, 4, 5, 6].map(level => ({ tag: `h${level}`, attrs: { level } })),
  },
  bulletList: { toDOM: () => ['ul', 0], parseDOM: [{ tag: 'ul' }] },
  orderedList: {
    toDOM: node => ['ol', { start: String(node.attrs.start) }, 0],
    parseDOM: [{ tag: 'ol', getAttrs: element => ({ start: Number(element.getAttribute('start') ?? 1) }) }],
  },
  listItem: { toDOM: () => ['li', 0], parseDOM: [{ tag: 'li' }] },
  codeBlock: {
    toDOM: node => ['pre', ['code', node.attrs.language === null ? {} : { 'data-language': String(node.attrs.language) }, 0]],
    parseDOM: [{
      tag: 'pre', preserveWhitespace: 'full', contentElement: 'code',
      getAttrs: element => ({ language: element.querySelector('code')?.getAttribute('data-language') ?? null }),
    }],
  },
  hardBreak: { toDOM: () => ['br'], parseDOM: [{ tag: 'br' }] },
};
const markDOM: Record<string, Pick<MarkSpec, 'toDOM' | 'parseDOM'>> = {
  bold: { toDOM: () => ['strong', 0], parseDOM: [{ tag: 'strong' }, { tag: 'b' }] },
  italic: { toDOM: () => ['em', 0], parseDOM: [{ tag: 'em' }, { tag: 'i' }] },
  code: { toDOM: () => ['code', 0], parseDOM: [{ tag: 'code' }] },
  link: {
    toDOM: mark => ['a', { href: String(mark.attrs.href), target: '_blank', rel: 'noopener noreferrer' }, 0],
    parseDOM: [{ tag: 'a[href]', getAttrs: element => ({ href: element.getAttribute('href') }) }],
  },
};
let nodes = contentSchema.spec.nodes;
let marks = contentSchema.spec.marks;
nodes.forEach((name, spec) => { nodes = nodes.update(name, { ...spec, ...nodeDOM[name] }); });
marks.forEach((name, spec) => { marks = marks.update(name, { ...spec, ...markDOM[name] }); });
const editorSchema = new Schema({ nodes, marks });

type Heading = { id: string; text: string; level: number };
type Selection = { block: string; bold: boolean; italic: boolean; code: boolean; list: string | null; language: string; start: number };
const emptySelection: Selection = { block: 'paragraph', bold: false, italic: false, code: false, list: null, language: '', start: 1 };

function validLink(href: string): boolean {
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

/** Check raw clipboard markup before the native parser can discard anything. */
function supportedHTML(html: string): boolean {
  const allowed = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'PRE', 'CODE', 'BR', 'STRONG', 'B', 'EM', 'I', 'A']);
  const parsed = document.createElement('template');
  parsed.innerHTML = html;
  for (const element of parsed.content.querySelectorAll('*')) {
    if (!allowed.has(element.tagName)) return false;
    for (const attribute of element.attributes) {
      const name = attribute.name;
      // ProseMirror supplies slice context for native copy/paste. It does not
      // become an attribute in persisted JSON.
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

export function Editor({ initialContent, editable, onChange, onValidationChange, header, label = 'Document body' }: {
  initialContent: ContentEnvelope;
  editable: boolean;
  onChange: (content: ContentEnvelope) => void;
  onValidationChange?: (error: string | null) => void;
  header?: ReactNode;
  label?: string;
}) {
  const identifier = `editor-${useId().replace(/[^a-zA-Z0-9_-]/g, '-')}`;
  const mount = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const initial = useRef(initialContent);
  const callbacks = useRef({ onChange, onValidationChange });
  const mayEdit = useRef(editable);
  const linkInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState(emptySelection);
  const [headings, setHeadings] = useState<Heading[]>([]);
  const [activeHeading, setActiveHeading] = useState<string | null>(null);
  const [outlineOpen, setOutlineOpen] = useState(true);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkValue, setLinkValue] = useState('');
  callbacks.current = { onChange, onValidationChange };
  mayEdit.current = editable;

  useEffect(() => {
    if (!mount.current) return;
    function validation(message: string | null) {
      setError(message);
      callbacks.current.onValidationChange?.(message);
    }
    function updatePresentation(current: EditorView) {
      const nextHeadings: Heading[] = [];
      current.state.doc.descendants((node, position) => {
        if (node.type.name !== 'heading') return;
        const id = `${identifier}-heading-${position}`;
        nextHeadings.push({ id, text: node.textContent || 'Untitled section', level: Number(node.attrs.level) });
      });
      setHeadings(nextHeadings);
      const { $from, from, to, empty } = current.state.selection;
      const applied = current.state.storedMarks ?? $from.marks();
      const active = (name: string) => {
        const mark = editorSchema.marks[name]!;
        return empty ? applied.some(item => item.type === mark) : current.state.doc.rangeHasMark(from, to, mark);
      };
      let list: string | null = null, start = 1;
      for (let depth = $from.depth; depth > 0; depth--) {
        const ancestor = $from.node(depth);
        if (ancestor.type.name === 'bulletList' || ancestor.type.name === 'orderedList') {
          list = ancestor.type.name; start = Number(ancestor.attrs.start ?? 1); break;
        }
      }
      setSelection({
        block: $from.parent.type.name === 'heading' ? `heading-${String($from.parent.attrs.level)}` : $from.parent.type.name,
        bold: active('bold'), italic: active('italic'), code: active('code'), list,
        language: typeof $from.parent.attrs.language === 'string' ? $from.parent.attrs.language : '', start,
      });
    }
    let native: NativeNode;
    try {
      native = editorSchema.nodeFromJSON(validateContent(initial.current).content.document);
      native.check();
    } catch {
      validation('This content is unsupported. The editor has not changed or discarded it.');
      return;
    }
    let plainPaste = false;
    function clipboard(event: ClipboardEvent | DragEvent): boolean {
      const transfer = event instanceof ClipboardEvent ? event.clipboardData : event.dataTransfer;
      if (!transfer) return false;
      const html = transfer.getData('text/html');
      const text = transfer.getData('text/plain');
      const plain = plainPaste && event instanceof ClipboardEvent;
      plainPaste = false;
      if (transfer.files.length || new TextEncoder().encode(plain ? text : html || text).byteLength > CONTENT_LIMITS.maxBytes
        || (!plain && html && !supportedHTML(html))) {
        event.preventDefault();
        validation('Paste was rejected. Unsupported formatting, files, links, or oversized content cannot be inserted. Use plain-text paste for text only.');
        return true;
      }
      return false;
    }
    const current = new EditorView(mount.current, {
      state: EditorState.create({
        doc: native,
        plugins: [
          history(),
          keymap({
            'Mod-z': undo, 'Mod-Shift-z': redo, 'Mod-y': redo,
            'Mod-b': toggleMark(editorSchema.marks.bold!), 'Mod-i': toggleMark(editorSchema.marks.italic!),
            'Mod-`': toggleMark(editorSchema.marks.code!),
            Enter: splitListItemKeepMarks(editorSchema.nodes.listItem!),
            'Mod-[': liftListItem(editorSchema.nodes.listItem!), 'Mod-]': sinkListItem(editorSchema.nodes.listItem!),
            'Shift-Enter': (state, dispatch) => {
              if (state.selection.$from.parent.type.name === 'codeBlock') return newlineInCode(state, dispatch);
              dispatch?.(state.tr.replaceSelectionWith(editorSchema.nodes.hardBreak!.create()).scrollIntoView());
              return true;
            },
          }),
          keymap(baseKeymap),
        ],
      }),
      editable: () => mayEdit.current,
      attributes: { role: 'textbox', 'aria-label': label, 'aria-multiline': 'true', 'aria-readonly': String(!mayEdit.current), 'aria-describedby': `${identifier}-error`, tabindex: '0' },
      decorations(state) {
        const decorated: Decoration[] = [];
        state.doc.descendants((node, position) => {
          if (node.type.name === 'heading') decorated.push(Decoration.node(position, position + node.nodeSize, {
            id: `${identifier}-heading-${position}`, tabindex: '-1',
          }));
        });
        return DecorationSet.create(state.doc, decorated);
      },
      handleDOMEvents: { paste: (_current, event) => clipboard(event), drop: (_current, event) => clipboard(event) },
      handleKeyDown: (_current, event) => { plainPaste = (event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'v'; return false; },
      dispatchTransaction(transaction) {
        if (transaction.docChanged && !mayEdit.current) { current.updateState(current.state); return; }
        const next = current.state.apply(transaction);
        let content: ContentEnvelope | undefined;
        if (transaction.docChanged) {
          try {
            content = validateContent({ format: 'prosemirror-json', schemaVersion: 1, document: next.doc.toJSON() }).content;
          } catch {
            current.updateState(current.state);
            validation('This edit was rejected because the content is unsupported or exceeds its size, depth, or node limit. Your previous document is retained.');
            return;
          }
        }
        current.updateState(next);
        updatePresentation(current);
        if (content) { validation(null); callbacks.current.onChange(content); }
      },
    });
    view.current = current;
    updatePresentation(current);
    return () => { view.current = null; current.destroy(); };
    // Snapshot replacement is deliberate: the parent supplies a new React key.
    // Changes to initialContent never replace local edits in an existing view.
  }, [identifier]);

  useEffect(() => {
    view.current?.setProps({ editable: () => editable, attributes: { role: 'textbox', 'aria-label': label, 'aria-multiline': 'true', 'aria-readonly': String(!editable), 'aria-describedby': `${identifier}-error`, tabindex: '0' } });
    if (!editable) setLinkOpen(false);
  }, [editable, identifier, label]);
  useEffect(() => { if (linkOpen) linkInput.current?.focus(); }, [linkOpen]);
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

  function command(operation: Command) {
    const current = view.current;
    if (!current || !editable) return;
    operation(current.state, current.dispatch, current);
    current.focus();
  }
  function block(value: string) {
    if (value.startsWith('heading-')) command(setBlockType(editorSchema.nodes.heading!, { level: Number(value.slice(8)) }));
    else if (value === 'codeBlock') command(setBlockType(editorSchema.nodes.codeBlock!, { language: null }));
    else command(setBlockType(editorSchema.nodes.paragraph!));
  }
  function changeListStart(value: string) {
    const start = Number(value), current = view.current;
    if (!current || !Number.isInteger(start) || start < 1 || start > 2_147_483_647) return;
    for (let depth = current.state.selection.$from.depth; depth > 0; depth--) {
      if (current.state.selection.$from.node(depth).type.name === 'orderedList') {
        current.dispatch(current.state.tr.setNodeMarkup(current.state.selection.$from.before(depth), undefined, { start }));
        return;
      }
    }
  }
  function changeLanguage(value: string) {
    const current = view.current;
    if (!current || !editable) return;
    setBlockType(editorSchema.nodes.codeBlock!, { language: value || null })(current.state, current.dispatch, current);
  }
  function applyLink(remove = false) {
    const current = view.current;
    if (!current || !editable) return;
    if (!remove && !validLink(linkValue)) {
      const message = 'Enter an absolute HTTP, HTTPS, or mailto URL without spaces, credentials, or control characters.';
      setError(message); callbacks.current.onValidationChange?.(message); return;
    }
    const { from, to, empty } = current.state.selection;
    let transaction = current.state.tr;
    const type = editorSchema.marks.link!;
    if (remove) transaction = empty ? transaction.removeStoredMark(type) : transaction.removeMark(from, to, type);
    else {
      const mark = type.create({ href: linkValue });
      transaction = empty ? transaction.addStoredMark(mark) : transaction.addMark(from, to, mark);
    }
    current.dispatch(transaction); setLinkOpen(false); current.focus();
    if (empty) { setError(null); callbacks.current.onValidationChange?.(null); }
  }

  return <div className="editor-layout">
    <div className="editor-content">
      {header}
      {editable && <>
        <div className="editor-toolbar" role="group" aria-label="Document formatting">
          <select aria-label="Text style" value={selection.block} onChange={event => block(event.target.value)}>
            <option value="paragraph">Paragraph</option>
            {[1, 2, 3, 4, 5, 6].map(level => <option key={level} value={`heading-${level}`}>Heading {level}</option>)}
            <option value="codeBlock">Code block</option>
          </select>
          <button type="button" aria-label="Bold" aria-pressed={selection.bold} disabled={selection.block === 'codeBlock'} onMouseDown={event => event.preventDefault()} onClick={() => command(toggleMark(editorSchema.marks.bold!))}><b>B</b></button>
          <button type="button" aria-label="Italic" aria-pressed={selection.italic} disabled={selection.block === 'codeBlock'} onMouseDown={event => event.preventDefault()} onClick={() => command(toggleMark(editorSchema.marks.italic!))}><i>I</i></button>
          <button type="button" aria-label="Inline code" aria-pressed={selection.code} disabled={selection.block === 'codeBlock'} onMouseDown={event => event.preventDefault()} onClick={() => command(toggleMark(editorSchema.marks.code!))}>Code</button>
          <button type="button" disabled={selection.block === 'codeBlock'} aria-expanded={linkOpen} aria-controls={`${identifier}-link`} onMouseDown={event => event.preventDefault()} onClick={() => { setLinkValue(''); setLinkOpen(!linkOpen); }}>Link</button>
          <button type="button" aria-label="Bulleted list" aria-pressed={selection.list === 'bulletList'} onMouseDown={event => event.preventDefault()} onClick={() => command(wrapInList(editorSchema.nodes.bulletList!))}>Bullets</button>
          <button type="button" aria-label="Numbered list" aria-pressed={selection.list === 'orderedList'} onMouseDown={event => event.preventDefault()} onClick={() => command(wrapInList(editorSchema.nodes.orderedList!, { start: 1 }))}>Numbers</button>
          {selection.list && <button type="button" onMouseDown={event => event.preventDefault()} onClick={() => command(liftListItem(editorSchema.nodes.listItem!))}>Remove list</button>}
          <button type="button" onMouseDown={event => event.preventDefault()} onClick={() => command(undo)}>Undo</button>
          <button type="button" onMouseDown={event => event.preventDefault()} onClick={() => command(redo)}>Redo</button>
        </div>
        {selection.block === 'codeBlock' && <label className="editor-note">Code language <input aria-label="Code language" value={selection.language} maxLength={64} onChange={event => changeLanguage(event.target.value)} /></label>}
        {selection.list === 'orderedList' && <label className="editor-note">List starts at <input aria-label="Numbered list start" type="number" min="1" max="2147483647" value={selection.start} onChange={event => changeListStart(event.target.value)} /></label>}
        {linkOpen && <div id={`${identifier}-link`} className="editor-link-editor" role="group" aria-label="Edit link">
          <label htmlFor={`${identifier}-url`}>Link URL</label>
          <input id={`${identifier}-url`} ref={linkInput} value={linkValue} onChange={event => setLinkValue(event.target.value)} maxLength={CONTENT_LIMITS.maxHrefLength} placeholder="https://example.test" onKeyDown={event => { if (event.key === 'Escape') { setLinkOpen(false); view.current?.focus(); } if (event.key === 'Enter') { event.preventDefault(); applyLink(); } }} />
          <button type="button" onClick={() => applyLink()}>Apply link</button><button type="button" onClick={() => applyLink(true)}>Remove link</button><button type="button" onClick={() => { setLinkOpen(false); view.current?.focus(); }}>Cancel</button>
        </div>}
        <p className="editor-note">Save explicitly. Unsupported formatting is rejected. Shift+Enter inserts a line break.</p>
      </>}
      <p id={`${identifier}-error`} className="editor-error" role="alert" hidden={!error}>{error}</p>
      <div className="editor-mount" ref={mount} />
    </div>
    <details className="editor-outline" open={outlineOpen} onToggle={event => setOutlineOpen(event.currentTarget.open)}>
      <summary>On this page</summary>
      <nav aria-label="On this page">
        {headings.length ? headings.map(heading => <a key={heading.id} href={`#${heading.id}`} className={heading.level > 2 ? 'outline-subheading' : undefined} aria-current={activeHeading === heading.id ? 'location' : undefined} onClick={event => { event.preventDefault(); const target = document.getElementById(heading.id); target?.scrollIntoView({ behavior: 'instant', block: 'start' }); target?.focus({ preventScroll: true }); }}>{heading.text}</a>) : <small>No headings in this document.</small>}
      </nav>
    </details>
  </div>;
}
