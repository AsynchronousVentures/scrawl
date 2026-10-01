// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Search } from 'lucide-react';
import { Link, useBlocker, useLocation, useNavigate } from 'react-router';
import { extractPlainText, validateContent } from '@scrawl/content';
import { Editor } from './Editor';
import { SearchDialog } from './SearchDialog';
import { SpaceAccess } from './SpaceAccess';
import { DocumentNavigation, DocumentPath, ParentOptions } from './DocumentOrganization';
import { LiveSession, type LiveState } from './live';
import type { CommentState } from './PrivateComments';
import { api, ApiError } from './api/client';
import type { DocumentSummary, Draft, ExportFormat, LoadedDocument, LiveMetadata, PublicationStatus, PublishingAvailability, Revision, RevisionSummary, SearchResult, Space, User } from './api/client';

const emptyDraft = (): Draft => ({ title: 'Untitled document', content: validateContent({
  format: 'blocknote-json', schemaVersion: 1, editorVersion: '0.55.0',
  document: [{ id: crypto.randomUUID(), type: 'paragraph', content: [] }],
}).content });
const draftFrom = (loaded: LoadedDocument): Draft => ({ title: loaded.document.revision.title, content: loaded.document.revision.content });
const failureMessage = (error: unknown) => error instanceof ApiError ? error.message : 'The response could not be used. Your unsaved work is retained.';
const validId = (value: string | null) => value && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value) ? value : undefined;
type DocumentTarget = string | { spaceId: string; slug: string };

function downloadFile(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

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
  const routeLocation = useLocation();
  const navigate = useNavigate();
  const handledHref = useRef(location.pathname + location.search);
  const canonicalTarget = useRef<string | null>(null);
  const [user, setUser] = useState<User | null>();
  const [bootError, setBootError] = useState('');
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [accessOpen, setAccessOpen] = useState(false);
  const [accessBusy, setAccessBusy] = useState(false);
  const [spacePrompt, setSpacePrompt] = useState(false);
  const [spaceName, setSpaceName] = useState('');
  const [creatingSpace, setCreatingSpace] = useState(false);
  const [spaceCreateError, setSpaceCreateError] = useState('');
  const [spaceNotice, setSpaceNotice] = useState('');
  const [spacesCursor, setSpacesCursor] = useState<string | null>(null);
  const [space, setSpace] = useState<Space | null>(null);
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [draftParentId, setDraftParentId] = useState<string | null>(null);
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveParentId, setMoveParentId] = useState('');
  const [moveError, setMoveError] = useState('');
  const [moveNeedsCompare, setMoveNeedsCompare] = useState(false);
  const moveWriting = useRef(false);
  const actionsTrigger = useRef<HTMLElement>(null);
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
  const [searchOpen, setSearchOpen] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [uploadError, setUploadError] = useState('');
  const [uploadMessage, setUploadMessage] = useState('');
  const [publishing, setPublishing] = useState<PublishingAvailability | null>(null);
  const [publication, setPublication] = useState<PublicationStatus | null>(null);
  const [publicationError, setPublicationError] = useState('');
  const [publicationRetry, setPublicationRetry] = useState(0);
  const [publicationPrompt, setPublicationPrompt] = useState<{ action: 'publish'; revision: Revision } | { action: 'withdraw' } | null>(null);
  const [narrow, setNarrow] = useState(() => matchMedia('(max-width: 700px)').matches);
  const [collaborationEnabled, setCollaborationEnabled] = useState(false);
  const [collaborationKnown, setCollaborationKnown] = useState(false);
  const [liveChecking, setLiveChecking] = useState(false);
  const [liveCheckError, setLiveCheckError] = useState(false);
  const [liveRetry, setLiveRetry] = useState(0);
  const [live, setLive] = useState<LiveSession | null>(null);
  const [liveState, setLiveState] = useState<LiveState | null>(null);
  const [retainedLiveDraft, setRetainedLiveDraft] = useState<Draft | null>(null);
  const [commentState, setCommentState] = useState<CommentState>({ dirty: false, pending: false });
  const liveRef = useRef<LiveSession | null>(null);
  const draftRef = useRef(draft); draftRef.current = draft;
  const generation = useRef(0);
  const historyGeneration = useRef(0);
  const listGeneration = useRef(0);
  const titleInput = useRef<HTMLInputElement>(null);
  const saveTrigger = useRef<HTMLButtonElement>(null);
  const spaceTrigger = useRef<HTMLButtonElement>(null);
  const accessTrigger = useRef<HTMLButtonElement>(null);
  const owner = useRef<string | null>(null);
  const draftSpaceId = useRef<string | null>(null);
  const newDraftBaseline = useRef<Draft | null>(null);
  const requestedDocument = useRef<DocumentTarget | null>(null);
  const dirty = Boolean(draft && (!base || draft.title !== base.document.revision.title
    || JSON.stringify(draft.content) !== JSON.stringify(base.document.revision.content)));
  const discardBaseline = base ? draftFrom(base) : newDraftBaseline.current;
  const hasDraftChanges = Boolean(draft && discardBaseline && (draft.title !== discardBaseline.title
    || JSON.stringify(draft.content) !== JSON.stringify(discardBaseline.content)));
  const hasUnsavedWork = commentState.dirty || Boolean(retainedLiveDraft) || (liveState ? liveState.pending > 0 || liveState.localChanges && dirty : dirty);
  const dirtyRef = useRef(hasUnsavedWork); dirtyRef.current = hasUnsavedWork;
  const sharedEditingUnavailable = Boolean(base?.document.editingMode === 'live' && collaborationKnown && !collaborationEnabled);
  const mayEdit = Boolean(user && !accessIssue && collaborationKnown && !liveChecking && !liveCheckError && space?.access === 'editor' && !base?.document.archivedAt
    && (!base || base.document.editingMode === 'solo' || collaborationEnabled && liveState?.initialized)
    && (!live || liveState?.phase === 'connected' && liveState.metadata.canWrite));
  const blocked = busy || accessBusy || creatingSpace || uploading > 0 || commentState.pending;
  const blockedRef = useRef(blocked); blockedRef.current = blocked;
  const mayPublish = Boolean(publishing?.mayPublish && user && !accessIssue && base && !base.document.archivedAt && !conflict);
  const uploadContext = useRef({ id: base?.document.id ?? null, editable: mayEdit });
  uploadContext.current = { id: base?.document.id ?? null, editable: mayEdit };
  const navigationBlocker = useBlocker(({ currentLocation, nextLocation, historyAction }) => {
    const next = nextLocation.pathname + nextLocation.search;
    // Canonicalizing an authorized response is not navigation away from a draft.
    // Never exempt Back/Forward, even when it targets a previously canonical URL.
    if (historyAction !== 'POP' && next === canonicalTarget.current) {
      canonicalTarget.current = null;
      return false;
    }
    return currentLocation.pathname + currentLocation.search !== next && (dirtyRef.current || blocked);
  });

  function rememberSelection(selectedSpace: string | null, selectedDocument: string | null, replace = true) {
    const url = new URL(location.href);
    url.searchParams.delete('space'); url.searchParams.delete('document');
    url.pathname = selectedSpace ? `/spaces/${selectedSpace}${selectedDocument ? `/documents/${selectedDocument}` : ''}` : '/';
    url.hash = '';
    const href = url.pathname + url.search;
    handledHref.current = href;
    if (href === location.pathname + location.search && !location.hash) return;
    canonicalTarget.current = href;
    // The local draft and its URL must commit together. A deferred router
    // render can otherwise treat an earlier canonical URL as user navigation.
    void navigate(href, { replace, flushSync: true });
  }
  function resetDocument() {
    setAccessOpen(false); setMoveOpen(false); setMoveNeedsCompare(false); setMoveError(''); setDraftParentId(null);
    setLiveCheckError(false);
    liveRef.current?.destroy(); liveRef.current = null; setLive(null); setLiveState(null); setRetainedLiveDraft(null);
    setLoadingDocument(false);
    draftSpaceId.current = null;
    newDraftBaseline.current = null;
    requestedDocument.current = null;
    setBase(null); setDraft(null); dirtyRef.current = false; setContentError(null);
    setConflict(null); setSaveError(''); setNotice(''); setHistoryOpen(false);
    setRevisions([]); setRevision(null); historyGeneration.current++;
    setUploadError(''); setUploadMessage('');
    setPublication(null); setPublicationPrompt(null); setPublicationError('');
  }
  function adopt(loaded: LoadedDocument, preserveEditor = false) {
    setLiveCheckError(false);
    if (!preserveEditor) {
      liveRef.current?.destroy(); liveRef.current = null; setLive(null); setLiveState(null); setRetainedLiveDraft(null);
      if (collaborationEnabled && !loaded.document.archivedAt) setLiveChecking(true);
    }
    draftSpaceId.current = loaded.document.spaceId;
    setMoveNeedsCompare(false); setMoveError(''); setBase(loaded); setDraftParentId(loaded.document.parentDocumentId); setDraft(draftFrom(loaded));
    if (!preserveEditor) setEditorKey(key => key + 1);
    dirtyRef.current = false; setContentError(null); setSaveError(''); setConflict(null);
    setUploadError(''); setUploadMessage('');
    rememberSelection(loaded.document.spaceSlug, loaded.document.slug);
  }
  function joinLive(metadata: LiveMetadata, account: User) {
    liveRef.current?.destroy();
    const session = new LiveSession(metadata.documentId, metadata, account, state => {
      if (liveRef.current !== session) return;
      setLiveState(state);
      if (state.initialized) setDraft(previous => previous ? { ...previous, title: state.title } : previous);
    });
    liveRef.current = session; setLive(session); setLiveState(session.snapshot()); setLiveChecking(false); setEditorKey(key => key + 1);
    void session.connect();
  }
  useEffect(() => {
    if (!user) return;
    let current = true; setCollaborationKnown(false);
    void api.collaboration().then(value => { if (current) { setCollaborationEnabled(value.enabled); setCollaborationKnown(true); } })
      .catch(error => { if (current && !unavailable(error)) setSaveError('Editing availability could not be checked. Reload to retry. Your local work is retained.'); });
    return () => { current = false; };
  }, [user?.id]);
  useEffect(() => {
    if (!collaborationEnabled || !base || base.document.archivedAt || !user || accessIssue || liveRef.current?.id === base.document.id) {
      setLiveChecking(false); return;
    }
    let current = true; setLiveChecking(true); setLiveCheckError(false);
    void api.liveDocument(base.document.id).then(async metadata => {
      if (!current || liveRef.current?.id === base.document.id) return;
      const saved = await api.document(base.document.id);
      if (current && liveRef.current?.id !== base.document.id) { setBase(saved); joinLive(metadata, user); }
    }).catch(error => {
      if (current && liveRef.current?.id !== base.document.id && !(error instanceof ApiError && error.status === 409) && !unavailable(error)) {
        setLiveCheckError(true); setSaveError('Shared document state could not be checked. Your local work is retained. Retry before editing.');
      }
    }).finally(() => { if (current) setLiveChecking(false); });
    return () => { current = false; };
  }, [collaborationEnabled, base?.document.id, base?.document.archivedAt, user?.id, accessIssue, liveRetry]);
  useEffect(() => () => liveRef.current?.destroy(), []);
  async function enableLive() {
    if (!base || !user || dirty || blocked || !mayEdit) return;
    setBusy(true); setBusyLabel('Starting shared editing…'); setSaveError('');
    let enrolled = false;
    try {
      const metadata = await api.enrollLive(base.document.id, base.etag);
      enrolled = true;
      const saved = await api.document(base.document.id);
      setBase(saved); joinLive(metadata, user);
    } catch (error) { if (!unavailable(error)) { setLiveCheckError(enrolled); setSaveError(failureMessage(error)); } }
    finally { setBusy(false); }
  }
  async function reconnectLive() {
    if (!base || !user || !live || blocked || retainedLiveDraft) return;
    setBusy(true); setBusyLabel('Reconnecting…');
    try {
      const metadata = await api.liveDocument(base.document.id);
      const saved = await api.document(base.document.id);
      setRetainedLiveDraft(draftRef.current); setBase(saved); setDraft(draftFrom(saved));
      setConflict(null); setSaveError(''); joinLive(metadata, user);
    } catch (error) { if (!unavailable(error)) setSaveError(failureMessage(error)); }
    finally { setBusy(false); }
  }
  function unavailable(error: unknown) {
    if (!(error instanceof ApiError) || ![401,403,404].includes(error.status)) return false;
    generation.current++; historyGeneration.current++;
    setAccessIssue(error.status === 401 ? 'session' : 'access');
    setSearchOpen(false); setAccessOpen(false); setSpacePrompt(false); setSpaceNotice(''); setUploadMessage('');
    setPublication(null); setPublicationPrompt(null); setPublicationError('');
    setSpaces([]); setSpace(null); setDocuments([]); setSpacesCursor(null);
    setListLoading(false); setLoadingDocument(false); setHistoryOpen(false);
    setRevisions([]); setRevision(null); setConflict(null); setNotice('');
    if (!dirtyRef.current) resetDocument();
    if (error.status === 401) setUser(null);
    setSaveError(error.status === 401 ? 'Your session expired.' : 'Access to this document is unavailable.');
    return true;
  }
  function guarded(action: () => void) {
    if (blocked) return;
    setMobileOpen(false);
    if (dirtyRef.current) setPending({ action }); else action();
  }
  function resetDraftToBaseline() {
    if (live) return; // Leaving never rolls a shared document back over its peers.
    setDraft(base ? draftFrom(base) : newDraftBaseline.current);
    setEditorKey(key => key + 1);
    setContentError(null); setSaveError('');
    setUploadError(''); setUploadMessage('');
    dirtyRef.current = !base;
    // A local reset cannot adopt the latest ETag or resolve a stale-save conflict.
  }
  function discardChanges() {
    if (!mayEdit || blocked || (!hasDraftChanges && !contentError)) return;
    setPending({ action: () => setNotice('Unsaved changes discarded. Nothing was saved.') });
  }

  async function loadDocument(target: DocumentTarget, ticket = generation.current, expectedSpaceId?: string) {
    requestedDocument.current = target;
    setLoadingDocument(true); setSaveError('');
    try {
      const loaded = typeof target === 'string' ? await api.document(target) : await api.documentBySlug(target.spaceId, target.slug);
      if (ticket !== generation.current) return;
      if (expectedSpaceId && loaded.document.spaceId !== expectedSpaceId) throw new ApiError(404);
      adopt(loaded);
    } catch (error) {
      if (ticket === generation.current && !unavailable(error)) setSaveError(failureMessage(error));
    } finally { if (ticket === generation.current) setLoadingDocument(false); }
  }
  async function listDocuments(selected: Space, archived = includeArchived) {
    const ticket = generation.current, request = ++listGeneration.current;
    setListLoading(true); setListError('');
    try {
      // Build a complete metadata index before showing a tree. Each bounded
      // page rechecks server access; no document bodies are downloaded here.
      const items: DocumentSummary[] = [];
      let cursor: string | undefined;
      do {
        const result = await api.documents(selected.id, true, cursor);
        if (ticket !== generation.current || request !== listGeneration.current) return null;
        items.push(...result.items); cursor = result.nextCursor ?? undefined;
      } while (cursor);
      setDocuments(items);
      return { items: items.filter(item => archived || !item.archivedAt), nextCursor: null };
    } catch (error) {
      if (ticket === generation.current && request === listGeneration.current && !unavailable(error)) setListError(failureMessage(error));
      return null;
    } finally { if (ticket === generation.current && request === listGeneration.current) setListLoading(false); }
  }

  function openSpacePrompt() {
    if (user?.role !== 'administrator' || accessIssue || blocked) return;
    setMobileOpen(false); setSpaceName(''); setSpaceCreateError(''); setSpaceNotice(''); setSpacePrompt(true);
  }
  async function createSpace() {
    if (user?.role !== 'administrator' || accessIssue || blocked || !spaceName.trim()) return;
    const ticket = generation.current;
    setCreatingSpace(true); setSpaceCreateError('');
    try {
      const created = await api.createSpace(spaceName.trim());
      if (ticket !== generation.current) return;
      setSpaces(previous => previous.some(item => item.id === created.id) ? previous : [...previous, created]);
      setSpaceNotice(`Created space "${created.name}".`);
      // Creating a space is not document navigation. Keep the draft, editor
      // undo stack, save error and comparison ETag intact in an open workspace.
      if (!space && !draftRef.current) await selectSpace(created);
      setSpacePrompt(false);
    } catch (error) {
      if (ticket === generation.current && !unavailable(error)) setSpaceCreateError(error instanceof ApiError && error.status === 400
        ? 'Enter a space name between 1 and 200 characters.'
        : 'The space could not be created. Check your connection and try again. Your document edits are retained.');
    } finally { setCreatingSpace(false); }
  }
  async function recheckAccess(error: ApiError) {
    if (error.status === 401) { unavailable(error); return; }
    const ticket = generation.current;
    setAccessOpen(false); setBusy(true); setBusyLabel('Checking access…');
    try {
      const current = await api.me();
      if (ticket === generation.current) await workspace(current, Boolean(dirtyRef.current && draftRef.current));
    } catch (failure) {
      if (ticket === generation.current && !unavailable(failure)) setSaveError('Access could not be checked. Your local work is retained.');
    } finally { setBusy(false); }
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
  async function selectSpace(selected: Space, documentTarget?: DocumentTarget) {
    // Search may reach an authorized space outside the loaded navigation page.
    setSpaces(previous => previous.some(item => item.id === selected.id)
      ? previous.map(item => item.id === selected.id ? selected : item) : [...previous, selected]);
    const ticket = ++generation.current;
    resetDocument(); setSpace(selected); setDocuments([]); setAccessIssue(null);
    // Keep a direct link intact until its document has actually loaded. A
    // failed list/read must not replace the requested document with a default.
    if (!documentTarget) rememberSelection(selected.slug, null);
    const result = await listDocuments(selected);
    if (ticket !== generation.current || !result) return;
    const target = documentTarget ?? result.items[0]?.id;
    if (target) await loadDocument(target, ticket, selected.id);
  }
  async function workspace(account: User, recover = false) {
    handledHref.current = location.pathname + location.search;
    setSpacePrompt(false); setSpaceNotice('');
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
      const slugs = /^\/spaces\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:\/documents\/([a-z0-9]+(?:-[a-z0-9]+)*))?\/?$/.exec(location.pathname);
      if (slugs) {
        const selected = await api.spaceBySlug(slugs[1]!);
        if (ticket !== generation.current) return;
        setAccessIssue(null);
        await selectSpace(selected, slugs[2] ? { spaceId: selected.id, slug: slugs[2] } : undefined);
        return;
      }
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
    if (navigationBlocker.state === 'blocked' && !hasUnsavedWork && !blocked && !pending) navigationBlocker.reset();
  }, [navigationBlocker, hasUnsavedWork, blocked, pending]);
  useEffect(() => {
    const href = routeLocation.pathname + routeLocation.search;
    if (!user || href === handledHref.current) return;
    handledHref.current = href;
    setMobileOpen(false); resetDocument(); setSpace(null); setDocuments([]);
    void workspace(user);
  }, [routeLocation.pathname, routeLocation.search, user?.id]);
  useEffect(() => {
    const media = matchMedia('(max-width: 700px)');
    const change = () => { setNarrow(media.matches); setMobileOpen(false); };
    media.addEventListener('change', change); return () => media.removeEventListener('change', change);
  }, []);
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => { if (dirtyRef.current || blockedRef.current) { event.preventDefault(); event.returnValue = ''; } };
    addEventListener('beforeunload', unload); return () => removeEventListener('beforeunload', unload);
  }, []);
  useEffect(() => {
    setPublishing(null);
    if (!user || accessIssue) return;
    let active = true;
    void api.publishingAvailability().then(value => { if (active) setPublishing(value); }).catch(error => {
      if (active && !unavailable(error)) setPublicationError('Publishing availability could not be checked.');
    });
    return () => { active = false; };
  }, [user?.id, accessIssue, publicationRetry]);
  useEffect(() => {
    setPublication(null);
    if (!publishing?.mayPublish || !base || accessIssue) return;
    const ticket = generation.current, id = base.document.id;
    let active = true;
    void api.publication(id).then(value => {
      if (active && ticket === generation.current) { setPublication(value); setPublicationError(''); }
    }).catch(error => {
      if (active && ticket === generation.current && !unavailable(error)) setPublicationError('Publication status could not be checked.');
    });
    return () => { active = false; };
  }, [publishing?.mayPublish, base?.document.id, base?.document.lockVersion, accessIssue, publicationRetry]);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !(event.ctrlKey || event.metaKey) || event.altKey) return;
      if (event.key.toLowerCase() === 's' && !event.shiftKey) {
        if (event.target instanceof HTMLElement && (event.target.closest('[role="dialog"]')
          || event.target.closest('.bn-comment-editor'))) return;
        const button = saveTrigger.current;
        if (!button) return;
        event.preventDefault();
        // Use the current control, including its disabled state and existing
        // write guards. Holding the shortcut never creates repeated writes.
        if (!event.repeat && !button.disabled) button.click();
        return;
      }
      if (!user || accessIssue || blocked || event.key.toLowerCase() !== 'k') return;
      // BlockNote owns its native link shortcut while editing, including UI
      // portalled from the editor. Search remains available in the header.
      if (event.target instanceof HTMLElement && (event.target.closest('[role="dialog"]')
        || event.target.closest('.bn-root') && event.target.closest('[contenteditable="true"]'))) return;
      event.preventDefault(); setSearchOpen(true);
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, [user, accessIssue, blocked]);

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
    if (!draft || !space || !mayEdit || !dirty || blocked || conflict || contentError) return;
    if (!draft.title.trim() || draft.title.length > 200) { setSaveError('Enter a title between 1 and 200 characters.'); return; }
    let checked: Draft;
    try { checked = { title: draft.title, content: validateContent(draft.content).content }; }
    catch { setSaveError('The content cannot be saved. Check the supported format and size limits.'); return; }
    if (live && base && liveState) {
      if (liveState.phase !== 'connected' || liveState.pending) return;
      const snapshot = liveState.metadata, session = live, ticket = generation.current;
      setBusy(true); setBusyLabel('Saving…'); setSaveError('');
      void api.checkpointLive(base.document.id, base.etag, snapshot).then(saved => {
        if (ticket !== generation.current || liveRef.current !== session) return;
        setBase(saved); session.checkpointAccepted(snapshot.sequence); setNotice(`Saved revision ${saved.document.currentRevisionNumber}.`);
        if (space) void listDocuments(space);
      }).catch(async error => {
        if (ticket !== generation.current) return;
        if (error instanceof ApiError && error.status === 412) await readConflict(base.document.id);
        else if (!unavailable(error)) setSaveError(failureMessage(error));
      }).finally(() => setBusy(false));
      return;
    }
    void mutate(() => base ? api.save(base.document.id, base.etag, checked) : api.create(space.id, checked, draftParentId), 'Saving…', true);
  }
  async function restoreRevision(revisionId: string) {
    if (!base || !mayEdit || blocked) return;
    if (!live || !liveState || !user) {
      guarded(() => { void mutate(() => api.restore(base.document.id, base.etag, revisionId), 'Restoring…'); });
      return;
    }
    if (dirty || commentState.dirty || liveState.pending || retainedLiveDraft || liveState.phase !== 'connected') return;
    setBusy(true); setBusyLabel('Restoring…'); setSaveError('');
    try {
      const restored = await api.restoreLive(base.document.id, base.etag, liveState.metadata, revisionId);
      adopt(restored); joinLive(restored.room, user); setHistoryOpen(false); setRevision(null);
      if (space) void listDocuments(space);
    } catch (error) {
      if (error instanceof ApiError && error.status === 412) await readConflict(base.document.id);
      else if (!unavailable(error)) setSaveError(failureMessage(error));
    } finally { setBusy(false); }
  }
  function newDocument(parentId: string | null = null) {
    guarded(() => {
      generation.current++; resetDocument();
      const initial = emptyDraft(); newDraftBaseline.current = initial; setDraft(initial);
      setEditorKey(key => key + 1);
      draftSpaceId.current = space?.id ?? null; setDraftParentId(parentId);
      if (space) void listDocuments(space);
      rememberSelection(space?.slug ?? null, null, false);
      requestAnimationFrame(() => { titleInput.current?.focus(); titleInput.current?.select(); });
    });
  }
  async function moveDocument() {
    if (!base || !space || space.access !== 'editor' || accessIssue || blocked || hasUnsavedWork || conflict || moveNeedsCompare || moveWriting.current || listLoading || listError || moveParentId === (base.document.parentDocumentId ?? '')) return;
    const ticket = generation.current, current = base;
    moveWriting.current = true; setBusyLabel('Moving document…'); setBusy(true); setMoveError(''); setNotice('');
    try {
      const moved = await api.move(current.document.id, current.etag, moveParentId || null);
      if (ticket !== generation.current) return;
      // A move changes metadata only. Preserve native content, undo and peer
      // edits that may arrive while this request drains.
      setBase(moved); setDraftParentId(moved.document.parentDocumentId); setMoveOpen(false); setNotice('Document moved.');
      void listDocuments(space);
    } catch (error) {
      if (ticket !== generation.current) return;
      if (error instanceof ApiError && error.status === 412) { setMoveOpen(false); await readConflict(current.document.id); }
      else if (!unavailable(error)) {
        const ambiguous = !(error instanceof ApiError && [400, 409, 428].includes(error.status));
        setMoveNeedsCompare(ambiguous);
        setMoveError(`${ambiguous ? 'The move could not be confirmed. Compare the latest document before trying again. ' : ''}${failureMessage(error)}`);
      }
    } finally { moveWriting.current = false; setBusy(false); }
  }
  async function changePublication() {
    if (!base || !mayPublish || blocked || !publicationPrompt) return;
    const ticket = generation.current, id = base.document.id, prompt = publicationPrompt;
    setPublicationPrompt(null); setPublicationError('');
    setBusyLabel(prompt.action === 'publish' ? 'Publishing saved revision…' : 'Withdrawing publication…'); setBusy(true);
    try {
      const result = prompt.action === 'publish' ? await api.publish(id, base.etag, prompt.revision.id) : await api.unpublish(id, base.etag);
      if (ticket !== generation.current) return;
      // Publication updates lifecycle authority only. Keep the complete local
      // draft, content comparison baseline and native undo history unchanged.
      setBase(previous => previous?.document.id === id ? { ...previous, etag: result.etag,
        document: { ...previous.document, lockVersion: result.status.lockVersion } } : previous);
      setPublication(result.status);
      setNotice(prompt.action === 'publish'
        ? `Revision ${prompt.revision.revisionNumber} published. Unsaved edits and later private saves are not included.`
        : 'Publication withdrawn. Future public requests are denied. Your local edits are unchanged.');
    } catch (error) {
      if (ticket !== generation.current) return;
      if (error instanceof ApiError && error.status === 412) {
        setPublicationError('Publication was not changed. Resolve the document conflict before another action.'); await readConflict(id);
      } else if (!unavailable(error)) setPublicationError(`Publication was not changed. ${failureMessage(error)}`);
    } finally { setBusy(false); }
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
  async function exportDocument(format?: ExportFormat, revisionId?: string) {
    if (!base || accessIssue || blocked) return;
    const ticket = generation.current, id = base.document.id;
    setSaveError(''); setNotice(''); setBusyLabel('Exporting…'); setBusy(true);
    try {
      const blob = format ? await api.exportFile(id, format, revisionId)
        : new Blob([JSON.stringify(await api.export(id), null, 2) + '\n'], { type: 'application/json' });
      if (ticket !== generation.current) return;
      downloadFile(blob, `scrawl-document-${id}${revisionId ? `-revision-${revisionId}` : ''}.${format ?? 'json'}`);
      setNotice(`Exported ${revisionId ? 'the selected saved revision' : 'the saved revision'} as ${format ? format.toUpperCase() : 'native JSON'}.${dirty ? ' Your unsaved draft is not included.' : ''}`);
    } catch (error) { if (ticket === generation.current && !unavailable(error)) setSaveError(failureMessage(error)); }
    finally { setBusy(false); }
  }
  async function uploadAttachment(file: File) {
    const ticket = generation.current, id = uploadContext.current.id;
    if (!id || !uploadContext.current.editable || busy || conflict) throw new Error('Save an editable document before uploading attachments');
    setUploading(count => count + 1); setUploadError(''); setUploadMessage('');
    try {
      const attachment = await api.upload(id, file);
      if (ticket !== generation.current || uploadContext.current.id !== id || !uploadContext.current.editable) {
        throw new Error('The attachment target is no longer available');
      }
      setUploadMessage('Attachment uploaded. Save to include it in the document revision.');
      return attachment.url;
    } catch (error) {
      if (ticket === generation.current && uploadContext.current.id === id && !unavailable(error)) {
        setUploadError(error instanceof ApiError && error.status === 413
          ? 'The file is too large or the document attachment limit was reached. Your draft has not been saved.'
          : error instanceof ApiError && error.status === 415
          ? 'This file type is not supported. Your draft has not been saved.'
          : 'Attachment upload failed. Your complete local draft is retained. No document revision was saved.');
      }
      throw error;
    } finally { setUploading(count => count - 1); }
  }
  function pickSearchResult(result: SearchResult) {
    setSearchOpen(false);
    guarded(() => {
      const ticket = generation.current;
      setBusyLabel('Opening document…'); setBusy(true);
      void api.space(result.spaceId).then(async selected => {
        const loaded = await api.document(result.id);
        if (ticket === generation.current) {
          rememberSelection(selected.slug, loaded.document.slug, false);
          await selectSpace(selected, result.id);
        }
      }).catch(error => { if (ticket === generation.current && !unavailable(error)) setSaveError(failureMessage(error)); })
        .finally(() => setBusy(false));
    });
  }
  async function logout() {
    setBusyLabel('Logging out…'); setBusy(true); setSaveError('');
    try {
      await api.logout(); generation.current++; resetDocument(); setUser(null); setSpaces([]); setSpace(null);
      setDocuments([]); setAccessIssue(null); owner.current = null; rememberSelection(null,null);
    } catch (error) { if (!unavailable(error)) setSaveError(failureMessage(error)); }
    finally { setBusy(false); }
  }

  const accessTicket = generation.current;
  const navigation = <>
    {(spaces.length > 0 || user?.role === 'administrator' && !accessIssue) && <div className="listhead space-heading">
      {spaces.length > 0 ? <label htmlFor="space">Space</label> : <span>Spaces</span>}
      {user?.role === 'administrator' && !accessIssue && <button ref={spaceTrigger} aria-haspopup="dialog" disabled={blocked || listLoading} onClick={openSpacePrompt}>New space</button>}
    </div>}
    {spaceNotice && <p role="status" className="muted">{spaceNotice}</p>}
    {spaces.length > 0 && <select id="space" aria-label="Space" value={space?.id ?? ''} disabled={blocked} onChange={event => {
      const selected = spaces.find(item => item.id === event.target.value); if (selected) void navigate(`/spaces/${selected.slug}`);
    }}><option value="" disabled>Select a space</option>{spaces.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>}
    {space && user?.role === 'administrator' && !accessIssue && <button className="quiet space-access" ref={accessTrigger} aria-haspopup="dialog" disabled={blocked} onClick={() => { setMobileOpen(false); setAccessOpen(true); }}>Space access</button>}
    {spacesCursor && <button disabled={listLoading} onClick={() => { void moreSpaces(spacesCursor); }}>More spaces</button>}
    {space && <><div className="listhead"><span>Documents</span>{space.access === 'editor' && !accessIssue && <button onClick={() => newDocument()} disabled={blocked}>New document</button>}</div>
      {listLoading && <p role="status" className="muted">Loading documents…</p>}
      <DocumentNavigation key={space.id} documents={documents} currentId={base?.document.id ?? null} showArchived={includeArchived} spaceSlug={space.slug} blocked={blocked} />
      {!listLoading && !listError && (includeArchived ? documents.length === 0 : !documents.some(item => !item.archivedAt)) && <p className="muted">No documents in this space.</p>}

      <label className="archive-toggle"><input type="checkbox" checked={includeArchived} disabled={blocked} onChange={event => { setIncludeArchived(event.target.checked); void listDocuments(space,event.target.checked); }} />Show archived</label>
    </>}
    {!space && !listLoading && <p className="muted">{accessIssue ? 'Space access is unavailable.' : 'No accessible spaces.'}</p>}
    {listError && <div role="alert"><p>{listError}</p><button onClick={() => { if (space) void listDocuments(space); else if (user) void workspace(user,Boolean(hasUnsavedWork && draft)); }}>Retry</button></div>}
  </>;
  const status = accessIssue ? 'Not saved · local draft only' : busy ? busyLabel : uploading > 0 ? 'Uploading attachment…' : conflict ? 'Not saved · resolve conflict'
    : liveChecking || liveState?.phase === 'connecting' ? 'Connecting shared document…'
    : liveState?.phase === 'closed' ? 'Connection closed · local work retained'
    : liveState?.pending ? 'Syncing changes · not saved as a revision'
    : saveError ? 'Not saved · request failed'
    : liveState && dirty ? `Shared changes · not saved as a revision · based on revision ${base?.document.currentRevisionNumber}`
    : dirty ? `Unsaved changes${base ? ` · based on revision ${base.document.currentRevisionNumber}` : ''}`
    : base?.document.archivedAt ? `Archived · revision ${base.document.currentRevisionNumber}` : `Saved · revision ${base?.document.currentRevisionNumber ?? ''}`;

  return <>
    <header className="top"><span className="brand">Scrawl</span>
      {user && <button className="header-search" aria-label="Search documents" aria-haspopup="dialog" aria-keyshortcuts="Control+k Meta+k"
        disabled={Boolean(accessIssue) || blocked} onClick={() => setSearchOpen(true)}><Search size={17} aria-hidden="true" /><span>Search documents</span><kbd>{/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘ K' : 'Ctrl K'}</kbd></button>}
      {user && narrow && <button aria-haspopup="dialog" aria-expanded={mobileOpen} onClick={() => setMobileOpen(true)}>Navigation</button>}
      {user && <div className="account"><span>{user.email}</span><button className="quiet" disabled={blocked} onClick={() => guarded(() => { void logout(); })}>Log out</button></div>}
    </header>
    {user === undefined ? <main className="state">{bootError ? <><h1>Could not load Scrawl</h1><p role="alert">{bootError}</p><button onClick={() => { void start(); }}>Retry</button></> : <p role="status">Loading Scrawl…</p>}</main>
      : <>
        {!user && <Login onLogin={account => workspace(account,Boolean(hasUnsavedWork && draft))} />}
        {(user || hasUnsavedWork && draft) && <div className={`workspace${!user ? ' retained-workspace' : ''}`}>
          {user && !narrow && <aside className="sidebar" aria-label="Workspace navigation">{navigation}</aside>}
          {user && narrow && <Dialog.Root open={mobileOpen} onOpenChange={setMobileOpen}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="mobile-navigation" aria-describedby={undefined}><Dialog.Title className="sr">Workspace navigation</Dialog.Title><Dialog.Close className="quiet">Close navigation</Dialog.Close>{navigation}</Dialog.Content></Dialog.Portal></Dialog.Root>}
          <main className="main">
            {draft && <div className="documentbar"><span className={dirty || accessIssue || saveError ? 'dirty' : ''} role="status">{status}</span>
              {base && !accessIssue && <><button disabled={blocked} onClick={() => { if (historyOpen) setHistoryOpen(false); else void openHistory(); }}>History</button>
                <details className="doc-menu"><summary ref={actionsTrigger} aria-label="Document actions">⋯</summary><div className="menu-items">
                  {space?.access === 'editor' && !base.document.archivedAt && <button disabled={blocked} onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); newDocument(base.document.id); }}>New child document</button>}
                  {space?.access === 'editor' && !conflict && <button disabled={blocked || hasUnsavedWork || Boolean(liveState?.pending)} onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); setMoveParentId(base.document.parentDocumentId ?? ''); if (!moveNeedsCompare) setMoveError(''); setMoveOpen(true); }}>Move document</button>}
                  <button disabled={blocked} onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); void exportDocument(); }}>Export JSON</button>
                  {collaborationEnabled && !live && mayEdit && <button disabled={blocked || dirty} onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); void enableLive(); }}>Enable shared editing</button>}
                  {(['pdf', 'docx'] as const).map(format => <button key={format} disabled={blocked} onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); void exportDocument(format); }}>Export {format.toUpperCase()}</button>)}
                  {mayPublish && <button disabled={blocked || !publication} onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); setPublicationPrompt({ action: 'publish', revision: base.document.revision }); }}>Publish saved revision</button>}
                  {mayPublish && publication?.publication?.active && <button disabled={blocked} onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); setPublicationPrompt({ action: 'withdraw' }); }}>Withdraw publication</button>}
                  {space?.access === 'editor' && !conflict && <button disabled={blocked || Boolean(liveState?.pending)} onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); guarded(() => { void mutate(() => api.archive(base.document.id,base.etag,Boolean(base.document.archivedAt)),base.document.archivedAt ? 'Unarchiving…' : 'Archiving…'); }); }}>{base.document.archivedAt ? 'Unarchive' : 'Archive'}</button>}
                </div></details></>}
              {mayEdit && <div className="save-actions">{live ? <><button disabled={blocked || !liveState?.canUndo} aria-label="Undo my changes" onClick={() => live.undo()}>Undo</button><button disabled={blocked || !liveState?.canRedo} aria-label="Redo my changes" onClick={() => live.redo()}>Redo</button></> : <button disabled={blocked || (!hasDraftChanges && !contentError)} onClick={discardChanges}>Discard changes</button>}<button ref={saveTrigger} className="primary" aria-keyshortcuts="Control+s Meta+s" title="Save (Ctrl/Cmd+S)" disabled={blocked || !dirty || Boolean(conflict) || Boolean(contentError) || Boolean(liveState?.pending)} onClick={save}>Save</button></div>}
            </div>}
            {accessIssue && <div className="notice" role="alert"><strong>{saveError || (accessIssue === 'session' ? 'Your session expired.' : 'Access to this document is unavailable.')}</strong><p>{dirty ? 'Your complete unsaved title and body are retained in this tab. Nothing was saved. Server actions are unavailable. Copy your draft before closing or reloading.' : commentState.dirty ? 'Your unsent comment text remains in this tab. Nothing was submitted. Server actions are unavailable. Copy it before closing or reloading.' : 'Sign in or ask an administrator to verify your access.'}</p>
              {dirty && draft && <button onClick={() => { void navigator.clipboard.writeText(draft.title+'\n\n'+extractPlainText(draft.content.document)).then(() => setNotice('Local draft text copied. Nothing was saved.')).catch(() => setNotice('Copy is unavailable. Select and copy the retained title and body.')); }}>Copy local draft text</button>}
            </div>}
            {!accessIssue && saveError && <div className="notice" role="alert"><strong>{saveError}</strong>{dirty && <p>Your complete local draft is retained. It has not been saved.</p>}{!draft && <button onClick={() => { if(requestedDocument.current)void loadDocument(requestedDocument.current); }}>Retry</button>}</div>}
            {liveCheckError && !accessIssue && <button disabled={blocked} onClick={() => { setSaveError(''); setLiveRetry(value => value + 1); }}>Retry shared document</button>}
            {sharedEditingUnavailable && !accessIssue && <p className="notice" role="status">Shared editing is disabled. Showing saved revision {base?.document.currentRevisionNumber} read-only. Live changes and comments remain stored but are unavailable.</p>}
            {notice && <p className="notice" role="status">{notice}</p>}
            {uploadError && !accessIssue && <p className="notice" role="alert">{uploadError}</p>}
            {uploadMessage && !accessIssue && <p className="notice" role="status">{uploadMessage}</p>}
            {publicationError && !accessIssue && <div className="notice" role="alert"><p>{publicationError}</p><button disabled={blocked} onClick={() => setPublicationRetry(value => value + 1)}>Retry publication status</button></div>}
            {publishing?.mayPublish && publication?.publication && !accessIssue && <p className="publication-status">{publication.publication.active
              ? <>Published revision {publication.publication.revisionNumber} · <a href={`/publications/${publication.publication.publicId}`} target="_blank" rel="noopener noreferrer">View public document</a></>
              : 'Publication inactive. Publishing again requires explicit approval.'}</p>}
            {loadingDocument ? <p role="status">Loading document…</p> : draft ? <div className={`document-grid${historyOpen || conflict ? ' with-panel' : ''}`}>
              {liveState && !liveState.initialized && liveState.phase === 'connecting' ? <p role="status">Connecting shared document…</p> : <Editor key={editorKey} initialContent={draft.content} editable={mayEdit && !busy} {...(liveState?.initialized && live ? { live, onCommentStateChange: setCommentState } : {})}
                {...(mayEdit ? { uploadFile: uploadAttachment } : {})} uploadAvailable={Boolean(base && mayEdit && !busy && !conflict)}
                resolveFileUrl={api.resolveFileUrl} onValidationChange={setContentError} onChange={content => { setDraft(previous => previous ? { ...previous, content } : previous); if (!live) { setSaveError(''); setNotice(''); } }} header={<>
                {space && !accessIssue && <DocumentPath space={space} parentId={base ? base.document.parentDocumentId : draftParentId} documents={documents} blocked={blocked} />}
                {!base && space && !accessIssue && <label className="draft-location">Location <select aria-label="New document location" value={draftParentId ?? ''} disabled={blocked || listLoading || Boolean(listError)} onChange={event => setDraftParentId(event.target.value || null)}>
                  <option value="">Space root</option><ParentOptions documents={documents} />
                </select></label>}
                <p className="meta">{accessIssue ? 'Retained local draft · not a saved server document' : base?.document.archivedAt ? 'Archived document' : space?.access === 'reader' ? 'Reader access' : 'Editor access'}</p>
                <label className="sr" htmlFor="title">Document title</label><input ref={titleInput} id="title" className="title" aria-label="Document title" value={draft.title} readOnly={!mayEdit} disabled={blocked} onKeyDown={event => { if (live && (event.ctrlKey || event.metaKey) && !event.altKey && ['z', 'y'].includes(event.key.toLowerCase())) { event.preventDefault(); if (event.shiftKey || event.key.toLowerCase() === 'y') live.redo(); else live.undo(); } }} onChange={event => { if (live) live.writeTitle(event.target.value); else setDraft(previous => previous ? { ...previous,title:event.target.value } : previous); setSaveError(''); setNotice(''); }} />
                {mayEdit && !base && <p className="attachment-help">Save this document before uploading attachments.</p>}
              </>} />}
              {liveState?.phase === 'closed' && !accessIssue && <aside className="notice" role="alert"><strong>The shared connection closed.</strong><p>Your complete local title and body remain in this tab. No rejected work will be retried. Reconnecting keeps a separate copy for deliberate comparison.</p>{retainedLiveDraft && <p>Download or discard the earlier retained draft before reconnecting again.</p>}<button disabled={blocked || Boolean(retainedLiveDraft)} onClick={() => { if (commentState.dirty) guarded(() => { void reconnectLive(); }); else void reconnectLive(); }}>Reconnect and compare</button></aside>}
              {retainedLiveDraft && <aside className="notice" aria-label="Retained local draft"><h2>Retained local draft</h2><p>{retainedLiveDraft.title}</p><p>Your previous title and body are kept separately. Review the shared document before reapplying any unsent edits.</p><pre className="retained-draft-text">{extractPlainText(retainedLiveDraft.content.document)}</pre><button onClick={() => downloadFile(new Blob([JSON.stringify(retainedLiveDraft, null, 2)], { type: 'application/json' }), 'scrawl-local-draft.json')}>Download retained local draft</button><button onClick={() => guarded(() => setRetainedLiveDraft(null))}>Discard retained draft</button></aside>}
              {conflict && <aside className="side-panel conflict" aria-label="Save conflict"><h2>Save conflict</h2><p>Compare your local title and body with the latest server version, then choose how to reconcile. No write will be retried automatically.</p>
                {conflict.loading && <p role="status">Loading latest server version…</p>}
                {conflict.error && <div role="alert"><p>{conflict.error}</p><button onClick={() => { if(base)void readConflict(base.document.id); }}>Retry</button></div>}
                {conflict.latest && <><small>Latest server version · revision {conflict.latest.document.currentRevisionNumber}</small><Editor key={conflict.latest.etag} initialContent={conflict.latest.document.revision.content} label="Latest server content" editable={false} resolveFileUrl={api.resolveFileUrl} onChange={() => {}} header={<h3>{conflict.latest.document.revision.title}</h3>} />
                  <div className="actions"><button onClick={() => { const latest=conflict.latest!; setMoveNeedsCompare(false); setMoveError(''); setBase(latest); setConflict(null); setSaveError(''); setNotice(live ? "The current shared document is kept, including collaborators' edits. Review against the new checkpoint, then explicitly Save." : 'Your local title and body are kept. Review your changes against the new comparison base, then explicitly Save.'); }}>{live ? 'Use current shared content' : 'Use my changes'}</button>{!live && <button onClick={() => guarded(() => { adopt(conflict.latest!); setNotice('Using the latest saved server version.'); })}>Use server version</button>}</div>
                </>}
              </aside>}
              {historyOpen && !accessIssue && <aside className="side-panel" aria-label="Revision history"><button className="quiet close" onClick={() => setHistoryOpen(false)}>Close history</button><h2>History</h2>
                {historyLoading && <p role="status">Loading history…</p>}
                {historyError && <div role="alert"><p>{historyError}</p><button onClick={() => { void openHistory(); }}>Retry</button></div>}
                <ol className="revisions">{revisions.map(item => <li key={item.id}><button aria-label={`Revision ${item.revisionNumber}`} aria-pressed={revision?.id===item.id} disabled={blocked} onClick={() => { void selectRevision(item); }}><span>Revision {item.revisionNumber}</span><small>{new Date(item.createdAt).toLocaleString()}</small></button></li>)}</ol>
                {revisionsCursor && <button disabled={historyLoading} onClick={() => { void openHistory(revisionsCursor); }}>More revisions</button>}
                {revision && !historyLoading && <Editor key={revision.id} initialContent={revision.content} label="Revision content" editable={false} resolveFileUrl={api.resolveFileUrl} onChange={() => {}} header={<><h3>{revision.title}</h3>{mayEdit && !conflict && <button className="restore" disabled={blocked || revision.id===base?.document.revision.id || Boolean(live && (dirty || commentState.dirty || liveState?.pending || retainedLiveDraft))} onClick={() => { void restoreRevision(revision.id); }}>Restore revision {revision.revisionNumber}</button>}{mayPublish && <button disabled={blocked || !publication} onClick={() => setPublicationPrompt({ action: 'publish', revision })}>Publish revision {revision.revisionNumber}</button>}<div className="revision-exports"><button disabled={blocked} onClick={() => { void exportDocument('pdf', revision.id); }}>Export PDF</button><button disabled={blocked} onClick={() => { void exportDocument('docx', revision.id); }}>Export DOCX</button></div></>} />}
              </aside>}
            </div> : !loadingDocument && !saveError && !accessIssue && !listLoading && <section className="state"><h1>{space ? 'No documents yet' : 'No accessible spaces'}</h1><p>{space ? space.access === 'editor' ? 'Create a document when you are ready.' : 'An editor can add the first document.' : user?.role === 'administrator' ? 'Create a space to organize your documents.' : 'Ask an administrator for space access.'}</p></section>}
          </main>
        </div>}
      </>}
    <Dialog.Root open={Boolean(pending) || navigationBlocker.state === 'blocked'} onOpenChange={open => {
      if (!open) { setPending(null); if (navigationBlocker.state === 'blocked') navigationBlocker.reset(); }
    }}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="dialog" onCloseAutoFocus={event => {
      event.preventDefault();
      const composer = commentState.dirty && document.querySelector<HTMLElement>('.bn-comment-editor .bn-editor[contenteditable="true"]');
      if (composer) composer.focus(); else titleInput.current?.focus();
    }}><Dialog.Title>{blocked ? 'Please wait' : 'Unsaved changes'}</Dialog.Title><Dialog.Description>{blocked ? 'The current request must finish before leaving this document.' : commentState.dirty ? 'Continuing discards your unsent comment text and any other local draft. Accepted document changes remain shared.' : live ? 'Your shared edits have not been saved as a revision. Accepted changes remain shared; leaving discards only unsent work in this tab.' : 'Your title and body have not been saved. Continuing will discard your local changes.'}</Dialog.Description><div className="actions"><Dialog.Close className="primary">Keep editing</Dialog.Close><button disabled={blocked} onClick={() => {
      const action = pending?.action; setPending(null); resetDraftToBaseline();
      if (navigationBlocker.state === 'blocked') navigationBlocker.proceed(); else action?.();
    }}>Discard changes</button></div></Dialog.Content></Dialog.Portal></Dialog.Root>
    <Dialog.Root open={spacePrompt} onOpenChange={open => { if (!creatingSpace) setSpacePrompt(open); }}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="dialog" onCloseAutoFocus={event => { event.preventDefault(); if (spaceTrigger.current?.isConnected) spaceTrigger.current.focus(); else titleInput.current?.focus(); }} onEscapeKeyDown={event => { if (creatingSpace) event.preventDefault(); }} onPointerDownOutside={event => { if (creatingSpace) event.preventDefault(); }}>
      <Dialog.Title>New space</Dialog.Title><Dialog.Description>Create a space for private documents. Only administrators have access until members are granted access.</Dialog.Description>
      <form className="space-form" onSubmit={event => { event.preventDefault(); void createSpace(); }}>
        <label htmlFor="new-space-name">Space name</label><input id="new-space-name" required maxLength={200} value={spaceName} disabled={creatingSpace} onChange={event => setSpaceName(event.target.value)} />
        {spaceCreateError && <p role="alert">{spaceCreateError}</p>}
        {creatingSpace && <p role="status">Creating space…</p>}
        <div className="actions"><Dialog.Close type="button" disabled={creatingSpace}>Cancel</Dialog.Close><button className="primary" disabled={creatingSpace || !spaceName.trim()}>Create space</button></div>
      </form>
    </Dialog.Content></Dialog.Portal></Dialog.Root>
    <Dialog.Root open={moveOpen && Boolean(base && space && !accessIssue)} onOpenChange={open => { if (!moveWriting.current) setMoveOpen(open); }}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="dialog" onCloseAutoFocus={event => { event.preventDefault(); if (actionsTrigger.current?.isConnected) actionsTrigger.current.focus(); else titleInput.current?.focus(); }} onEscapeKeyDown={event => { if (moveWriting.current) event.preventDefault(); }} onPointerDownOutside={event => { if (moveWriting.current) event.preventDefault(); }}>
      <Dialog.Title>Move document</Dialog.Title><Dialog.Description>Choose a location in this space. Content, history and links stay unchanged.</Dialog.Description>
      <form className="space-form" onSubmit={event => { event.preventDefault(); void moveDocument(); }}>
        <label htmlFor="move-parent">Parent document</label><select id="move-parent" value={moveParentId} disabled={blocked || listLoading || moveNeedsCompare} onChange={event => { setMoveParentId(event.target.value); setMoveError(''); }}>
          <option value="">Space root</option>{base?.document.parentDocumentId && documents.find(item => item.id === base.document.parentDocumentId)?.archivedAt && <option value={base.document.parentDocumentId} disabled>Current parent (archived)</option>}
          <ParentOptions documents={documents} {...(base ? { documentId: base.document.id } : {})} />
        </select>
        {listLoading && <p role="status">Loading locations…</p>}{listError && <p role="alert">Locations could not be loaded. Close this dialog and retry the document list.</p>}
        {moveError && <p role="alert">{moveError}</p>}{moveWriting.current && <p role="status">Moving document…</p>}
        {moveNeedsCompare && base && <button type="button" disabled={blocked} onClick={() => { setMoveOpen(false); void readConflict(base.document.id); }}>Compare latest document</button>}
        <div className="actions"><Dialog.Close type="button" disabled={blocked}>Cancel</Dialog.Close><button className="primary" disabled={blocked || listLoading || Boolean(listError) || moveNeedsCompare || hasUnsavedWork || moveParentId === (base?.document.parentDocumentId ?? '')}>Move document</button></div>
      </form>
    </Dialog.Content></Dialog.Portal></Dialog.Root>
    {accessOpen && space && user?.role === 'administrator' && !accessIssue && <SpaceAccess key={`${user.id}:${space.id}`} space={space} onClose={() => setAccessOpen(false)}
      onCloseFocus={() => { if (accessTrigger.current?.isConnected) accessTrigger.current.focus(); else titleInput.current?.focus(); }} onBusyChange={setAccessBusy}
      onChanged={updated => { if (accessTicket === generation.current && updated.id === space.id) { setSpace(updated); setSpaces(previous => previous.map(item => item.id === updated.id ? updated : item)); } }} onPermissionFailure={async error => { if (accessTicket === generation.current) await recheckAccess(error); }} />}
    {searchOpen && user && !accessIssue && <SearchDialog onClose={() => setSearchOpen(false)} onPick={pickSearchResult} onFailure={unavailable} />}
    <Dialog.Root open={Boolean(publicationPrompt)} onOpenChange={open => { if (!open) setPublicationPrompt(null); }}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="dialog" onCloseAutoFocus={event => { event.preventDefault(); titleInput.current?.focus(); }}>
      <Dialog.Title>{publicationPrompt?.action === 'publish' ? `Publish revision ${publicationPrompt.revision.revisionNumber}?` : 'Withdraw publication?'}</Dialog.Title>
      <Dialog.Description>{publicationPrompt?.action === 'publish'
        ? 'Anyone with the public link can read this saved revision, including its content and links. Unsaved edits and later private saves are not included.'
        : 'Future public requests will be denied. Copies already downloaded cannot be erased.'}</Dialog.Description>
      {publicationPrompt?.action === 'publish' && <p className="publication-selection">{publicationPrompt.revision.title} · revision {publicationPrompt.revision.revisionNumber}</p>}
      <div className="actions"><Dialog.Close>Keep editing</Dialog.Close><button className="primary" disabled={!mayPublish || blocked} onClick={() => { void changePublication(); }}>{publicationPrompt?.action === 'publish' ? `Publish revision ${publicationPrompt.revision.revisionNumber}` : 'Withdraw publication'}</button></div>
    </Dialog.Content></Dialog.Portal></Dialog.Root>
    <footer className="footer">Scrawl · <a href="/assets/LICENSE.txt" target="_blank" rel="noopener noreferrer">AGPL-3.0-only</a> · <a href="/assets/THIRD_PARTY_NOTICES.txt" target="_blank" rel="noopener noreferrer">Third-party notices</a> · <a href="/assets/scrawl-source.tar.gz" download>Source for this build</a></footer>
  </>;
}
