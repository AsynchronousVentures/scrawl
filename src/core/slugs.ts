// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

// Keep the one-time SQL backfill's normalization in sync with this rule.
export function slugify(title: string, fallback: 'space' | 'document') {
  return title.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64).replace(/-+$/g, '') || fallback;
}

/** Call only while holding the namespace's creation lock. Archived slugs stay reserved. */
export function availableSlug(base: string, occupied: readonly string[]) {
  const used = new Set(occupied);
  let candidate = base;
  for (let suffix = 2; used.has(candidate); suffix++) candidate = `${base}-${suffix}`;
  return candidate;
}

export function validSlug(value: string) {
  return value.length <= 80 && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(value);
}
