# Demo walkthrough

Scrawl's integrated demo uses actual authentication, the HTTP API, PostgreSQL 18, native BlockNote, private files and saved revisions. All seeded content is synthetic. [Validation](../VALIDATION.md) records observed checks and limits; [the integration backlog](integration-backlog.md) records review state. The integration branch is not merged or released.

## Use the running demo

Open [Scrawl's field guide](https://agentvm.beardie-tone.ts.net:10000/spaces/scrawl-field-guide/documents/start-here) from any browser. At the maintainer's explicit request, Tailscale Funnel now forwards public HTTPS 10000 to the existing loopback API on 3100. Private documents still require authentication and current grants. This is a synthetic development preview, not a production deployment.

Links now use stable readable names, for example [the Demo Handbook release checklist](https://agentvm.beardie-tone.ts.net:10000/spaces/demo-handbook/documents/release-checklist). Saving a renamed title keeps its existing link. Duplicate titles get readable numeric suffixes within their space; archived links remain reserved. Old `?space=UUID&document=UUID` bookmarks still work and become readable paths after authorized loading. UUIDs remain in the API, revision provenance and native exports.

Document navigation uses normal links: Ctrl/Cmd-click or the browser context menu can open another tab, leaving this tab's draft intact. Move between two documents, then try Back/Forward. Unsaved title/body changes require either Keep editing or deliberate discard; navigation never creates a revision. Leaving during a Save/upload is blocked until its request finishes. Saved documents opened through search also participate in browser history.

Private live-state storage uses migration eight, with existing content, history and versions preserved. The running preview documents remain in solo mode and its collaboration flag stays false. Experimental opt-in startup and the official live editor/comments UI are implemented and tested in a separate disposable browser fixture. Remaining activation checks are listed in ADR 0003 and validation. Save, discard, history, export and selected publishing retain their established solo behavior here.

In a saved editable document, use `/image` and the supplied Upload tab to attach a synthetic PNG. Permission loading no longer leaves the editor permanently without Upload. The image remains private and is included in history only after explicit Save. In the isolated shared-editing fixture, uploading without Save leaves saved JSON/PDF/DOCX unchanged. A later private checkpoint includes the image in that revision; historical exports and existing public approvals keep their selected attachment allowlists.

Retrieve credentials locally, without copying them into issues, screenshots or chat:

```sh
cd /home/dev/t3/projects/scrawl
less artifacts/demo18/artifacts/demo/credentials.json
```

The file is ignored and owner-only. Use `administrator@example.test` for all capabilities, `editor@example.test` for editing, `reader@example.test` for reading/history/export, and `outsider@example.test` to verify isolation. Each has its own generated password. Use separate browser profiles when comparing roles. The editor and reader belong to "Scrawl field guide"; Demo A's separate spaces deliberately revoke their editor grant at the end of each run.

An already approved synthetic revision is available at [the read-only handbook](https://agentvm.beardie-tone.ts.net:10000/publications/5cc554b9-c753-4de1-9502-0e1188323e9d), publicly without signing in. It includes only the approved revision and its scoped image.

The five useful documents are "Start here", "Your first week", "Service runbook", "Release checklist" and "Decisions and ownership". They include an uploaded private architecture image, nested/toggle content, checklists, rich formatting, code and tables. The release checklist is long enough to exercise scrolling and section navigation.

1. Open "Start here". Use the actual heading-derived "On this page" links, then inspect the private image. On a narrow screen, Navigation opens a drawer and the outline collapses above the document.
2. Create a document, edit its title and use `/` for BlockNote's supplied blocks. Select text for formatting/link UI, use the block handle for actions/nesting, and try a table, checklist and code block. Save explicitly with the button or Ctrl/Cmd+S and reload. The shortcut uses the same pending/conflict guards; it does not submit native comments or act inside dialogs. There is no autosave.
3. Use Ctrl/Cmd+Z and the platform redo shortcut, including after Save. Discard changes beside Save asks before resetting title/body to this tab's baseline, clears local undo and creates no revision. Keep editing cancels.
4. Save a new document before using BlockNote's Upload tab for an image/file. Uploaded bytes are private; Save records their reference. Removing a current block leaves older revisions' attachments readable to authorized users. Rejected uploads leave local work intact.
5. Open History, select an older revision and Restore. A new revision is appended. Use Document actions to archive/unarchive or export saved JSON/PDF/DOCX; history also exports a selected saved revision. Exports exclude unsaved changes. PDFs and DOCX contain visible titles and embedded authorized images.
6. Use the header Search control. Ctrl/Cmd+K opens search outside the editable editor; inside editable text, BlockNote keeps its native link shortcut. Arrow keys and Enter select a result. Search covers accessible current saved titles/bodies, excludes archives and unsaved edits, and respects the dirty-navigation confirmation.
7. Open one document in two tabs, edit both, and save the first. Saving the second returns 412, retains its complete draft and shows the latest saved version separately. Use my changes deliberately changes the comparison baseline but writes nothing; review and press Save. Use server version asks before discarding dirty work. Missing/stale preconditions are never automatically retried.
8. As administrator, choose Publish saved revision from Document actions, or select an older revision in History and use Publish revision. Confirm the explicit saved revision and its public scope. Private drafts and later saves remain private. View the approved page without signing in, then withdraw it. Archive invalidates the approval; unarchive requires a new deliberate approval. Approved pages are now internet-accessible through the explicitly authorized Funnel preview.
9. Log in as reader and outsider. Readers can read, inspect history and export but cannot mutate. Outsiders receive no private titles/content/history/versions. Temporary save failure retains editable unsaved work; expiry/lost access clears unrelated navigation and server actions, retaining the draft read-only in the tab. Re-login as the draft's account rechecks access and requires deliberate reconciliation. Nothing is reported as saved after a failed write.

10. As administrator, choose New space beside the space selector, or from Navigation on mobile. Create a named private space. An open document stays selected with its unsaved work intact; select the new space deliberately when ready. An empty installation enters its first space automatically. New spaces are administrator-only until you grant access. Readers and outsiders cannot create spaces.

11. As administrator, choose Space access in the current space. Enter an existing provisioned account email and grant Reader or Editor. Change a listed role and press Apply. Remove asks for confirmation; Keep access cancels. Existing sessions lose access after removal. Administrators retain implicit access to every space. A stale or unconfirmed request retains your requested change and requires Reload access before another deliberate submission. Opening the dialog or changing grants does not save, discard or reset the document's local edits or undo history. Account provisioning stays in the operator CLI.

Private draft title/body live only in memory. Closing/reloading can discard them after the browser warning. There is no persistent content cache, IndexedDB or service worker. Native toggle expansion booleans may use localStorage; document content does not. Collaboration/comments are not enabled.

## Exercise experimental shared documents locally

Do not enroll retained preview documents while activation work is incomplete. The owned browser harness initializes, migrates and enables collaboration only in its guarded disposable target, uses genuine cookie sessions, then removes that target:

```sh
npm run check
npm run test:db
npm run test:browser -- test/browser/live.spec.ts
```

Run database and browser suites sequentially; Demo A and the browser harness reserve the same explicit disposable database name. Normal application configuration uses `COLLABORATION_ENABLED=false`. Setting it true requires one owner process per database/schema and `DB_POOL_MAX >= 2`; it does not enroll documents automatically. Authenticated `/api/v1/collaboration` reports actual availability. If the runtime is disabled after a document was enrolled, its saved revision remains readable with an explicit read-only notice. Live changes/comments stay stored, and solo Save/Restore are unavailable. Re-enabling and opening a fresh authorized tab loads that retained live state; use explicit Save to checkpoint it. Disabling is not a conversion or reset.

In an explicitly enabled local synthetic workspace, open a clean saved document and choose Document actions, Enable shared editing. Open it in another tab. The supplied editor synchronizes authorized title/body changes, while Save creates immutable history. "Syncing" and "Shared changes" are not successful checkpoints. Undo/Redo affect this tab's changes and retain peer contributions; a whole-document baseline discard is unavailable in shared mode.

A stale checkpoint retains the complete shared document and shows the latest saved checkpoint separately. Use current shared content deliberately changes the comparison baseline, then explicitly Save. It never replaces peers' content. Restore is available only for a clean checkpoint and starts a new epoch; other old connections close.

Operator recovery invalidates every session for the recovered account, including other open tabs. Pending comment text stays read-only in its original tab. Sign in with the recovered account credentials, then review before reconnecting; Keep editing cancels a discard. Recovery is tested only against owned synthetic accounts, leaving preview credentials unchanged.

The disposable acceptance harness verifies both graceful and abrupt process restart. Acknowledged live content/comments survive without becoming revisions; fresh authenticated tabs recover them, while old closed tabs retain local work read-only. Do not terminate the retained preview to reproduce the test.

Use the supplied Add reaction picker and reaction badges in Comments. Failed add/remove actions show an error and leave accepted reactions unchanged; retry deliberately. Pending requests must finish before leaving. Emoji recents contain only IDs/counts, never private document or comment text.

Nested lists use the supplied slash menu and Tab indentation. Undo my changes and keyboard undo retain another account's nested contribution, including the empty parent structure required around it. Redo restores local text without removing the peer's contribution; explicit Save checkpoints the complete native hierarchy.

Select text and use the supplied Add comment control. The native composer, private thread list and server commands share the authorized document session. Readers can inspect threads, including focusing them, while reply composers remain read-only. Failed mouse/keyboard submissions retain pending text and report failure. Unsent comment text participates in Back/Forward, application navigation and reload warnings. Keep editing retains it. Use the comment Save control to submit that composer; document Save does not submit comments. While submission is pending, its composer becomes read-only and leaving must wait for the response. Private comments never enter immutable content snapshots, indexed search, native export or public publishing. Open Comments to use the supplied thread sidebar. Focus a thread to reply; keyboard-accessible More actions provides own-comment Edit/Delete, and Resolve/Re-open keeps the conversation separate from document history. Failed replies/edits retain their complete text, failed delete/resolve leaves the thread unchanged, and deliberate retry is required. Closing the thread list is unavailable while a composer is dirty or submitting. If a session expires while only a comment is unsent, sign-in appears and the complete composer remains read-only. Sign in with the same account to verify access, then review before reconnecting. Keep editing cancels a discard. A reader downgrade locks the composer without clearing it; a later grant never submits the draft automatically. After revocation, copying retained text is a local action and server commands remain unavailable.

When a connection closes, the complete current title/body remains read-only in the tab. Reconnect and compare creates a fresh authenticated document without replaying rejected updates. The former complete draft remains separately visible and can be downloaded as native draft JSON. It participates in navigation warnings and cannot be overwritten by another reconnect or restore until deliberately discarded. Keep editing cancels discard. Neither documents nor drafts are cached in browser storage. In an explicitly enabled workspace, select text in one authenticated tab to show the supplied cursor name and selection in another editor or reader tab. Names come from the server session; outsiders cannot join, and revoked participants disappear. Cursor movement creates no revisions. The retained preview still keeps the entire collaboration capability disabled. Default native/PDF/DOCX export and search use the saved checkpoint, even while another tab shows accepted live changes. History exports and a publication stay on the explicitly selected immutable revision. Private comments remain excluded. The browser isolation case verifies this without saving the live changes; accepted synchronization does not advance saved or public history.

Actual disposable-fixture screenshots: [native participant cursor and selection](https://uwvqig7mu5.ufs.sh/f/tJOw1mn9psOEmiwe0bAREQYrCeu0NMabGJf9dWzUS21xZKvn), [desktop comments](https://uwvqig7mu5.ufs.sh/f/tJOw1mn9psOEtIU246n9psOEgi62D1HuWBIdXRlvM5wjaer0), [mobile comments](https://uwvqig7mu5.ufs.sh/f/tJOw1mn9psOEKmv2BNC3Bjv1YwCrM4JkcGPpy6E8TQIxhfOK). These show the running application in its authorized acceptance fixture, not an enabled collaboration feature in the retained preview.

## Restart the current demo

The demo uses a persistent user service, separate from the agent process:

```sh
systemctl --user restart scrawl-integration-demo.service
systemctl --user show scrawl-integration-demo.service --property=ActiveState,SubState,MainPID
curl --fail --silent http://127.0.0.1:3100/health/ready
```

If the transient unit is no longer loaded after a machine restart, recreate it:

```sh
systemd-run --user --unit=scrawl-integration-demo \
  --description='Scrawl integration demo' \
  --property=WorkingDirectory=/home/dev/t3/projects/scrawl/artifacts/demo18 \
  --property=Restart=on-failure --property=RestartSec=3 \
  --property=StandardOutput=append:/home/dev/t3/projects/scrawl/artifacts/demo18/server.log \
  --property=StandardError=append:/home/dev/t3/projects/scrawl/artifacts/demo18/server.log \
  /home/dev/.nvm/versions/node/v24.20.0/bin/node \
  --import /home/dev/t3/projects/scrawl/node_modules/tsx/dist/loader.mjs \
  /home/dev/t3/projects/scrawl/scripts/demo-server.ts \
  --origin https://agentvm.beardie-tone.ts.net:10000
```

The existing service has a runtime drop-in selecting that exact HTTPS origin. Tailscale retains its background route separately. To restore only Scrawl's authorized public route if needed:

```sh
sudo -n tailscale funnel --https=10000 --bg --yes http://127.0.0.1:3100
tailscale funnel status
```

Do not use `tailscale serve reset` or `tailscale funnel reset`: those affect other services. The T3 Code connection on private HTTPS 443 remains unchanged. Old static preview paths and dead preview proxies were removed; the obsolete Scrawl prototype server was stopped. Their files and all retained database volumes remain intact. The old Scrawl 8447 route is no longer available.

Inspect/start only the current PostgreSQL 18 project while preserving its data:

```sh
cd /home/dev/t3/projects/scrawl
docker compose --env-file artifacts/demo18/.env.demo -f compose.demo.yaml ps
docker compose --env-file artifacts/demo18/.env.demo -f compose.demo.yaml up -d --wait postgres
```

The project is `scrawl-demo-a18`, volume `scrawl-demo-a18_demo_postgres18_data`, port 5434, official image mount `/var/lib/postgresql`. Private uploads live under `artifacts/demo18/var/private-attachments`; preserve them with this database. The original 17 project `scrawl-p4-demo`, port 5433 and volume `scrawl-p4-demo_demo_postgres_data` remain untouched. Manage that old database only with its unchanged root `.env.demo`, original project and `compose.demo.postgres17.yaml`. Never use the current fixture reset on retained data or mount a 17 volume into the 18 image.

Publishing defaults off in normal configuration. It is explicitly `true` only in this synthetic demo's owner-only `.env.demo`. Global disabling pauses otherwise valid grants; unpublish/archive revoke approval. Re-enabling does not revive an approval invalidated by archive.

## Verify the actual running demo

This opt-in authored acceptance runner uses fresh browser sessions against the actual persistent origin. It reads private credentials safely, checks native blocks/private image/search/history/export/mobile/reader/outsider and Back/Forward navigation, logs no passwords/cookies, and creates no document revisions or reset:

```sh
cd /home/dev/t3/projects/scrawl/artifacts/demo18
node --import /home/dev/t3/projects/scrawl/node_modules/tsx/dist/loader.mjs \
  /home/dev/t3/projects/scrawl/scripts/demo-verify.ts \
  --origin https://agentvm.beardie-tone.ts.net:10000
```

It expects the original synthetic field-guide titles/content. It exits nonzero on an assertion failure. Screenshots are ignored under `artifacts/demo18/artifacts/running-evidence`, taken only after credentials are absent from the page. Full mutation/conflict/permission/publication tests use their own disposable database, as described in validation.

## Run Demo B

Do not repeat init/setup/reset on the running demo. For a new local fixture workspace, use a new private working directory and free configured ports. These example commands use `artifacts/demo18` and assume it does not already exist:

```sh
cd /home/dev/t3/projects/scrawl
npm ci
npm run check
mkdir -m 700 artifacts/demo18
cd artifacts/demo18
node --import /home/dev/t3/projects/scrawl/node_modules/tsx/dist/loader.mjs \
  /home/dev/t3/projects/scrawl/scripts/demo-fixtures.ts init
docker compose --env-file .env.demo -f /home/dev/t3/projects/scrawl/compose.demo.yaml up -d --wait postgres
node --import /home/dev/t3/projects/scrawl/node_modules/tsx/dist/loader.mjs \
  /home/dev/t3/projects/scrawl/scripts/demo-fixtures.ts setup --database scrawl_demo_a
node --import /home/dev/t3/projects/scrawl/node_modules/tsx/dist/loader.mjs \
  /home/dev/t3/projects/scrawl/scripts/demo-server.ts
```

In another terminal with that same private working directory, seed through the actual local HTTP API:

```sh
cd /home/dev/t3/projects/scrawl/artifacts/demo18
node --import /home/dev/t3/projects/scrawl/node_modules/tsx/dist/loader.mjs \
  /home/dev/t3/projects/scrawl/scripts/demo-workspace.ts --database scrawl_demo_a
```

Open `http://127.0.0.1:3100/`. Repeat seed verifies its owner-only manifest and existing documents, then changes nothing. It refuses an existing named space without a matching manifest and never retries creates or resets implicitly. Initialization refuses an existing private config, and setup refuses existing credentials/populated users. If using another working directory/project or port, keep database/API settings consistent and choose a separate Compose project explicitly.

For same-origin Vite development, stop the normal server and run the absolute `scripts/demo-dev.ts` from the fixture directory. It starts API and Vite together, proxies the browser's exact origin/cookies, and shuts both down with Ctrl-C. No wildcard CORS or authentication bypass is introduced. `--port 5175` selects a frontend port. Fixture/Demo A tools require the normal local API origin, so stop Vite and start normal `demo-server.ts` for them. HTTPS previews require the exact authorized origin with the explicit server-only `--origin` override. Public Funnel access is authorized only for this synthetic Scrawl instance.

## Run Demo A

Use the normal local-origin server from the disposable fixture directory, not the HTTPS-origin service. Running Demo A locally also requires turning off only Scrawl's public route first, so a local-origin server is not exposed through a mismatched public origin:

```sh
sudo -n tailscale funnel --https=10000 off
systemctl --user stop scrawl-integration-demo.service
```

Start the same `demo-server.ts` without `--origin` in one terminal, and run the following in another. Stop that local server, restart the user service, verify readiness, and restore only the Scrawl Funnel route afterward using the commands above:

```sh
cd /home/dev/t3/projects/scrawl/artifacts/demo18
node --import /home/dev/t3/projects/scrawl/node_modules/tsx/dist/loader.mjs \
  /home/dev/t3/projects/scrawl/scripts/demo-a.ts
node --import /home/dev/t3/projects/scrawl/node_modules/tsx/dist/loader.mjs \
  /home/dev/t3/projects/scrawl/scripts/demo-a.ts
```

Each successful run creates a separate synthetic "Demo Handbook" space with a checklist and three immutable revisions. It asserts real sessions, missing-precondition 428, stale-write 412, unchanged rejected history, reader/outsider denial, restore append, archive/unarchive, native export and revocation of two existing editor sessions. It signs out all five session jars after success. Repeating preserves earlier spaces/documents/accounts. It never retries creates or failed saves, and fails nonzero. The complete PostgreSQL suite separately proves the actual overlapping-write race and mid-write rollback.

Inspect the latest owner-only export/result locally:

```sh
cd /home/dev/t3/projects/scrawl/artifacts/demo18
node --input-type=module -e 'import {readFile} from "node:fs/promises"; const x=JSON.parse(await readFile("artifacts/demo/export.json","utf8")); console.log(JSON.stringify({format:x.format,exportVersion:x.exportVersion,document:x.document,revision:x.revision,content:x.content},null,2))'
```

Native export contains `scrawl-document`, export version 1, minimal document/revision provenance, and `blocknote-json`, schema version 1, editor version 0.55.0, with native blocks. No credentials, profiles, memberships or session records are included. This is a current single-document snapshot, not history backup/import. PDF/DOCX endpoints export the current saved snapshot or explicit selected revision and preserve authorization; external images or unsupported colors return explicit errors rather than fetch/flatten them.

## Explicit fixture reset

Only the designated development `scrawl_demo_a` with a matching disposable marker may be reset. Stop its server first and inspect the target. Reset consumes the owner-only `.env.demo`, never arbitrary ambient `DATABASE_URL`, checks the actual connected database/user, refuses production/remote/mismatched targets and unexpected public tables, and requires the exact confirmation:

```sh
cd /home/dev/t3/projects/scrawl/artifacts/demo18
node --import /home/dev/t3/projects/scrawl/node_modules/tsx/dist/loader.mjs \
  /home/dev/t3/projects/scrawl/scripts/demo-fixtures.ts reset --database scrawl_demo_a
node --import /home/dev/t3/projects/scrawl/node_modules/tsx/dist/loader.mjs \
  /home/dev/t3/projects/scrawl/scripts/demo-fixtures.ts setup --database scrawl_demo_a
```

Reset removes synthetic rows and the credential/workspace/result/export manifests, preserves migrations/private config, and provisions nothing automatically. The next explicit setup creates new account IDs/passwords. It does not wipe private byte storage; inaccessible orphan files require later explicit inspection/cleanup. Never run this procedure on retained real content or an unrelated database. Avoid `down -v` on retained projects.

## Resume implementation

Read status, validation, the integration issues and accepted ADRs. Continue on `integration/blocknote-demo` and keep draft PR #6 unmerged. The next substantial work is isolated durable collaboration/comments under [ADR 0003](adr/0003-collaboration-checkpoints.md), with real storage/permission/reconnect/undo gates before enabling it. No paid AI calls, new provider accounts or generic extension framework are needed. Keep the existing demo runnable and preserve its history/private files.

The optional runtime and supplied client are integrated and browser tested, with the current results in validation. The retained preview keeps collaboration disabled and its documents remain solo. Continue the solo walkthrough there; experimental enabled-fixture behavior does not claim that this preview supports multiplayer editing. Finish the remaining activation gates before enabling or enrolling retained synthetic documents.

The retained preview frontend includes the native upload permission-loading fix; the backend remains on native-presence feature checkpoint `1bc5e15` and needs no restart for this frontend change. Fresh administrator, reader, outsider and anonymous publication/image browser sessions passed through the existing Funnel. Current screenshots are in `artifacts/demo18/artifacts/running-evidence/`; full-row fingerprints of all eight retained content/grant/attachment/publication tables match exactly. No revisions, reset, credential rotation or live enrollment occurred. Restart remains `systemctl --user restart scrawl-integration-demo.service`. Complete checks pass 91 cases; the unchanged backend previously passed 137 database cases. The latest full browser run passed 71/71 in 9.5 minutes, zero retries/skips, after switching to full Chromium headless mode and targeting native keyboard selection to the editor. Six slowed workflows passed and both old-shell tab controls failed. Both complete PostgreSQL 18 hosted pipelines passed on `072d9bd`, and new SQL-gated transport draining passes the full 138-case database suite. Later ordinary startup comment selection still failed 1/5 and passive tracing failed 2/10 before shutdown. Resume with that native selection boundary before enabling retained collaboration; do not treat instrumented passes as a fix. Use `NODE_ENV=test npm run test:browser -- --grep "abrupt process death|document links support|restart preserves"` for the recovery/navigation gate; preserve its assertions and recorded logs in VALIDATION.md. Browser installation remains `npx playwright install --with-deps chromium`; do not install only the headless shell.

Administrator space creation is available in the running frontend. The retained-preview verification checks the actual dialog and keyboard cancellation without creating spaces or revisions. Fresh administrator/reader/outsider and anonymous publication/image checks passed, with all eight retained content/grant/file/live table fingerprints unchanged. [Running New space dialog](https://uwvqig7mu5.ufs.sh/f/tJOw1mn9psOEyFjQQxPDKlsjPL1ewa6qphHC0vSn8i5IZB7y). No backend restart or migration is needed for this frontend addition.

Space-creation validation passes six real workflows, including keyboard focus after a deliberately held first-space read. Complete checks pass 91 cases. The preceding full browser run passed 76/77, with the native nested-list peer insertion failing before undo assertions; the cause is unresolved and retained collaboration remains off. Run `NODE_ENV=test npm run test:browser -- --grep 'space creation|genuinely empty workspace'` for the new flow. See VALIDATION.md for the exact distinction between focused and complete results.

The complete PostgreSQL 18 regression passed 138/138 with zero skips after the focus correction, retaining migrations, transactional/concurrency guards, sessions and Demo A. No migration command is required for space creation.

## Connected space access checkpoint

The existing PostgreSQL 18 preview service now serves the connected dialog. Restart with `systemctl --user restart scrawl-integration-demo.service`; no migration is required. Focused verification: `NODE_ENV=test npm run test:browser -- --grep 'space access|space creation is absent'` (seven passed). Run the retained read-only verifier from `artifacts/demo18` using `node --import ../../node_modules/tsx/dist/loader.mjs ../../scripts/demo-verify.ts --origin https://agentvm.beardie-tone.ts.net:10000`. Its latest run verified administrator and reader workflows, then failed during outsider login; a complete preview pass is unverified. No retained document, history, grant or attachment bytes changed. The complete local browser regression passed 83/83, zero retries/skips. Focused native reliability repetitions passed 12/12, but a later exact-flow probe reproduced shutdown exit 1 once in ten trials. Ten further restart repetitions passed with fixed phase diagnostics and no failure phase; cause remains unproven; see VALIDATION.md before enabling collaboration.

The fresh all-role retained verifier subsequently passed, including anonymous publication/image access (`verification-space-access-rate-aware.log`). Rapid repeated logins can receive the library's real 429 limit. Wait for its window and run verification deliberately; do not disable limits or automatically retry authentication. The verifier now reports the authentication HTTP status without exposing credentials. Eight retained content-table fingerprints remain unchanged.

## HTTP drain and keyboard save checkpoint

The existing retained preview was restarted with the accepted-request-aware HTTP drain fix. Its current page, JavaScript/CSS assets and readiness endpoint return 200 through the unchanged Funnel. Ctrl/Cmd+S uses the real Save control, including its pending/conflict guards; native comment composers use their own Save control. Fresh administrator, reader, outsider and anonymous selected-publication/image verification passed (`artifacts/demo18/verification-login-phases.log`). The first post-restart verification failed before recording an authentication response; its cause is unverified and is not erased by the subsequent pass. The verifier records only fixed login stages/statuses and never retries sign-in automatically. No migration, fixture reset, account recovery or retained collaboration activation occurred.

The expanded full browser regression now passes 88/88 in 12.0 minutes, zero retries/skips: `NODE_ENV=test npm run test:browser`. The masked retained-preview verifier also passes all three authenticated roles and anonymous publishing. [Actual running workspace](https://uwvqig7mu5.ufs.sh/f/tJOw1mn9psOERzfJMpVm6dK4kbZyuGeYvnWgwipA7PsjC3a5). Retained collaboration remains disabled; inspect current hosted checks and the recorded native caret/navigation failures before changing that flag. Proposed same-space organization is tracked in issue #7; it is not a live feature.
