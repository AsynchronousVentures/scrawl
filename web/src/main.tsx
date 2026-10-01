// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { App } from './App';
import { PublicDocument } from './PublicDocument';
import './styles.css';

const publicId = /^\/publications\/([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})$/i.exec(location.pathname)?.[1];
createRoot(document.getElementById('root')!).render(publicId ? <PublicDocument publicId={publicId} />
  : <RouterProvider router={createBrowserRouter([{ path: '*', element: <App /> }])} />);
