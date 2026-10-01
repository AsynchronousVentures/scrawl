# Validation

## Prepared authenticated collaboration HTTP integration

Optional implemented routes now expose enrollment/metadata, explicit checkpoints, epoch-changing restore, document-scoped author names and the pinned BlockNote REST comment contract. The running application does not mount this capability yet. Core transactions continue to check access and session lifetime; checkpoint/restore include current recipient receipts. A single document mutex serializes socket acceptance, joins, comments, enrollment and lifecycle changes across old/new epochs. Restore and archive close old connections only after commit. Unknown lifecycle failure invalidates every cached epoch for that document.

HTTP schemas are separate from persistence models. Responses exclude Yjs bytes, recipient/session records and emails. Native comments use the supplied RESTYjsThreadStore, with genuine cookie sessions. The test covers create, relative anchor, reply, author edit, reactions, resolve/unresolve and soft/hard deletion, including the official client's JSON headers on bodyless commands. Numeric ProseMirror offsets never replace relative anchors. User lookup is bounded and document scoped; revoked members and unrelated users return no names. Concurrent checkpoints produce one 200, one 412 and exactly one new revision; omitted sequence is 428, live-only comments do not create revisions, restore appends history, and HTTP archive/unarchive preserves it.

Observed final results, without skips or retries:

- `npm run check`: 89 tests, types, import boundaries, backend/frontend builds and generated OpenAPI/types passed. Log: `artifacts/live-http-final-check.log`.
- `npm run test:db`: 136/136 on PostgreSQL 18, including Demo A, migration preservation, transaction rollback, authorization and real sockets. Log: `artifacts/live-http-final-db18.log`.
- The same complete suite passed 136/136 on a separately owned temporary PostgreSQL 17 container/database. Log: `artifacts/live-http-db17.log`. Its container and credential file were removed; retained 17 and 18 data were untouched.
- Focused final native storage/HTTP/socket acceptance passed 40/40. Log: `artifacts/live-http-lock-final18.log`.
- `npm run test:browser`: 47/47 passed against the real API/PostgreSQL, without retries/skips. Log: `artifacts/live-http-full-browser-verified.log`. The focused navigation run also passed 2/2 in `artifacts/live-http-navigation-browser.log`. No collaborative browser acceptance is claimed.

An initial new fixture used a string instead of the existing fixture helper's string array, then incomplete native comment blocks; those failed runs were corrected, not counted as passing. Missing empty-body compatibility and an old checkpoint DTO assertion were also caught before the final checks. The private checkpoint result now explicitly separates its document DTO from its internal recipient/sequence receipt. A contract check caught Swagger interpreting `type:null` as no response entity; the schemas now generate the actual nullable JSON response and optional empty request bodies expected by the native store. A temporary 17 startup failed because Linux tmpfs rejected `size=1GB`; the owned failed container was removed and `size=1g` used for the successful runs.

Hosted delivery checkpoint `fa532a6` has a successful complete [PR matrix](https://github.com/AsynchronousVentures/scrawl/actions/runs/36845242946). Its [push matrix](https://github.com/AsynchronousVentures/scrawl/actions/runs/36845236701) passed PostgreSQL 17 but failed two of 47 PostgreSQL 18 browser scenarios: modified-click document tab loading and the supplied external-link toolbar. Both pass in the focused local run above. Their intermittent cause remains unverified; this is not classified as an infrastructure failure and no assertion was weakened. A first local full-browser attempt safely refused its reserved disposable database while Demo A from the concurrent database suite still owned that target; one fixture setup failed and 46 cases did not run. After the database suites finished, the independent full run passed all 47. New checkpoint hosted results remain pending until observed.

There is no new migration, dependency change, retained-data reset or live enrollment. The existing eight migrations remain the sole history. The live UI, authenticated presence, deliberate reconnect and actual peer-safe browser undo remain disabled/unverified. The browser API client now derives live metadata/enrollment, scoped user lookup, checkpoint and restore requests from generated OpenAPI types; its strict type check passed. These requests have no mounted UI caller yet and do not retry or replace an ETag. Next connect the official BlockNote collaboration/comments UI, preserve explicit Save versus synchronized state, and pass the activation gates in ADR 0003 before enabling it in the retained demo.

## Serialized comment delivery checkpoint (fa532a6)

The isolated transport now applies server comment mutations under the same room mutex as inbound edits and joining. Core acceptance rechecks sender/recipient authority and commits the native thread/anchor state before applying it to the broadcasting room. Unknown persistence/commit errors close that cache for every peer; fresh connections load actual durable state. Shutdown tracks these server operations as well as socket acceptance. Permission-checked metadata carries only epoch, accepted sequence, document ETag and read/write status; current expiry/send guards still apply. Passive downgrade updates read-only status without requiring another keystroke.

The focused actual-cookie/WebSocket suite passed 20/20, retaining its 16 existing cases and adding SQL-gated comment delivery, denied actions, rollback and an exception after a real comment commit. Revoked recipients retain exactly their previous native/comment state and receive no later accepted sequence. A further focused storage/socket run passed 39/39 after adding actual document-owned/foreign attachment links to comment tests. Comment links now use the same attachment ownership check as body links. The final complete `npm run check` passed all 89 tests, strict types, boundaries, both builds and generated OpenAPI. Final full PostgreSQL suites passed 135/135 on 18 and 135/135 on 17, no failures/skips; the temporary 17 container/configuration were removed. The latest complete existing browser suite remains 47/47, also covered by both complete hosted comment-core matrices. A subsequent focused 20/20 PostgreSQL 18 socket run plus type check passed after explicitly distinguishing uncertain structured 5xx failures from rejected 4xx actions; its injected 503 occurs after a real comment commit and still closes/reloads the cache. That final narrow check was not separately rerun on 17. New collaborative browser workflows remain unavailable and unverified.

The metadata test found a gap in the earlier raw-frame observer: the official provider sets binaryType to ArrayBuffer, while that observer decoded only Buffer. Its existing provider unsynced-state and peer assertions were active, but the raw counters did not observe those frames. The observer now handles every ws binary representation, asserts an actual acknowledgement after the SQL gate opens, verifies authorized initial metadata, and checks that outsiders receive none. Test SQL-wait queries are also scoped to their own DocumentLive relation so concurrent schemas cannot satisfy a different gate. Earlier failed metadata/cascading fixture runs are not counted as passing.

This transport remains absent from application startup. No comment endpoint, collaborative browser UI or presence is enabled. HTTP/lifecycle adapters and official client/undo/reconnect workflows remain activation work. There is no dependency, schema, migration or retained-data reset in this checkpoint. Both complete hosted 17/18 matrices passed on preceding comment core `4f66f45`: [PR run](https://github.com/AsynchronousVentures/scrawl/actions/runs/36843346406), [push run](https://github.com/AsynchronousVentures/scrawl/actions/runs/36843341118). New delivery hosted results remain unverified until recorded.

The persistent synthetic preview was rebuilt/restarted on `4f66f45`. Observed readiness and fresh administrator/reader/outsider/anonymous acceptance passed, refreshing its six screenshots with no revisions or fixture resets. All 143 source archive files matched that checkout byte-for-byte, and the served archive hash matched the local artifact. The current preview remains solo, with retained 17/18 content/history, credentials, uploads and its authorized Funnel origin preserved.

## Official private comment core

The private live core now runs BlockNote's supplied `YjsThreadStore` and `DefaultThreadStoreAuth` against a clone, then validates and commits before returning. Current editor authorization, session lifetime and recipient receipts use the same space-before-document transaction as native edits. Server-derived authors, dates and IDs cannot be supplied in request fields. Editors may create/reply/react/resolve, edit only their own comments and delete under the official editor policy. Readers may retrieve authorized live state but cannot mutate comments. Thread IDs are scoped to the selected document/epoch.

Comments use the supplied paragraph composer contract, safe native links/styles, a 16 KiB/100-paragraph body limit, 500 thread entries and 200 comments per thread, plus the existing 8 MiB encoded-state limit. Relative selections are resolved through pinned y-prosemirror mapping; foreign, deleted, collapsed and already-anchored selections fail without numeric-position fallback. Native overlapping marks, resolve/unresolve and removal of dangling anchors preserve content and CRDT identities. Checkpoints, indexed search, exports and selected publications remain free of comment content and anchors.

Focused native/comment tests passed 18/18, including the existing ten live-validator checks and eight new comment workflows. The focused real PostgreSQL/authenticated-session storage suite passed 19/19, including four new comment cases for author/reader/outsider/recipient policy, concurrent replies, rollback and grant revocation during a lock wait. These are core checks, not delivered comments or a browser UI. The complete `npm run check` passed 89 unit/config/HTTP/CLI tests, strict types, boundaries, both builds and generated OpenAPI. Full `npm run test:db` runs passed 131/131 on each of PostgreSQL 18 and 17, no failures/skips. The temporary 17 container/configuration were removed. The most recent complete real-browser regression remains the 47-case transport run, with both hosted transport matrices also passing. Comment browser workflows are not yet available or verified.

The first anchor tests exposed the native overlapping-mark hash encoding missing from validation; only the official comment encoding is now recognized, with malformed/other hashed marks still rejected. Another test exposed that the pinned official thread decoder omits its stored `deletedAt`; server guards and anchor cleanup now inspect that native field directly. The supplied store/format is preserved rather than forked. Nested Y.ID values in fixture selections now pass through the same JSON serialization as the official REST client. Earlier failed runs are not counted as verification.

`prosemirror-transform@1.12.2` is promoted to an exact direct dependency for official mark transformations. Its existing locked version and complete MIT notice are unchanged. No content version or migration changed. Startup activation, serialized server mutation delivery, HTTP adapters, official comment UI/user resolution, authenticated presence, deliberate reconnect and peer-safe browser undo remain unverified or unfinished.

## Prepared authenticated live transport

The integration branch now contains an isolated Hocuspocus 4.7.0 transport attached to the actual Fastify HTTP server in tests. Application startup does not mount it and the running demo stays in solo mode. Genuine Better Auth cookie sessions and the configured same-origin upgrade are required; room identifiers contain only document/epoch UUIDs. Reader updates, outsider discovery, unknown/oversized frames and direct thread mutations are rejected. Awareness is deliberately disabled until authenticated presence is integrated.

The complete `npm run check` passed 81 unit/config/HTTP/CLI tests, both strict type checks, boundaries, builds and generated OpenAPI drift. Complete `npm run test:db` runs passed 127/127 on PostgreSQL 18 and 17, no failures/skips; the disposable 17 container and its temporary configuration were removed. The focused `node --env-file=.env --import tsx --test test/integration/live-transport.test.ts` passed 16/16 with no skips. SQL-gated acceptance proves no peer delivery or success acknowledgement before commit. Tests cover concurrent native/title edits, a peer joining during acceptance, failed initial loading, rollback, an exception after an actual commit, reader downgrade, passive expiry, operator recovery, grant revocation, archive/unarchive, retained restore epochs and loss of the owned PostgreSQL lease during a write. Shutdown waits for in-flight acceptance even after its socket has left the room. A lease-loss write may finish atomically or roll back, but neither outcome is acknowledged through the closed owner; a replacement loads the exact durable state. Transport recreation is tested, not an operating-system process crash.

Intermediate failures were diagnosed rather than counted as passes. The supplied external provider initially needed explicit attachment. A rejected initial load left an upstream awareness timer alive because its document had not entered the unload registry; the failure path now destroys that unpublished document. Disabling provider retries exposed a join/recipient race, fixed by holding the room mutex through connection registration. Tests stop reconnect scheduling in the supplied provider's configuration callback and assert one physical socket per attempt. A lease-loss assertion incorrectly required an in-flight commit despite possible database timeout rollback; it now checks both complete atomic outcomes and the same no-delivery guarantees. A later assertion tried to check the attached gateway after shutdown had already detached it; the rejection check now runs before shutdown. These earlier failed/hanging runs are not passing verification.

Six necessary direct dependencies were pinned: Hocuspocus server/provider, `ws`, its types, `async-mutex` and Yjs-compatible `lib0`. Every preexisting package/name/version/integrity triple is preserved, including relocated/deduplicated lib0 entries; the Better Auth/Prisma/Fastify/BlockNote/Yjs baseline is unchanged. Complete MIT texts and exact release references are retained in third-party notices. No migration changed; the existing eight-migration history remains required.

The existing persistent preview was rebuilt and restarted on `b2493e7`, without enabling sockets or enrolling documents. An immediate acceptance attempt failed at administrator login; after observing `/health/ready` return 200, the fresh administrator/reader/outsider/anonymous verification passed and refreshed six screenshots. No revision or fixture reset was created. The specific first-attempt cause is unverified. All 141 source archive files matched the checkout byte-for-byte, and the served archive's hash matched the local artifact. Existing retained 17/18 databases and private uploads remain intact.

The latest complete local browser regression passed 47/47 with no retries/skips, preserving Demo A and the established private editor, search/files/export/publication and draft/conflict workflow. It verifies the existing application, not a collaborative browser UI. Official comments, authenticated presence, lifecycle HTTP integration, peer-safe browser undo, deliberate reconnect and usable live editor feedback remain unfinished activation gates. Both complete hosted matrices passed on preceding ownership/expiry checkpoint `a8e7823`: [PR run](https://github.com/AsynchronousVentures/scrawl/actions/runs/36837610939), [push run](https://github.com/AsynchronousVentures/scrawl/actions/runs/36837604799). Both complete hosted matrices subsequently passed on transport checkpoint `b2493e7`, including all four 17/18 jobs: [PR run](https://github.com/AsynchronousVentures/scrawl/actions/runs/36841951782), [push run](https://github.com/AsynchronousVentures/scrawl/actions/runs/36841945745).

## Durable private live storage

The follow-up adds isolated PostgreSQL process ownership and a post-write session-lifetime check. The new advisory-gated timing test first reproduced an incorrect success when a genuine session expired during a delayed write. The fix rolls back expired senders and omits recipients that expire during that wait. Ownership tests terminate only their own lease backend and verify exclusive same-schema ownership, independent schemas and clean handoff. These checks do not enable transport or prove actual delivery.

The complete current `npm run check` passed all 81 unit/config/HTTP/CLI tests, types, boundaries, builds and generated OpenAPI. Complete `npm run test:db` runs passed 111/111 on PostgreSQL 18 and 17, no failures/skips. The disposable 17 test container was removed. No dependency or migration changed. The most recent complete local browser run remains 47/47 on the storage checkpoint; the later six-case authorization run passed without retries/skips. Both complete hosted 17/18 matrices passed on recipient checkpoint `c320de0`: [PR run](https://github.com/AsynchronousVentures/scrawl/actions/runs/36833965052), [push run](https://github.com/AsynchronousVentures/scrawl/actions/runs/36833961108). Both complete ownership/expiry matrices subsequently passed on `a8e7823`, linked above.

The next core checkpoint adds transactional recipient authorization for a bounded authenticated connection audience. Stable user/session locks cover sender and recipients, and account recovery takes the same order. Receipts expose only currently authorized connection IDs and read/write status. Actual downgrade, expired and multiple-session tests passed, including an acceptance paused inside its database write while recovery waited on its user lock; after commit/recovery, later receipts excluded that account. This does not enable or verify socket delivery.

`npm run check` again passed all 81 tests/types/boundaries/build/OpenAPI checks; complete PostgreSQL suites passed 106/106 on each of 17 and 18, no skips. Six focused real browser cases passed without retries/skips for login/logout, reader/outsider isolation, conflict retention, expiry and membership revocation. The full 47-case storage run below remains the most recent complete local browser run. No migration or dependency changed in this recipient checkpoint. The disposable 17 test container was removed after the run.

The eighth migration, `20261001000000_live_documents`, adds nullable document epoch pointers and versioned private Yjs states. Existing documents remain in solo mode. Core enrollment/read/update/checkpoint/restore operations validate native content and attachment ownership, recheck current permissions/session under space-before-document locks, and preserve immutable checkpoints. Explicit checkpoints require the document ETag plus epoch and observed sequence. Restore retains the old state and appends a new revision under a fresh epoch. No HTTP/WebSocket routes or collaborative UI are enabled.

Observed on storage checkpoint `583ae97` (tested in the isolated checkout as `b3946c4`):

- `npm run check` passed strict types, boundaries, 81 unit/config/HTTP/CLI tests, both builds and generated OpenAPI. No dependencies changed.
- `npm run test:db` passed 104/104 on real PostgreSQL 18 and 17, with no skips. New coverage uses genuine HTTP-authenticated cookie sessions, concurrent native merges, idempotent delivery, reader/outsider denial, exact checkpoint preconditions/concurrency, malformed/protected frames, foreign attachments, forced room/head failure rollback, retained restore epochs, archive/unarchive, lock-wait revocation and actual operator recovery.
- A populated seven-migration database rehearsal preserved solo documents, immutable revisions, metadata and version counters when applying migration eight. Its current-room foreign key is deferred until commit and rejects cross-document pointers.
- `npm run test:browser` passed all 47 real workflows, no retries/skips, including Demo A and the established conflict, failure, undo/discard and permission checks.
- The first expanded regression found that explicit demo reset refused the new table. The allowlist now recognizes only that owned table in addition to existing tables. Demo A's reset check seeds an actual encoded room and verifies its removal while retaining the full migration ledger. Production, non-demo and unexpected-table guards remain unchanged. The corrected complete PostgreSQL suites passed on both versions.
- Migration eight was applied additively to the retained synthetic 18 demo. Owner-only before/after digests confirmed exact preservation of every existing identity/account/session/verification/space/grant/document/revision/attachment/reference/publication record. No document was enrolled. The original retained 17 database/volume was untouched; the temporary 17 test container was removed.
- The integrated backend/frontend were rebuilt, the existing persistent service restarted, and `demo-verify.ts --origin https://agentvm.beardie-tone.ts.net:10000` passed in fresh administrator/reader/outsider/anonymous sessions. Actual running screenshots were refreshed; the runner created no revisions or fixture resets. Existing native editing, navigation, private files/search/history/export/mobile and selected public content remain usable.

Apply the reviewed history to an explicit development target with `node --env-file=.env node_modules/prisma/build/index.js migrate deploy`, then regenerate with `npm run db:generate` and rebuild. This migration does not convert or reset content. Guarded fixture initialization/setup/reset commands remain explicit; never use them on retained data. The prepared transport above implements isolated socket checks. Startup activation, official comments and actual peer-safe browser undo must still pass [ADR 0003](docs/adr/0003-collaboration-checkpoints.md) before activation. The storage, recipient and ownership/expiry hosted matrices passed.

## Autonomous product iteration: document navigation

On 2026-10-01, private navigation gained native document links and maintained React Router 8.4.0 history/blocking. Back/Forward loads through the same authorized reads as a direct link. "Keep editing" cancels a transition and preserves the local title/body; deliberate discard changes no saved revision. Navigation cannot abandon an in-flight Save or upload. Modified link clicks open an independent tab without discarding the current draft. Search and new-document navigation create history entries, while canonicalization and successful saves replace the current entry. Reload/external navigation retains the existing browser unload guard. No private content is put in router state or browser storage.

`npm run check` passed, including 71 unit/config/HTTP/CLI tests, strict types, boundaries, both builds and OpenAPI drift. The clean full browser run passed 46/46 with zero retries/skips, retaining all prior 43 workflows and adding three real-session link/history/draft/in-flight-save checks. The extended persistent preview acceptance passed fresh administrator/reader/outsider/anonymous sessions, including Back/Forward, authorized files, indexed search, history/native export, narrow-screen use and publication isolation. No fixture reset or saved revision was created by that preview verification. The initial focused setup omitted the required Origin and correctly received 403; its request was corrected. The opener-isolated tab check uses the browser context's page event rather than a parent popup association. These intermediate failures were not counted as passing.

There is no new migration or backend change. The existing seven-migration baseline remains required. Exactly one direct frontend dependency and its two transitive dependencies were added, with MIT license texts retained in third-party notices. All preexisting locked versions/integrity hashes are unchanged; the installation audit reported zero vulnerabilities. The full PostgreSQL 18 suite passed 92/92 with no failures/skips, including guarded Demo A, rollback, concurrency, migrations and current-grant checks. The current local iteration did not rerun PostgreSQL 17. Full 17/18 hosted matrices passed on the preceding readable-link checkpoint `c729cd1`: [PR run](https://github.com/AsynchronousVentures/scrawl/actions/runs/36723795537), [push run](https://github.com/AsynchronousVentures/scrawl/actions/runs/36723788549). These hosted results are distinct from the navigation change's local verification; new hosted results are unverified until recorded.

Hosted navigation checkpoint `102d09d` exposed failures that its local run missed: [PR matrix](https://github.com/AsynchronousVentures/scrawl/actions/runs/36824468665) failed on both versions and [push matrix](https://github.com/AsynchronousVentures/scrawl/actions/runs/36824464788) failed on 18 while 17 passed. One case incorrectly showed Upload before a new document's first Save; another timed out waiting for a modified-click tab. Earlier check/migration/database steps passed in all four jobs. A local repeated run reproduced the tab timeout (nine passes and one failure). Synchronous canonical URL commits alone did not resolve the tab check, and holding the keyboard modifier still exposed a transient page handle that navigated to the correct URL but then lost its URL. None of these failures are counted as passing verification.

The browser app now uses React Router's [documented DOM provider](https://reactrouter.com/api/data-routers/RouterProvider) and synchronous canonical navigation so local state and its canonical URL commit together. The modified-click check observes the actual rendered native tab through the browser context instead of retaining an initial transient target; all URL, authentication, draft-retention and no-write assertions remain. Opener protection is unchanged. A new six-cycle rapid draft switch check asserts that unsaved documents have no upload authority and navigation creates no revisions. The three targeted cases passed 24/24 repetitions with zero retries/skips after removing diagnostic instrumentation. The clean full browser run then passed 47/47 with zero retries/skips, including all previous workflows and Demo A. The complete check passed 81 unit/config/HTTP/CLI tests, strict types, boundaries, builds and OpenAPI drift. The full PostgreSQL 18 regression was repeated and passed 92/92 with no failures/skips, including concurrency, rollback and migrations. Fresh administrator/reader/outsider/anonymous sessions passed against the running Funnel demo again with no content writes/reset, and refreshed its screenshots.

Both complete hosted matrices passed on corrective checkpoint `a86a749`: [PR](https://github.com/AsynchronousVentures/scrawl/actions/runs/36829121529), [push](https://github.com/AsynchronousVentures/scrawl/actions/runs/36829118236). All four 17/18 jobs passed frozen installation, complete checks, migration deployment, 92 database tests and 47 browser tests. This resolves the earlier hosted navigation failures without relaxing assertions or retrying jobs. The rebuilt 135-file source archive was verified byte-for-byte against the checkout and its served public copy. No new migration or dependency was added by the corrective or isolated native-validator commits.

Research and next-work dependencies are in [the integration backlog](docs/integration-backlog.md). Collaboration is still unavailable while server validation, persistence, authenticated transport and peer-safe undo gates are implemented. T3's collaborative snapshot worked for the login screen earlier in this iteration. Later `preview_status` and `preview_open` explicitly reported that no connected desktop automation host was available; the authored real-browser acceptance runners supplied subsequent verification and screenshots. Fresh-session running-application screenshots were refreshed by `demo:verify`, without credentials in captures. The task-owned ordinary 18 test database is retained temporarily for the active autonomous development session; both retained demo databases, content/history, credentials and uploads remain intact.

## Isolated live content preparation, prior checkpoint

The first collaboration module validates encoded Yjs state through the pinned native BlockNote server utilities. It preserves CRDT identities and concurrent updates, validates rich blocks and title text, rejects incomplete dependencies and hidden schema changes, and protects comment structures including deleted or shadowed items. Official comment anchors are excluded from native checkpoint content; all remaining native content must survive an exact round trip. Temporary blank live titles are allowed, while existing checkpoint title requirements remain unchanged.

`node --import tsx --test test/live-content.test.ts` passed 10/10 with no skips. The complete check passed 81 unit/config/HTTP/CLI tests, strict types, boundaries, both builds and generated OpenAPI. The initial `c4bc9cf` preparation added no migration or dependency and did not authorize, persist, acknowledge or broadcast edits. Its validated projection now supports the private core storage described above. Authenticated transport, revocation/reconnect delivery, supplied comments and peer-safe undo must still pass [ADR 0003's activation gates](docs/adr/0003-collaboration-checkpoints.md) before the demo exposes collaboration.

## Readable private URLs
Private navigation now uses `/spaces/:spaceSlug/documents/:documentSlug`, including [the supplied release-checklist example](https://agentvm.beardie-tone.ts.net:10000/spaces/demo-handbook/documents/release-checklist). Initial saved titles determine stable slugs; renaming, restoring and archiving retain them. Duplicate names get readable numeric suffixes, and archived names remain reserved. Existing UUID query bookmarks continue to load and canonicalize after authentication. UUID API identities, export provenance and independent public approval URLs are unchanged. Route logging now uses templates to avoid recording private names.

`npm run check` passed with 71 unit/config/HTTP/CLI tests, strict backend/frontend types, boundaries, builds and generated OpenAPI. The complete real PostgreSQL suite passed 92/92 on both 17 and 18, with zero skips/failures, including concurrent space/document slug collisions, scope, archive reservation, immutable history, restored content, current grants and revoked sessions. Space creation also rechecks a session revoked while waiting for its namespace lock. The clean full browser run passed 43/43 with no retries or skips, retaining all previous checks and Demo A alongside direct login/reload/rename/old bookmarks, reader/outsider restrictions and unknown-link isolation. The persistent Funnel demo passed its fresh administrator/reader/outsider/anonymous acceptance again, including canonical links and reloads.

Intermediate failures were resolved and rerun, not counted as passing: a focused browser invocation overlapped the database suite's disposable database and was refused by its target guard; two older browser assertions/fault injections assumed query URLs and were updated without removing their protections. One intermediate full 17 run failed Demo A, while its isolated rerun and final complete 92-test run passed; the harness now reports only known failure-stage labels for safe diagnosis. An acceptance-script variable/type error was corrected. Historical foundation validation below remains the earlier checkpoint, not a claim about these intermediate runs.

Migration `20260930060000_readable_slugs` is seventh in the existing history. Run `npm run db:generate` and `npm run db:migrate` on an explicitly selected development database before starting the updated code. It adds bounded unique navigation columns, deterministic collision-safe backfill and format checks, without adding revisions or changing timestamps, lifecycle/lock versions, grants, attachment references or publication approval. A real retained-data test compares every preexisting space/document/revision field before/after. The running PostgreSQL 18 preview was stopped, migrated and restarted; exact fingerprints of its existing spaces, documents, revisions, attachments and publications matched after excluding only the new slug columns. No reset or credential change occurred; the original 17 demo/volume was not migrated or altered. No dependency changes were needed.

## BlockNote integration demo, current branch

Work is on `integration/blocknote-demo`, based on completed P4 `445bae2`. [Draft PR #6](https://github.com/AsynchronousVentures/scrawl/pull/6) and [five tracking issues](docs/integration-backlog.md) distinguish implemented-on-branch work from merged or released work. Nothing in this integration is merged, released or deployed to production. The maintainer authorized the session to continue across earlier packet boundaries, then explicitly requested public Funnel access for the synthetic preview; historical packet results below are not the current editor's contract.

Node.js 24.20.0, npm 10.9.9, PostgreSQL 17.11 and 18.6, and Playwright Chromium were used. The original retained 17 demo/data/history and disconnected approved prototypes remain intact. The integrated synthetic demo uses a separate fresh 18 volume and database at loopback 5434, with the official image's `/var/lib/postgresql` mount.

### Implemented and observed

Native BlockNote 0.55.0 and its official shadcn UI provide standard rich blocks, seven styles, slash menus, formatting/link UI, block controls, nested/toggle content and tables. Scrawl validates the native envelope before persistence and proves a loss-free official server round trip. Saved revisions stay immutable; restore appends history. Explicit save, native undo/redo, confirmed title/body discard, complete conflict comparison, expiry/revocation retention and mobile navigation remain in place. Discard writes nothing and never adopts a newer ETag after conflict.

Private attachments use detected types, full bounded image decoding, immutable document-owned metadata and normalized revision references. Upload creates no content revision. Current access controls every download. Official OSS PDF/DOCX exporters run offline using bundled compiler/fonts, include visible snapshot titles, embed authorized images and retain authenticated file links. External media and unsupported export colors produce explicit errors. Native JSON export remains a saved snapshot, not a backup or import system.

PostgreSQL search uses a stored generated weighted title/body vector and GIN index. Its parameterized query applies current session and space grants before ranking or excerpts, searches only saved current non-archived heads, and returns bounded plain text. The connected dialog has keyboard selection, debouncing, stale-response protection and guarded navigation.

Publishing is disabled by default. Its implemented backend approves one explicitly selected immutable revision, validates publication-scoped attachment references and uses the document ETag inside core transactions. Private saves do not advance the publication; archive invalidates prior approval even after unarchive. Anonymous responses contain only approved title/content/publication time. The private synthetic demo explicitly enables this capability. All 41 browser workflows passed in a clean full run, including deterministic delayed-read protection and actual native external link/file opener isolation. Collaboration/comments remain isolated and unenabled.

| Check | Observed result |
| --- | --- |
| `npm run check` | Exit 0: import boundaries, both strict TypeScript projects, 71 unit/config/HTTP/CLI tests, backend/frontend/source archive builds and generated OpenAPI drift check |
| `NODE_ENV=test npm run test:db` on 17.11 | Exit 0: 86 tests, zero failures/skips |
| Same complete database suite on 18.6 | Exit 0: 86 tests, zero failures/skips |
| `SCRAWL_BROWSER_EVIDENCE=1 NODE_ENV=test npm run test:browser` | Exit 0: clean 41/41, zero retries/skips, actual HTTP API and PostgreSQL 17.11 |
| Real API Demo A on fresh migrated 18 demo | 368 assertions; repeat runner/reset/no-retry behavior also passes in both complete database suites |
| Hosted foundation matrix on `9874740` | Exit 0 on PostgreSQL 17 and 18: frozen install, complete check, migrations, database/browser suites and generated OpenAPI |
| Rich workspace seed and repeat | Five native documents plus private image created; repeat changed no content/history/credentials |
| Actual persistent HTTPS demo acceptance | Fresh administrator, reader and outsider sessions passed login/logout, saved native rendering/private image, indexed search, history, exact native export, read-only restrictions, isolation and narrow-screen overflow checks; a fresh anonymous session rendered the selected publication/scoped image without private controls |
| Retained 17 to disposable 18 copy rehearsal | Exact restore, additive SQL migrations, backed-up finite native conversion, original revision identities/head metadata retained and original source unchanged |

Meaningful coverage includes same-ETag concurrent saves, exactly one new revision, injected mid-write rollback, deferred same-document heads, immutable history, cross-document denial, session recovery/revocation, unsafe fixture reset refusal, overlapping memberships, search SQL rechecks and backfill/rebuild, attachment quotas/type/ownership/retention, and selected publication lifecycle/allowlists. Browser checks exercise actual sessions, APIs and PostgreSQL, without mocked successful writes. Earlier unsuccessful intermediate checks were fixed and rerun; failures and skips are never counted as passing.

The currently pinned backend baseline remains Better Auth 1.7.6, Prisma 7.10.0, Fastify 5.12.5, pg 8.23.0 and ProseMirror model 1.25.12. Existing remaining resolved dependency versions/integrities were compared and stayed unchanged. Necessary native editor/export/media/testing packages are exact-pinned; obsolete direct custom-editor/toolbar dependencies were removed. XL exporter packages use their GPL-3.0 OSS license. Full dependency/font notices and the exact checkout source archive are included with the built app. Final `npm ci` passed with zero audit advisories; the CI-equivalent `NODE_ENV=test npm run check` also passed. Earlier hosted runs failed a generated-type drift check on the intermediate search commit; the committed generation now passes locally. The complete PR matrix on `0cf2d80` passed on 17 and 18. One duplicate push job exposed a new-draft/loading race; `9874740` fixes it with a deterministic delayed-read regression. The [complete hosted push matrix on `9874740`](https://github.com/AsynchronousVentures/scrawl/actions/runs/36680339346) passed on both PostgreSQL 17 and 18, including the 41-case browser suite; documentation-only commits follow that verified code checkpoint.

### Repeat the checks

Use an ordinary local test connection in owner-only `.env`, separate from either retained demo. Database and browser suites reserve the same disposable name and must run sequentially on each PostgreSQL instance:

```sh
npm ci
npm run check
npm run db:migrate
NODE_ENV=test npm run test:db
PLAYWRIGHT_SKIP_BROWSER_GC=1 npx playwright install --with-deps chromium
SCRAWL_BROWSER_EVIDENCE=1 npm run test:browser
```

Fresh development defaults to PostgreSQL 18 with `docker compose up -d --wait`. To test an existing 17 development volume, use its original Compose project and `compose.postgres17.yaml` explicitly. Do not mount 17's old volume into the 18 image or run tests against the retained review database. A second test instance can use an owner-only alternate environment file and an explicit free loopback port. This session ran 18 tests on the task-owned 5435 instance, never the final 5434 demo.

### Migration and preservation instructions

The single history now has eight migrations: identity/spaces, documents/revisions, native BlockNote metadata, indexed search, private attachments, selected publication, readable navigation slugs and private live storage. `migrate deploy` is additive and never converts content automatically. Search backfill changes only generated derived state. Publication adds a separate positive availability generation; nullable live pointers leave existing documents in solo mode. Existing native instances need normal deployment of the additive migrations, not content conversion.

For retained legacy content, stop the application and rehearse on an explicitly disposable local copy first:

```sh
node --env-file=.env.copy node_modules/prisma/build/index.js migrate deploy
node --env-file=.env.copy --import tsx scripts/content-upgrade.ts --dry-run
node --env-file=.env.copy --import tsx scripts/content-upgrade.ts --apply --backup /private/path/original-document-revisions.json
node --env-file=.env.copy --import tsx scripts/content-upgrade.ts --dry-run
```

Use an owner-only `.env.copy` targeting that copy. The original-data archive contains private bodies/provenance and stays out of Git, screenshots and issues. Conversion creates an exclusive owner-only archive and fsyncs it before any writes, then converts all revisions atomically under exclusive locks. It preserves IDs, numbers, titles, authors, times, heads, lifecycle and lock versions. Unknown or unrepresentable legacy content aborts instead of stripping formatting. Native inline code cannot combine with other marks/links; legacy hard-break mark attribution may also be unrepresentable. Two real PostgreSQL conversion tests cover preservation, repeat execution and rollback after injected mid-conversion failure. The finite reader lives only in operator scripts, not runtime compatibility code.

For derived search maintenance on an explicit local target:

```sh
node --env-file=.env.copy --import tsx scripts/search-index.ts rebuild
```

### Running application and honest limits

[The current walkthrough](docs/demo-walkthrough.md) records the public Funnel URL, safe local credential retrieval, exact restart/setup/reset commands and suggested workflows. Actual running-demo captures are separate from prototype artifacts. T3 preview navigation/evaluation works, but its snapshot operation returned an execution failure; authored real-browser acceptance produced screenshots without exposing credentials.

On 2026-09-30 the maintainer requested moving this synthetic instance to public Tailscale Funnel and cleaning up stale previews. Scrawl now uses `https://agentvm.beardie-tone.ts.net:10000/`; the persistent user service's origin was changed to that exact URL and readiness returned 200. Fresh administrator, reader, outsider and anonymous browser acceptance passed again against the new origin, with no revisions or fixture reset. An additional HTTPS check forced the publicly resolved Funnel relay address, rather than the tailnet address: HTML/readiness returned 200, anonymous private identity/document requests returned 401, the approved publication contained only title/content/publication time, and real sign-in/session/sign-out passed. A sign-out request from the former 8447 origin returned 403 and left the valid session intact; proper sign-out then revoked it. Temporary test cookies were removed.

Only the public Scrawl 10000 route and unchanged private T3 Code 443 route remain. Removed routes were the four old static preview paths, two proxies without listeners, the obsolete Scrawl prototype route and the superseded 8447 Scrawl route. The prototype HTTP process was stopped; all files, database volumes, content, history, credentials and private uploads were preserved. No backend code, dependencies, migrations, origin checks or cookie protections changed. The full unit/database/mutation-browser suites were not rerun for this runtime/documentation-only change; their earlier observed results above remain the regression checkpoint. T3 snapshot still fails, while navigation/evaluation and the authored real-browser runner succeed.

No collaboration/comments, AI/provider calls, document hierarchies, full backup/import, external search service or generic plugin framework is enabled. File crash-orphan cleanup, range/seek media responses, desktop Office rendering, Firefox/WebKit/native mobile, screen-reader testing, formal PDF accessibility certification, production operation and load testing remain unverified or unimplemented. Custom CSS colors outside exporter presets/six-digit hex and external images remain valid native content but cannot yet be rendered by the offline exporters; the app reports this explicitly. No private document content is persisted to browser storage. Native toggle expansion booleans are the sole localStorage exception. The task-owned ordinary 17 and extra 18 test containers/volumes/networks and temporary upgrade/proof files were removed after validation. The running 18 demo, retained 17 demo, private uploads, owner-only credentials and ignored evidence/logs remain intentionally available. One post-restart browser probe ran before startup finished and failed; after readiness was confirmed, all fresh-session acceptance checks passed again. The native editor bundle emits a nonblocking large-chunk warning (about 1.57 MB minified / 469 kB gzip for the main chunk).

### Current running-demo screenshots

These captures are from the persistent application and synthetic workspace, after actual authentication; no passwords, cookies or tokens appear. Generated PNGs remain ignored. Published through `t3code-publish-evidence`:

- [Document, navigation and outline](https://uwvqig7mu5.ufs.sh/f/tJOw1mn9psOEtShRG7n9psOEgi62D1HuWBIdXRlvM5wjaer0)
- [Actual indexed search](https://uwvqig7mu5.ufs.sh/f/tJOw1mn9psOEA5GivBJQwKgCvrG4dfBPDk3UtpaVSO2ny9Aj)
- [Authorized private image](https://uwvqig7mu5.ufs.sh/f/tJOw1mn9psOEt9jHdBn9psOEgi62D1HuWBIdXRlvM5wjaer0)
- [Native table, checklist, formatting and code](https://uwvqig7mu5.ufs.sh/f/tJOw1mn9psOEneza6DuPu5RwaceHS9ImGo6YL4DOxq0QVJhz)
- [Narrow-screen document](https://uwvqig7mu5.ufs.sh/f/tJOw1mn9psOE91YfLeHa3mMo6IegLYGHK7XhZJ5lr2PDBUjW)
- [Anonymous approved revision](https://uwvqig7mu5.ufs.sh/f/tJOw1mn9psOEu0AzzT3BENg7VJrQhHPY3inoRKcTZytmM2sl)

## P4 editor refinement, verified locally on 2026-09-30

This refinement starts from completed P4 `9630659` and stops at P4 review. Node.js `v24.20.0`, npm `10.9.9`, PostgreSQL `17.11`, and Chromium were used. The approved prototype and layout remain intact. The initial P4 editor used ProseMirror directly; it now uses actual Tiptap with maintained OSS controls as requested. Earlier packet results below are historical.

### Implemented behavior and migration effects

Tiptap `3.31.3` supplies React lifecycle, official formatting/list/link commands, keyboard bindings, and UndoRedo. Radix Toolbar `1.1.19` supplies keyboard navigation, Radix Popover `1.1.23` supplies the link form, and Lucide React `1.49.0` supplies icons. Charcoal surfaces, sage accent, typography, central document, navigation, action hierarchy, and heading outline are preserved. There is no new design framework or simulated live search.

Only the existing nine node types and four marks are enabled. Small adapters remove unsupported default attributes, retain list starts and code languages, preserve the native mark order/combinations, and use the shared validators. No StarterKit or text-direction attributes are added. Automatic links, input/paste rules, and the official ordered-list plain-text conversion plugin are disabled. Unsupported HTML/files still fail before parsing; rejected transactions retain the accepted document. The strengthened native round-trip browser test now performs a real body transaction and Undo before saving, proving that all native nodes, marks, and attributes survive Tiptap serialization.

Toolbar buttons expose pressed/disabled states, names, shortcuts, and visible focus. Link editing loads the current href and keeps selection through Apply, Remove, Cancel, and Escape. Invalid URLs stay local to the form and leave the valid title/body intact. Tests found and corrected deferred editor focus dismissing keyboard-opened popovers, rapid repeated clicks bypassing the single-click opener, and an initial null editor-state snapshot hiding headings. The Vite app uses Tiptap's immediate rendering option so outlines and toolbar state work before the first interaction. Injected Tiptap styling is disabled; the existing stylesheet controls presentation.

Successful Save, including first creation, updates the saved baseline without remounting the editor or clearing body undo history. Undo/Redo use Tiptap history; title editing uses native input behavior. Discard changes beside Save requires confirmation, resets the complete title/body to this tab's baseline, and clears local editor history. Keep editing cancels. Discard sends no write, creates no revision, and changes no ETag. A new draft resets to "Untitled document" and an empty paragraph, with no document created. After 412, discard keeps the original baseline/ETag and conflict/latest-server comparison. Another Save still requires deliberate reconciliation. Failure, expiry, revocation, dirty navigation, and private in-memory draft protections remain intact.

No backend source, API/schema types, Prisma model/migration, content format/version, fixture commands, or core authorization/transaction behavior changed. All 398 resolved entries from `9630659` retain their versions and integrity values; the backend/auth/Prisma pins are unchanged. Existing instances use normal `npm ci`, `npm run db:migrate`, and `npm run check`; migrate deploy retains the same two migrations with no editor data transformation. The current browser bundle notices cover 71 packages. The exact-checkout source archive includes both new editor source files and excludes private/generated/artifact files.

### Actual checks and review evidence

| Command/check | Observed result |
| --- | --- |
| `npm ci` | Exit 0; frozen install and Prisma generation, zero audit advisories |
| Baseline lock comparison with `9630659` | 398 existing resolved versions/integrities unchanged, no missing entries |
| `npm run check` on final editor source | Exit 0; boundaries, both strict TypeScript projects, 58 tests, both builds, generated API drift check |
| `NODE_ENV=test npm run test:db` | Exit 0; all 48 PostgreSQL tests, zero skipped, including rollback, concurrency, auth/access and guarded Demo A/reset |
| Focused editor/native browser run after link corrections | Exit 0; 7/7, no retries |
| Final initial-outline/mobile/native browser run | Exit 0; 3/3, no retries |
| `SCRAWL_BROWSER_EVIDENCE=1 npm run test:browser` on final build | Exit 0; 25/25, no retries; all 19 original P4 scenarios plus six editor scenarios; Demo A's 327 assertions preserved |
| `npm audit --omit=dev` and `npm ls --depth=0` | Exit 0; zero runtime advisories and exact installed pins |
| Runtime bundle notice audit | 71 packages, zero missing or extra notice entries |
| Private HTTPS collaborative preview | Actual retained session, formatting Undo/Redo and confirmed discard observed; server revision stayed unchanged, no JS-visible cookies or localStorage entries |

The six added browser scenarios cover native formatting and toolbar keyboard navigation; Undo/Redo across Save and first creation; link add/edit/remove, invalid URLs, keyboard focus/cancel and repeated clicks; list toggle/start/code language/hard-break commands and literal plain-text paste; existing/new draft discard without writes/history changes; and 412 discard followed by deliberate ETag reconciliation. Every original browser scenario remains. Failed intermediate runs were corrected and rerun; the final suite is fully green.

Tests use the existing guarded freshly migrated disposable fixtures and actual authenticated HTTP API. The task-owned ordinary PostgreSQL server at 5432 was separate from the retained manual demo at 5433. Browser/database suites ran sequentially. Test fixtures were removed by their harnesses; the `scrawl-editor` container/network/volume was removed afterward. The retained demo configuration, credentials, database, and loopback/private Tailscale servers remain available for review. Neither an arbitrary database nor the manual demo was reset.

Fresh screenshots from the asserted running application contain only synthetic content and no passwords, cookies, or tokens. Published with `t3code-publish-evidence`; local PNGs remain ignored:

- [Long document, toolbar and initial outline](https://uwvqig7mu5.ufs.sh/f/tJOw1mn9psOE86vuNCbw0lHU8rYvyih9SJ35DdcOXpW7z16C)
- [Formatting and active toolbar states](https://uwvqig7mu5.ufs.sh/f/tJOw1mn9psOEvyXlDhetwP8gXuYBsqD65yxbLW3FApIC0kEl)
- [Link editor](https://uwvqig7mu5.ufs.sh/f/tJOw1mn9psOExqQG2ah9J86kgDlYGmNidF1UE5zbcIpWjuv0)
- [Discard confirmation with Keep editing](https://uwvqig7mu5.ufs.sh/f/tJOw1mn9psOExiCM7Uh9J86kgDlYGmNidF1UE5zbcIpWjuv0)
- [Narrow-screen document and controls](https://uwvqig7mu5.ufs.sh/f/tJOw1mn9psOEW0q0m6mRvuRFP7JMAnErXw4f9SjKdoOxZya5)

With ordinary test PostgreSQL available and configured in `.env`, repeat the checks sequentially:

```sh
npm ci
npm run check
NODE_ENV=test npm run test:db
SCRAWL_BROWSER_EVIDENCE=1 npm run test:browser
```

The [Demo B walkthrough](docs/demo-walkthrough.md#run-demo-b) has the exact guarded setup, seed, local/development/private HTTPS launch commands and workflow. The retained review server uses `npm run demo:serve -- --origin https://agentvm.beardie-tone.ts.net:8447`; the private route is [Scrawl](https://agentvm.beardie-tone.ts.net:8447/). Credentials stay in the owner-only local fixture file described in the walkthrough. The original disconnected prototype is preserved; the small editor control prototype at `artifacts/design-p4/scrawl-editor-refinement.html` also remains a clearly marked synthetic artifact.

No local blocker remains. Firefox/WebKit, native mobile browsers, screen-reader testing, hosted CI, production operation and performance/load testing remain unverified. Interactive T3 navigation/typing/DOM checks worked, but its screenshot operation failed; authored acceptance tests produced the actual application captures. The nonblocking Vite chunk warning is now about 758 kB minified / 235 kB gzip. The existing scrollbar license provenance limitation remains in the notices. No push, deployment, public exposure, persistent browser content storage, or next packet was added.

## P4 initial implementation, historical results on 2026-09-30

P4 is complete locally on P3 baseline `76da4c0`. Node.js `v24.20.0`, npm `10.9.9`, PostgreSQL `17.11`, and Playwright Chromium were used. No push, hosted CI, deployment, public exposure, or next packet ran. P0-P3 historical evidence follows this section.

### Implementation and migration effects

The real React/Vite app follows the approved charcoal/sage prototype: space/document navigation, a central document, explicit primary Save, accessible History, a document menu for lifecycle/export, and a heading-derived outline. Narrow screens use a navigation drawer and collapsed outline. The disconnected prototype at `artifacts/design-p4/scrawl-demo-b-prototype.html` is preserved separately; live code has no fixture selectors, simulation labels, or search results/control. Search remains unimplemented.

The typed `openapi-fetch` product client uses checked-in types generated from the implemented OpenAPI. The three restricted authentication endpoints retain their existing library semantics; the app uses real sign-in/sign-out and `/me`, with same-origin HttpOnly sessions. Vite development preserves the browser Origin/cookies through its proxy. The built frontend is served only at `/` and `/assets/` on the application origin; unknown API paths remain JSON problem responses. Static assets retain no-store, nosniff, and server request IDs and are excluded from OpenAPI.

The one API adjustment is additive `access: "reader" | "editor"` on authorized space DTOs, derived in core for the current caller. Administrators receive effective editor access. It enables honest read-only controls without probing write endpoints; every server operation remains authoritative. P1 tests assert reader/editor/admin access, changed membership roles, hidden-resource denial, and no leaked memberships. There are still 14 implemented OpenAPI paths and 18 operations.

The unchanged P2 parser/schema is relocated byte-for-byte to `src/shared/content.ts`, with a compatibility re-export from core. Browser DOM representations add no persisted nodes, marks, or attributes. Native round-trip tests cover every accepted feature, including ordered-list start values, code language, heading levels, hard breaks, and link marks. Unsupported HTML/file paste is rejected before the editor can silently discard it; the parser enforces the same URLs, bytes, depth, and node limits on edits and saves. Heading navigation uses native ProseMirror decorations for IDs/focus targets, keeping presentation metadata out of stored content.

No Prisma model, migration, content-schema version, auth baseline, or transaction/lock order changed. All 256 pre-existing resolved lock entries retain their versions and integrity values. Better Auth 1.7.6, Prisma 7.10.0, Fastify 5.12.5, pg 8.23.0, and ProseMirror model 1.25.12 remain pinned. New exact dependencies are limited to frontend/editor/dialog/client/build/browser tooling and `@fastify/static` for the built app. Existing instances run normal `npm ci`, `npm run db:migrate`, and `npm run check`; migrate deploy retains the existing two-migration history with no P4 data transformation.

The build includes the AGPL license, browser-bundle third-party notices, and a source archive made from the actual checkout. Its explicit inventory excludes private environments, credentials, artifacts, dependencies, generated clients, and builds. The source download is available in the footer before private network review. [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) records the inspected 39-package browser module graph and injected bundler-helper notices. Full release packaging remains P9; one upstream notice correspondence limitation is recorded below.

### Observed checks

| Command/check | Result |
| --- | --- |
| `npm ci` | Exit 0; frozen install, Prisma client generation, zero audit advisories |
| Baseline lock comparison against `76da4c0` | All 256 existing resolved versions/integrities unchanged; no missing baseline entries |
| `npm run check` | Exit 0; import boundaries, both strict TypeScript projects, 58 unit/config/HTTP/CLI tests, backend/frontend builds, and generated API type drift check |
| `NODE_ENV=test npm run test:db` | Exit 0; 48 reported PostgreSQL tests, 0 skipped; P0-P3 auth/bootstrap/recovery/migration/rollback/concurrency/export/reset coverage preserved |
| `npm run test:browser` | Exit 0; all 19 real-API/PostgreSQL Chromium scenarios passed, 0 retries, including Demo A |
| Focused final-build native/outline/mobile/recovery browser run | Exit 0; 4/4 passed before the final full run |
| Opt-in synthetic screenshot rerun and final history usability check | Exit 0; 5/5 evidence cases, then 1/1 history/restore/lifecycle/export after placing Restore above the long snapshot |
| Guarded `demo:dev` runtime probe | Real same-origin proxy login/session/create/logout passed; foreign Origin and cross-site writes denied; API 404 remained JSON; both child processes stopped |
| Fresh `demo:init`, Compose project `scrawl-p4-demo` on 5433, explicit setup, `demo:b:seed` and `demo:a` | Passed; two existing migrations applied, four generated accounts, heading-rich UI fixture through real HTTP, Demo A 327 assertions |
| Stopped-server explicit reset/setup, then seed and Demo A again | Passed; migration history retained, new generated accounts, fresh UI fixture, Demo A 327 assertions |
| Actual private Tailscale HTTPS preview | Real session `/me` 200, Secure/HttpOnly cookie, foreign-Origin product/auth and cross-site product writes 403; private Serve only |
| Collaborative-preview outline inspection | Actual heading list matched content; activation focused "Archive and export" and scrolled to it; no JS-visible auth cookies, localStorage entries, or desktop overflow |
| `npm audit` / `npm ls --depth=0` | Exit 0; zero advisories, exact pins installed |
| Source archive inventory | 91 source files at the inspected build, required license/notices present, zero private/generated/dependency/artifact paths |

The P3 and browser suites reserve the named `scrawl_demo_a` on ordinary PostgreSQL and refuse existing data. They ran sequentially on the task-owned server at 5432 and dropped only databases/schemas they created. The retained manual demo uses a different server at 5433. Do not run `test:db` and `test:browser` simultaneously against one PostgreSQL server, or alongside an independently retained database with the reserved name on that server. Install/build first; do not reinstall dependencies during fixture/server commands.

### Browser acceptance and corrections

The 19 cases use actual authenticated browser contexts and the built app against a freshly migrated disposable database. They assert login/logout and origin/cookie protections; create/edit/explicit save/reload; full supported native editor round trips; rejected unsupported paste without fetching remote assets; restore-as-new with preserved history; archive/unarchive and parser-matched native downloads; reader server denials; outsider isolation; two-tab stale-save behavior; dirty space/document/reload warnings; injected temporary save failure; actual session expiry; a new unsaved draft surviving expiry/re-login; mismatched space/document isolation; actual administrator membership revocation; loading/retry/empty states; keyboard/mobile navigation; executable Demo A; wrong-account/read-failure draft recovery; and live heading scroll/focus/update.

On 412, the complete local title/native body stays intact and the latest server snapshot appears separately. No second PATCH occurs automatically. Use my changes deliberately changes the comparison base without writing, then the user explicitly saves. Use server version requires discard confirmation; Keep editing preserves the draft. A temporary failure retains editable work without claiming success. Expiry/revocation clears server navigation/actions and retains dirty work read-only in memory. Owner re-login rechecks space/document access; a different account cannot adopt or save the draft. Existing documents require explicit reconciliation even after read-recovery Retry. No persistent private-content cache or background replacement is used.

Review/testing found and fixed genuine UI defects: expired unsaved new documents needed independent space/owner tracking; mismatched query space/document pairs could show wrong controls; read-recovery Retry could discard dirty work; late space-list responses could repopulate navigation after logout; archive-filter reads could arrive out of order; and direct heading DOM attributes were removed by ProseMirror. Heading decorations fixed the observed outline keyboard failure. Auth test pacing was corrected to follow the pinned library's inactivity-based limiter, without relaxing server limits, retrying writes, or weakening assertions. Selector/text-normalization fixes were test-harness corrections.

### Exact commands, screenshots, and remaining limits

[The walkthrough](docs/demo-walkthrough.md#run-demo-b) contains exact fresh setup, seed, built app, development proxy, private Tailscale, reset, export-inspection, and browser commands. Minimal local verification is:

```sh
npm ci
npm run check
NODE_ENV=test npm run test:db
PLAYWRIGHT_SKIP_BROWSER_GC=1 npx playwright install --with-deps chromium
npm run test:browser
```

Browser screenshots are captured only at asserted synthetic application states with `SCRAWL_BROWSER_EVIDENCE=1`. Failure screenshots/traces/videos stay disabled; evidence capture refuses populated password inputs. Actual running-application captures, inspected for synthetic content and no credentials/session data:

- [Editing and heading outline](https://uwvqig7mu5.ufs.sh/f/tJOw1mn9psOEu77ytU3BENg7VJrQhHPY3inoRKcTZytmM2sl)
- [Two-tab conflict with complete retained draft](https://uwvqig7mu5.ufs.sh/f/tJOw1mn9psOE9uvKe6Ha3mMo6IegLYGHK7XhZJ5lr2PDBUjW)
- [History with restore above the snapshot](https://uwvqig7mu5.ufs.sh/f/tJOw1mn9psOEP2lYuoSVJw37gOsa4me9KNb8ldovCRxzMuZD)
- [Lost access with retained local draft](https://uwvqig7mu5.ufs.sh/f/tJOw1mn9psOE6BXEQDmBtHDGsz3Ll8CM1XJypa9AQ2TIbFxi)
- [Narrow-screen navigation and collapsed outline](https://uwvqig7mu5.ufs.sh/f/tJOw1mn9psOEON9x0Uyx2WwrmlSBoDzp4gydj8FEY1CtJZaf)

Exact evidence command, after the ordinary PostgreSQL server is available:

```sh
SCRAWL_BROWSER_EVIDENCE=1 npm run test:browser -- --grep 'history restore|two tabs preserve|membership revocation|mobile navigation|the outline follows'
```

Local PNGs remain ignored in `artifacts/browser-evidence/`. Interactive T3 navigation/DOM inspection worked, but its active web client's screenshot operation failed repeatedly; the authored browser acceptance tests capture actual running-app evidence instead of substituting another interactive browser.

No local P4 blocker remains. Hosted CI, Firefox/WebKit, native mobile browsers, screen-reader testing, production TLS/proxy/deployment, workload/scalability, backup/import/release remain unverified. Only essential mobile layout/keyboard behavior was exercised. Acceptance runs the built frontend; development proxy authentication/writes were probed, but HMR updates were not exercised. The Vite build reports a nonblocking 500 kB chunk warning (about 527 kB minified, 162 kB gzip); no speculative splitting/framework was added. One MIT package, `react-remove-scroll-bar@2.3.8`, omits its license file and has an unavailable recorded source commit; the official upstream notice is included, with exact-commit correspondence unverified. The P1 recovery/rate-limit limits and P3 Linux loopback/repetition limits remain. Private Tailscale HTTPS was tested; this is not a production-operation claim.

The guarded manual demo database/private credentials and [connected private preview](https://agentvm.beardie-tone.ts.net:8447/) are retained for local P4 review. The task-owned ordinary PostgreSQL container/network/volume was removed after checks. The approved static prototype and its separate private route remain intact. Browser/integration scratch databases, injected objects, fixture credentials, and directories are removed by their harnesses. The one-use private screenshot sign-in helper used actual library authentication with locally read credentials, forwarded only HttpOnly cookies, and was removed immediately; no auth bypass or helper is part of the application. Screenshots and safe synthetic exports remain ignored review artifacts. Stop at P4 review. No publishing, uploads, search, nesting, autosave, collaboration, SSO, AI, admin console, or next packet was added.

## P3 baseline, historical results

P3 is complete locally on P2 baseline `457784e`. Node.js `v24.20.0`, npm `10.9.9`, and real PostgreSQL `17.11` were used. No hosted CI, push, or deployment ran. P0-P2 historical results follow this section.

### Baseline and migration effects

No dependencies, overrides, lockfile entries, Prisma models, or migrations changed. The pinned Better Auth 1.7.6 / Prisma 7.10.0 / ProseMirror model 1.25.12 baseline remains. There are still exactly two migrations: `20260930000000_identity_spaces` and `20260930010000_documents_revisions`. Existing P2 instances need no new migration; normal `npm ci` and `npm run db:migrate` retain the existing history. Demo setup applies those same migrations with `migrate deploy` before provisioning, never schema push/reset. Explicit fixture reset deletes only demo rows and preserves `_prisma_migrations`.

### Observed checks

| Command/check | Result |
| --- | --- |
| `npm ci` | Exit 0; frozen install and Prisma client generation passed; lockfile unchanged |
| `npm run check` | Exit 0; import boundaries, typecheck, all 50 unit/config/HTTP/CLI tests, build; original 44 tests retained |
| `COMPOSE_PROJECT_NAME=scrawl-p3 docker compose up -d --wait postgres` | Exit 0; task-owned loopback PostgreSQL 17 healthy for required integration tests |
| `NODE_ENV=test npm run test:db` | Exit 0; 48 reported tests, 0 skipped: original 37 plus six export and five demo tests including parent tests |
| `DATABASE_URL=postgresql://unused@127.0.0.1:1/unused NODE_ENV=test npm run test:db` | Exit 1 as expected; six required database files failed visibly, 0 skipped |
| `npm run openapi:export` and parsed spec assertions | Exit 0; 14 implemented paths / 18 operations; native export has its own response schema; future routes absent |
| Compiled server probe | Readiness 200; anonymous me/export 401; live 14-path OpenAPI; SIGTERM exit 0 |
| `npm audit` / `npm ls --depth=0` | Exit 0; zero advisories and unchanged exact pins |
| `npm run demo:init` | Exit 0; private generated configuration created exclusively, no secret output |
| `COMPOSE_PROJECT_NAME=scrawl-p3-demo docker compose --env-file .env.demo -f compose.demo.yaml up -d --wait postgres` | Exit 0; second fresh designated demo database healthy on loopback 5433 |
| `npm run demo:setup -- --database scrawl_demo_a` | Exit 0; existing two migrations applied and four generated accounts provisioned |
| `npm run demo:serve` then `npm run demo:a` twice | Both runners exit 0, each with 327 assertions; persisted four users, two spaces/documents, six revisions, zero active sessions |
| Repeated setup / reset without confirmation | Exit 1 as expected; no implicit reset or reprovisioning |
| `npm run demo:reset -- --database scrawl_demo_a` | Exit 0; users/documents/revisions/sessions cleared, credential manifest removed, both migrations retained |
| Explicit setup/server/runner after reset | Exit 0; new generated accounts and another successful 327-assertion walkthrough |
| `cat artifacts/demo/export.json` and `cat artifacts/demo/result.json` | Current restored revision 3, synthetic content, provenance IDs, and matching assertion count; no credentials/session data |

The integration suite requires a local non-production PostgreSQL role able to create a disposable database, in addition to the previous isolated-schema permissions. Its P3 test reserves `scrawl_demo_a` on that server, refuses if it already exists, and drops only the database it created. Ordinary Compose and CI roles have these privileges. A separate demo can run on port 5433 while the suite uses ordinary PostgreSQL on 5432. Do not run two P3 suites against the same server simultaneously.

One manual setup attempt was interrupted by running a dependency reinstall concurrently. It failed nonzero without an implicit reset. After the install finished, explicit demo reset/setup succeeded. Install first and keep fixture commands sequential.

### Acceptance evidence

The executable runner uses actual HTTP sockets, real library sign-in, independent in-memory cookie jars for administrator/editor/reader/outsider plus a second editor session, and the running application server. It asserts matching starting ETags, successful save then stale 412, missing 428, unchanged head/history after rejected writes, reader administration/mutation denial, and outsider document/list/revision denial without resource fields or ETags. Restoring appends revision 3 with original content and preserves intervening history. Archive/unarchive advances lifecycle versions only. After administrator revocation, existing editor cookies still authenticate `/me` but cannot read/write/history/export in that space. Successful runs sign out all five sessions.

Authorized export is selected by the core's existing authorized current-head read, validated through the restricted content parser, and serialized with a separate allowlisted HTTP response schema. Runner and integration tests revalidate/reload exported JSON and compare it to the selected revision. Tests cover administrator/editor/reader export, archived export, outsider/anonymous/revoked-session denials, and unsupported selectors. Exact key checks and synthetic secret/token checks exclude authentication records, profiles, credentials, cookies, and sessions, including from captured CLI/server logs.

P3's mandatory PostgreSQL test provisions a freshly migrated database, spawns the actual server and executable, runs twice, and checks persistent counts. It injects a revision-insert failure; the executable exits nonzero, one document is created and one save is attempted, proved with a rollback-independent sequence. No create or stale/failed write is retried. It rejects unsafe reset/configuration attempts without changing data, stops the server, resets explicitly, verifies migration retention, regenerates accounts/passwords, and runs again. P2's distinct overlapping-save and mid-write rollback tests remain unchanged and pass, as do all P0/P1 bootstrap/recovery/access/migration checks.

Review found that the fixture coordinator needs a second pool connection; demo configuration now rejects `DB_POOL_MAX=1`, with focused coverage. The general application configuration and default pool size remain unchanged.

### Exact Demo A and export commands

From the repository root, use the separate generated demo configuration. No ordinary `.env` or manually supplied passwords are needed:

```sh
npm ci
npm run demo:init
docker compose --env-file .env.demo -f compose.demo.yaml up -d --wait postgres
npm run demo:setup -- --database scrawl_demo_a
npm run demo:serve
```

In a second terminal:

```sh
npm run demo:a
npm run demo:a
cat artifacts/demo/export.json
cat artifacts/demo/result.json
```

Stop the server before an explicit reset/reseed:

```sh
npm run demo:reset -- --database scrawl_demo_a
npm run demo:setup -- --database scrawl_demo_a
npm run demo:serve
```

Run `npm run demo:a` again from the second terminal. Setup never resets implicitly; missing/wrong database confirmation fails. Production, remote/non-demo targets, missing designation, unsafe files, and URL options are refused. `.env.demo` and `artifacts/demo/credentials.json` contain locally generated secrets and must stay private/ignored. Only export/result files are safe synthetic inspection artifacts. See [the walkthrough](docs/demo-walkthrough.md) for fixture identities, repetition, port settings, and removal commands.

Export supports only the current authorized single-document JSON snapshot, including archived documents. It identifies export format version 1 and content schema version 1 with minimal source provenance. It is not complete history, bulk export/import, Markdown conversion, or a database backup. There is no API explorer; existing generated OpenAPI is sufficient for this packet.

### Remaining limits and cleanup

No local P3 blocker remains. Hosted CI, production TLS/proxy operation, non-Linux loopback source addresses, workload/scalability, backup/import/restore, and release/source delivery remain unverified. The P1 limits on concurrent in-flight sign-in during recovery and process-restart rate-limit durability remain. Demo A's stale clients submit sequentially; real concurrent saves and forced transaction rollback are proven by the preserved PostgreSQL suite. Repeated runs create additional synthetic spaces/documents, and unchanged authentication rate limits can reject very rapid repeats. Failed runs retain partial data and sessions until expiry or explicit reset; there is no automatic destructive recovery.

Task-owned PostgreSQL containers/networks/volumes, disposable database/test schemas, injected trigger/function/sequence objects, scratch directories, private demo configuration/credentials, and generated build/OpenAPI output were removed. The ignored synthetic latest `artifacts/demo/export.json` and `result.json` remain for inspection. Existing development configuration, dependencies, and generated Prisma client were preserved.

Stop at P3 for review. No UI, publishing, uploads, search, nesting, Markdown conversion, bulk portability, or generic demo framework was implemented.

## P2 baseline, historical results

P2 is complete locally on the P1 baseline `208d4d0`. Node.js `v24.20.0`, npm `10.9.9`, and real PostgreSQL `17.11` were used. No hosted CI, push, or deployment ran. P0/P1 historical results follow this section.

### Content dependency and baseline preservation

Added exact `prosemirror-model@1.25.12` and its locked `orderedmap@2.1.1` dependency, both MIT. P1 contained no headless native document model; this small package supplies the real Schema/Node validation and native JSON round trip required by P2. No editor, DOM, HTML renderer, or schema-extension package was added. The [ProseMirror schema guide](https://prosemirror.net/docs/guide/#schema) and installed 1.25.12 source/types were checked. Native `nodeFromJSON`, `check`, and `toJSON` behavior is covered by observed tests rather than assuming JSON is safe.

Structured comparison against the baseline lockfile proves every existing P1 direct/transitive resolved version remains unchanged. Only the two packages above were added; the existing advisory overrides remain. npm refreshed root `hasInstallScript` metadata to match the pre-existing postinstall. Reviewed both new MIT license notices; all 256 resolved entries have license metadata, including 196 MIT entries and the unchanged license families recorded in P1. `npm audit` reports zero advisories. Third-party distribution notices/source remain a release gate.

### Observed checks

| Command/check | Result |
| --- | --- |
| `npm ci` | Exit 0; frozen install and Prisma 7.10.0 client generation passed |
| `npm run db:generate` | Exit 0; generated client includes the new models |
| `COMPOSE_PROJECT_NAME=scrawl-p2 docker compose up -d --wait postgres` | Exit 0; task-owned loopback PostgreSQL 17 healthy |
| `npm run db:migrate` | Exit 0; both existing P1 and new P2 migrations applied to an empty database |
| Focused native content tests | Exit 0; 14 tests, including every supported node/mark, native-created content, text extraction, canonicalization, URL/byte/depth/node limits, cycles, and aggregate allocation limits |
| `npm run check` | Exit 0; implemented import boundaries, full typecheck, all 44 unit/config/HTTP/CLI tests, and build passed; original 30 P0/P1 tests retained |
| `NODE_ENV=test npm run test:db` | Exit 0; all 37 reported PostgreSQL tests passed, 0 skipped: existing 21, P2's 14 scenarios plus parent, and one upgrade test |
| Populated P1 upgrade and repeated deploy | Passed in the mandatory PostgreSQL suite; full-row fingerprints of identity/credential/session/space/membership data unchanged, existing cookies and password still authenticate |
| `DATABASE_URL=postgresql://unused@127.0.0.1:1/unused NODE_ENV=test npm run test:db` | Exit 1 as expected; all four required database test files failed visibly, 0 skipped |
| `npm run openapi:export` and parsed/live spec assertions | Exit 0; exactly 13 implemented paths/17 operations, all existing-document mutations advertise If-Match, lifecycle bodies optional, later-packet routes absent |
| `npm audit` and `npm ls --depth=0` | Exit 0; zero advisories, exact direct pins, existing versions unchanged |
| Compiled server probe | Readiness 200, anonymous me/document/list requests 401, live 13-path OpenAPI, SIGTERM exit 0 |

The PostgreSQL suite uses real authenticated HTTP sockets and separate cookie jars. The upgrade fixture installs the unchanged P1 migration, records it with Prisma's supported baselining command, populates real auth/access records, then applies P2 through ordinary `migrate deploy`. That fixture baselining is test setup, not an upgrade instruction for existing instances.

### Acceptance evidence and corrections

Concurrent save requests are both observed waiting on the real space lock before it is released. With the same current ETag, exactly one returns 200 and one 412; persisted history gains exactly one revision. The failure injection runs after revision insertion and before head advance. A rollback-independent sequence proves the revision existed inside that transaction; after failure, the document and ETag are unchanged with zero orphan revisions or missing heads.

SQL tests prove a document insertion can temporarily lack its first revision within the transaction, but COMMIT rejects it if the revision is not created. Updating a head to a number that exists only on another document also fails at COMMIT. The actual composite foreign key is verified as DEFERRABLE INITIALLY DEFERRED. Revision reads/restores scope both IDs, and cross-document attempts return 404 without changing history.

Tests cover authorized create/list/read/update/history/restore, derived creator/author, explicit DTO serialization with every supported native node/mark, reader/outsider/anonymous denial including direct core calls, bounded pagination, immutable snapshots, title-only/body-only changes, canonical no-op saves, restore-as-new even for identical content, every mutator's 428/412/400 preconditions, archive/unarchive version separation, and membership revocation while a writer waits. Unsupported content/attributes/URLs return 400; byte/depth/node limits and the existing HTTP cap return 413 without changing state. Archived reads/history stay authorized; saves/restores return 409 until unarchived.

Review found title/change-note NUL and lone UTF-16 surrogate inputs could reach PostgreSQL. They now fail with 400 before SQL; create/update/restore regression cases passed. The content module also stops aggregate scalar byte growth before serialization for direct core callers. P1's lock-observation queries now scope their fixture relation, preserving exact race assertions while P2 tests run in parallel. Its OpenAPI inventory now lists implemented P2 routes without admitting future routes. No P0/P1 assertion was removed or weakened.

### Migration and API instructions

Use the existing Node 24/npm/PostgreSQL setup and ignored configuration from [README.md](README.md#local-development). Upgrade from an already migrated P1 database with:

```sh
npm ci
npm run db:migrate
npm run check
npm run test:db
npm run openapi:export
```

`db:migrate` applies `20260930010000_documents_revisions` after the unchanged P1 migration. It adds Document and DocumentRevision, indexes, positive versions, restricted content-format/schema-version checks, paired archive fields, auth/space/revision references, and the deferred same-document head foreign key. It does not transform or delete existing P1 data. Prisma owns the one migration history; no schema push/reset or alternate engine is used. Regeneration restores the ignored client, not schema state.

The create envelope is `{title, content, changeNote?}`; PATCH accepts title/content changes only, with an optional note. Read the current document ETag and send that single strong tag as `If-Match` for PATCH/restore/archive/unarchive. A canonical no-op save returns unchanged state; a note alone is not a save, and a note on a no-op is ignored. Restore always appends an immutable attributed snapshot. Archive/unarchive advances only lifecycle lock versions; a repeated current state is a no-op after checking its precondition. See [API contracts](docs/api-design.md) and [exact content/lifecycle limits](docs/core-schema.md#native-blocknote-content-and-lifecycle-policy).

### Remaining limits and cleanup

No local P2 blocker remains. Hosted CI, production TLS/proxy operation, workload/scalability, backup/restore and release/source delivery remain unverified. The P1 limits on concurrent in-flight sign-in during recovery and process-restart rate-limit durability remain. Revisions are immutable through product operations; a trusted database operator is not constrained by a product API sandbox. Space-wide mutation serialization is the documented demo policy, not a throughput claim.

Task-created schemas and injected trigger/function/sequence objects were removed. The task-owned PostgreSQL container/network/volume and generated build/OpenAPI output were removed after verification. Installed project dependencies, ignored generated Prisma client, and existing ignored local configuration remain for development. No persistent demo account or content was left in a development database.

Stop at P2 for review. P3, the API demo and native export, begins only when assigned. No UI, publishing, uploads, search, nesting, autosave, collaboration, or generic extension framework was implemented.

## P1 baseline, historical results

P1 is complete locally. Node.js `v24.20.0`, npm `10.9.9`, and real PostgreSQL `17.11` were used. No hosted CI or deployment ran. The historical P0 results are retained below.

### Dependency proof and pins

| Added direct dependency | Exact pin | License |
| --- | --- | --- |
| better-auth | 1.7.6 | MIT |
| @prisma/client | 7.10.0 | Apache-2.0 |
| @prisma/adapter-pg | 7.10.0 | Apache-2.0 |
| prisma, development CLI | 7.10.0 | Apache-2.0 |

All seven P0 direct pins and all pre-existing P0 transitive versions remain unchanged, verified against the baseline lockfile. Better Auth 1.7.6 declares Prisma/client 7 peer compatibility. Its [Prisma guide](https://better-auth.com/docs/adapters/prisma) specifies Prisma 7 with PostgreSQL and a driver adapter; its [Fastify guide](https://better-auth.com/docs/integrations/fastify) documents the Fetch handler bridge and session API. The implementation was verified against the installed 1.7.6 source/types and real sessions, not inferred from examples alone. Prisma's [v7 guide](https://www.prisma.io/docs/guides/upgrade-prisma-orm/v7) matches the generated TypeScript client and driver-adapter configuration used here.

Auth model generation ran with `npx --yes auth@1.7.6 generate --config artifacts/auth-config.ts --output artifacts/auth-schema.prisma --yes`. That temporary configuration instantiated the same auth factory. The reviewed layout was merged into the checked-in Prisma schema; Prisma alone generated/applied the SQL migration. Generated clients and generator scratch files are ignored and were not committed.

The initial Prisma installation reported four high advisory entries, originating from deepmerge-ts and mysql2. Scoped overrides pin `@prisma/config -> deepmerge-ts@8.0.2` and `prisma -> mysql2@3.24.5`. The former addresses [GHSA-ggr8-5vv4-36mx](https://github.com/advisories/GHSA-ggr8-5vv4-36mx); mysql2's patched release avoids the reported [authentication downgrade](https://github.com/advisories/GHSA-3f6p-5ww8-9rcr) and [compressed protocol](https://github.com/advisories/GHSA-rgwj-5xj2-c3m3) advisories. These overrides apply only to the newly added dependency graph. Clean install, Prisma config loading/generation/migration, typecheck, and real PostgreSQL auth operations passed with them. `npm audit` now reports zero advisories. Recheck the overrides when upgrading Prisma rather than silently adopting a different major.

Reviewed license metadata for all 254 resolved dependency entries, including optional platform packages: 194 MIT, 23 Apache-2.0, 26 ISC, 1 MIT and ISC, 6 BSD-3-Clause, 1 BSD-2-Clause, 1 EPL-2.0, and 2 Unlicense. No missing license metadata. The EPL-2.0 entry is `elkjs@0.11.1`, reached through Prisma CLI's Studio dependency; it is not imported by the Scrawl backend. Its [license/source notices](https://github.com/kieler/elkjs/blob/master/LICENSE.md) were inspected and remain in the installed package. Distribution packaging and preservation of third-party notices/source remain a P9 gate, not a completed release-license review. The original AGPL LICENSE is unchanged.

### Observed checks

| Command/check | Result |
| --- | --- |
| `npm ci` | Exit 0; frozen install and automatic Prisma client generation passed |
| `npm run db:generate` | Exit 0; Prisma 7.10.0 generated the ignored client |
| `COMPOSE_PROJECT_NAME=scrawl-p1 docker compose up -d --wait postgres` | Exit 0; task-owned PostgreSQL 17 healthy, loopback only |
| `npm run db:migrate` | Exit 0; first migration applied to an empty development database |
| Isolated-schema `prisma migrate deploy`, then repeated deploy | Exit 0 both times in the integration fixture; empty migration and safe reapplication proved |
| `npm run check` | Exit 0; import boundaries, full typecheck, all 30 unit/config/HTTP/CLI tests, and build passed; original 25 P0 tests retained |
| `NODE_ENV=test npm run test:db` | Exit 0; 21 reported tests pass, including 19 P1 scenarios and P0 real readiness; 0 skipped |
| `DATABASE_URL=postgresql://unused@127.0.0.1:1/unused NODE_ENV=test npm run test:db` | Exit 1 as expected; both required database tests failed visibly, 0 skipped |
| `npm run openapi:export` | Exit 0; offline export and live HTTP spec contain only six implemented paths/eight product+system operations |
| `npm audit` and `npm ls --depth=0` | Exit 0; zero advisories and exact direct pins installed |
| Real terminal operator probes | Bootstrap/provision/recover exited 0; repeat bootstrap exited 1; all password echoes absent; temporary schema removed |
| Compiled `node --env-file-if-exists=.env dist/server.js` probe | Loopback readiness 200, anonymous me/spaces 401, correct live OpenAPI, SIGTERM exit 0 |

The terminal probes ran `node --import tsx scripts/operator.ts` in a Python PTY against an isolated migrated schema, sending passwords only after hidden prompts. No passwords appeared in tool output or command arguments. CI tests the operator core with real auth records/sessions and checks argument/nonterminal rejection; interactive PTY verification was local.

### Acceptance evidence and defects fixed

The PostgreSQL suite uses actual HTTP sockets, isolated cookie jars, and random synthetic credentials. It verifies concurrent bootstrap (one owner), refusal to seize any populated instance including one without an administrator, member-only provisioning, duplicate/invalid provisioning, injected credential-insert rollback, closed registration, HttpOnly and production Secure cookies, safe DTOs, anonymous denial, administrator-only creation/membership, hidden-space discovery, bounded filtered pagination, self-promotion denial, direct core policy enforcement, real logout, immediate membership revocation, recovery invalidating both existing sessions and the old password, and session revalidation after waiting for a space lock.

Membership race tests hold the real PostgreSQL space row lock and observe both HTTP transactions waiting in `pg_stat_activity` before releasing it. With one initial ETag, exactly one succeeds and one returns 412; the persisted role matches the winner. The revoked-session wait test shows no membership/version change after account recovery invalidates the waiting writer.

Origin/CSRF protection is explicit in every environment. Better Auth 1.7.6 otherwise relaxes origin checking under `NODE_ENV=test`; Scrawl sets both disable switches to false. Tests pass under CI's test environment. Product writes require the configured Origin, and auth rate limits use the unproxied peer address, rejecting forwarding-header spoof attempts. Real auth logging probes exclude passwords, cookies, query/submitted content, and secret-bearing callback URLs.

Initial integration failures exposed nullable session JSON serialization and plain-text library 429 responses being parsed as JSON. Both were corrected; rate limits now return 429 and the native Retry-After header. A Fastify reply status typing mismatch was also corrected without casts or suppression. No P0 checks were weakened.

### Migration and operator instructions

Use Node 24 and the checked-in npm lockfile. Configure DATABASE_URL and a fresh AUTH_SECRET in ignored `.env`; APP_ORIGIN defaults to loopback for development and must be explicit HTTPS in production. See [README setup](README.md#local-development), which generates the secret into the file without displaying it.

```sh
npm ci
npm run db:migrate
npm run operator -- bootstrap --email owner@example.test --name "Local Owner"
npm run dev
```

`npm run db:migrate` runs Prisma `migrate deploy`, applying `20260930000000_identity_spaces`. It adds auth-owned user/session/account/verification tables, Space and SpaceMembership, text auth foreign keys, UUID space IDs, UTC timestamps, uniqueness/indexes, role/name/positive-version checks, and restrictive core user references. There is no schema push/reset or separate Better Auth migration engine. No document, revision, publication, or attachment tables exist. Existing P0 had no domain schema/data to transform.

Provision members with `npm run operator -- provision --email user@example.test --name "Local User"`; recover with `npm run operator -- recover --email user@example.test`. Passwords are hidden terminal input with confirmation, not flags/environment variables. Recovery uses supported request/reset APIs and session revocation inside the same Prisma transaction. Bootstrap refuses any existing user; provision/recover require an administrator record. Account commands share an advisory transaction lock. They run only on the trusted host and are not exposed as HTTP endpoints.

The HTTP surface mounts three library session endpoints only. JSON omits raw session credentials and uses generic auth error messages while retaining native error codes. Prisma remains behind core operations and explicit HTTP DTOs. Membership changes lock the space, recheck current session/role, validate one strong space ETag, and commit membership/version changes atomically. Every successful grant/change/revoke increments the space lock version, including idempotent repetitions.

### Remaining limits and cleanup

No local P1 blocker remains. Hosted CI has not run. Tests cover production cookie configuration, not a production TLS/proxy deployment. Concurrent in-flight sign-in during account recovery, process-restart rate-limit durability, network source/license delivery, and release packaging have not been verified. No UI, SSO, API keys, documents, publishing, or backup/restore was implemented or claimed.

Integration/terminal schemas were removed, and task-created PostgreSQL container/network/volume and generated build/OpenAPI/generator scratch files were removed after verification. Installed project dependencies, ignored generated Prisma client, and the ignored local `.env` remain for development. The local secret was generated without displaying it. No default owner or password was left in a development database.

Stop at P1 for review. Next bounded packet is P2, content schema/documents/revisions, only when assigned. No push, hosted integration, or deployment occurred.

## P0 baseline, historical results

Recorded 2026-09-29. Scrawl's supplied foundation is verified locally. Product packets P1 onward remain proposals; this is not a release approval.

### Environment and dependency pins

Node.js `v24.20.0`, npm `10.9.9`, Docker Engine `29.8.1`, Docker Compose `5.5.1`, and PostgreSQL `17.11` from `postgres:17` were available and used.

| Direct dependency | Exact version | License |
| --- | --- | --- |
| fastify | 5.12.5 | MIT |
| @fastify/swagger | 9.9.0 | MIT |
| pg | 8.23.0 | MIT |
| @types/node | 24.19.0 | MIT |
| @types/pg | 8.23.1 | MIT |
| tsx | 4.23.15 | MIT |
| typescript | 5.9.3 | Apache-2.0 |

Versions resolve within the scaffold's original major ranges. Exact pins and npm's v3 lockfile are included; all resolved artifacts use `registry.npmjs.org`. No ORM/auth/UI dependencies were added. Fastify's [support policy](https://fastify.dev/docs/v5.10.x/Reference/LTS/) covers maintained Node LTS lines; Swagger's [compatibility table](https://github.com/fastify/fastify-swagger#compatibility) pairs Swagger 9 with Fastify 5. This combination was tested here on Node 24.

Reviewed all 103 dependency entries, including optional platform packages, in the lockfile: 92 MIT, 5 BSD-3-Clause, 5 ISC, and 1 Apache-2.0. No missing/unknown license metadata was found. Direct packages include license files; TypeScript also includes `ThirdPartyNoticeText.txt`. These permissive license families fit the selected AGPL packaging direction; preserve their individual notices when distributing dependencies. `npm audit` reported zero known vulnerabilities at verification time.

### Commands and observed results

| Command/check | Observed result |
| --- | --- |
| `sha256sum -c SHA256SUMS` before edits | All supplied files matched the archive manifest |
| `npm install` | Exit 0; initial dependency resolution and lockfile created |
| `npm install --package-lock-only` after exact pins | Exit 0; lockfile synchronized |
| `npm ci` | Exit 0; clean frozen install from the reviewed lockfile |
| `cp .env.example .env` | Created ignored local example configuration |
| `COMPOSE_PROJECT_NAME=scrawl-p0 docker compose up -d --wait postgres` | Exit 0; isolated test database healthy, exposed only at `127.0.0.1:5432` |
| Initial `npm run check` | Exit 2 at typecheck; serializer and unknown-error defects found, then fixed |
| Final `npm run check` | Exit 0; typecheck, all 25 config/HTTP/logging tests, and build passed |
| `npm run test:db` | Exit 0; 1 real PostgreSQL integration test passed, 0 skipped |
| `DATABASE_URL=postgresql://unused@127.0.0.1:1/unused npm run test:db` | Exit 1 as expected; unreachable database yielded 503 rather than skipping the required test |
| `npm run openapi:export` | Exit 0; parsed export verified Scrawl API title, only `/health/live` and `/health/ready`, and the 503 problem schema |
| `npm audit` | Exit 0; zero known advisories |
| `npm ls --depth=0` | Exit 0; installed direct versions match exact pins |
| Compiled-server probe using `node --env-file-if-exists=.env dist/server.js` | Bound an ephemeral loopback port; actual HTTP liveness/readiness returned 200, live OpenAPI was correct, auth/document probes returned 404, and SIGTERM exited 0 |
| `npm run dev` with an ephemeral loopback port | Actual HTTP readiness returned 200; development process stopped after verification |
| CI YAML parsing and assertions | Passed; Node version file, PostgreSQL 17 service, and required database test step present |
| Relative Markdown file-link check | Passed across README, agent instructions, contributing/validation documents, and docs |
| Staged inventory/metadata review and `git diff --cached --check` | Passed; no private/generated files staged; package and lockfile identity/license/pins match |
| Official GNU license comparison | Downloaded `https://www.gnu.org/licenses/agpl-3.0.txt` into memory; byte-for-byte identical to included LICENSE |

The logging regression captures the actual logger in a child process. Request authorization/cookies, response cookies, query strings, submitted content, and error message/name markers were absent. Tests also cover non-Error throws and oversized bodies. No credentials, submitted body, or database error details were logged in these probes.

The compiled-server probe used the configured real database. Compose's loopback port mapping was inspected. Missing database infrastructure remains a visible failure in CI, whose mandatory steps are `npm ci`, `npm run check`, `npm run test:db`, and `npm run openapi:export`.

### Foundation fixes and housekeeping

- The request serializer now always returns a string URL, satisfying strict indexed-access checking without logging query strings.
- The error handler narrows unknown errors before accessing Fastify fields. Unexpected-error logging uses a fixed message rather than an arbitrary error name.
- Package/OpenAPI identity and current planning documents now name Scrawl, repository `scrawl`.
- The archive-only SHA256SUMS manifest was verified before edits and removed because its checksums would be stale after implementation. LICENSE itself is unchanged.
- Task-created PostgreSQL container, network, and empty test volume were removed after checks. Temporary probe logs and generated OpenAPI/build output were removed. Installed project dependencies and ignored local `.env` remain for development.

LICENSE SHA-256 remains `0d96a4ff68ad6d4b6f1f30f713b18d5184912ba8dd389f86aa7710db079abcb0`.

### Limits and next packet

No local P0 blocker remains. Hosted CI has not run; the workflow definition was parsed and its check commands passed locally. No remote repository, public source URL, deployment, hosted integration, or external write was created.

No schema or migration changes occurred. Prisma, real identity/access, documents/revisions, publishing, frontend flows, and backup/restore remain unimplemented and unverified. Network source/license delivery and a private security-reporting channel remain release requirements, with a checklist in [licensing notes](docs/license-recommendation.md).

Stop after P0 for review. The next bounded assignment is [P1: identity, Prisma and space access](docs/backlog.md#p1--real-identity-prisma-and-space-access).
