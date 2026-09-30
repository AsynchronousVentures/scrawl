// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { admin } from 'better-auth/plugins';
import { adminAc, userAc } from 'better-auth/plugins/admin/access';
import type { PrismaClient, Prisma } from '../../generated/prisma/client.js';
import type { IdentityConfig } from '../../config.js';

export function createAuth(
  prisma: PrismaClient | Prisma.TransactionClient,
  config: IdentityConfig,
  sendResetPassword?: (data: { token: string }) => Promise<void>,
) {
  return betterAuth({
    appName: 'Scrawl',
    baseURL: config.origin,
    basePath: '/api/auth',
    secret: config.secret,
    trustedOrigins: [config.origin],
    database: prismaAdapter(prisma, { provider: 'postgresql', transaction: '$transaction' in prisma }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      revokeSessionsOnPasswordReset: true,
      ...(sendResetPassword ? { sendResetPassword } : {}),
    },
    session: { cookieCache: { enabled: false } },
    advanced: {
      useSecureCookies: config.secureCookies,
      // Better Auth otherwise relaxes origin checking under NODE_ENV=test.
      disableOriginCheck: false,
      disableCSRFCheck: false,
      ipAddress: { ipAddressHeaders: ['x-scrawl-client-ip'] },
    },
    rateLimit: { enabled: true },
    telemetry: { enabled: false },
    // Preserve an operational signal without forwarding library messages or arguments.
    logger: { level: 'warn', log: () => { console.error('Authentication event'); } },
    plugins: [admin({
      defaultRole: 'member',
      adminRoles: ['administrator'],
      roles: { administrator: adminAc, member: userAc },
    })],
  });
}
