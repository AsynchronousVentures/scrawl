# Demo walkthrough

Demo A and the connected Demo B use the actual API, local authentication, and PostgreSQL. Demo C remains a later acceptance script. Use synthetic content only. See [VALIDATION.md](../VALIDATION.md) for observed results and limits.

## Run Demo A

Requires Node.js 24, npm, Docker Compose, and free loopback ports 5433 and 3100. Run from the repository root. This uses its own private `.env.demo` and disposable PostgreSQL database `scrawl_demo_a`, separate from ordinary `.env` development configuration.

```sh
npm ci
npm run demo:init
docker compose --env-file .env.demo -f compose.demo.yaml up -d --wait postgres
npm run demo:setup -- --database scrawl_demo_a
npm run demo:serve
```

Leave the server running. In a second terminal at the repository root:

```sh
npm run demo:a
npm run demo:a
cat artifacts/demo/export.json
cat artifacts/demo/result.json
```

Each successful run creates a fresh "Demo Handbook" space and "Release checklist" document through actual HTTP requests. It leaves three immutable revisions and revokes its editor membership at the end. Repeating the runner preserves earlier spaces/documents and the four provisioned accounts. `result.json` records the latest successful run's IDs and assertion count; `export.json` is its current revision's native snapshot. Both are ignored, owner-only local files. They are written after the walkthrough assertions pass.

The runner exits nonzero on assertion, transport, or parser failure. It never retries creates or saves. A failed run can leave partial synthetic data and live sessions until expiry or explicit reset; it does not silently clean up. Failures before artifact writing preserve the latest successful files. Existing authentication rate limits remain active, so rapid repeated sign-ins can fail. The tested Linux runner uses distinct loopback source addresses for actors rather than bypassing those limits.

## Fixtures and explicit reset

`demo:init` exclusively creates owner-only `.env.demo` with locally generated authentication and database secrets. It refuses to overwrite existing configuration. `demo:setup` applies the existing Prisma migration history and uses the existing host operator operations to bootstrap/provision:

| Identity | Instance role | Per-run access |
| --- | --- | --- |
| `administrator@example.test` | Administrator | Creates space and manages memberships |
| `editor@example.test` | Member | Editor, with two separate authenticated cookie jars |
| `reader@example.test` | Member | Reader |
| `outsider@example.test` | Member | No membership |

Passwords are generated locally into ignored, owner-only `artifacts/demo/credentials.json`. Commands print only fixture emails and IDs. Do not print or share this file, `.env.demo`, cookies, or session tokens. The runner keeps cookie jars in memory and signs out all five sessions after a successful run.

Setup refuses an existing credential file or populated instance. Reset requires explicit confirmation of the fixed disposable database name. Both commands refuse production, missing development/disposable markers, non-demo database names, remote hosts, URL options, mismatched database settings, or a demo connection pool below two connections. They consume `.env.demo`, never an arbitrary ambient `DATABASE_URL`, and verify the actual connected database/user. Concurrent fixture commands are refused. Reset also refuses unexpected public tables.

Stop `demo:serve` with Ctrl-C before resetting. Reset deletes synthetic document/access/authentication rows and the credential manifest, preserves the migration ledger and private configuration, and does not provision automatically:

```sh
npm run demo:reset -- --database scrawl_demo_a
npm run demo:setup -- --database scrawl_demo_a
npm run demo:serve
```

Then run `npm run demo:a` in the second terminal again. Reset without `--database scrawl_demo_a` fails without changing data. The next setup generates new account IDs and passwords. Existing successful export/result files are retained as local artifacts until another successful run.

To remove this disposable database, first stop the server and explicitly reset as above, then:

```sh
docker compose --env-file .env.demo -f compose.demo.yaml down -v
rm .env.demo
```

This removes only this Compose project's demo volume. Keep `.env.demo` if retaining the database volume, since it contains that database's generated credentials. Port changes must keep `PORT`/`APP_ORIGIN` and `DEMO_DB_PORT`/`DATABASE_URL` consistent in the private file.

## Demo A assertions

Revision 1 contains "Run tests before deploying." Revision 2 adds "Verify the backup." Restoring revision 1 creates revision 3 with the original content and leaves revisions 1 and 2 intact. The private marker used in Demo C below is not added by Demo A.

| Step | Action | Asserted evidence |
| --- | --- | --- |
| 1 | Explicitly migrate/provision a fresh disposable database; sign in each actor | Real sessions and identities; anonymous product access denied |
| 2 | Administrator creates space/grants membership | Outsider sees no space; reader cannot administer |
| 3 | Editor creates the checklist | One document and revision 1; server ETag |
| 4 | Two isolated editor clients read the same document | Matching representation and starting ETag |
| 5 | Client A saves revision 2; client B submits the old tag | Success then 412; exactly one new revision; rejected write leaves head/history unchanged |
| 6 | Submit a mutation without If-Match | 428; unchanged head/history |
| 7 | Reader attempts edit/restore/archive/unarchive | 404; unchanged head/history |
| 8 | Outsider guesses document/revision IDs and attempts a write | 404 without resource fields or ETag; anonymous requests 401; unchanged history |
| 9 | Editor restores revision 1 | Revision 3 has a new ID and original content; intervening history preserved |
| 10 | Reader exports native JSON; outsider and anonymous clients try export | Authorized snapshot matches selected content through the existing parser; denied exports; exact allowlisted keys and no secret/session values |
| 11 | Editor archives; administrator unarchives | Only lifecycle lock versions advance; current content/history retained; default list excludes archived document |
| 12 | Administrator revokes editor; both existing editor sessions request again | Read/write/history/export denied; original cookie unchanged and `/me` still works; history unchanged |
| 13 | Sign out all authenticated clients | Subsequent `/me` requests return 401 |

The mandatory PostgreSQL suite separately preserves P2's actual overlapping-save race and forced failure between revision insertion and head advance. The runner demonstrates stale clients in sequence; it does not replace those transaction tests. P3 tests run the executable twice, verify persisted counts, inject a failed save and prove a nonzero exit with exactly one attempt, reject unsafe resets, explicitly reset/reseed, and run again.

## Native export scope

`GET /api/v1/documents/{id}/export` returns the current authorized snapshot as an `application/json` attachment, including for an archived document. Readers, editors, and administrators with access can export. Outsiders receive 404 and anonymous callers 401. There is no revision selector or format query.

The envelope contains `format: "scrawl-document"`, `exportVersion: 1`, minimal document/revision provenance, and `content` with `format: "blocknote-json"`, `schemaVersion: 1`, `editorVersion: "0.55.0"`, and the native blocks array. Provenance includes document/space/revision IDs, revision number/title, timestamps, and creator/author IDs. It excludes profiles, emails, roles, memberships, credentials, session data, and authentication records. Content is validated by the native BlockNote parser in the core operation and revalidated/matched by the runner.

This is one current document snapshot, not complete revision history, bulk portability, import, or an instance backup. See [API contracts](api-design.md) for the exact field allowlists. The runner's export is revision 3, after restore, containing "Run tests before deploying.".

## Run Demo B

Use the same explicitly designated disposable database as Demo A. From a fresh checkout, install and build before starting any fixture command:

```sh
npm ci
npm run check
npm run demo:init
docker compose --env-file .env.demo -f compose.demo.yaml up -d --wait postgres
npm run demo:setup -- --database scrawl_demo_a
npm run demo:serve
```

In a second terminal, seed the connected interface through real authenticated HTTP requests:

```sh
npm run demo:b:seed -- --database scrawl_demo_a
cat artifacts/demo/b-result.json
```

Open `http://127.0.0.1:3100/`. The seed creates a fresh "Demo B handbook" space and a longer "Release checklist" with headings. Repetition adds a separate synthetic space/document without deleting earlier data. It grants editor and reader access, leaves the outsider without membership, and signs out its seed session. It never resets or retries writes. Initial setup is unnecessary when a valid existing fixture configuration and database are already provisioned. Reset remains the explicit stopped-server procedure above.

Open the owner-only `artifacts/demo/credentials.json` locally in your editor and enter the chosen fixture account's generated credentials in the login form. Do not print, commit, screenshot, or share that file. Use separate browser profiles for `editor@example.test`, `reader@example.test`, and `outsider@example.test` if comparing access side by side. The administrator account sees all spaces. Demo A creates additional separate spaces and revokes its own editor grants, so select "Demo B handbook" when following this UI walkthrough.

### Same-origin development

Stop `demo:serve` first, then run:

```sh
npm run demo:dev
```

Open `http://127.0.0.1:5173/`. This starts the API on the configured loopback port and Vite on 5173, proxies API/health/OpenAPI on the browser origin, and configures the API to accept exactly that development origin. `npm run demo:dev -- --port 5175` changes only the frontend port. Ctrl-C stops both processes. Fixture setup/reset/seed and Demo A continue to require the normal `demo:serve` origin, so stop the development server and start `demo:serve` for those commands. No permissive CORS or authentication bypass is used.

For a normal non-demo database, build with `npm run check`, migrate with `npm run db:migrate`, then run `npm start` with your existing private configuration. A missing frontend build leaves the backend-only workflows available; a present invalid build fails startup. Unknown API routes retain problem responses rather than becoming HTML.

### Retained P4 review workspace

The current private app is [Scrawl on Tailscale](https://agentvm.beardie-tone.ts.net:8447/). Its synthetic accounts/configuration and database on 5433 are already provisioned; do not repeat init/setup unless performing the explicit stopped-server reset. The approved static prototype remains on the separate 8446 route. This retained database uses the task-specific Compose project `scrawl-p4-demo`, so inspect/manage that project explicitly:

```sh
COMPOSE_PROJECT_NAME=scrawl-p4-demo docker compose --env-file .env.demo -f compose.demo.yaml ps
```

Use the same project prefix for `up`/`down` when managing this retained database. Fresh setups above use Compose's normal `scrawl-demo-a` project name. Do not start a second project on the occupied port or remove the private file while retaining its database volume.

### Private Tailscale preview

Build first. Stop the development or normal demo server, then use an existing private Tailscale node and an unused HTTPS Serve port:

```sh
npm run demo:serve -- --origin https://<node>.<tailnet>.ts.net:8447
```

In another terminal:

```sh
tailscale serve --bg --https=8447 http://127.0.0.1:3100
tailscale serve status
```

Open that exact HTTPS origin from a device on the tailnet. This explicit server-only override keeps the guarded local database configuration unchanged and enables Secure cookies. Do not enable Funnel. The prototype's existing separate preview can stay intact. Stop only this task's route with `tailscale serve --https=8447 off` when no longer needed. The built footer provides the AGPL license, third-party notices, and actual build source without exposing private environments or fixture credentials. A public deployment/source-delivery review is still outside P4.

### Connected workflows

1. Log in as editor, select the handbook, read the checklist, and follow an "On this page" heading link. Edit a heading and see the outline follow the actual content. On narrow screens use Navigation to open the space/document drawer; the outline collapses above the document.
2. Create a document with New document, edit its title/body, and press Save. Reload to verify persisted content. The Tiptap toolbar supports the existing text styles, bold, italic, inline code, lists, and links. Undo/Redo use editor history and remain available after Save; keyboard shortcuts are Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z. Title input uses native browser editing. Save stays disabled while unchanged or invalid. There is no autosave.
3. Open History, select an earlier revision, and restore it. Restore appends a new revision. Unsaved changes require explicit discard; Keep editing returns to the complete local draft.
4. Open Document actions to archive, unarchive, or Export JSON. Show archived includes archived documents in the list. Archive/unarchive preserves history and advances only the lifecycle lock version. Archived content is read-only.
5. Inspect the downloaded `scrawl-document-<id>.json` in a text editor, or run `cat /path/to/download.json`. It contains the current saved native snapshot and minimal provenance, not unsaved edits or authentication/session records. Export remains permission-checked and is not a full backup/import system.
6. Open the same document in two tabs. Edit both title and body in the second tab, save the first, then save the second. The 412 panel keeps the full local draft and displays the latest saved version separately. Use my changes deliberately adopts that version as the comparison base without writing; review and press Save yourself. Use server version requires confirmation before discarding a dirty draft. No stale write is retried automatically.
7. Navigate with a dirty draft and choose Keep editing. A reload/close uses the browser's unsaved-change warning. Temporary save failures retain an editable draft with failure feedback. Session expiry or lost access clears space/document navigation and server actions, retains dirty work read-only in the tab, and says that nothing was saved. Re-login as the draft's account rechecks access and requires reconciliation for an existing document. Copy the retained draft before closing if access remains unavailable.
8. Log in as reader: read, history, and authorized export are available; mutations are denied by the API as well as absent from the controls. Log in as outsider: no private titles, content, history, or versions appear. The live app has no search UI or simulated results; fixture search remains only in the approved disconnected prototype.

Private drafts live only in memory. No localStorage, IndexedDB, service worker, persisted query cache, or background refresh stores/replaces private content. Concurrent changes are discovered on explicit operations, not a collaboration channel.

BlockNote supplies the editing controls. Select text for the floating formatting toolbar, use `/` for the slash menu, and use the block handle for block actions. Standard checklists, nested/toggle blocks, tables, code, links and seven text styles retain native content through save, reload, history and export. Links use the supplied Create/Edit link form. Use Ctrl/Cmd+Z and the platform redo shortcut for native undo/redo, including after an explicit save. Unsafe or oversized local edits stay in the tab with Save disabled until corrected or discarded. Native toggle expansion booleans may be stored locally; private document titles/bodies are not persisted in browser storage.

Discard changes beside Save opens the same confirmation as dirty navigation. Keep editing preserves the complete draft. Confirming resets both title and body to this tab's baseline and clears local editor undo history, without an API write, new revision, or ETag change. A new document returns to "Untitled document" with an empty paragraph and remains uncreated until Save. After a 412, discard restores the old local baseline while retaining the latest-server comparison and conflict. Choose Use my changes or Use server version deliberately before another save; discard never silently adopts a newer ETag.

### Browser acceptance commands

The browser suite uses the ordinary `.env` PostgreSQL connection as a local database administrator, creates its own freshly migrated `scrawl_demo_a`, invokes the guarded fixture commands, and runs the real built server on a free loopback port. It refuses an existing `scrawl_demo_a` on that server and drops only its own database. It does not touch the separate retained demo database on port 5433. Run database and browser suites sequentially:

```sh
npm run check
PLAYWRIGHT_SKIP_BROWSER_GC=1 npx playwright install --with-deps chromium
NODE_ENV=test npm run test:db
npm run test:browser
```

The browser suite has no automatic retries. Authentication pacing follows the unchanged pinned library's rate limits. Failure screenshots, traces, and videos are disabled to avoid credential artifacts; the application clears its password field at submit. Manually captured review screenshots contain only synthetic document content. Browser tests cover real sessions, protected writes, persisted editor round trips, toolbar/link commands, undo/redo across saves, confirmed local discard, unsupported paste, history/restore, lifecycle/export, reader/outsider policy, two-tab reconciliation, dirty navigation, failed saves, session expiry, actual membership revocation, loading/error/empty states, keyboard operation, and the heading outline. They also execute Demo A against the same running API. P2 rollback/concurrency coverage remains in `test:db`.

Observed results and [current editor screenshots](../VALIDATION.md#actual-checks-and-review-evidence) are recorded in validation. P4 stops for review; publishing and real search remain unimplemented.

## Demo C — selective public publishing

Enable publishing explicitly. Administrator previews and publishes revision 2. Use a completely separate unauthenticated browser/cookie jar to read the public view. Internally save revision 3 containing the private marker and a different title; the public page must still show revision 2's title/body.

Try changing public URLs to access private revision IDs, parent metadata, history and unrelated pages. All must fail or omit that material. Ordinary editors/readers cannot publish. Unpublish and issue a new anonymous request: not found. Re-publish explicitly, archive, then unarchive: anonymous access stays denied until another explicit publish action.

Turn global publishing off: private documentation still works and public access stops. Re-enabling resumes still-active grants only; it does not undo per-document revocation/archive invalidation. Display source/license information for the actual running build before sharing this demo remotely.

## Later acceptance additions

P6: searching `INTERNAL-DEMO-NOTE-7391` as an outsider returns nothing; archived pages disappear; same-space hierarchy cycle tests pass.

P7: publish a revision containing image A, then privately add B. Public readers can retrieve only A through the active publication. After unpublish, new file requests fail. Images retained in history remain available to authorized internal readers.

P8/P9: export/import into another empty database with fresh IDs/private grants; back up and restore database plus file bytes into a blank instance; migrate from the previous schema. Record commands, artifact sizes/checksums, and outcomes without publishing credentials.
