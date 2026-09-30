# Implementation status

Recorded 2026-09-30 after local P4 verification on P3 baseline `76da4c0`. See [VALIDATION.md](../VALIDATION.md) for observed results, exact commands, migration effects, screenshots, and limits.

| Area | Status |
| --- | --- |
| Project identity and license | Scrawl (`scrawl`), AGPL-3.0-only; standard LICENSE unchanged |
| P0-P3 foundation and API | Preserved; all original 50 unit/config/HTTP/CLI tests and 48 reported PostgreSQL tests pass |
| Dependency baseline | All 256 previous resolved versions/integrities unchanged; Better Auth 1.7.6 / Prisma 7.10.0 / Fastify 5.12.5 / ProseMirror model 1.25.12 retained |
| Schema and migrations | Existing two Prisma migrations unchanged; no P4 schema/data changes |
| Authorization and transactions | Remain in core; real bootstrap/recovery/access/concurrency/rollback/deferred-head checks pass |
| P3 guarded fixtures, Demo A and native export | Preserved; executable Demo A passes 327 assertions in browser suite and fresh/reset manual fixtures; unsafe reset and no-retry tests pass |
| P4 connected private UI | Implemented and browser-verified: login/logout, spaces/documents, restricted editor, explicit Save, history/restore, lifecycle, export |
| P4 approved visual direction | Charcoal surfaces/sage accent/central document retained; preserved disconnected prototype; live app has no simulated search or prototype controls |
| P4 outline and narrow screens | Content-derived headings scroll/focus/update; collapsed outline and navigation drawer; viewport overflow/keyboard checks pass |
| P4 unsaved work | Dirty/discard/reload protection, separate latest-version conflict, explicit reconciliation, failure/expiry/revocation draft retention verified |
| P4 API adjustment | Caller-derived reader/editor access in authorized space DTOs; actual permissions remain server-checked; no new product routes |
| OpenAPI and boundaries | 14 implemented paths / 18 operations; generated browser types checked; no Prisma/server imports in frontend; exact unchanged shared parser |
| P4 checks | 58 unit/config/HTTP/CLI, 48 PostgreSQL, 19 Chromium browser scenarios pass; strict types, both builds, generated types, frozen install, and audit pass |
| Private preview and source | Actual Tailscale HTTPS authentication/origin probes pass; build includes license/notices and source archive excluding private artifacts |
| CI | Node 24/PostgreSQL 17 job includes sequential database/browser suites; local equivalents pass; hosted execution unverified |
| P5 public publishing | Proposed; not implemented |
| P6-P9 search/files/portability/release | Proposed; not implemented |
| Public source URL/security reporting/release packaging | Still required before public release |

P4 is complete locally and ready for review. No local blocker remains. Hosted CI, other browser engines/native mobile/screen readers, production operation, workload/scalability, backup/import/release remain unverified. The nonblocking bundle-size warning and one upstream dependency-notice correspondence limit are recorded in validation. P1 authentication/rate-limit and P3 Linux/demo repetition limits still apply.

The task-owned manual disposable PostgreSQL database on 5433, generated owner-only demo configuration/credentials, connected private Tailscale preview, approved static prototype/route, and ignored synthetic evidence/export artifacts are retained for review. Test-owned databases/schemas/credentials/scratch and the temporary screenshot sign-in helper were removed. No push, deploy, public exposure, or P5 work occurred. Stop at the P4 review boundary.
