# Implementation status

## Integration branch, current

The maintainer expanded this session to a cohesive BlockNote demo. Work is on `integration/blocknote-demo`, not merged or released. The original remote `main` contains completed P4 `445bae2`. [The integration backlog](integration-backlog.md) tracks five issues and dependencies.

| Area | Implemented | Verified |
| --- | --- | --- |
| Native BlockNote/private workflow | Standard blocks/styles, official shadcn UI/server utilities, explicit save/native undo/discard, nested heading outline, history/restore, conflicts, mobile drawer | Complete check passed 81 unit/config/HTTP/CLI tests; all 47 browser workflows passed in a clean full run, zero retries/skips |
| Normal document navigation | Native links, Back/Forward, independent tabs, draft and in-flight-request blocking; synchronous canonical URL/state commits | Targeted run passed 24 repetitions and the full 47-case browser regression; both complete hosted 17/18 matrices passed on `a86a749`. Fresh preview checks passed without writes; earlier failures remain recorded |
| Backend guarantees | Core authorization, immutable revisions, ETag concurrency, space-before-document locks, lifecycle counters | Complete 111-test PostgreSQL regression passed on both 17 and 18, including actual concurrency, rollback, recovery, revocation and guarded Demo A/reset |
| Readable private links | Persisted scoped slugs, stable title-change links, authorized direct paths, preserved UUID bookmarks, private-safe route logging | Complete 92-test PostgreSQL suites and all 43 browser workflows passed; retained preview migration preserved exact existing content/head/version metadata |
| Preservation/default PostgreSQL 18 | Fresh official-layout 18 volume; explicit 17 compatibility; finite backed-up native conversion | Exact retained 17-to-disposable-18 restore, all six migrations/native conversion and original source unchanged; two real conversion tests |
| Private attachments/PDF/DOCX | Immutable document-owned bytes/metadata/revision references; supplied offline OSS exporters; native Upload and downloads | Real database/session quotas/type/ownership/retention checks, native upload/first-save undo, current/historical visible export titles/content/images and dirty-work exclusion |
| Authorized indexed search | Weighted generated title/body vector, GIN, bounded permission-filtered SQL; connected accessible dialog | Real database backfill/rebuild/current-grant/session tests plus browser keyboard, stale response, empty/error/loading and guarded navigation |
| Selected publishing | Default off; administrator approval of explicit immutable revision, scoped files, anonymous native article, withdraw/archive invalidation | Twelve backend tests and actual browser selection/dirty retention/412/private-save/anonymous-image/lifecycle cases pass |
| Persistent synthetic demo | Five useful rich documents/image on separate 18 database; explicitly authorized public Funnel 10000; persistent user service | Fresh administrator/reader/outsider and anonymous sessions passed again on the new origin; public-relay login/logout, private denial and old-origin refusal verified |
| Collaboration/comments | Native storage, authenticated transport, transactional comments and optional metadata/enrollment/checkpoint/restore/comment HTTP adapters implemented on branch; startup/UI remain disabled | Complete check passes 89 tests; complete PostgreSQL regressions pass 136/136 on each of 17/18. The 21 real-socket/HTTP cases include the official REST client, scoped names, concurrent checkpoints and lifecycle/epoch closure. Native rollback, recipient authority, migration and ownership checks remain passing. Two earlier hosted browser failures pass locally but their intermittent cause is unresolved. Collaborative browser undo/reconnect and presence remain gated |

`npm ci` and the CI-equivalent complete check passed with zero audit advisories. The delayed-read and native external link/file opener-isolation regressions pass alongside readable-link navigation in the clean full 43-case browser run. The complete hosted foundation matrix on code checkpoint `9874740` passed on both PostgreSQL 17 and 18; readable-link work follows that checkpoint, with its current results in validation. Earlier generated API drift on an intermediate commit was corrected without weakening its check. The pinned backend baseline remains intact. Optional AI is deferred; no paid calls occurred.

[VALIDATION.md](../VALIDATION.md) records exact commands, migration effects, screenshots and honest limits. [The walkthrough](demo-walkthrough.md) has the current public preview URL, local credential retrieval, restart commands and workflows. Stale preview routes and the obsolete prototype HTTP process were removed at the maintainer's request; T3 Code remains private. Original retained 17 data/history and prototype files remain intact. Historical P4 status below describes its checkpoint, not the current native editor or current routes.

The maintainer has requested continuing autonomous development toward a cohesive OSS alternative to Outline. Normal navigation and private live storage are checkpointed; prepared authenticated transport is verified in isolation; official comment core, serialized delivery and optional HTTP/lifecycle adapters are verified; supplied collaborative client integration is next. Existing packet boundaries are historical, while retained-data, authorization, license and no-merge/no-production constraints remain. [The integration backlog](integration-backlog.md) records research and dependencies; planned features are not described as running demo behavior.

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
