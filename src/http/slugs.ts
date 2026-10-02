// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

export const slugSchema = { type: 'string', minLength: 1, maxLength: 80, pattern: '^[a-z0-9]+(-[a-z0-9]+)*$' } as const;
