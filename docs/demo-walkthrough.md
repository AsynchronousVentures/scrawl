# Demo walkthrough

Scrawl's integrated demo uses actual authentication, the HTTP API, PostgreSQL 18, native BlockNote, private files and saved revisions. All seeded content is synthetic. [Validation](../VALIDATION.md) records observed checks and limits; [the integration backlog](integration-backlog.md) records review state. The integration branch is not merged or released.

## Use the running demo

Open [Scrawl's field guide](https://agentvm.beardie-tone.ts.net:10000/spaces/scrawl-field-guide/documents/start-here) from any browser. At the maintainer's explicit request, Tailscale Funnel now forwards public HTTPS 10000 to the existing loopback API on 3100. Private documents still require authentication and current grants. This is a synthetic development preview, not a production deployment.

Links now use stable readable names, for example [the Demo Handbook release checklist](https://agentvm.beardie-tone.ts.net:10000/spaces/demo-handbook/documents/release-checklist). Saving a renamed title keeps its existing link. Duplicate titles get readable numeric suffixes within their space; archived links remain reserved. Old `?space=UUID&document=UUID` bookmarks still work and become readable paths after authorized loading. UUIDs remain in the API, revision provenance and native exports.

Saved documents open in reading mode, including for administrators and editors. Choose **Edit** to change the title/body or use BlockNote's editing controls. **Save** keeps you editing and preserves native undo. **Done editing** returns to reading; unsaved solo edits require **Keep editing** or confirmed discard. New documents start editable. History, export and the document menu are available from reading mode with current permissions. Reload and document navigation return to reading mode. On narrow screens the heading outline starts collapsed; open On this page to navigate sections.

[Actual reading view](https://uwvqig7mu5.ufs.sh/f/tJOw1mn9psOEEMXvyHx8YF2HnTkvz39hoUltEXLVADQeWbO4) and [editing view](https://uwvqig7mu5.ufs.sh/f/tJOw1mn9psOEUT1jSV96KHbCAF9OklxTB024wRJWicaD387I), captured from the running synthetic preview with account details hidden.

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

Within a space, document links keep the navigation tree and expanded branches in place while Scrawl checks current access and reads the next document. The previous document is temporarily inactive. Search uses the same opening path, and rejected reads never leave another document under the target URL. Dirty navigation still asks whether to discard or Keep editing.

Copy, export, favorite and upload confirmations now appear as toasts at the bottom right, without moving the document. F6 focuses notifications; Tab reaches the toast and its dismiss button. Hover/focus pauses the supplied timeout. Save failures, conflicts and lost-access instructions stay beside the document. [Actual running toast](https://uwvqig7mu5.ufs.sh/f/tJOw1mn9psOEEzb59Bx8YF2HnTkvz39hoUltEXLVADQeWbO4).

The five useful documents are "Start here", "Your first week", "Service runbook", "Release checklist" and "Decisions and ownership". They include an uploaded private architecture image, nested/toggle content, checklists, rich formatting, code and tables. The release checklist is long enough to exercise scrolling and section navigation.

1. Open "Start here". Use the heading-derived "On this page" links, then inspect the private image. The address keeps the readable document path and adds a section fragment. Copy that address or Ctrl/Cmd-click a section to open it separately; reload and Back/Forward return to sections without saving the current draft. Existing heading links survive heading renames. New unsaved headings become available in other sessions after Save. Reader links still require space access; published section links stay within the selected revision. On a narrow screen, Navigation opens a drawer and the outline collapses above the document.
2. Choose Edit on a saved document, or create a document. Edit its title and use `/` for BlockNote's supplied blocks. Select text for formatting/link UI, use the block handle for actions/nesting, and try a table, checklist and code block. Ctrl/Cmd+End moves to the last native text insertion point; add Shift to extend the selection from the current caret. A trailing divider is preserved when you type. These selection commands do not save or create a revision. Save explicitly with the button or Ctrl/Cmd+S and reload. The save shortcut uses the same pending/conflict guards; it does not submit native comments or act inside dialogs. There is no autosave.
3. Use Ctrl/Cmd+Z and the platform redo shortcut, including after Save. Discard changes beside Save asks before resetting title/body to this tab's baseline, clears local undo and creates no revision. Keep editing cancels.
4. Save a new document before using BlockNote's Upload tab for an image/file. Uploaded bytes are private; Save records their reference. Removing a current block leaves older revisions' attachments readable to authorized users. Rejected uploads leave local work intact.
5. Open History, select an older revision and Restore. A new revision is appended. Use Document actions to archive/unarchive or export saved JSON/PDF/DOCX; history also exports a selected saved revision. Exports exclude unsaved changes. PDFs and DOCX contain visible titles and embedded authorized images.
6. To reuse a guide, choose Duplicate saved document from Document actions, or Duplicate revision in History. Name the copy and create it at this space's root. It starts at revision 1, has its own private files and is unpublished. Your current draft stays here; Open copy asks before leaving unsaved work. An uncertain response never retries creation.
7. Use the header Search control. Ctrl/Cmd+K opens search outside the editable editor; inside editable text, BlockNote keeps its native link shortcut. Arrow keys and Enter select a result. Search covers accessible current saved titles/bodies, excludes archives and unsaved edits, and respects the dirty-navigation confirmation.
8. Open one document in two tabs, choose Edit in both, and save the first. Saving the second returns 412, retains its complete draft and shows the latest saved version separately. Use my changes deliberately changes the comparison baseline but writes nothing; review and press Save. Use server version asks before discarding dirty work. Missing/stale preconditions are never automatically retried.
9. As administrator, choose Publish saved revision from Document actions, or select an older revision in History and use Publish revision. Confirm the explicit saved revision and its public scope. Private drafts and later saves remain private. View the approved page without signing in, then withdraw it. Archive invalidates the approval; unarchive requires a new deliberate approval. Approved pages are now internet-accessible through the explicitly authorized Funnel preview.
10. Log in as reader and outsider. Readers can read, inspect history and export but cannot mutate. Outsiders receive no private titles/content/history/versions. Temporary save failure retains editable unsaved work; expiry/lost access clears unrelated navigation and server actions, retaining the draft read-only in the tab. Re-login as the draft's account rechecks access and requires deliberate reconciliation. Nothing is reported as saved after a failed write.

11. As administrator, choose New space beside the space selector, or from Navigation on mobile. Create a named private space. An open document stays selected with its unsaved work intact; select the new space deliberately when ready. An empty installation enters its first space automatically. New spaces are administrator-only until you grant access. Readers and outsiders cannot create spaces.

12. As administrator, choose Space access in the current space. Enter an existing provisioned account email and grant Reader or Editor. Change a listed role and press Apply. Remove asks for confirmation; Keep access cancels. Existing sessions lose access after removal. Administrators retain implicit access to every space. A stale or unconfirmed request retains your requested change and requires Reload access before another deliberate submission. Opening the dialog or changing grants does not save, discard or reset the document's local edits or undo history. Account provisioning stays in the operator CLI.

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

If the transient unit was collected after an explicit stop or a machine restart, recreate it:

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

Native export contains `scrawl-document`, export version 1, minimal document/revision provenance, and `blocknote-json`, schema version 1, editor version 0.55.0, with native blocks. No credentials, profiles, memberships or session records are included. This is one saved single-document snapshot, current by default or an explicitly selected revision, not history backup/import. PDF/DOCX endpoints export the current saved snapshot or explicit selected revision and preserve authorization; external images or unsupported colors return explicit errors rather than fetch/flatten them.

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

Development is now on hold at the maintainer's request, with the current checkpoint prepared for draft PR #6. No new shared fixture or enrollment was performed. After an explicit resume, start with the current holding section in status and the recorded validation results; older checkpoint paragraphs below are historical. Finish the ADR 0003 activation audit and verify authenticated live editing through the existing preview origin before enabling collaboration. Keep retained content/history intact, use PostgreSQL 18 only and do not start hosted CI merely to repeat already observed local checks while the Actions allowance is exhausted.

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

## Organization API checkpoint

The retained preview now runs migration nine and the authorized organization API from `06a3f0f`. All eight content/grant/live/file/publication record digests match before and after migration, excluding only the added nullable parent field; existing documents remain roots. Fresh administrator, reader, outsider and anonymous publication/image checks pass (`verification-hierarchy-core-preview.log`). The normal private workflow and approved layout are unchanged. No nested navigation, breadcrumbs or move controls are displayed yet; those are the next connected implementation in issue #7. Child creation and moves are currently headless API capabilities, with current ETags and no access inheritance or publication cascade. Native export remains one content snapshot, not a hierarchy backup.

New branch installations require `npm run db:generate` and `npm run db:migrate` before starting the backend. The existing preview has already applied that migration. Restart or recreate the transient service using the earlier commands; `systemctl start` cannot restart a unit that systemd collected after stopping it. Do not reset retained fixtures or change Funnel configuration for this update.

## Organize private documents

The document list now groups children below their parent, with alphabetical siblings and keyboard-operable disclosure buttons. The selected document's ancestors open automatically. Breadcrumb links above the title navigate to the space and parent documents. Mobile navigation remains in its existing drawer.

Use Document actions > New child document to start an empty native draft under the current active document. Existing unsaved work still requires deliberate discard, with Keep editing returning to the full draft. Before its first Save, the Location control can select Space root or another active parent without losing title/body edits. Creating a child does not copy its parent's content or attachments.

Save or discard local edits before using Document actions > Move document. Select an active parent or Space root and confirm. Moves preserve readable URLs, content revisions and native undo state. A stale move opens the existing comparison interface; an uncertain response requires comparison even after closing and reopening the dialog. Nothing retries automatically. Readers have no structural controls, and outsiders receive no tree or breadcrumb metadata.

An active child blocks parent archive. Move or archive the children explicitly first. An archived parent cannot receive new or reactivated children. Show archived includes archived locations in navigation. The server enforces same-space parents, cycle rejection and a maximum of 32 levels. Private hierarchy is not included in public pages or native single-document export.

Opening a space starts at its first active alphabetical root. Longer breadcrumb paths show the two closest parents; Earlier parent documents opens the remaining links with native keyboard controls. At level 32, New child document explains the nesting limit. New document still starts a root draft. The mobile action menu stays inside the toolbar and can scroll vertically.


The complete local regression on `b03d230` passes 97 real browser workflows, including Demo A. A separate authenticated shared-editing fixture verifies that an incoming peer's complete title/body survives a pending structural move, without an implicit revision or peer-reverting undo. Only explicit Save checkpoints those changes. Run `NODE_ENV=test npm run test:browser -- test/browser/live.spec.ts --grep 'pending structural move'` to exercise that proof; the retained preview remains in solo mode pending its remaining native-selection activation gate. Use the existing PostgreSQL 18 instance only. No reset or additional migration is needed for this verification checkpoint.


Use Document actions > Copy private link to copy the saved readable document address. This works for editors and readers, including when an editor has an unsaved title/body. It copies the stable saved location, leaves the draft and history alone, and grants no access or publication. If the browser refuses clipboard access, copy the address bar URL manually. Keyboard focus returns to Document actions. [Actual masked running interface](https://uwvqig7mu5.ufs.sh/f/tJOw1mn9psOE7HoTpqitwUWT3HxrEBYNkgzAoiu6SGqjCZDa).


Exports now download as readable saved-snapshot names, such as `scrawl-start-here-revision-2.json`, rather than UUID filenames. Current native/PDF/DOCX downloads use the exported head; historical native/PDF/DOCX use the selected revision's own title and number. Unsaved titles/bodies never supply the filename or content. Open History, select a revision and choose Export JSON to download that immutable native snapshot. Reader access is sufficient; withdrawn space access denies export even with an existing session. The existing preview has been restarted and its fresh role/publication checks pass, including actual native download names. No migration or reset is needed. The preceding complete 100-case browser suite passed; four focused post-change download workflows also pass.


Native history export uses `GET /api/v1/documents/{documentId}/export?revisionId={revisionId}`. The selected revision must belong to that document. A JSON download retains `exportVersion: 1`, native format/schema/editor versions and minimal document/revision provenance; it contains neither other revisions nor live changes, local drafts, comments or authentication data. The JSON references private attachments and does not bundle file bytes. Export never creates a revision. Use the History panel to inspect the selected title/body before downloading.

[Running native history export](https://uwvqig7mu5.ufs.sh/f/tJOw1mn9psOE2GDBpEXFPmf09I4aCjAc31tEypZN8DwQeiRU) shows the actual retained application after a successful selected-revision JSON download. The account area is masked.

The connected search dialog now includes "Search in" with all accessible spaces or one space. Each result shows its space name under its saved title, followed by an excerpt, so identically named documents can be distinguished. Changing the scope cancels an older request and clears its results; it keeps the same query and existing dirty-navigation confirmation. Native arrow keys work in the space select, while arrows in the query navigate document results. The dropdown uses the currently loaded authorized space list; reload after external membership changes to refresh that list.

[Running space-filtered search](https://uwvqig7mu5.ufs.sh/f/tJOw1mn9psOEsfviehtlpi6cxDJdrRtE9BZ0SqhYLkbPg81N) shows the actual retained application, with the account area masked.

Section-link navigation is shown in this [running-application screenshot](https://uwvqig7mu5.ufs.sh/f/tJOw1mn9psOEt3l9S9xn9psOEgi62D1HuWBIdXRlvM5wjaer). It contains synthetic content; the account area is masked.

Saved-copy work is pushed in `ec18d44` on the integration branch and running at the existing URL. [Actual duplication dialog](https://uwvqig7mu5.ufs.sh/f/tJOw1mn9psOEALRsfrJQwKgCvrG4dfBPDk3UtpaVSO2ny9Aj), account area masked. Fresh role and keyboard-cancellation verification passes without changing retained documents. Restart the existing service with `systemctl --user restart scrawl-integration-demo.service`, wait for `/health/ready` to return 200, then use the existing `demo-verify.ts` command. This follow-up requires no migration or reset. The full updated browser suite finishes 108/109, including all seven copy workflows, with one experimental native Add comment setup timeout. Eight fresh-session repetitions pass after a diagnostic-only correction; this is not a demonstrated fix. Hosted PR verification passes all 109 browser cases; the push finishes 108/109 with a native Add comment setup timeout in the shared save-shortcut case. Retained collaboration stays disabled.

Operators can check the current preview's saved content and private storage without changing data:

```sh
cd /home/dev/t3/projects/scrawl/artifacts/demo18
node --import ../../node_modules/tsx/dist/loader.mjs ../../scripts/content-check.ts --demo
```

The observed scan reports `ok: true`, 7 documents, 10 revisions and one attachment, zero integrity errors. Output contains only aggregate counts/categories; missing or inconsistent data returns exit status 1. This command does not check live state/comments or unregistered files and is not a backup. No migration or restart is required for this host-only addition.

## Development recovery

The new [host-only recovery workflow](recovery.md) backs up a stopped development instance and restores only into a newly named owned target on the existing PostgreSQL 18 server. Database authentication records and private files are included; runtime secrets are protected separately. Native single-document export is still a content snapshot.

To run the actual CLI/HTTP rehearsal locally without changing the retained preview:

```sh
cd /home/dev/t3/projects/scrawl
SCRAWL_PG_CLIENT_CONTAINER=scrawl-autonomous18-postgres-1 NODE_ENV=test \
  node --env-file-if-exists=.env --import tsx --test test/integration/recovery.test.ts
```

It creates and removes its own synthetic databases/private temporary files on the existing test server. No migration or preview restart is needed for this host-only addition. The retained preview remains running on its original database with collaboration disabled. Recovery's exact backup/restore instructions and unverified limits are in the linked document; no retained backup or production restore is claimed. New work remains local while the included Actions allowance is exhausted.

## Personal favorites

At https://agentvm.beardie-tone.ts.net:10000/spaces/scrawl-field-guide/documents/start-here, open Document actions and choose Add to favorites or Remove from favorites. Favorites appear above the space selector. Readers can keep their own favorites. Links preserve native new-tab behavior and the same unsaved-navigation guard. Start here is favorited for the synthetic administrator. This preference does not save document edits or create a revision.

Try adding a favorite with unsaved title/body edits, then use its link to another document. Keep editing cancels navigation without replacing your work. An uncertain favorite response shows a separate error; Check favorite status reads the server before allowing another change. Archived or inaccessible documents are omitted; unarchive or restored access can reveal an existing preference again.

The retained preview has the tenth additive migration, with all 12 prior table fingerprints/counts preserved. Fresh role/publication checks and a real favorite workflow pass without changing document content/history/ETags. [Running favorites screenshot](https://uwvqig7mu5.ufs.sh/f/tJOw1mn9psOE3XCvnYOXCby2MI4afdLiu7mWkov5PeT8RzlA), account area masked. [Running mobile favorites](https://uwvqig7mu5.ufs.sh/f/tJOw1mn9psOEn2n6esuPu5RwaceHS9ImGo6YL4DOxq0QVJhz) uses the collapsed navigation; a fresh running check confirms visible links and no horizontal page overflow at 390px. This is Chromium viewport verification, not a physical-device test. Existing credentials remain in the owner-only local `artifacts/demo18/artifacts/demo/credentials.json`; do not publish that file. Restart with `systemctl --user restart scrawl-integration-demo.service`, then wait for `/health/ready` to return 200.

On another installation, run `npm run db:migrate` against its existing PostgreSQL 18 target before starting this backend. Do not reset or create a second version target. The focused command is `NODE_ENV=test npm run test:browser -- --grep 'favorites '`. The complete local regression passes 101 standard, 166 PostgreSQL 18 and 116 browser checks. Hosted results are recorded separately in VALIDATION.md; this integration work is not merged or released.
