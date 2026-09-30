# Validation

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

The create envelope is `{title, content, changeNote?}`; PATCH accepts title/content changes only, with an optional note. Read the current document ETag and send that single strong tag as `If-Match` for PATCH/restore/archive/unarchive. A canonical no-op save returns unchanged state; a note alone is not a save, and a note on a no-op is ignored. Restore always appends an immutable attributed snapshot. Archive/unarchive advances only lifecycle lock versions; a repeated current state is a no-op after checking its precondition. See [API contracts](docs/api-design.md) and [exact content/lifecycle limits](docs/core-schema.md#p2-content-and-lifecycle-policy).

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
