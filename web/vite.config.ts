// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: [{ find: /^@scrawl\/content$/,
    replacement: fileURLToPath(new URL('../src/shared/content.ts', import.meta.url)),
  }] },
  server: {
    host: '127.0.0.1', port: 5173, strictPort: true, cors: false,
    headers: { 'Cross-Origin-Opener-Policy': 'same-origin' },
    allowedHosts: ['127.0.0.1'],
    // APP_ORIGIN names this browser origin. Forward its Origin and cookies unchanged.
    proxy: {
      '/api': { target: 'http://127.0.0.1:3100', changeOrigin: false },
      '/health': { target: 'http://127.0.0.1:3100', changeOrigin: false },
      '/openapi.json': { target: 'http://127.0.0.1:3100', changeOrigin: false },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
});
