// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import type { PrismaClient, Prisma } from '../../generated/prisma/client.js';
import type { IdentityConfig } from '../../config.js';
import { createAuth } from './auth.js';

export type NewLocalUser = Readonly<{ email: string; name: string; password: string }>;

export function createOperator(prisma: PrismaClient, config: IdentityConfig) {
  // All host account commands share one lock. Bootstrap refuses any existing user,
  // and auth-owned user/account/password/session changes commit together.
  async function locked<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>) {
    return prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(7242026)`;
      return operation(tx);
    }, { timeout: 15_000, maxWait: 10_000 });
  }

  function validateUser(input: NewLocalUser) {
    if (!input.name.trim() || input.name.length > 200) throw new Error('Name must contain 1 to 200 characters');
    if (input.password.length < 12 || input.password.length > 128) throw new Error('Password must contain 12 to 128 characters');
  }

  async function requireAdministrator(tx: Prisma.TransactionClient) {
    if (!await tx.user.findFirst({ where: { role: 'administrator' }, select: { id: true } })) {
      throw new Error('Bootstrap an administrator before managing accounts');
    }
  }

  return {
    async bootstrap(input: NewLocalUser) {
      validateUser(input);
      return locked(async (tx) => {
        if (await tx.user.count() !== 0) throw new Error('Bootstrap refused: this instance already has users');
        const result = await createAuth(tx, config).api.createUser({ body: {
          email: input.email, name: input.name, password: input.password, role: 'administrator',
        } });
        return { id: result.user.id, email: result.user.email, role: result.user.role };
      });
    },
    async provision(input: NewLocalUser) {
      validateUser(input);
      return locked(async (tx) => {
        await requireAdministrator(tx);
        const result = await createAuth(tx, config).api.createUser({ body: {
          email: input.email, name: input.name, password: input.password, role: 'member',
        } });
        return { id: result.user.id, email: result.user.email, role: result.user.role };
      });
    },
    async recover(email: string, newPassword: string) {
      return locked(async (tx) => {
        await requireAdministrator(tx);
        const user = await tx.user.findUnique({ where: { email: email.toLowerCase() }, select: { id: true } });
        if (!user) throw new Error('Account recovery refused: user not found');
        // Live acceptance locks users before sessions. Recovery uses the same
        // order before the library deletes every session for this account.
        await tx.$queryRaw`SELECT "id" FROM "user" WHERE "id" = ${user.id} FOR UPDATE`;
        await tx.$queryRaw`SELECT "id" FROM "session" WHERE "userId" = ${user.id} ORDER BY "id" FOR UPDATE`;
        let token: string | undefined;
        // Use the library reset flow without email delivery. The token stays in memory.
        const auth = createAuth(tx, config, async (data) => { token = data.token; });
        await auth.api.requestPasswordReset({ body: { email } });
        if (!token) throw new Error('Account recovery failed');
        await auth.api.resetPassword({ body: { token, newPassword } });
        return { id: user.id };
      });
    },
  };
}
