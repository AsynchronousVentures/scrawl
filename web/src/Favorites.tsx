// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { api, type FavoriteSummary } from './api/client';

/** Personal navigation state never reads or replaces the document draft/ETag. */
export function useFavorites(ownerId: string | null, documentId: string | null, savedVersion: number | null,
  archivedAt: string | null, unavailable: (error: unknown) => boolean) {
  const scope = useRef({ ownerId, documentId }); scope.current = { ownerId, documentId };
  const denied = useRef(unavailable); denied.current = unavailable;
  const listSequence = useRef(0), stateSequence = useRef(0), writing = useRef(false);
  const [list, setList] = useState<{ owner: string | null; items: FavoriteSummary[]; cursor: string | null }>({ owner: null, items: [], cursor: null });
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<{ owner: string | null; message: string }>({ owner: null, message: '' });
  const [state, setState] = useState<{ owner: string | null; id: string | null; value: boolean | null }>({ owner: null, id: null, value: null });
  const [stateLoading, setStateLoading] = useState(false);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<{ owner: string | null; id: string | null; error: string; notice: string }>({ owner: null, id: null, error: '', notice: '' });

  async function load(cursor?: string) {
    const owner = scope.current.ownerId; if (!owner) return;
    const ticket = ++listSequence.current; setListLoading(true); setListError({ owner, message: '' });
    try {
      const data = await api.favorites(cursor);
      if (scope.current.ownerId !== owner || ticket !== listSequence.current) return;
      setList(previous => ({ owner, items: cursor && previous.owner === owner
        ? [...previous.items, ...data.items.filter(item => !previous.items.some(existing => existing.id === item.id))] : data.items,
      cursor: data.nextCursor }));
    } catch (error) {
      if (scope.current.ownerId === owner && ticket === listSequence.current && !denied.current(error)) {
        setListError({ owner, message: 'Favorites could not be loaded. Refresh to try again.' });
      }
    } finally { if (ticket === listSequence.current) setListLoading(false); }
  }
  async function read() {
    const { ownerId: owner, documentId: id } = scope.current; if (!owner || !id) return;
    const ticket = ++stateSequence.current; setStateLoading(true); setFeedback({ owner, id, error: '', notice: '' });
    try {
      const value = await api.favorite(id);
      if (scope.current.ownerId === owner && scope.current.documentId === id && ticket === stateSequence.current) {
        setState({ owner, id, value });
      }
    } catch (error) {
      if (scope.current.ownerId === owner && scope.current.documentId === id && ticket === stateSequence.current && !denied.current(error)) {
        setState({ owner, id, value: null }); setFeedback({ owner, id, error: 'Favorite status could not be checked.', notice: '' });
      }
    } finally { if (ticket === stateSequence.current) setStateLoading(false); }
  }
  async function change() {
    const { ownerId: owner, documentId: id } = scope.current;
    if (!owner || !id || writing.current || stateLoading || state.owner !== owner || state.id !== id || state.value === null) return;
    writing.current = true; setPending(true); setFeedback({ owner, id, error: '', notice: '' }); ++stateSequence.current;
    try {
      const value = await api.setFavorite(id, !state.value);
      if (scope.current.ownerId !== owner || scope.current.documentId !== id) return;
      setState({ owner, id, value }); setFeedback({ owner, id, error: '', notice: value ? 'Added to favorites.' : 'Removed from favorites.' });
      void load();
    } catch (error) {
      if (scope.current.ownerId === owner && scope.current.documentId === id && !denied.current(error)) {
        setState({ owner, id, value: null });
        setFeedback({ owner, id, error: 'The favorite change was not confirmed. Check its status before trying again.', notice: '' });
      }
    } finally { writing.current = false; setPending(false); }
  }
  useEffect(() => {
    if (ownerId) void load();
    else { setList({ owner: null, items: [], cursor: null }); setListError({ owner: null, message: '' }); setListLoading(false); }
    return () => { ++listSequence.current; };
  }, [ownerId, documentId, savedVersion, archivedAt]);
  useEffect(() => {
    setState({ owner: null, id: null, value: null }); setStateLoading(false);
    setFeedback({ owner: null, id: null, error: '', notice: '' });
    if (ownerId && documentId) void read();
    return () => { ++stateSequence.current; };
  }, [ownerId, documentId, archivedAt]);
  const items = useMemo(() => list.owner === ownerId && ownerId
    ? [...list.items].sort((left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id)) : [], [list, ownerId]);
  const value = state.owner === ownerId && state.id === documentId ? state.value : null;
  const visibleFeedback = feedback.owner === ownerId && feedback.id === documentId ? feedback : null;
  return { items, cursor: list.owner === ownerId ? list.cursor : null, pending, value,
    listLoading: Boolean(ownerId && (listLoading || list.owner !== ownerId && listError.owner !== ownerId)),
    listError: listError.owner === ownerId ? listError.message : '', stateLoading,
    stateError: visibleFeedback?.error ?? '', notice: visibleFeedback?.notice ?? '',
    refresh() { void load(); if (documentId) void read(); }, more() { if (list.cursor) void load(list.cursor); },
    read, change };
}

export function FavoritesNavigation({ favorites, currentId, blocked }: {
  favorites: ReturnType<typeof useFavorites>; currentId: string | null; blocked: boolean;
}) {
  return <nav className="favorites-nav" aria-label="Favorites">
    <div className="listhead"><span>Favorites</span></div>
    {favorites.listLoading && <p role="status" className="muted">Loading favorites…</p>}
    <ul>{favorites.items.map(item => <li key={item.id}><Link to={`/spaces/${item.spaceSlug}/documents/${item.slug}`}
      className={item.id === currentId ? 'active' : ''} aria-current={item.id === currentId ? 'page' : undefined}
      aria-disabled={blocked || undefined} onClick={event => { if (blocked) event.preventDefault(); }}>
      <span>{item.title}</span>{' '}<small>{item.spaceName}</small>
    </Link></li>)}</ul>
    {!favorites.listLoading && !favorites.listError && favorites.items.length === 0 && <p className="muted">No favorites yet.</p>}
    {favorites.listError && <p role="alert">{favorites.listError}</p>}
    {favorites.listError && <button disabled={blocked || favorites.listLoading} onClick={favorites.refresh}>Refresh favorites</button>}
    {favorites.cursor && <button disabled={blocked || favorites.listLoading} onClick={favorites.more}>More favorites</button>}
  </nav>;
}
