# Implementation status

## Integration branch, current

The maintainer expanded this session to a cohesive BlockNote demo. Work is on `integration/blocknote-demo`, not merged or released. The original remote `main` contains completed P4 `445bae2`. [The integration backlog](integration-backlog.md) tracks five issues and dependencies.

| Area | Implemented | Verified |
| --- | --- | --- |
| Native BlockNote foundation | Standard native blocks, official shadcn UI/server utilities, versioned persistence, native history/restore/export | 63 unit tests, 22 authenticated PostgreSQL document/export cases; browser integration still being corrected |
| Preservation | Finite backed-up offline format conversion; no runtime dual editor/parser | Two real PostgreSQL upgrade tests, including mid-write rollback; retained original 17 data unchanged |
| Existing backend guarantees | Core authorization, immutable revisions, ETag concurrency, space-before-document locks, lifecycle versions | Focused concurrency/rollback/revocation/outsider/export tests pass; full regression pending |
| PostgreSQL 18/search | Fresh 18 configuration in progress; current data on 17 retained | Runtime 18/search not yet verified |
| Attachments/PDF/DOCX | Planned next integration | Not yet implemented |
| Publishing/collaboration/comments | Dependency contracts recorded, implementation planned | Not enabled |

[VALIDATION.md](../VALIDATION.md) records actual commands and unverified items. The final persistent demo and current screenshots are pending this integration run. Historical P4 status below describes its completed checkpoint, not the current integration result.

## Completed P4 checkpoint

Recorded 2026-09-30 after the P4 editor refinement on completed P4 baseline `9630659`. See [VALIDATION.md](../VALIDATION.md) for observed results, exact commands, migration effects, screenshots, and limits.

| Area | Status |
| --- | --- |
| Project identity and license | Scrawl (`scrawl`), AGPL-3.0-only; standard LICENSE unchanged |
| P0-P3 foundation and API | Preserved; all original 50 unit/config/HTTP/CLI tests and 48 reported PostgreSQL tests pass |
| Dependency baseline | All 398 resolved versions/integrities from the P4 baseline unchanged; Better Auth 1.7.6 / Prisma 7.10.0 / Fastify 5.12.5 / ProseMirror model 1.25.12 retained |
| Schema and migrations | Existing two Prisma migrations unchanged; no P4 schema/data changes |
| Authorization and transactions | Remain in core; real bootstrap/recovery/access/concurrency/rollback/deferred-head checks pass |
| P3 guarded fixtures, Demo A and native export | Preserved; executable Demo A passes 327 assertions in browser suite and fresh/reset manual fixtures; unsafe reset and no-retry tests pass |
| P4 connected private UI | Implemented and browser-verified: login/logout, spaces/documents, restricted editor, explicit Save, history/restore, lifecycle, export |
| P4 approved visual direction | Charcoal surfaces/sage accent/central document retained; preserved disconnected prototype; live app has no simulated search or prototype controls |
| P4 OSS editor | Actual Tiptap 3.31.3, official restricted extensions/UndoRedo, Radix toolbar/link popover, Lucide icons; unchanged native format verified through real body transactions |
| P4 outline and narrow screens | Content-derived headings scroll/focus/update; collapsed outline and navigation drawer; viewport overflow/keyboard checks pass |
| P4 unsaved work | Confirmed title/body baseline discard without writes/revisions/ETag changes, undo across Save, dirty/reload protection, deliberate conflict reconciliation and failure/expiry/revocation retention verified |
| P4 API adjustment | Caller-derived reader/editor access in authorized space DTOs; actual permissions remain server-checked; no new product routes |
| OpenAPI and boundaries | 14 implemented paths / 18 operations; generated browser types checked; no Prisma/server imports in frontend; exact unchanged shared parser |
| P4 checks | 58 unit/config/HTTP/CLI, 48 PostgreSQL, 25 Chromium browser scenarios pass; strict types, both builds, generated types, frozen install, and audit pass |
| Private preview and source | Actual private HTTPS review retained; updated 71-package notices and source archive exclude private artifacts |
| CI | Node 24/PostgreSQL 17 job includes sequential database/browser suites; local equivalents pass; hosted execution unverified |
| P5 public publishing | Proposed; not implemented |
| P6-P9 search/files/portability/release | Proposed; not implemented |
| Public source URL/security reporting/release packaging | Still required before public release |

P4 and its editor refinement are complete locally and ready for review. No local blocker remains. Hosted CI, other browser engines/native mobile/screen readers, production operation, workload/scalability, backup/import/release remain unverified. The nonblocking bundle-size warning and one upstream dependency-notice correspondence limit are recorded in validation. P1 authentication/rate-limit and P3 Linux/demo repetition limits still apply.

The ordinary `scrawl-editor` test container/network/volume and harness fixtures were removed. The manual disposable PostgreSQL database on 5433, generated owner-only demo configuration/credentials, connected private Tailscale preview, approved static prototype/route, and ignored synthetic evidence/export artifacts are retained for review. Test-owned databases/schemas/credentials/scratch and the temporary screenshot sign-in helper were removed. No push, deploy, public exposure, or P5 work occurred. Stop at the P4 review boundary.
