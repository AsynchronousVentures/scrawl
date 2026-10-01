// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

export function downloadFilename(response: Response, format: 'json' | 'pdf' | 'docx') {
  // Scrawl supplies bounded ASCII filenames. Treat response names as advisory:
  // ignore paths, unrelated extensions and malformed headers instead of using them.
  const name = /^attachment; filename="([a-z0-9][a-z0-9-]{0,120}\.(?:json|pdf|docx))"$/
    .exec(response.headers.get('content-disposition') ?? '')?.[1];
  return name?.endsWith(`.${format}`) ? name : `scrawl-document.${format}`;
}
