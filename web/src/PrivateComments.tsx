// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import { ComponentsContext, FloatingComposerController, ThreadsSidebar, type ComponentProps } from '@blocknote/react';
import { components as supplied } from '@blocknote/shadcn';

export type CommentState = { dirty: boolean; pending: boolean };
const Authority = createContext({ writable: false, dirty: false, pending: false, reportDraft: (_id: string, _dirty: boolean) => {},
  run: async (_action: () => unknown) => {} });
const Sidebar = createContext(false);

function CommentEditor(props: ComponentProps['Comments']['Editor']) {
  const { writable, reportDraft, run } = useContext(Authority);
  const id = useId();
  const [initialEditable] = useState(props.editable && writable);
  // Use the same native setter as the document editor. Changing this pinned
  // view's editable prop remounts it during submission and interrupts undo.
  useLayoutEffect(() => { props.editor.isEditable = props.editable && writable; }, [props.editor, props.editable, writable]);
  useEffect(() => {
    if (!props.editable) return;
    const empty = props.editor.isEmpty, baseline = JSON.stringify(props.editor.document);
    const report = () => reportDraft(id, empty ? !props.editor.isEmpty : JSON.stringify(props.editor.document) !== baseline);
    const unsubscribe = props.editor.onChange(report);
    report();
    // Loss of write authority keeps this local draft tracked. Closing the
    // native composer, saving, or cancelling its edit clears the guard.
    return () => { unsubscribe(); reportDraft(id, false); };
  }, [props.editor, props.editable, id, reportDraft]);
  return <div onKeyDownCapture={event => {
    // Catch the supplied async submit command, including keyboard failures.
    // Formatting, content editing and submission remain library operations.
    if (!writable || !props.editable || event.key !== 'Enter' || event.shiftKey || event.altKey || event.nativeEvent.isComposing
      || event.nativeEvent.keyCode === 229 || props.editor.prosemirrorView?.composing) return;
    event.preventDefault(); event.stopPropagation();
    if (!event.repeat) {
      // This pinned factory's optional shortcut conflicts with its generic
      // declaration. Narrow the named public command instead of casting it.
      const command = props.editor.getExtension('commentEditorSubmit');
      if (command && 'submit' in command && typeof command.submit === 'function') {
        const submit = command.submit;
        void run(() => submit());
      } else void run(() => { throw new Error('Comment submission is unavailable'); });
    }
  }}><supplied.Comments.Editor {...props} editable={initialEditable} /></div>;
}
function CommentAction(props: ComponentProps['Generic']['Toolbar']['Button']) {
  const { writable, run } = useContext(Authority);
  const action = props.onClick;
  return <supplied.Generic.Toolbar.Button {...props}
    label={props.label ?? props.mainTooltip ?? (typeof props.children === 'string' ? props.children : 'Comment action')}
    isDisabled={props.isDisabled || !writable}
    {...(action ? { onClick: (event: MouseEvent) => { void run(() => action(event)); } } : {})} />;
}
function CommentMenuItem(props: ComponentProps['Generic']['Menu']['Item']) {
  const { writable, run } = useContext(Authority);
  return <supplied.Generic.Menu.Item {...props} onClick={() => {
    if (writable && props.onClick) void run(props.onClick);
  }} />;
}
function CommentView(props: ComponentProps['Comments']['Comment']) {
  const { writable } = useContext(Authority);
  // Hover-only mounting prevents keyboard users from reaching native actions.
  return <supplied.Comments.Comment {...props} showActions={writable ? true : props.showActions ?? 'hover'} />;
}
function CommentCard(props: ComponentProps['Comments']['Card']) {
  const inSidebar = useContext(Sidebar), { dirty, pending } = useContext(Authority);
  // The supplied sidebar deselects on blur. Keep its local composer mounted
  // while text or a request is pending; navigation has its own discard guard.
  return <supplied.Comments.Card {...props}
    onFocus={event => { if (!inSidebar || !dirty && !pending) props.onFocus?.(event); }}
    onBlur={event => { if (!inSidebar || !dirty && !pending) props.onBlur?.(event); }} />;
}
// The pinned sidebar exposes a reply composer on thread focus, even for a
// reader. Guard that supplied component; core authorization remains decisive.
const components = { ...supplied, Comments: { ...supplied.Comments, Editor: CommentEditor, Comment: CommentView, Card: CommentCard },
  Generic: { ...supplied.Generic, Toolbar: { ...supplied.Generic.Toolbar, Button: CommentAction },
    Menu: { ...supplied.Generic.Menu, Item: CommentMenuItem } } };

export function PrivateComments({ writable, onStateChange }: { writable: boolean; onStateChange?: (state: CommentState) => void }) {
  const [error, setError] = useState(false);
  const [state, setState] = useState<CommentState>({ dirty: false, pending: false });
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const drafts = useRef(new Set<string>()), requests = useRef(0), mounted = useRef(true);
  const callback = useRef(onStateChange); callback.current = onStateChange;
  const report = useCallback(() => {
    if (!mounted.current) return;
    const value = { dirty: drafts.current.size > 0, pending: requests.current > 0 };
    setState(value); callback.current?.(value);
  }, []);
  const reportDraft = useCallback((id: string, dirty: boolean) => {
    if (dirty) drafts.current.add(id); else drafts.current.delete(id);
    report();
  }, [report]);
  const run = useCallback(async (action: () => unknown) => {
    requests.current++; report();
    try { await action(); if (mounted.current) setError(false); }
    catch { if (mounted.current) setError(true); }
    finally { requests.current--; report(); }
  }, [report]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; callback.current?.({ dirty: false, pending: false }); };
  }, []);
  return <Authority.Provider value={{ writable: writable && !state.pending, dirty: state.dirty, pending: state.pending, reportDraft, run }}><ComponentsContext.Provider value={components}>
    {/* One supplied thread view owns replies; duplicating it in a floating
        view lets focus changes unmount a composer with unsent text. */}
    <FloatingComposerController />
    {error && <p className="notice" role="alert">The comment action did not finish. Any pending text remains in the composer. Check your connection and access before trying again.</p>}
    {(state.dirty || state.pending) && <p className="notice" role="status">{state.pending ? 'Submitting comment…' : writable ? 'Unsaved comment text. Use the comment Save control to submit it. Document Save does not submit comments.' : 'Unsent comment text remains in this tab. Submission is unavailable. Copy it before closing or reloading.'}</p>}
    <details className="document-comments" open={sidebarOpen}>
      <summary aria-disabled={sidebarOpen && (state.dirty || state.pending)} onClick={event => { event.preventDefault(); if (!sidebarOpen || !state.dirty && !state.pending) setSidebarOpen(open => !open); }}>Comments</summary>
      <Sidebar.Provider value={true}><ThreadsSidebar filter="all" sort="position" /></Sidebar.Provider>
    </details>
  </ComponentsContext.Provider></Authority.Provider>;
}
