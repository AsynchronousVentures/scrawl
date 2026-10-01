// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import { useEffect, useState } from 'react';
import { Editor } from './Editor';
import { api, ApiError, type PublicDocument as Snapshot } from './api/client';

type State = { status: 'loading' | 'unavailable' | 'error' } | { status: 'ready'; snapshot: Snapshot };

export function PublicDocument({ publicId }: { publicId: string }) {
  const [state, setState] = useState<State>({ status: 'loading' });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading' });
    void api.publicDocument(publicId, controller.signal).then(snapshot => {
      if (!controller.signal.aborted) setState({ status: 'ready', snapshot });
    }).catch(error => {
      if (!controller.signal.aborted) setState({ status: error instanceof ApiError && error.status === 404 ? 'unavailable' : 'error' });
    });
    return () => controller.abort();
  }, [publicId, retry]);

  return <>
    <header className="top"><span className="brand">Scrawl</span></header>
    <main className="main public-document">
      {state.status === 'loading' ? <p role="status">Loading published document…</p>
        : state.status === 'ready' ? <Editor key={`${publicId}-${retry}`} initialContent={state.snapshot.content}
          label="Published document content" editable={false} sectionLinks onChange={() => {}}
          header={<><p className="meta">Published {new Date(state.snapshot.publishedAt).toLocaleDateString()}</p><h1 className="public-title">{state.snapshot.title}</h1></>} />
          : <section className="state"><h1>{state.status === 'unavailable' ? 'Published document unavailable' : 'Could not load this document'}</h1>
            <p role={state.status === 'error' ? 'alert' : undefined}>{state.status === 'unavailable' ? 'This link is not available.' : 'The request could not complete.'}</p>
            {state.status === 'error' && <button onClick={() => setRetry(value => value + 1)}>Retry</button>}
          </section>}
    </main>
    <footer className="footer">Scrawl · <a href="/assets/LICENSE.txt" target="_blank" rel="noopener noreferrer">AGPL-3.0-only</a> · <a href="/assets/THIRD_PARTY_NOTICES.txt" target="_blank" rel="noopener noreferrer">Third-party notices</a> · <a href="/assets/scrawl-source.tar.gz" download>Source for this build</a></footer>
  </>;
}
