# Validation

## P2, verified locally on 2026-09-30

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
