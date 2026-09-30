# Scrawl

An **Asynchronous Ventures** open-source project. Repository name: `scrawl`.

**License: AGPL-3.0-only. Status: P4 Demo B verified locally; pre-release.**

A self-hosted, private-by-default documentation platform with an independent API and optional publication of selected document revisions. No SaaS tenancy, billing, paid feature gates, or required vendor account. The source-code license does not automatically license users' independent documentation.

## Start here

1. Read [the demo-first build plan](docs/plan.md).
2. Give the development agent [the kickoff prompt](docs/agents/demo-kickoff.md).
3. Review [P0: foundation verification](docs/agents/first-packet.md), then assign [the work packets](docs/backlog.md) one at a time. Stop at P4 review before assigning publishing.
4. Use [the demo walkthrough](docs/demo-walkthrough.md) for Demo A and the connected Demo B application.

The [architecture](docs/architecture.md), [core schema brief](docs/core-schema.md), [API proposal](docs/api-design.md), and [publishing rules](docs/public-publishing.md) explain the hard boundaries. [Decisions](docs/decisions.md) distinguish requirements from implementation defaults. [VALIDATION.md](VALIDATION.md) states what has actually run.

## Current implementation

The supplied Fastify scaffold provides environment validation, liveness/readiness, generated OpenAPI, standard problem responses, request IDs, redacted logging, PostgreSQL readiness access, and graceful shutdown. P0 adds exact dependency pins, a reviewed npm lockfile, regression coverage, and minimal Node 24/PostgreSQL 17 CI.

P1 adds real local sessions, closed registration, host account commands, and administrator-managed space access. Authorization lives in core operations; Prisma records do not become HTTP DTOs.

P2 adds restricted headless content validation, document create/read/update, immutable revision history/restore, and archive/unarchive. Existing-document mutations require a current strong ETag; title/body saves and lifecycle lock versions remain separate.

P3 adds a repeatable real HTTP Demo A runner, explicit disposable fixture setup/reset, and authorized native single-document JSON export. Follow [the walkthrough](docs/demo-walkthrough.md#run-demo-a) to run it and inspect a local export.

P4 adds a React/Vite private document interface with the restricted ProseMirror editor, explicit saves, conflict comparison, revision history, lifecycle actions, and native export. The approved charcoal/sage prototype remains separate from the connected application. The live UI has no simulated search or fixture controls.

**Publishing, search, attachments, bulk export/import, SSO, and API keys are not implemented.** Use synthetic documentation during this pre-release demo and keep it private.

The incoming archive's history is recorded in [changes-v3.md](docs/changes-v3.md). Current checks and foundation fixes are recorded in [VALIDATION.md](VALIDATION.md).

## Local development

Requires Node.js 24, npm, and Docker Compose or a PostgreSQL 17 database matching the development configuration.

First copy `.env.example` to `.env`.

```sh
cp .env.example .env
```

Generate the secret directly into a newly copied `.env`, without printing it. This refuses to overwrite a populated secret:

```sh
node --input-type=module <<'JS'
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
const env = readFileSync('.env', 'utf8');
if (!/^AUTH_SECRET=$/m.test(env)) throw new Error('AUTH_SECRET must be empty for this setup step');
chmodSync('.env', 0o600);
writeFileSync('.env', env.replace(/^AUTH_SECRET=$/m, `AUTH_SECRET=${randomBytes(32).toString('hex')}`));
JS
```

Then install, migrate, verify, and start locally:

```sh
npm ci
docker compose up -d --wait postgres
npm run db:migrate
npm run check
npm run test:db
npm run openapi:export
npm run dev
```

Dependencies are pinned in `package.json` and `package-lock.json`. Development credentials in `.env.example` are examples, not deployment defaults. Never commit `.env`. Both the API and Compose database bind to loopback by default.

```sh
curl -i http://127.0.0.1:3000/health/live
curl -i http://127.0.0.1:3000/health/ready
curl http://127.0.0.1:3000/openapi.json
```

`npm test` covers configuration and injected HTTP tests. `npm run test:db` requires local PostgreSQL with schema/database creation privileges and fails when it is unavailable. `npm run check` covers import boundaries, both TypeScript projects, unit/HTTP tests, both builds, and the generated API type check. Database and browser suites run separately and sequentially. CI includes them, but hosted execution is recorded separately in [VALIDATION.md](VALIDATION.md).

`npm ci` regenerates the ignored Prisma client; `db:migrate` applies the single checked-in migration history. OpenAPI describes implemented system and P1-P3 product routes and is written to ignored `artifacts/openapi.json`. `npm run web:generate` regenerates the checked-in browser types from that specification. Frontend code imports only the generated client and browser-safe content contract, never Prisma or server operations. There is no API explorer.

`npm run web:build` creates `web/dist` plus license, third-party notices, and an archive of the actual source checkout. The application serves that build at `/` on its existing origin when present. For a source archive extracted outside a checkout, run `git init` before the build; its source-packaging inventory uses Git and the included ignore rules. See [Demo B commands](docs/demo-walkthrough.md#run-demo-b) for guarded fixture setup, same-origin Vite development, browser acceptance tests, and private Tailscale preview.

Use `npm start` after `npm run build` to run the compiled backend. `docker compose down` stops the development database while preserving its data volume.

## Local accounts and access

Run account commands on the trusted host. Passwords use a hidden terminal prompt with confirmation, never flags or environment variables. No administrator is created automatically.

```sh
npm run operator -- bootstrap --email owner@example.test --name "Local Owner"
npm run operator -- provision --email reader@example.test --name "Local Reader"
npm run operator -- recover --email reader@example.test
```

Bootstrap works only when the instance has no users, including under concurrent attempts. Provisioning creates members and requires an existing administrator. Recovery changes the password and revokes all sessions in one transaction. These commands have host authority, not remote HTTP endpoints.

Sign in with `POST /api/auth/sign-in/email`, inspect a session with `GET /api/auth/get-session`, and sign out with `POST /api/auth/sign-out`. Session credentials travel in HttpOnly cookies; JSON omits raw tokens and credential fields. Better Auth's other endpoints are not mounted. Production requires an explicit HTTPS `APP_ORIGIN` and uses Secure cookies.

P1 product routes are `/api/v1/me`, space creation/list/read, and administrator membership PUT/DELETE. Browser writes require the configured `Origin`. Membership writes require the space's strong `ETag` in `If-Match`; missing is 428, stale is 412. Lists use bounded `limit` and UUID `cursor` parameters. P2 adds document create/list/read/update, revision list/read/restore, and archive/unarchive. Editors and administrators mutate; readers read; outsiders receive 404. Lists omit archived documents unless `includeArchived=true`; authorized archived reads/history remain available. Canonical no-op saves preserve the ETag; restoring always appends a revision. See [API details](docs/api-design.md), [content limits](docs/core-schema.md#p2-content-and-lifecycle-policy), and [validation/migration notes](VALIDATION.md).

## License

Original project code is licensed under **GNU Affero General Public License version 3 only**, SPDX `AGPL-3.0-only`; see [LICENSE](LICENSE). This program is distributed without warranty, including implied warranties of merchantability or fitness for a particular purpose. See the license for its complete terms. Third-party components retain their own licenses.

`private: true` in package metadata prevents accidental npm publication; it does not make the source proprietary. [Licensing notes](docs/license-recommendation.md) and [CONTRIBUTING.md](CONTRIBUTING.md) describe the release/source-availability policy. No additional non-commercial restriction or trademark policy is imposed by this scaffold.
