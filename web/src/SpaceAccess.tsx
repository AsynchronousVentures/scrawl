// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { api, ApiError, type MemberProfile, type Space } from './api/client';

type Access = 'reader' | 'editor';
export function SpaceAccess({ space, onClose, onCloseFocus, onBusyChange, onChanged, onPermissionFailure }: {
  space: Space;
  onClose: () => void;
  onCloseFocus: () => void;
  onBusyChange: (busy: boolean) => void;
  onChanged: (space: Space) => void;
  onPermissionFailure: (error: ApiError) => Promise<void>;
}) {
  const [loaded, setLoaded] = useState<Awaited<ReturnType<typeof api.members>> | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Access>('reader');
  const [desired, setDesired] = useState<Record<string, Access>>({});
  const [removal, setRemoval] = useState<MemberProfile | null>(null);
  const alive = useRef(true), reads = useRef(0);

  async function load(cursor?: string) {
    const ticket = ++reads.current;
    setLoading(true); setError('');
    try {
      const result = await api.members(space.id, cursor);
      if (!alive.current || ticket !== reads.current) return;
      if (cursor && loaded && result.etag !== loaded.etag) {
        setStale(true); setError('Access changed while loading members. Reload access, review it, then apply your changes.'); return;
      }
      setLoaded(previous => cursor && previous ? { ...result, members: { ...result.members,
        items: [...previous.members.items, ...result.members.items.filter(item => !previous.members.items.some(old => old.user.id === item.user.id))],
      } } : result);
      setStale(false); setRemoval(null);
    } catch (failure) {
      if (!alive.current || ticket !== reads.current) return;
      setStale(true);
      if (failure instanceof ApiError && [401,403,404].includes(failure.status)) await onPermissionFailure(failure);
      else setError('The member list could not be loaded. Your document edits are retained.');
    } finally { if (alive.current && ticket === reads.current) setLoading(false); }
  }
  useEffect(() => {
    alive.current = true; void load();
    return () => { alive.current = false; reads.current++; };
  }, [space.id]);

  async function commit(user: MemberProfile, access: Access | null) {
    if (!loaded || !alive.current) return;
    const updated = await api.changeMember(space.id, user.id, loaded.etag, access);
    if (!alive.current) return;
    onChanged(updated.space); setNotice(access === null ? 'Access removed.' : 'Access updated.');
    setDesired(previous => { const next = { ...previous }; delete next[user.id]; return next; });
    await load(); // A successful write can refresh its list; a 412 never retries or adopts a new tag.
  }
  async function run(operation: () => Promise<void>) {
    if (busy || loading || stale || !loaded) return;
    setBusy(true); onBusyChange(true); setError(''); setNotice('');
    try { await operation(); }
    catch (failure) {
      if (!alive.current) return;
      if (failure instanceof ApiError && failure.status === 412) {
        setStale(true); setError('Access changed elsewhere. Reload access, review it, then apply your changes again.');
      } else if (failure instanceof ApiError && [401,403,404].includes(failure.status)) await onPermissionFailure(failure);
      else { setStale(true); setError('The access change could not be confirmed. Reload access before trying again. Your requested change and document edits are retained.'); }
    } finally { if (alive.current) setBusy(false); onBusyChange(false); }
  }
  async function grant() {
    await run(async () => {
      let user: MemberProfile;
      try { user = await api.lookupUser(email.trim()); }
      catch (failure) {
        if (failure instanceof ApiError && failure.status === 404) {
          const current = await api.me();
          if (!alive.current) return;
          if (current.role === 'administrator') { setError('No existing account uses that email. Ask your operator to provision it.'); return; }
        }
        throw failure;
      }
      if (!alive.current) return;
      if (user.role === 'administrator') { setNotice('Administrators already have access to every space.'); return; }
      await commit(user, role);
    });
  }
  const disabled = busy || loading || stale || !loaded;
  return <Dialog.Root open onOpenChange={open => { if (!open && !busy) onClose(); }}><Dialog.Portal>
    <Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="dialog access-dialog" onCloseAutoFocus={event => { event.preventDefault(); onCloseFocus(); }}
      onEscapeKeyDown={event => { if (busy) event.preventDefault(); }} onPointerDownOutside={event => { if (busy) event.preventDefault(); }}>
      <Dialog.Title>Space access</Dialog.Title><Dialog.Description>{space.name}. Administrators always have access to every space.</Dialog.Description>
      <form className="access-form" onSubmit={event => { event.preventDefault(); void grant(); }}>
        <label htmlFor="member-email">Existing account email</label><input id="member-email" type="email" required maxLength={254} autoComplete="off" value={email} disabled={busy} onChange={event => setEmail(event.target.value)} />
        <div className="access-grant"><label htmlFor="member-role">Access</label><select id="member-role" value={role} disabled={busy} onChange={event => setRole(event.target.value === 'editor' ? 'editor' : 'reader')}><option value="reader">Reader</option><option value="editor">Editor</option></select>
          <button className="primary" disabled={disabled || !email.trim()}>Grant access</button></div>
      </form>
      {loading && <p role="status">Loading members…</p>}{busy && <p role="status">Updating access…</p>}
      {notice && <p role="status">{notice}</p>}
      {error && <div role="alert"><p>{error}</p><button disabled={busy || loading} onClick={() => { void load(); }}>Reload access</button></div>}
      {!loading && loaded && loaded.members.items.length === 0 && <p className="muted">No member grants. Only administrators can access this space.</p>}
      <ul className="members">{loaded?.members.items.map(member => <li key={member.user.id}>
        <div className="member-info"><strong>{member.user.name}</strong><small>{member.user.email}</small></div>
        {member.user.role === 'administrator' ? <span className="muted">Administrator access</span> : <div className="member-actions">
          <select aria-label={`Access for ${member.user.email}`} value={desired[member.user.id] ?? member.role} disabled={disabled} onChange={event => setDesired(previous => ({ ...previous, [member.user.id]: event.target.value === 'editor' ? 'editor' : 'reader' }))}><option value="reader">Reader</option><option value="editor">Editor</option></select>
          <button disabled={disabled || !desired[member.user.id] || desired[member.user.id] === member.role} onClick={() => { void run(() => commit(member.user, desired[member.user.id]!)); }}>Apply</button>
          <button disabled={disabled} onClick={() => setRemoval(member.user)}>Remove</button>
        </div>}
      </li>)}</ul>
      {loaded?.members.nextCursor && <button disabled={busy || loading} onClick={() => { void load(loaded.members.nextCursor!); }}>More members</button>}
      {removal && <section className="access-removal" aria-label="Confirm access removal"><p>Remove {removal.email}'s access? Existing sessions will lose access to this space.</p><div className="actions"><button disabled={busy} onClick={() => setRemoval(null)}>Keep access</button><button disabled={disabled} onClick={() => { void run(() => commit(removal, null)); }}>Remove access</button></div></section>}
      <div className="actions"><Dialog.Close disabled={busy}>Done</Dialog.Close></div>
    </Dialog.Content></Dialog.Portal></Dialog.Root>;
}
