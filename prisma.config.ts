// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import { defineConfig } from 'prisma/config';

const databaseUrl = process.env.DATABASE_URL;
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  ...(databaseUrl ? { datasource: { url: databaseUrl } } : {}),
});
