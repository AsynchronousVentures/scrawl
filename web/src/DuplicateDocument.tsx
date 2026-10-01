// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import { useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Link } from 'react-router';
import { api, ApiError, type Document, type Revision } from './api/client';

export function DuplicateDocument({ documentId, revision, onClose, onBusy, onCreated, onFailure, returnFocus }: {
  documentId: string; revision: Revision; onClose: () => void; onBusy: (busy: boolean) => void;
  onCreated: () => void; onFailure: (error: unknown) => boolean; returnFocus: () => void;
}) {
  const [title, setTitle] = useState(`${revision.title.slice(0, 193).replace(/[\ud800-\udbff]$/, '')} (copy)`);
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState<Document | null>(null);
  const writing = useRef(false);
  async function create() {
    if (writing.current || attempted || !title.trim()) return;
    writing.current = true; setBusy(true); setAttempted(true); onBusy(true);
    try {
      const result = await api.duplicate(documentId, revision.id, title);
      setCreated(result.document); onCreated();
    } catch (error) {
      if (!onFailure(error)) setError(error instanceof ApiError ? error.message : 'The response could not be used.');
    } finally { writing.current = false; setBusy(false); onBusy(false); }
  }
  return <Dialog.Root open onOpenChange={open => { if (!open && !writing.current) onClose(); }}><Dialog.Portal>
    <Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="dialog copy-dialog"
      onCloseAutoFocus={event => { event.preventDefault(); returnFocus(); }}
      onEscapeKeyDown={event => { if (writing.current) event.preventDefault(); }}
      onPointerDownOutside={event => { if (writing.current) event.preventDefault(); }}>
      <Dialog.Title>Duplicate saved document</Dialog.Title>
      <Dialog.Description>Copy revision {revision.revisionNumber} of "{revision.title}" to this space's root, including its private attachments. Your current edits stay here. History, comments and publication are not copied.</Dialog.Description>
      {created ? <><p role="status">Created "{created.revision.title}" with revision 1.</p><div className="actions">
        <Dialog.Close>Keep editing</Dialog.Close>
        <Link className="primary" to={`/spaces/${created.spaceSlug}/documents/${created.slug}`} onClick={onClose}>Open copy</Link>
      </div></> : <form className="copy-form" onSubmit={event => { event.preventDefault(); void create(); }}>
        <label htmlFor="copy-title">Copy title</label><input id="copy-title" maxLength={200} required value={title} disabled={busy || attempted} onChange={event => setTitle(event.target.value)} />
        {busy && <p role="status">Copying saved revision…</p>}
        {error && <div role="alert"><p>{error}</p><p>Your draft is retained. The request will not be retried. Check the document list before creating another copy, since the response may be uncertain.</p></div>}
        <div className="actions"><Dialog.Close type="button" disabled={busy}>Keep editing</Dialog.Close><button className="primary" disabled={busy || attempted || !title.trim()}>Create copy</button></div>
      </form>}
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>;
}
