# P0 validation

Recorded 2026-09-29. Scrawl's supplied foundation is verified locally. Product packets P1 onward remain proposals; this is not a release approval.

## Environment and dependency pins

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

## Commands and observed results

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

## Foundation fixes and housekeeping

- The request serializer now always returns a string URL, satisfying strict indexed-access checking without logging query strings.
- The error handler narrows unknown errors before accessing Fastify fields. Unexpected-error logging uses a fixed message rather than an arbitrary error name.
- Package/OpenAPI identity and current planning documents now name Scrawl, repository `scrawl`.
- The archive-only SHA256SUMS manifest was verified before edits and removed because its checksums would be stale after implementation. LICENSE itself is unchanged.
- Task-created PostgreSQL container, network, and empty test volume were removed after checks. Temporary probe logs and generated OpenAPI/build output were removed. Installed project dependencies and ignored local `.env` remain for development.

LICENSE SHA-256 remains `0d96a4ff68ad6d4b6f1f30f713b18d5184912ba8dd389f86aa7710db079abcb0`.

## Limits and next packet

No local P0 blocker remains. Hosted CI has not run; the workflow definition was parsed and its check commands passed locally. No remote repository, public source URL, deployment, hosted integration, or external write was created.

No schema or migration changes occurred. Prisma, real identity/access, documents/revisions, publishing, frontend flows, and backup/restore remain unimplemented and unverified. Network source/license delivery and a private security-reporting channel remain release requirements, with a checklist in [licensing notes](docs/license-recommendation.md).

Stop after P0 for review. The next bounded assignment is [P1: identity, Prisma and space access](docs/backlog.md#p1--real-identity-prisma-and-space-access).
