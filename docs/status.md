# Implementation status

Recorded 2026-09-30 after local P1 verification. See [VALIDATION.md](../VALIDATION.md) for exact pins, migrations, commands, defects fixed, and limits.

| Area | Status |
| --- | --- |
| Project identity and license | Scrawl (`scrawl`), AGPL-3.0-only; standard LICENSE unchanged |
| P0 foundation | Preserved; original 25 tests still pass |
| P1 dependency integration | Better Auth 1.7.6 / Prisma-client-adapter 7.10.0 pinned and tested with real PostgreSQL 17; audit reports zero advisories after scoped overrides |
| P1 schema | One reviewed Prisma migration history; auth-owned records plus Space/SpaceMembership; no later-packet tables |
| P1 local identity | Real library credentials/sessions; closed registration; three session HTTP endpoints; safe JSON DTOs and explicit origin/CSRF checks |
| P1 host operations | Bootstrap, member provisioning, and recovery/session revocation implemented and tested, including real hidden terminal prompts |
| P1 access | Me, administrator creation/membership, permission-filtered listing/read; authorization in core operations |
| P1 concurrency and revocation | Real overlapping membership transactions, strong ETags, immediate membership/session denial, session recheck after lock wait, and rollback tested |
| P1 checks | 30 unit/config/HTTP/CLI tests and 21 reported PostgreSQL tests pass; build/typecheck/OpenAPI/clean install pass |
| CI | Node 24/PostgreSQL 17 workflow includes migrations and required database tests; local equivalents pass; hosted run unverified |
| P2 documents/revisions | Not implemented |
| P3 API demo/export | Not implemented |
| P4 thin UI | Not implemented |
| P5 public publishing | Not implemented |
| P6-P9 search/files/portability/release | Not implemented |
| Public source URL/private security reporting and release packaging | Still required before public release; third-party notices/source review remains a release gate |

P1 is complete locally and ready for review. No local blockers. Production TLS/proxy operation, concurrent in-flight sign-in during recovery, durable rate limiting, and release/distribution checks remain unverified. No push, hosted integration, or deployment occurred. Temporary database resources were removed. Stop here; P2 begins only when assigned.
