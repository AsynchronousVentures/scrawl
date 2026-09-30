# Scrawl

An **Asynchronous Ventures** open-source project. Repository name: `scrawl`.

**License: AGPL-3.0-only. Status: P1 identity and space access verified locally; pre-release.**

A self-hosted, private-by-default documentation platform with an independent API and optional publication of selected document revisions. No SaaS tenancy, billing, paid feature gates, or required vendor account. The source-code license does not automatically license users' independent documentation.

## Start here

1. Read [the demo-first build plan](docs/plan.md).
2. Give the development agent [the kickoff prompt](docs/agents/demo-kickoff.md).
3. Review [P0: foundation verification](docs/agents/first-packet.md), then assign [the work packets](docs/backlog.md) one at a time. P1 is complete locally; P2 is next when assigned.
4. Use [the demo walkthrough](docs/demo-walkthrough.md) as the acceptance script, not as a claim the demo exists today.

The [architecture](docs/architecture.md), [core schema brief](docs/core-schema.md), [API proposal](docs/api-design.md), and [publishing rules](docs/public-publishing.md) explain the hard boundaries. [Decisions](docs/decisions.md) distinguish requirements from implementation defaults. [VALIDATION.md](VALIDATION.md) states what has actually run.

## Current implementation

The supplied Fastify scaffold provides environment validation, liveness/readiness, generated OpenAPI, standard problem responses, request IDs, redacted logging, PostgreSQL readiness access, and graceful shutdown. P0 adds exact dependency pins, a reviewed npm lockfile, regression coverage, and minimal Node 24/PostgreSQL 17 CI.

P1 adds real local sessions, closed registration, host account commands, and administrator-managed space access. Authorization lives in core operations; Prisma records do not become HTTP DTOs.

**Documents, revisions, publishing, attachments, SSO, API keys, and the frontend are not implemented.** Do not put real documentation into this scaffold or expose it publicly.

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

`npm test` covers configuration and injected HTTP tests. `npm run test:db` requires a real database and fails when it is unavailable. `npm run check` covers typecheck, unit/HTTP tests, and build; it does **not** include the database suite. CI runs both commands and OpenAPI export after `npm ci` and `npm run db:migrate`. `npm ci` regenerates the ignored Prisma client; `db:migrate` applies the single checked-in migration history. Generated OpenAPI describes implemented system and P1 product routes and is written to ignored `artifacts/openapi.json`. There is no bundled interactive API explorer or product UI yet.

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

P1 product routes are `/api/v1/me`, space creation/list/read, and administrator membership PUT/DELETE. Browser writes require the configured `Origin`. Membership writes require the space's strong `ETag` in `If-Match`; missing is 428, stale is 412. Lists use bounded `limit` and UUID `cursor` parameters. See [API details](docs/api-design.md) and [validation/migration notes](VALIDATION.md).

## License

Original project code is licensed under **GNU Affero General Public License version 3 only**, SPDX `AGPL-3.0-only`; see [LICENSE](LICENSE). This program is distributed without warranty, including implied warranties of merchantability or fitness for a particular purpose. See the license for its complete terms. Third-party components retain their own licenses.

`private: true` in package metadata prevents accidental npm publication; it does not make the source proprietary. [Licensing notes](docs/license-recommendation.md) and [CONTRIBUTING.md](CONTRIBUTING.md) describe the release/source-availability policy. No additional non-commercial restriction or trademark policy is imposed by this scaffold.
