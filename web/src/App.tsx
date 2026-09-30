// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { extractPlainText, validateContent } from '@scrawl/content';
import { Editor } from './Editor';
import { api, ApiError } from './api/client';
import type { DocumentSummary, Draft, LoadedDocument, Revision, RevisionSummary, Space, User } from './api/client';

const emptyDraft = (): Draft => ({ title: 'Untitled document', content: validateContent({
  format: 'blocknote-json', schemaVersion: 1, editorVersion: '0.55.0',
  document: [{ id: crypto.randomUUID(), type: 'paragraph', content: [] }],
}).content });
const draftFrom = (loaded: LoadedDocument): Draft => ({ title: loaded.document.revision.title, content: loaded.document.revision.content });
const failureMessage = (error: unknown) => error instanceof ApiError ? error.message : 'The response could not be used. Your unsaved work is retained.';
const validId = (value: string | null) => value && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value) ? value : undefined;

function Login({ onLogin }: { onLogin: (user: User) => Promise<void> }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <section className="login"><h1>Log in</h1><form onSubmit={event => {
    event.preventDefault(); if (busy) return;
    const submittedPassword = password;
    setPassword(''); setBusy(true); setError('');
    void api.login(email, submittedPassword).then(onLogin).catch(error => {
      setError(error instanceof ApiError && error.status === 401 ? 'Email or password was not accepted.' : failureMessage(error));
    }).finally(() => setBusy(false));
  }}>
    <label htmlFor="email">Email</label><input id="email" type="email" autoComplete="username" required value={email} onChange={event => setEmail(event.target.value)} disabled={busy} />
    <label htmlFor="password">Password</label><input id="password" type="password" autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)} disabled={busy} />
    <button className="primary" disabled={busy}>{busy ? 'Logging in…' : 'Log in'}</button>
    {error && <p role="alert">{error}</p>}
    <p className="muted">Accounts are provisioned by your administrator.</p>
  </form></section>;
}

export function App() {
  const [user, setUser] = useState<User | null>();
  const [bootError, setBootError] = useState('');
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [spacesCursor, setSpacesCursor] = useState<string | null>(null);
  const [space, setSpace] = useState<Space | null>(null);
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [documentsCursor, setDocumentsCursor] = useState<string | null>(null);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState('');
  const [loadingDocument, setLoadingDocument] = useState(false);
  const [base, setBase] = useState<LoadedDocument | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editorKey, setEditorKey] = useState(0);
  const [contentError, setContentError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState('Saving…');
  const [saveError, setSaveError] = useState('');
  const [notice, setNotice] = useState('');
  const [accessIssue, setAccessIssue] = useState<'session' | 'access' | null>(null);
  const [conflict, setConflict] = useState<{ latest: LoadedDocument | null; error: string; loading: boolean } | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [revisions, setRevisions] = useState<RevisionSummary[]>([]);
  const [revisionsCursor, setRevisionsCursor] = useState<number | null>(null);
  const [revision, setRevision] = useState<Revision | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [pending, setPending] = useState<{ action: () => void } | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [narrow, setNarrow] = useState(() => matchMedia('(max-width: 700px)').matches);
  const generation = useRef(0);
  const historyGeneration = useRef(0);
  const listGeneration = useRef(0);
  const titleInput = useRef<HTMLInputElement>(null);
  const owner = useRef<string | null>(null);
  const draftSpaceId = useRef<string | null>(null);
  const newDraftBaseline = useRef<Draft | null>(null);
  const dirty = Boolean(draft && (!base || draft.title !== base.document.revision.title
    || JSON.stringify(draft.content) !== JSON.stringify(base.document.revision.content)));
  const discardBaseline = base ? draftFrom(base) : newDraftBaseline.current;
  const hasDraftChanges = Boolean(draft && discardBaseline && (draft.title !== discardBaseline.title
    || JSON.stringify(draft.content) !== JSON.stringify(discardBaseline.content)));
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty;
  const mayEdit = Boolean(user && !accessIssue && space?.access === 'editor' && !base?.document.archivedAt);

  function rememberSelection(selectedSpace: string | null, selectedDocument: string | null) {
    const url = new URL(location.href);
    url.searchParams.delete('space'); url.searchParams.delete('document');
    if (selectedSpace) url.searchParams.set('space', selectedSpace);
    if (selectedDocument) url.searchParams.set('document', selectedDocument);
    history.replaceState(null, '', url);
  }
  function resetDocument() {
    draftSpaceId.current = null;
    newDraftBaseline.current = null;
    setBase(null); setDraft(null); dirtyRef.current = false; setContentError(null);
    setConflict(null); setSaveError(''); setNotice(''); setHistoryOpen(false);
    setRevisions([]); setRevision(null); historyGeneration.current++;
  }
  function adopt(loaded: LoadedDocument, preserveEditor = false) {
    draftSpaceId.current = loaded.document.spaceId;
    setBase(loaded); setDraft(draftFrom(loaded));
    if (!preserveEditor) setEditorKey(key => key + 1);
    dirtyRef.current = false; setContentError(null); setSaveError(''); setConflict(null);
    rememberSelection(loaded.document.spaceId, loaded.document.id);
  }
  function unavailable(error: unknown) {
    if (!(error instanceof ApiError) || ![401,403,404].includes(error.status)) return false;
    generation.current++; historyGeneration.current++;
    setAccessIssue(error.status === 401 ? 'session' : 'access');
    setSpaces([]); setSpace(null); setDocuments([]); setSpacesCursor(null); setDocumentsCursor(null);
    setListLoading(false); setLoadingDocument(false); setHistoryOpen(false);
    setRevisions([]); setRevision(null); setConflict(null); setNotice('');
    if (!dirtyRef.current) resetDocument();
    if (error.status === 401) setUser(null);
    setSaveError(error.status === 401 ? 'Your session expired.' : 'Access to this document is unavailable.');
    return true;
  }
  function guarded(action: () => void) {
    if (busy) return;
    setMobileOpen(false);
    if (dirtyRef.current) setPending({ action }); else action();
  }
  function resetDraftToBaseline() {
    setDraft(base ? draftFrom(base) : newDraftBaseline.current);
    setEditorKey(key => key + 1);
    setContentError(null); setSaveError('');
    dirtyRef.current = !base;
    // A local reset cannot adopt the latest ETag or resolve a stale-save conflict.
  }
  function discardChanges() {
    if (!mayEdit || busy || (!hasDraftChanges && !contentError)) return;
    setPending({ action: () => setNotice('Unsaved changes discarded. Nothing was saved.') });
  }

  async function loadDocument(id: string, ticket = generation.current, expectedSpaceId?: string) {
    setLoadingDocument(true); setSaveError('');
    try {
      const loaded = await api.document(id);
      if (ticket !== generation.current) return;
      if (expectedSpaceId && loaded.document.spaceId !== expectedSpaceId) throw new ApiError(404);
      adopt(loaded);
    } catch (error) {
      if (ticket === generation.current && !unavailable(error)) setSaveError(failureMessage(error));
    } finally { if (ticket === generation.current) setLoadingDocument(false); }
  }
  async function listDocuments(selected: Space, archived = includeArchived, cursor?: string) {
    const ticket = generation.current, request = ++listGeneration.current;
    setListLoading(true); setListError('');
    try {
      const result = await api.documents(selected.id, archived, cursor);
      if (ticket !== generation.current || request !== listGeneration.current) return null;
      setDocuments(previous => cursor ? [...previous, ...result.items] : result.items);
      setDocumentsCursor(result.nextCursor);
      return result;
    } catch (error) {
      if (ticket === generation.current && request === listGeneration.current && !unavailable(error)) setListError(failureMessage(error));
      return null;
    } finally { if (ticket === generation.current && request === listGeneration.current) setListLoading(false); }
  }
  async function moreSpaces(cursor: string) {
    const ticket = generation.current;
    setListLoading(true); setListError('');
    try {
      const result = await api.spaces(cursor);
      if (ticket !== generation.current) return;
      setSpaces(previous => [...previous, ...result.items]); setSpacesCursor(result.nextCursor);
    } catch (error) {
      if (ticket === generation.current && !unavailable(error)) setListError(failureMessage(error));
    } finally { if (ticket === generation.current) setListLoading(false); }
  }
  async function selectSpace(selected: Space, documentId?: string) {
    const ticket = ++generation.current;
    resetDocument(); setSpace(selected); setDocuments([]); setDocumentsCursor(null); setAccessIssue(null);
    rememberSelection(selected.id, documentId ?? null);
    const result = await listDocuments(selected);
    if (ticket !== generation.current || !result) return;
    const id = documentId ?? result.items[0]?.id;
    if (id) await loadDocument(id, ticket, selected.id);
  }
  async function workspace(account: User, recover = false) {
    setUser(account); setBootError(''); setListLoading(true); setListError('');
    const ticket = ++generation.current;
    try {
      const result = await api.spaces();
      if (ticket !== generation.current) return;
      setSpaces(result.items); setSpacesCursor(result.nextCursor);
      if (recover && draft && draftSpaceId.current) {
        if (owner.current !== account.id) {
          setUser(null); setSpaces([]); setSpacesCursor(null); setSpace(null); setDocuments([]);
          setAccessIssue('session'); setSaveError('Sign in with the account that owns this local draft.'); return;
        }
        const selected = await api.space(draftSpaceId.current);
        const latest = base ? await api.document(base.document.id) : null;
        if (ticket !== generation.current) return;
        setSpace(selected); setAccessIssue(null); setSaveError('');
        setConflict(latest ? { latest, error: '', loading: false } : null); setHistoryOpen(false);
        if (!latest) setNotice('Access verified. Your local draft has not been saved. Review it and explicitly Save.');
        await listDocuments(selected);
        return;
      }
      owner.current = account.id;
      const params = new URLSearchParams(location.search);
      const spaceId = validId(params.get('space'));
      const documentId = validId(params.get('document'));
      let selected = result.items.find(item => item.id === spaceId) ?? result.items[0];
      if (spaceId) selected = await api.space(spaceId);
      if (!spaceId && documentId) { const loaded = await api.document(documentId); selected = await api.space(loaded.document.spaceId); }
      if (ticket !== generation.current) return;
      setAccessIssue(null);
      if (selected) await selectSpace(selected, documentId);
      else { setSpace(null); setDocuments([]); resetDocument(); }
    } catch (error) {
      if (ticket === generation.current && !unavailable(error)) setListError(failureMessage(error));
    } finally { setListLoading(false); }
  }
  async function start() {
    setUser(undefined); setBootError('');
    try { await workspace(await api.me()); }
    catch (error) { if (error instanceof ApiError && error.status === 401) setUser(null); else setBootError(failureMessage(error)); }
  }
  useEffect(() => { void start(); }, []);
  useEffect(() => {
    const media = matchMedia('(max-width: 700px)');
    const change = () => { setNarrow(media.matches); setMobileOpen(false); };
    media.addEventListener('change', change); return () => media.removeEventListener('change', change);
  }, []);
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => { if (dirtyRef.current) { event.preventDefault(); event.returnValue = ''; } };
    addEventListener('beforeunload', unload); return () => removeEventListener('beforeunload', unload);
  }, []);

  async function readConflict(id: string) {
    const ticket = generation.current;
    setConflict({ latest: null, error: '', loading: true }); setHistoryOpen(false);
    try {
      const latest = await api.document(id);
      if (ticket === generation.current) setConflict({ latest, error: '', loading: false });
    } catch (error) {
      if (ticket === generation.current && !unavailable(error)) setConflict({ latest: null, error: failureMessage(error), loading: false });
    }
  }
  async function mutate(operation: () => Promise<LoadedDocument>, label = 'Saving…', preserveEditor = false) {
    const ticket = generation.current;
    setBusyLabel(label); setBusy(true); setSaveError(''); setNotice('');
    try {
      const loaded = await operation();
      if (ticket !== generation.current) return;
      adopt(loaded, preserveEditor); setHistoryOpen(false); setRevision(null);
      if (space) void listDocuments(space);
    } catch (error) {
      if (ticket !== generation.current) return;
      if (error instanceof ApiError && error.status === 412 && base) await readConflict(base.document.id);
      else if (!unavailable(error)) setSaveError(failureMessage(error));
    } finally { setBusy(false); }
  }
  function save() {
    if (!draft || !space || !mayEdit || !dirty || busy || conflict || contentError) return;
    if (!draft.title.trim() || draft.title.length > 200) { setSaveError('Enter a title between 1 and 200 characters.'); return; }
    let checked: Draft;
    try { checked = { title: draft.title, content: validateContent(draft.content).content }; }
    catch { setSaveError('The content cannot be saved. Check the supported format and size limits.'); return; }
    void mutate(() => base ? api.save(base.document.id, base.etag, checked) : api.create(space.id, checked), 'Saving…', true);
  }
  function newDocument() {
    guarded(() => {
      generation.current++; resetDocument();
      const initial = emptyDraft(); newDraftBaseline.current = initial; setDraft(initial);
      setEditorKey(key => key + 1);
      draftSpaceId.current = space?.id ?? null;
      rememberSelection(space?.id ?? null, null);
      requestAnimationFrame(() => { titleInput.current?.focus(); titleInput.current?.select(); });
    });
  }
  async function openHistory(cursor?: number) {
    if (!base || accessIssue) return;
    const id = base.document.id, ticket = generation.current, selection = ++historyGeneration.current;
    setHistoryOpen(true); setHistoryLoading(true); setHistoryError('');
    try {
      const result = await api.revisions(id, cursor);
      if (ticket !== generation.current || selection !== historyGeneration.current) return;
      setRevisions(previous => cursor ? [...previous, ...result.items] : result.items); setRevisionsCursor(result.nextCursor);
      if (!cursor && result.items[0]) {
        const loaded = await api.revision(id, result.items[0].id);
        if (ticket === generation.current && selection === historyGeneration.current) setRevision(loaded);
      }
    } catch (error) {
      if (ticket === generation.current && !unavailable(error)) setHistoryError(failureMessage(error));
    } finally { if (selection === historyGeneration.current) setHistoryLoading(false); }
  }
  async function selectRevision(selected: RevisionSummary) {
    if (!base) return;
    const ticket = generation.current, selection = ++historyGeneration.current;
    setHistoryLoading(true); setHistoryError('');
    try { const loaded = await api.revision(base.document.id, selected.id); if (ticket === generation.current && selection === historyGeneration.current) setRevision(loaded); }
    catch (error) { if (ticket === generation.current && !unavailable(error)) setHistoryError(failureMessage(error)); }
    finally { if (selection === historyGeneration.current) setHistoryLoading(false); }
  }
  async function exportDocument() {
    if (!base || accessIssue || busy) return;
    setSaveError(''); setNotice(''); setBusyLabel('Exporting…'); setBusy(true);
    try {
      const exported = await api.export(base.document.id);
      const blob = new Blob([JSON.stringify(exported, null, 2) + '\n'], { type: 'application/json' });
      const url = URL.createObjectURL(blob); const link = document.createElement('a');
      link.href = url; link.download = `scrawl-document-${base.document.id}.json`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice(dirty ? 'Exported the saved revision. Your unsaved draft is not included.' : 'Exported the saved revision as native JSON.');
    } catch (error) { if (!unavailable(error)) setSaveError(failureMessage(error)); }
    finally { setBusy(false); }
  }
  async function logout() {
    setBusyLabel('Logging out…'); setBusy(true); setSaveError('');
    try {
      await api.logout(); generation.current++; resetDocument(); setUser(null); setSpaces([]); setSpace(null);
      setDocuments([]); setAccessIssue(null); owner.current = null; rememberSelection(null,null);
    } catch (error) { if (!unavailable(error)) setSaveError(failureMessage(error)); }
    finally { setBusy(false); }
  }

  const navigation = <>
    {spaces.length > 0 && <><label htmlFor="space">Space</label><select id="space" aria-label="Space" value={space?.id ?? ''} disabled={busy} onChange={event => {
      const selected = spaces.find(item => item.id === event.target.value); if (selected) guarded(() => { void selectSpace(selected); });
    }}><option value="" disabled>Select a space</option>{spaces.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></>}
    {spacesCursor && <button disabled={listLoading} onClick={() => { void moreSpaces(spacesCursor); }}>More spaces</button>}
    {space && <><div className="listhead"><span>Documents</span>{space.access === 'editor' && !accessIssue && <button onClick={newDocument} disabled={busy}>New document</button>}</div>
      {listLoading && <p role="status" className="muted">Loading documents…</p>}
      <nav className="documents" aria-label="Documents">{documents.map(item => <button key={item.id} className={base?.document.id === item.id ? 'active' : ''} aria-current={base?.document.id === item.id ? 'page' : undefined} disabled={busy} onClick={() => guarded(() => { const ticket = ++generation.current; resetDocument(); rememberSelection(space.id,item.id); void loadDocument(item.id,ticket,space.id); })}>{item.title}{item.archivedAt && <small>Archived</small>}</button>)}</nav>
      {!listLoading && !listError && documents.length === 0 && <p className="muted">No documents in this space.</p>}
      {documentsCursor && <button disabled={listLoading} onClick={() => { void listDocuments(space,includeArchived,documentsCursor); }}>More documents</button>}
      <label className="archive-toggle"><input type="checkbox" checked={includeArchived} disabled={busy} onChange={event => { setIncludeArchived(event.target.checked); void listDocuments(space,event.target.checked); }} />Show archived</label>
    </>}
    {!space && !listLoading && <p className="muted">{accessIssue ? 'Space access is unavailable.' : 'No accessible spaces.'}</p>}
    {listError && <div role="alert"><p>{listError}</p><button onClick={() => { if (space) void listDocuments(space); else if (user) void workspace(user,Boolean(dirty && draft)); }}>Retry</button></div>}
  </>;
  const status = accessIssue ? 'Not saved · local draft only' : busy ? busyLabel : conflict ? 'Not saved · resolve conflict'
    : saveError ? 'Not saved · request failed' : dirty ? `Unsaved changes${base ? ` · based on revision ${base.document.currentRevisionNumber}` : ''}`
    : base?.document.archivedAt ? `Archived · revision ${base.document.currentRevisionNumber}` : `Saved · revision ${base?.document.currentRevisionNumber ?? ''}`;

  return <>
    <header className="top"><span className="brand">Scrawl</span>
      {user && narrow && <button aria-haspopup="dialog" aria-expanded={mobileOpen} onClick={() => setMobileOpen(true)}>Navigation</button>}
      {user && <div className="account"><span>{user.email}</span><button className="quiet" disabled={busy} onClick={() => guarded(() => { void logout(); })}>Log out</button></div>}
    </header>
    {user === undefined ? <main className="state">{bootError ? <><h1>Could not load Scrawl</h1><p role="alert">{bootError}</p><button onClick={() => { void start(); }}>Retry</button></> : <p role="status">Loading Scrawl…</p>}</main>
      : <>
        {!user && <Login onLogin={account => workspace(account,Boolean(dirty && draft))} />}
        {(user || dirty && draft) && <div className={`workspace${!user ? ' retained-workspace' : ''}`}>
          {user && !narrow && <aside className="sidebar" aria-label="Workspace navigation">{navigation}</aside>}
          {user && narrow && <Dialog.Root open={mobileOpen} onOpenChange={setMobileOpen}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="mobile-navigation" aria-describedby={undefined}><Dialog.Title className="sr">Workspace navigation</Dialog.Title><Dialog.Close className="quiet">Close navigation</Dialog.Close>{navigation}</Dialog.Content></Dialog.Portal></Dialog.Root>}
          <main className="main">
            {draft && <div className="documentbar"><span className={dirty || accessIssue || saveError ? 'dirty' : ''} role="status">{status}</span>
              {base && !accessIssue && <><button disabled={busy} onClick={() => { if (historyOpen) setHistoryOpen(false); else void openHistory(); }}>History</button><details className="doc-menu"><summary aria-label="Document actions">⋯</summary><div className="menu-items"><button disabled={busy} onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); void exportDocument(); }}>Export JSON</button>{space?.access === 'editor' && !conflict && <button disabled={busy} onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); guarded(() => { void mutate(() => api.archive(base.document.id,base.etag,Boolean(base.document.archivedAt)),base.document.archivedAt ? 'Unarchiving…' : 'Archiving…'); }); }}>{base.document.archivedAt ? 'Unarchive' : 'Archive'}</button>}</div></details></>}
              {mayEdit && <div className="save-actions"><button disabled={busy || (!hasDraftChanges && !contentError)} onClick={discardChanges}>Discard changes</button><button className="primary" disabled={busy || !dirty || Boolean(conflict) || Boolean(contentError)} onClick={save}>Save</button></div>}
            </div>}
            {accessIssue && <div className="notice" role="alert"><strong>{saveError || (accessIssue === 'session' ? 'Your session expired.' : 'Access to this document is unavailable.')}</strong><p>{dirty ? 'Your complete unsaved title and body are retained in this tab. Nothing was saved. Server actions are unavailable. Copy your draft before closing or reloading.' : 'Sign in or ask an administrator to verify your access.'}</p>
              {dirty && draft && <button onClick={() => { void navigator.clipboard.writeText(draft.title+'\n\n'+extractPlainText(draft.content.document)).then(() => setNotice('Local draft text copied. Nothing was saved.')).catch(() => setNotice('Copy is unavailable. Select and copy the retained title and body.')); }}>Copy local draft text</button>}
            </div>}
            {!accessIssue && saveError && <div className="notice" role="alert"><strong>{saveError}</strong>{dirty && <p>Your complete local draft is retained. It has not been saved.</p>}{!draft && <button onClick={() => { const id=validId(new URLSearchParams(location.search).get('document')); if(id)void loadDocument(id); }}>Retry</button>}</div>}
            {notice && <p className="notice" role="status">{notice}</p>}
            {loadingDocument ? <p role="status">Loading document…</p> : draft ? <div className={`document-grid${historyOpen || conflict ? ' with-panel' : ''}`}>
              <Editor key={editorKey} initialContent={draft.content} editable={mayEdit && !busy} onValidationChange={setContentError} onChange={content => { setDraft(previous => previous ? { ...previous, content } : previous); setSaveError(''); setNotice(''); }} header={<>
                <p className="meta">{accessIssue ? 'Retained local draft · not a saved server document' : `${space?.name ?? ''} · ${base?.document.archivedAt ? 'archived' : space?.access === 'reader' ? 'reader access' : 'editor access'}`}</p>
                <label className="sr" htmlFor="title">Document title</label><input ref={titleInput} id="title" className="title" aria-label="Document title" value={draft.title} readOnly={!mayEdit} disabled={busy} onChange={event => { setDraft(previous => previous ? { ...previous,title:event.target.value } : previous); setSaveError(''); setNotice(''); }} />
              </>} />
              {conflict && <aside className="side-panel conflict" aria-label="Save conflict"><h2>Save conflict</h2><p>Compare your local title and body with the latest server version, then choose how to reconcile. No write will be retried automatically.</p>
                {conflict.loading && <p role="status">Loading latest server version…</p>}
                {conflict.error && <div role="alert"><p>{conflict.error}</p><button onClick={() => { if(base)void readConflict(base.document.id); }}>Retry</button></div>}
                {conflict.latest && <><small>Latest server version · revision {conflict.latest.document.currentRevisionNumber}</small><Editor key={conflict.latest.etag} initialContent={conflict.latest.document.revision.content} label="Latest server content" editable={false} onChange={() => {}} header={<h3>{conflict.latest.document.revision.title}</h3>} />
                  <div className="actions"><button onClick={() => { const latest=conflict.latest!; setBase(latest); setConflict(null); setSaveError(''); setNotice('Your local title and body are kept. Review your changes against the new comparison base, then explicitly Save.'); }}>Use my changes</button><button onClick={() => guarded(() => { adopt(conflict.latest!); setNotice('Using the latest saved server version.'); })}>Use server version</button></div>
                </>}
              </aside>}
              {historyOpen && !accessIssue && <aside className="side-panel" aria-label="Revision history"><button className="quiet close" onClick={() => setHistoryOpen(false)}>Close history</button><h2>History</h2>
                {historyLoading && <p role="status">Loading history…</p>}
                {historyError && <div role="alert"><p>{historyError}</p><button onClick={() => { void openHistory(); }}>Retry</button></div>}
                <ol className="revisions">{revisions.map(item => <li key={item.id}><button aria-label={`Revision ${item.revisionNumber}`} aria-pressed={revision?.id===item.id} disabled={busy} onClick={() => { void selectRevision(item); }}><span>Revision {item.revisionNumber}</span><small>{new Date(item.createdAt).toLocaleString()}</small></button></li>)}</ol>
                {revisionsCursor && <button disabled={historyLoading} onClick={() => { void openHistory(revisionsCursor); }}>More revisions</button>}
                {revision && !historyLoading && <Editor key={revision.id} initialContent={revision.content} label="Revision content" editable={false} onChange={() => {}} header={<><h3>{revision.title}</h3>{mayEdit && !conflict && <button className="restore" disabled={busy || revision.id===base?.document.revision.id} onClick={() => guarded(() => { if(base)void mutate(() => api.restore(base.document.id,base.etag,revision.id),'Restoring…'); })}>Restore revision {revision.revisionNumber}</button>}</>} />}
              </aside>}
            </div> : !loadingDocument && !saveError && !accessIssue && !listLoading && <section className="state"><h1>{space ? 'No documents yet' : 'No accessible spaces'}</h1><p>{space ? 'Create a document when you are ready.' : 'Ask an administrator for space access.'}</p></section>}
          </main>
        </div>}
      </>}
    <Dialog.Root open={Boolean(pending)} onOpenChange={open => { if(!open)setPending(null); }}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="dialog" onCloseAutoFocus={event => { event.preventDefault();titleInput.current?.focus(); }}><Dialog.Title>Unsaved changes</Dialog.Title><Dialog.Description>Your title and body have not been saved. Continuing will discard your local changes.</Dialog.Description><div className="actions"><Dialog.Close className="primary">Keep editing</Dialog.Close><button onClick={() => { const action=pending?.action;setPending(null);resetDraftToBaseline();action?.(); }}>Discard changes</button></div></Dialog.Content></Dialog.Portal></Dialog.Root>
    <footer className="footer">Scrawl · <a href="/assets/LICENSE.txt" target="_blank" rel="noopener noreferrer">AGPL-3.0-only</a> · <a href="/assets/THIRD_PARTY_NOTICES.txt" target="_blank" rel="noopener noreferrer">Third-party notices</a> · <a href="/assets/scrawl-source.tar.gz" download>Source for this build</a></footer>
  </>;
}
