// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Link } from 'react-router';
import type { DocumentSummary, Space } from './api/client';

const titles = new Intl.Collator('en', { sensitivity: 'base', numeric: true });
function compareDocuments(a: DocumentSummary, b: DocumentSummary) {
  return titles.compare(a.title, b.title) || a.id.localeCompare(b.id);
}

export function initialDocument(documents: readonly DocumentSummary[]) {
  const ids = new Set(documents.map(item => item.id));
  const roots = documents.filter(item => !item.parentDocumentId || !ids.has(item.parentDocumentId));
  const active = roots.filter(item => !item.archivedAt);
  return [...(active.length ? active : roots.length ? roots : documents)].sort(compareDocuments)[0];
}

export function documentAncestors(parentId: string | null, index: ReadonlyMap<string, DocumentSummary>) {
  const path: DocumentSummary[] = [], seen = new Set<string>();
  while (parentId && !seen.has(parentId) && path.length < 32) {
    seen.add(parentId);
    const parent = index.get(parentId);
    if (!parent) break;
    path.unshift(parent); parentId = parent.parentDocumentId;
  }
  return path;
}

export function ParentOptions({ documents, documentId }: { documents: readonly DocumentSummary[]; documentId?: string }) {
  const index = new Map(documents.map(item => [item.id, item]));
  return <>{documents.filter(item => !item.archivedAt && item.id !== documentId)
    .map(item => ({ item, path: documentAncestors(item.parentDocumentId, index) }))
    .filter(({ path }) => path.length < 31 && !path.some(parent => parent.id === documentId))
    .sort((a, b) => compareDocuments(a.item, b.item))
    .map(({ item, path }) => <option key={item.id} value={item.id}>{[...path, item].map(parent => parent.title).join(' / ')}</option>)}</>;
}

export function DocumentPath({ space, parentId, documents, blocked }: {
  space: Space; parentId: string | null; documents: readonly DocumentSummary[]; blocked: boolean;
}) {
  const index = new Map(documents.map(item => [item.id, item]));
  const path = documentAncestors(parentId, index);
  const earlier = path.length > 3 ? path.slice(0, -2) : [];
  const recent = earlier.length ? path.slice(-2) : path;
  function parentLink(parent: DocumentSummary) {
    return <Link to={`/spaces/${space.slug}/documents/${parent.slug}`} aria-disabled={blocked || undefined}
      onClick={event => { if (blocked) event.preventDefault(); }}>{parent.title}{parent.archivedAt ? ' (archived)' : ''}</Link>;
  }
  return <nav className="document-path" aria-label="Document path">
    <Link to={`/spaces/${space.slug}`} aria-disabled={blocked || undefined} onClick={event => { if (blocked) event.preventDefault(); }}>{space.name}</Link>
    {earlier.length > 0 && <><span aria-hidden="true"> / </span><details className="path-menu">
      <summary aria-label="Earlier parent documents" aria-disabled={blocked || undefined} onClick={event => { if (blocked) event.preventDefault(); }}>…</summary>
      <div className="menu-items">{earlier.map(parent => <div key={parent.id}>{parentLink(parent)}</div>)}</div>
    </details></>}
    {recent.map(parent => <span key={parent.id}><span aria-hidden="true"> / </span>{parentLink(parent)}</span>)}
  </nav>;
}

export function DocumentNavigation({ documents, currentId, showArchived, spaceSlug, blocked }: {
  documents: readonly DocumentSummary[]; currentId: string | null; showArchived: boolean; spaceSlug: string; blocked: boolean;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const visible = useMemo(() => documents.filter(item => showArchived || !item.archivedAt)
    .sort(compareDocuments), [documents, showArchived]);
  const children = useMemo(() => {
    const result = new Map<string | null, DocumentSummary[]>(), ids = new Set(visible.map(item => item.id));
    for (const item of visible) {
      const parent = item.parentDocumentId && ids.has(item.parentDocumentId) ? item.parentDocumentId : null;
      const siblings = result.get(parent) ?? []; siblings.push(item); result.set(parent, siblings);
    }
    return result;
  }, [visible]);
  useEffect(() => {
    const current = documents.find(item => item.id === currentId);
    if (!current) return;
    const parents = documentAncestors(current.parentDocumentId, new Map(documents.map(item => [item.id, item])));
    setExpanded(previous => new Set([...previous, ...parents.map(parent => parent.id)]));
  }, [currentId, documents]);
  function branch(parentId: string | null, depth = 0) {
    if (depth >= 32) return null;
    return <ul className={depth > 6 ? 'deep-document-branch' : undefined}>{children.get(parentId)?.map(item => {
      const hasChildren = Boolean(children.get(item.id)?.length), open = expanded.has(item.id);
      return <li key={item.id}><div className="document-row">
        {hasChildren ? <button type="button" className="document-disclosure" aria-label={`Child documents of ${item.title}`}
          aria-expanded={open} aria-controls={`children-${item.id}`} disabled={blocked} onClick={() => setExpanded(previous => {
            const next = new Set(previous); if (open) next.delete(item.id); else next.add(item.id); return next;
          })}>{open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}</button> : <span className="document-disclosure" />}
        <Link to={`/spaces/${spaceSlug}/documents/${item.slug}`} className={item.id === currentId ? 'active' : ''}
          aria-current={item.id === currentId ? 'page' : undefined} aria-disabled={blocked || undefined}
          onClick={event => { if (blocked) event.preventDefault(); }}>{item.title}{item.archivedAt && <small>Archived</small>}</Link>
      </div>{hasChildren && <div id={`children-${item.id}`} hidden={!open}>{open && branch(item.id, depth + 1)}</div>}</li>;
    })}</ul>;
  }
  return <nav className="documents document-tree" aria-label="Documents">{branch(null)}</nav>;
}
