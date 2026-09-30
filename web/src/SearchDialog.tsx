// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import { useEffect, useId, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { api, type SearchResult } from './api/client';

type State = { status: 'idle' | 'loading' | 'error'; items: SearchResult[] }
  | { status: 'ready'; items: SearchResult[] };

export function SearchDialog({ onClose, onPick, onFailure }: {
  onClose: () => void;
  onPick: (result: SearchResult) => void;
  onFailure: (error: unknown) => boolean;
}) {
  const [query, setQuery] = useState('');
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<State>({ status: 'idle', items: [] });
  const [selected, setSelected] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const ticket = useRef(0);
  const navigating = useRef(false);
  const failure = useRef(onFailure); failure.current = onFailure;
  const identifier = `search-${useId().replace(/[^a-zA-Z0-9_-]/g, '-')}`;

  useEffect(() => {
    const value = query.trim(), request = ++ticket.current;
    if (!value) { setState({ status: 'idle', items: [] }); return; }
    const abort = new AbortController();
    setState({ status: 'loading', items: [] });
    const timer = setTimeout(() => {
      void api.search(value, abort.signal).then(result => {
        if (abort.signal.aborted || request !== ticket.current) return;
        setSelected(0); setState({ status: 'ready', items: result.items });
      }).catch(error => {
        if (abort.signal.aborted || request !== ticket.current) return;
        if (!failure.current(error)) setState({ status: 'error', items: [] });
      });
    }, 300);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [query, retry]);
  useEffect(() => {
    document.getElementById(`${identifier}-result-${selected}`)?.scrollIntoView({ block: 'nearest' });
  }, [identifier, selected, state.items]);

  function pick(result: SearchResult) {
    navigating.current = true; ticket.current++;
    onPick(result);
  }

  return <Dialog.Root open onOpenChange={open => { if (!open) onClose(); }}>
    <Dialog.Portal><Dialog.Overlay className="dialog-overlay" />
      <Dialog.Content className="dialog search-dialog" aria-describedby={`${identifier}-description`}
        onOpenAutoFocus={event => { event.preventDefault(); input.current?.focus(); }}
        onCloseAutoFocus={event => { if (navigating.current) event.preventDefault(); }}
        onKeyDown={event => {
          if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && state.items.length) {
            event.preventDefault();
            setSelected(previous => (previous + (event.key === 'ArrowDown' ? 1 : -1) + state.items.length) % state.items.length);
            input.current?.focus();
          } else if (event.key === 'Enter' && state.status === 'ready' && state.items[selected]
            && (event.target === input.current || (event.target instanceof HTMLElement && event.target.getAttribute('role') === 'option'))) {
            event.preventDefault(); pick(state.items[selected]);
          }
        }}>
        <div className="search-heading"><Dialog.Title>Search documents</Dialog.Title><Dialog.Close>Close</Dialog.Close></div>
        <Dialog.Description id={`${identifier}-description`} className="sr">Search saved documents you can access. Archived documents and unsaved changes are excluded.</Dialog.Description>
        <form className="search-form" role="search" onSubmit={event => event.preventDefault()}>
          <label className="sr" htmlFor={`${identifier}-query`}>Search accessible documents</label>
          <input ref={input} id={`${identifier}-query`} type="search" role="combobox" aria-autocomplete="list"
            aria-expanded={state.status === 'ready' && state.items.length > 0} aria-controls={`${identifier}-results`}
            aria-activedescendant={state.items[selected] ? `${identifier}-result-${selected}` : undefined}
            placeholder="Search accessible documents" autoComplete="off" maxLength={200} value={query}
            onChange={event => { ticket.current++; setSelected(0); setState({ status: event.target.value.trim() ? 'loading' : 'idle', items: [] }); setQuery(event.target.value); }} />
        </form>
        <p className="search-status" role="status" aria-live="polite">
          {state.status === 'idle' ? 'Search titles and saved document text.'
            : state.status === 'loading' ? 'Searching…'
            : state.status === 'ready' ? `${state.items.length} ${state.items.length === 1 ? 'result' : 'results'}` : ''}
        </p>
        <ul id={`${identifier}-results`} className="search-results" role="listbox" aria-label="Search results" aria-busy={state.status === 'loading'}>
          {state.items.map((result, index) => <li key={result.id} role="presentation"><button type="button" role="option"
            id={`${identifier}-result-${index}`} aria-selected={selected === index} tabIndex={-1}
            onFocus={() => setSelected(index)} onPointerMove={() => setSelected(index)} onClick={() => pick(result)}>
            <span>{result.title}</span><small>{result.excerpt}</small>
          </button></li>)}
        </ul>
        {state.status === 'ready' && !state.items.length && <div className="search-empty"><h3>No matching documents</h3><p>Try another word or title.</p></div>}
        {state.status === 'error' && <div className="search-empty" role="alert"><p>Search could not complete. Try again.</p><button onClick={() => setRetry(value => value + 1)}>Retry search</button></div>}
        <div className="search-footer"><span>↑ ↓ move · Enter open</span><span>Esc close</span></div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
