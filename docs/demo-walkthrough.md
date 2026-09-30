# Demo walkthrough

Scrawl's integrated demo uses actual authentication, the HTTP API, PostgreSQL 18, native BlockNote, private files and saved revisions. All seeded content is synthetic. [Validation](../VALIDATION.md) records observed checks and limits; [the integration backlog](integration-backlog.md) records review state. The integration branch is not merged or released.

## Use the running demo

Open [Scrawl's field guide](https://agentvm.beardie-tone.ts.net:10000/spaces/scrawl-field-guide/documents/start-here) from any browser. At the maintainer's explicit request, Tailscale Funnel now forwards public HTTPS 10000 to the existing loopback API on 3100. Private documents still require authentication and current grants. This is a synthetic development preview, not a production deployment.

Links now use stable readable names, for example [the Demo Handbook release checklist](https://agentvm.beardie-tone.ts.net:10000/spaces/demo-handbook/documents/release-checklist). Saving a renamed title keeps its existing link. Duplicate titles get readable numeric suffixes within their space; archived links remain reserved. Old `?space=UUID&document=UUID` bookmarks still work and become readable paths after authorized loading. UUIDs remain in the API, revision provenance and native exports.

Retrieve credentials locally, without copying them into issues, screenshots or chat:

```sh
cd /home/dev/t3/projects/scrawl
less artifacts/demo18/artifacts/demo/credentials.json
```

The file is ignored and owner-only. Use `administrator@example.test` for all capabilities, `editor@example.test` for editing, `reader@example.test` for reading/history/export, and `outsider@example.test` to verify isolation. Each has its own generated password. Use separate browser profiles when comparing roles. The editor and reader belong to "Scrawl field guide"; Demo A's separate spaces deliberately revoke their editor grant at the end of each run.

An already approved synthetic revision is available at [the read-only handbook](https://agentvm.beardie-tone.ts.net:10000/publications/5cc554b9-c753-4de1-9502-0e1188323e9d), publicly without signing in. It includes only the approved revision and its scoped image.

The five useful documents are "Start here", "Your first week", "Service runbook", "Release checklist" and "Decisions and ownership". They include an uploaded private architecture image, nested/toggle content, checklists, rich formatting, code and tables. The release checklist is long enough to exercise scrolling and section navigation.

1. Open "Start here". Use the actual heading-derived "On this page" links, then inspect the private image. On a narrow screen, Navigation opens a drawer and the outline collapses above the document.
2. Create a document, edit its title and use `/` for BlockNote's supplied blocks. Select text for formatting/link UI, use the block handle for actions/nesting, and try a table, checklist and code block. Save explicitly and reload. There is no autosave.
3. Use Ctrl/Cmd+Z and the platform redo shortcut, including after Save. Discard changes beside Save asks before resetting title/body to this tab's baseline, clears local undo and creates no revision. Keep editing cancels.
4. Save a new document before using BlockNote's Upload tab for an image/file. Uploaded bytes are private; Save records their reference. Removing a current block leaves older revisions' attachments readable to authorized users. Rejected uploads leave local work intact.
5. Open History, select an older revision and Restore. A new revision is appended. Use Document actions to archive/unarchive or export saved JSON/PDF/DOCX; history also exports a selected saved revision. Exports exclude unsaved changes. PDFs and DOCX contain visible titles and embedded authorized images.
6. Use the header Search control. Ctrl/Cmd+K opens search outside the editable editor; inside editable text, BlockNote keeps its native link shortcut. Arrow keys and Enter select a result. Search covers accessible current saved titles/bodies, excludes archives and unsaved edits, and respects the dirty-navigation confirmation.
7. Open one document in two tabs, edit both, and save the first. Saving the second returns 412, retains its complete draft and shows the latest saved version separately. Use my changes deliberately changes the comparison baseline but writes nothing; review and press Save. Use server version asks before discarding dirty work. Missing/stale preconditions are never automatically retried.
8. As administrator, choose Publish saved revision from Document actions, or select an older revision in History and use Publish revision. Confirm the explicit saved revision and its public scope. Private drafts and later saves remain private. View the approved page without signing in, then withdraw it. Archive invalidates the approval; unarchive requires a new deliberate approval. Approved pages are now internet-accessible through the explicitly authorized Funnel preview.
9. Log in as reader and outsider. Readers can read, inspect history and export but cannot mutate. Outsiders receive no private titles/content/history/versions. Temporary save failure retains editable unsaved work; expiry/lost access clears unrelated navigation and server actions, retaining the draft read-only in the tab. Re-login as the draft's account rechecks access and requires deliberate reconciliation. Nothing is reported as saved after a failed write.

Private draft title/body live only in memory. Closing/reloading can discard them after the browser warning. There is no persistent content cache, IndexedDB or service worker. Native toggle expansion booleans may use localStorage; document content does not. Collaboration/comments are not enabled.

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

This opt-in authored acceptance runner uses fresh browser sessions against the actual persistent origin. It reads private credentials safely, checks native blocks/private image/search/history/export/mobile/reader/outsider, logs no passwords/cookies, and creates no document revisions or reset:

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

Read status, validation, the five integration issues and accepted ADRs. Continue on `integration/blocknote-demo` and keep draft PR #6 unmerged. The next substantial work is isolated durable collaboration/comments under [ADR 0003](adr/0003-collaboration-checkpoints.md), with real storage/permission/reconnect/undo gates before enabling it. No paid AI calls, new provider accounts or generic extension framework are needed. Keep the existing demo runnable and preserve its history/private files.
