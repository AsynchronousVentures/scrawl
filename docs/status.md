# Implementation status

Recorded 2026-09-30 after local P3 verification on P2 baseline `457784e`. See [VALIDATION.md](../VALIDATION.md) for actual results, migrations, commands, and limits.

| Area | Status |
| --- | --- |
| Project identity and license | Scrawl (`scrawl`), AGPL-3.0-only; standard LICENSE unchanged |
| P0-P2 foundation, identity/access, and documents | Preserved; original 44 unit/config/HTTP/CLI tests and 37 reported PostgreSQL tests pass |
| Dependency baseline | P2 lockfile and every dependency pin unchanged; Better Auth 1.7.6 / Prisma 7.10.0 / ProseMirror model 1.25.12 retained |
| Schema and migrations | Existing two Prisma migrations unchanged; no P3 schema changes |
| P2 concurrency and history | Actual overlapping saves, forced mid-write rollback, deferred document-head constraints, immutable/cross-document history, and revocation races still pass |
| P3 fixture commands | Explicit development-only private configuration and setup/reset for fixed local disposable `scrawl_demo_a`; unsafe targets/implicit reset refused |
| P3 Demo A | Real running HTTP API, four accounts/five isolated sessions, 327 assertions per successful run; repeat execution and explicit reset/reseed verified |
| P3 runner failures | Injected failed save causes nonzero exit, one attempted save, no retried document creation; partial data retained for explicit reset |
| P3 native export | Permission-checked current single-document JSON with exact provenance/content schemas; parser round trip and selected-content equality; no authentication/session data |
| P3 checks | 50 unit/config/HTTP/CLI tests and 48 reported PostgreSQL tests pass, 0 skipped; clean install, boundaries, typecheck, build, generated OpenAPI, and audit pass |
| OpenAPI | 14 implemented paths / 18 operations; export included; no proposed routes or API explorer |
| CI | Existing Node 24/PostgreSQL 17 workflow includes mandatory database tests; local equivalents pass; hosted execution unverified |
| P4 thin UI | Not implemented |
| P5 public publishing | Not implemented |
| P6-P9 search/files/portability/release | Not implemented |
| Public source URL/private security reporting and release packaging | Still required before public release |

P3 is complete locally and ready for review. No local blocker remains. Hosted CI, production operation, non-Linux demo sockets, workload/scalability, backup/import/restore, and release/distribution remain unverified. The recorded P1 authentication/rate-limit limits still apply. Rapid demo repeats are subject to existing rate limits; failed runs leave partial fixtures and sessions until expiry or explicit reset.

Task-created database schemas, containers, networks, volumes, demo credentials/configuration, and scratch/build/OpenAPI output were removed after validation. Only the ignored synthetic `artifacts/demo/export.json` and `result.json` were retained for inspection, alongside existing development dependencies/configuration. No push or deployment occurred. Stop at the P3 review boundary; P4 begins only when assigned.
