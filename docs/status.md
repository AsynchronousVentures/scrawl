# Implementation status

Recorded 2026-09-30 after local P2 verification. See [VALIDATION.md](../VALIDATION.md) for exact pins, migrations, commands, corrections, and limits.

| Area | Status |
| --- | --- |
| Project identity and license | Scrawl (`scrawl`), AGPL-3.0-only; standard LICENSE unchanged |
| P0/P1 foundation and identity/access | Preserved; original 30 unit/config/HTTP/CLI tests and 21 reported PostgreSQL tests pass |
| P1 dependency baseline | Every existing resolved version unchanged; Better Auth 1.7.6 / Prisma 7.10.0 retained |
| P2 headless content | Native ProseMirror 1.25.12 schema, strict validation/limits, plain-text extraction, canonical round trips; 14 content tests pass |
| P2 schema | One additive Prisma migration; Document/DocumentRevision with nonnullable deferred same-document head FK, proven at COMMIT |
| P2 document operations | Authorized create/list/read/update, revision list/read/restore, archive/unarchive; policy and transactions in core |
| P2 concurrency and history | Real overlapping saves yield one success/one 412/one revision; injected mid-write rollback; immutable history; cross-document denial |
| P2 lifecycle/no-ops | Lifecycle lock versions separate from content numbers; canonical no-op saves unchanged; restore always appends; archived reads/history allowed, edits blocked |
| P2 migration preservation | Populated P1 upgrade preserves complete auth/access rows and real sessions; repeated deploy passes |
| P2 checks | 44 unit/config/HTTP/CLI tests and 37 reported PostgreSQL tests pass; clean install/typecheck/build/OpenAPI/compiled-server checks pass; audit zero advisories |
| CI | Existing Node 24/PostgreSQL 17 workflow runs migrations and required database tests; local equivalents pass; hosted execution unverified |
| P3 API demo/export | Not implemented |
| P4 thin UI | Not implemented |
| P5 public publishing | Not implemented |
| P6-P9 search/files/portability/release | Not implemented |
| Public source URL/private security reporting and release packaging | Still required before public release |

P2 is complete locally and ready for review. No local blockers. Production operation, workload/scalability, backup/restore, release/distribution checks, and the recorded P1 authentication/rate-limit limits remain unverified. Temporary test resources were removed. No push, hosted integration, or deployment occurred. Stop here; P3 begins only when assigned.
