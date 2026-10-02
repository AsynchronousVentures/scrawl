// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

/** Use the exported snapshot's title, never a draft or another revision's title. */
export function exportFilename(title: string, revisionNumber: number, format: 'json' | 'pdf' | 'docx') {
  const name = title.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 80).replace(/-+$/g, '') || 'document';
  return `scrawl-${name}-revision-${revisionNumber}.${format}`;
}
