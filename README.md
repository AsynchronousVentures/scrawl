# Scrawl

An **Asynchronous Ventures** open-source project. Repository name: `scrawl`.

**License: AGPL-3.0-only. Status: completed P0-P4 checkpoints, active integration branch; pre-release.**

A self-hosted, private-by-default documentation platform with an independent API and optional publication of selected document revisions. No SaaS tenancy, billing, paid feature gates, or required vendor account. The source-code license does not automatically license users' independent documentation.

## Start here

1. Read [the demo-first build plan](docs/plan.md).
2. Read [the integration backlog](docs/integration-backlog.md) and [actual validation results](VALIDATION.md) for the current branch.
3. The [kickoff prompt](docs/agents/demo-kickoff.md) and [historical work packets](docs/backlog.md) retain the original acceptance criteria. The current authorized session continues across their earlier stop boundaries in reviewable commits.
4. Use [the demo walkthrough](docs/demo-walkthrough.md) for Demo A and the connected Demo B application.

The [architecture](docs/architecture.md), [core schema brief](docs/core-schema.md), [API contracts](docs/api-design.md), and [publishing rules](docs/public-publishing.md) explain the hard boundaries. [Decisions](docs/decisions.md) distinguish requirements from implementation defaults. [VALIDATION.md](VALIDATION.md) states what has actually run.

## Current implementation

The supplied Fastify scaffold provides environment validation, liveness/readiness, generated OpenAPI, standard problem responses, request IDs, redacted logging, PostgreSQL readiness access, and graceful shutdown. P0 established exact dependency pins, a reviewed npm lockfile and regression coverage. CI uses Node 24 and PostgreSQL 18 only; observed local and hosted results are recorded separately in validation.

P1 adds real local sessions, closed registration, host account commands, and administrator-managed space access. Authorization lives in core operations; Prisma records do not become HTTP DTOs.

P2 established document create/read/update, immutable revision history/restore, archive/unarchive and conditional writes. The integration branch replaces its restricted body with versioned native BlockNote 0.55.0 content and official server utilities while retaining those guarantees. Standard blocks/styles are supported, with strict URL and resource validation.

P3 adds a repeatable real HTTP Demo A runner, explicit disposable fixture setup/reset, and authorized native single-document JSON export. Follow [the walkthrough](docs/demo-walkthrough.md#run-demo-a) to run it and inspect a local export.

The React/Vite interface uses BlockNote's official shadcn editor in the approved charcoal/sage layout, with explicit saves, confirmed local draft discard, conflict comparison, revision history, lifecycle actions and native export. The integration branch adds private document-owned attachments, OSS PDF/DOCX exports, and real PostgreSQL search. Search applies current access before ranking or returning titles/excerpts. The disconnected prototype remains preserved, including its fixture search.

Selected-revision publishing is implemented in the API and web application and defaults off. Administrator approval changes the public grant under the document ETag without adding a revision; private edits never advance it. Public reads include only the approved title/content/time and approved files. Archive invalidates prior approval even after unarchive. See [the integration backlog](docs/integration-backlog.md) for actual review state.

The current sequence is native/private documents, attachments/export, PostgreSQL 18/search, selected-revision publishing, isolated durable collaboration/comments, then optional AI. Collaboration/comments and AI are not enabled in the working demo. Same-space document organization is implemented on the integration branch. Bulk import/export, SSO and API keys remain separate work. Missing AI provider access does not block the demo, and no paid provider calls are authorized. Use synthetic documentation during this pre-release work.

Experimental shared-document startup is available with `COLLABORATION_ENABLED=true`, default off in every environment. It requires one application owner per database/schema and `DB_POOL_MAX` of at least 2. Authenticated `/api/v1/collaboration` reports actual availability; enabling the process does not enroll or change existing documents. The retained preview remains in solo mode while the remaining activation checks are completed. See [ADR 0003](docs/adr/0003-collaboration-checkpoints.md) and [validation](VALIDATION.md).

The incoming archive's history is recorded in [changes-v3.md](docs/changes-v3.md). Current checks and foundation fixes are recorded in [VALIDATION.md](VALIDATION.md).

## Local development

Requires Node.js 24, npm, and the existing PostgreSQL 18 instance. The fresh-checkout setup below is for contributors without an existing database; ongoing development does not create or test another database-version target.

For a fresh checkout with no `.env`, copy the example exclusively and generate a secret without printing it. This refuses to overwrite an existing environment file:

```sh
node --input-type=module <<'JS'
import { randomBytes } from 'node:crypto';
import { constants, copyFileSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
copyFileSync('.env.example', '.env', constants.COPYFILE_EXCL);
const env = readFileSync('.env', 'utf8');
if (!/^AUTH_SECRET=$/m.test(env)) throw new Error('AUTH_SECRET must be empty for this setup step');
chmodSync('.env', 0o600);
writeFileSync('.env', env.replace(/^AUTH_SECRET=$/m, `AUTH_SECRET=${randomBytes(32).toString('hex')}`));
JS
```

Then install, migrate, verify, and start a fresh PostgreSQL 18 development project. Port 5432 must be free; these commands do not adopt an existing PostgreSQL 17 volume:

```sh
npm ci
docker compose --project-name scrawl-dev18 -f compose.yaml up -d --wait postgres
npm run db:migrate
npm run check
NODE_ENV=test npm run test:db
npm run openapi:export
npm run dev
```

Dependencies are pinned in `package.json` and `package-lock.json`. Development database credentials in `.env.example` are examples, not deployment defaults. Never commit `.env`. The API and Compose database bind to loopback. `compose.yaml` uses a distinct `postgres18_data` volume mounted at `/var/lib/postgresql`, the PostgreSQL 18 image layout.

```sh
curl -i http://127.0.0.1:3000/health/live
curl -i http://127.0.0.1:3000/health/ready
curl http://127.0.0.1:3000/openapi.json
```

`npm test` covers configuration and injected HTTP tests. `npm run test:db` requires local PostgreSQL with schema/database creation privileges and fails when it is unavailable. `npm run check` covers import boundaries, both TypeScript projects, unit/HTTP tests, both builds, and the generated API type check. Database and browser suites run separately and sequentially. CI includes them, but hosted execution is recorded separately in [VALIDATION.md](VALIDATION.md).

`npm ci` regenerates the ignored Prisma client; `db:migrate` applies the single checked-in migration history. OpenAPI describes implemented routes, including search, attachments, rendered exports and publishing, and is written to ignored `artifacts/openapi.json`. `npm run web:generate` regenerates the checked-in browser types from that specification. Frontend code imports only the generated client and browser-safe content contract, never Prisma or server operations. There is no API explorer.

`npm run web:build` creates `web/dist` plus license, third-party notices, and an archive of the actual source checkout. The application serves that build at `/` on its existing origin when present. For a source archive extracted outside a checkout, run `git init` before the build; its source-packaging inventory uses Git and the included ignore rules. See [Demo B commands](docs/demo-walkthrough.md#run-demo-b) for guarded fixture setup, same-origin Vite development, browser acceptance tests, and private Tailscale preview.

Use `npm start` after `npm run build` to run the compiled backend. `docker compose --project-name scrawl-dev18 -f compose.yaml stop postgres` stops only that development service and preserves its volume.

### Retained databases

Development and CI use the existing PostgreSQL 18 target only. Multi-version compatibility development and testing have stopped. Historical results in validation do not create an ongoing compatibility commitment.

Original retained databases and volumes remain intact. The legacy `compose.postgres17.yaml` and `compose.demo.postgres17.yaml` files preserve their original mounts and project/environment requirements; they are retained for data preservation, not a second development target. Do not attach retained volumes to a different major image, delete them or reset their data.

Install the browser with `PLAYWRIGHT_SKIP_BROWSER_GC=1 npx playwright install --with-deps chromium` before its first run. The harness reserves its own `scrawl_demo_a` database on the ordinary test server; run database and browser suites sequentially, and do not run a separate demo against that reserved name.

### Native content migration and private files

Fresh migrated databases store `blocknote-json`, schema version 1, editor version `0.55.0`. Existing restricted ProseMirror snapshots require a finite offline conversion before the native application serves them; startup does not convert them and there is no runtime legacy parser.

Only on an explicitly selected, stopped development copy, with `.env` targeting that copy:

```sh
npm run db:migrate
npm run content:migrate -- --dry-run
npm run content:migrate -- --apply --backup artifacts/private-originals/content-before-blocknote.json
```

Dry-run checks every source snapshot without writing it. Apply writes an exclusive owner-only original-data archive before a single transactional conversion. Document/revision IDs, numbering, authored times, provenance, heads and lock versions are retained; the native representation uses a distinct ETag so older clients cannot overwrite it. Unrepresentable legacy content aborts conversion instead of silently dropping it. The archive contains private content/history and must stay protected; it is not a complete database backup. Ask before converting or resetting retained real data. Current retained-data rehearsals operate only on disposable copies.

`ATTACHMENT_STORAGE_DIR` names the private application-owned byte directory, defaulting to `var/private-attachments`. Keep it outside frontend/static roots and preserve it with the database. Files are immutable and retained by revision history; discarding a draft or resetting synthetic rows does not wipe a directory. Process-crash orphan inspection and cleanup remain explicit operator work.

Publishing uses `PUBLIC_PUBLISHING_ENABLED=false` by default. To exercise it on a local demo, deliberately set the value to `true` in that demo's private configuration and restart; each selected revision still needs administrator approval. Global disabling pauses public reads, while unpublish or archive revokes a grant. Re-enabling can resume a still-valid grant, so it must not be described as permanent revocation. This does not authorize public exposure of the development application.

## Local accounts and access

Run account commands on the trusted host. Passwords use a hidden terminal prompt with confirmation, never flags or environment variables. No administrator is created automatically.

```sh
npm run operator -- bootstrap --email owner@example.test --name "Local Owner"
npm run operator -- provision --email reader@example.test --name "Local Reader"
npm run operator -- recover --email reader@example.test
```

Bootstrap works only when the instance has no users, including under concurrent attempts. Provisioning creates members and requires an existing administrator. Recovery changes the password and revokes all sessions in one transaction. These commands have host authority, not remote HTTP endpoints.

Sign in with `POST /api/auth/sign-in/email`, inspect a session with `GET /api/auth/get-session`, and sign out with `POST /api/auth/sign-out`. Session credentials travel in HttpOnly cookies; JSON omits raw tokens and credential fields. Better Auth's other endpoints are not mounted. Production requires an explicit HTTPS `APP_ORIGIN` and uses Secure cookies.

P1 product routes are `/api/v1/me`, space creation/list/read, and administrator membership PUT/DELETE. Browser writes require the configured `Origin`. Membership writes require the space's strong `ETag` in `If-Match`; missing is 428, stale is 412. Lists use bounded `limit` and UUID `cursor` parameters. P2 adds document create/list/read/update, revision list/read/restore, and archive/unarchive. Editors and administrators mutate; readers read; outsiders receive 404. Lists omit archived documents unless `includeArchived=true`; authorized archived reads/history remain available. Canonical no-op saves preserve the ETag; restoring always appends a revision. See [API details](docs/api-design.md), [content limits](docs/core-schema.md#native-blocknote-content-and-lifecycle-policy), and [validation/migration notes](VALIDATION.md).

## License

Original project code is licensed under **GNU Affero General Public License version 3 only**, SPDX `AGPL-3.0-only`; see [LICENSE](LICENSE). This program is distributed without warranty, including implied warranties of merchantability or fitness for a particular purpose. See the license for its complete terms. Third-party components retain their own licenses.

`private: true` in package metadata prevents accidental npm publication; it does not make the source proprietary. [Licensing notes](docs/license-recommendation.md) and [CONTRIBUTING.md](CONTRIBUTING.md) describe the release/source-availability policy. No additional non-commercial restriction or trademark policy is imposed by this scaffold.
