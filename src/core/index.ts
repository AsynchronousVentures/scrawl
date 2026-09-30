// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import type { PrismaClient } from '../generated/prisma/client.js';
import type { IdentityConfig } from '../config.js';
import { createIdentity } from './identity/index.js';
import { createSpaces } from './spaces/index.js';
import { resolve } from 'node:path';
import { createAttachments } from './attachments/index.js';
import { createSearch } from './search/index.js';
import { createDocuments } from './documents/index.js';

export function createCore(prisma: PrismaClient, config: IdentityConfig, options: { attachmentStorageDir?: string } = {}) {
  const identity = createIdentity(prisma, config);
  const spaces = createSpaces(prisma, identity);
  const attachments = createAttachments(prisma, identity, spaces, options.attachmentStorageDir ?? resolve("var/private-attachments"));
  return { identity, spaces, attachments, search: createSearch(prisma, identity), documents: createDocuments(prisma, identity, spaces, attachments) };
}

export type Core = ReturnType<typeof createCore>;
