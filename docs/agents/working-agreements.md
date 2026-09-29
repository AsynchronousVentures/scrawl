# Working agreements

## Scope

Implement the assigned packet, not the whole roadmap. Follow the maintainer's product decisions: AGPL-3.0-only, entirely OSS, backend-first, Prisma/PostgreSQL, solid core with connected capabilities. No SaaS or paid-gate infrastructure. Use a short decision note for a real implementation tradeoff rather than a speculative architecture rewrite.

Keep AGENTS.md short. Use synthetic fixtures, example domains and generic content. Do not use real customer or private organizational data. Do not create/push repositories, install external apps, deploy publicly or send source to a service unless separately authorized.

## Code boundaries

Use maintained OSS libraries rather than copied application code. Review license compatibility and retain notices. Do not paste source from another product as a shortcut. Avoid BaseRepository, general plugin SDKs, event buses, service locators, duplicated contracts and one-interface-per-function architecture. Small duplication is better than an inaccurate abstraction; shared policy belongs in the core.

Routes validate/translate; application operations enforce access and transactions. Capabilities consume exported operations and narrow purpose-specific query contracts. Database client types never become the public schema. Do not query or mutate another module's tables through an unrestricted client. Add import checks only for implemented boundaries.

Use a single migration history and reviewed SQL where needed. Prisma/auth examples must match the pinned major and adapter versions. Never use schema push/reset on a real deployment. Keep transactions short and do not perform network side effects inside them.

## Security and content

Real auth, closed registration, server-controlled roles, real resource-level permissions. No impersonation headers, default shared admin credentials, wildcard CORS, anonymous writes or hidden bypass flags. Demo tooling refuses non-demo/production targets. Authenticated actor is never taken from submitted JSON.

Never log document bodies, credentials, session cookies or secret-bearing URLs. Validate the supported content schema on the server; arbitrary JSON/HTML and remote URL fetching are not shortcuts. Private save and public publish are different operations. The browser cannot enforce the only permission check.

## Verification

Use real PostgreSQL for migrations, rollback, concurrency, permissions and publication lifecycle tests. Include success and failure tests. Keep dependency locks and frozen installs. Run scoped searches and inspect relevant files before editing; prefer `rg`, git inventory, and structured-data tools. Do not disable a failing check to produce a green result.

A file containing tests is not proof they ran. A screenshot is not proof that backend invariants hold. Keep source, proposals, commands attempted, passed tests and unverified work separate. Update status.md after each packet.

## Completion

Report behavior/files changed, commands/results, migration effects, risks and next packet. Stop at the assigned review boundary. Do not silently continue, merge or deploy.
