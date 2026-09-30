# Scrawl demo-first build plan

**Owner:** Asynchronous Ventures

**Project:** Scrawl (`scrawl`)

**License:** AGPL-3.0-only

**Revision:** 3, 2026-09-29

**Status:** P1 identity/access implemented and verified locally; subsequent packets remain planned

## 1. What we are building

A self-hosted documentation platform that makes shared knowledge easy to write, find, revise, and selectively publish. It should feel like a modern document tool, not a taxonomy exercise. Its API is a supported product boundary, not a private transport for one frontend.

One installation supports multiple users and spaces. Private/team content is the default. Public publishing is explicit and exposes a selected immutable revision, not whatever an editor most recently saved. All first-party product functionality is OSS; no hosted control plane is necessary to run it.

Build a **working document loop** first: sign in, create a page, save a revision, reject a stale edit, read history, restore as a new revision, and deny an unrelated user. Then put a thin UI on that loop. Backend-first means the API and rules precede each screen, not that every backend feature must be finished before anyone can click a page.

## 2. Three demos, then a release gate

| Gate | Deliverable | Demonstration | Packets |
| --- | --- | --- | --- |
| Demo A: API core | Real sessions, spaces, pages, immutable revisions, conditional writes, basic native export | Two editors race; only one save wins. Restore adds history. Reader and outsider restrictions hold. | P0–P3 |
| Demo B: usable private wiki | Minimal login, space/page navigation, editor, history and conflict handling | Complete the same workflow in two browser windows without losing unsaved text. | P4 |
| Demo C: connected publishing | First built-in capability plus public view | Publish revision 2; save private revision 3; anonymous readers still see 2; unpublish revokes access. | P5 |
| Contributor preview / v0.1 candidate | Search, optional nesting, private images, portability, onboarding/recovery, packaging and operational checks | Find only authorized content, export/import, restore an instance, and upgrade from the previous schema. | P6–P9 |

A local demo is not a production release. P0–P5 use synthetic data and do not require email delivery, an external IdP, uploads, or vendor accounts. Authentication and permissions are real, not demo bypasses. The maintainer can stop after any demo and adjust UX without redesigning data integrity.

## 3. Scope discipline

**Required for Demo A:** current scaffold verification; Prisma/PostgreSQL; maintained authentication with closed registration; explicit local owner bootstrap; administrator-provisioned demo users; reader/editor space access; validated text documents; create/read/update; revision list/read/restore; archive/unarchive; bounded listings; native JSON export; generated OpenAPI; error and permission tests.

**Add for Demo B:** React/Vite; a restricted Tiptap-compatible editor; explicit Save; navigation; history; conflict dialog preserving local edits; accessible loading/error/empty states. Use the API, including authentication. No frontend database access or duplicated business permissions.

**Add for Demo C:** disabled-by-default publishing; administrator publish/unpublish; selected revision and safe public DTO; anonymous read-only page; no accidental republication after archive/unarchive; source/license access in the interface before network distribution.

**Deferred to P6–P9:** PostgreSQL search, same-space nesting, images/files, full native import/export, recovery/upgrade runbooks, usable team onboarding, and a documented optional identity-provider integration when needed.

**Excluded from this product direction:** tenants, billing, subscriptions, license activation, paid editions, entitlements, and seat accounting.

**Not part of these demos:** AI, chat connectors, proposal/approval workflows, comments, collaborative editing, autosave, embedding search, arbitrary HTML, custom blocks, groups/SCIM, per-document private ACL exceptions, scheduled or expiring shares, custom domains, theme builder, webhooks, Redis, queues, plugin marketplace, event bus, microservices, and a generic plugin SDK. These are not reserved features or empty tables; implement none until a concrete need appears.

## 4. Stack and version policy

Use TypeScript, Node.js 24, Fastify, PostgreSQL, and Prisma. Keep npm and the current backend package layout; do not change tooling merely for preference. Add a small `web/` package only when P4 actually introduces a frontend. The deployed product can serve its built frontend and API on one origin.

Fastify route schemas own validation and HTTP serialization; generate OpenAPI from them. A typed JSON Schema helper is acceptable when it reduces duplication. Database models are not response DTOs. [S3][S4]

Use Better Auth as the first authentication candidate. Its official integration guides cover Fastify and Prisma, but the real combination must be tested. Its current Prisma guide uses version 7, while current Prisma documentation also describes version 8 with different APIs. Start by evaluating a supported, security-maintained Prisma 7 / Better Auth combination matching that guide; do not silently mix majors. If that baseline is not suitable, stop and record a supported alternative rather than hand-writing an authentication adapter. Pin exact verified versions and use matching docs. [S5][S6][S7]

P1 retains Fastify, Swagger generation, and `pg`, and pins Better Auth 1.7.6 with Prisma/client/adapter-pg 7.10.0. Compatibility and targeted transitive advisory fixes are recorded in [VALIDATION.md](../VALIDATION.md). One migration history owns the entire schema. Auth model generation feeds reviewed Prisma migrations rather than a second migration engine. [S5]

Use a restricted Tiptap/ProseMirror-compatible JSON body, validated on the server and versioned independently of the API. Existing libraries supply the editor and schema primitives; custom code defines product rules. JSON persistence is not a promise of future collaborative editing support. [S8]

## 5. The core/capability boundary

**Platform:** environment, process lifecycle, database connection lifecycle, HTTP setup, request context, logging.

**Core:** authentication boundary, access, spaces, document identity, supported content schema, revision history, lifecycle; attachment ownership when introduced.

**Capabilities:** publishing first, then search and portability; later integrations only when assigned. Capabilities call exported authorized core operations and own only their additional records/behavior. They cannot sidestep permissions by querying or mutating core tables through an unrestricted database handle.

Keep one application with explicit dependency injection and ordinary module registration. Do not build a service locator, plugin manifest, hook bus, or BaseRepository. Extract shared behavior when it is real; do not introduce interfaces around every function. Details and transaction coordination are in [architecture.md](architecture.md).

## 6. Initial domain decisions

| Entity | Responsibility |
| --- | --- |
| Auth-owned user/session/account records | Library-managed credentials and sessions; stable user ID; server-controlled instance role |
| Space and membership | Explicit reader/editor access; instance administrators are privileged across all spaces |
| Document | Stable ID, space, current revision reference, lock version, archive state |
| DocumentRevision | Immutable numbered title/body snapshot with author/time/change note |
| Publication, introduced in P5 | Selected revision, public identifier, publisher/time and revocation/lifecycle grant |
| Attachment, introduced in P7 | Immutable document-owned bytes and private metadata |

No second tenant/user system. Users are not automatically members of all spaces. Documents may start at a space root; nesting is added only with its cycle and visibility rules. Title/body belong to the revision, not competing copies on document and revision rows. [core-schema.md](core-schema.md) records the initial constraints.

An internal save is visible to authorized teammates immediately. It is not a private personal draft or a public publish. Use explicit Save initially; delay autosave until revision and failure behavior are decided.

Restoring revision 2 when the current revision is 5 produces revision 6 containing restored content. Metadata-only changes increment the document lock version without inventing a content revision. No hard delete in the demos.

## 7. API correctness rules

Use `/api/v1` for product routes and the auth library's separate route namespace. IDs are strings, dates UTC ISO strings, content validated JSON. Return explicit DTOs and standard problem responses; do not send ORM records, stack traces, SQL, or hidden fields. Bound bodies, page sizes, cursors and queries.

Require one strong server-issued ETag in `If-Match` for existing-resource mutations. Missing precondition: 428. Stale precondition: 412. Validate access before revealing existence/version. Atomically check the version, insert the revision, and advance the head. HTTP headers without a conditional database write are not concurrency protection. [S9][S10]

Use real PostgreSQL for authorization, migration, concurrency, rollback and publication tests. A mocked ORM cannot demonstrate these guarantees. Current Prisma documentation describes transaction support; select the exact API for the pinned major. [S7]

Revocation, archive and unpublish are synchronous correctness boundaries, not eventually delivered events. Read operations filter by visibility before returning titles, snippets, counts, history or attachments. Queries and internal callers use the same policy.

Native export is a document format, not a database backup. Whole-instance backup and content portability are separate P8/P9 deliverables. Imported documents start private and do not silently re-create public grants.

## 8. Security and local-demo defaults

Use real library-managed credentials/sessions, closed registration, explicit owner bootstrap, and admin-created users through a small local command. No SMTP or IdP is required for Demo A. No magic user headers, fixed admin passwords, permissive signup fields, anonymous writes, or frontend role assertions. Initial recovery requires trusted host/operator access and the library's supported account/session APIs.

Default to loopback, same-origin and synthetic fixtures. Preserve CSRF/origin enforcement, secure production cookies, rate limits and session revocation. Never log secrets, credentials, request bodies or document content. No remote fetching of URLs embedded in content. Private attachments, once implemented, are never mounted as a static public directory.

The application must remain usable without an AI provider or any account with the project maintainer. No telemetry or outbound vendor calls by default.

## 9. Agent workflow

Work from one packet at a time. Report changed files, migration effects, commands/results, unresolved risks, and the next packet. The maintainer decides when to proceed. A failed check is work to resolve, not a reason to disable the check.

P0 is intentionally short: verify the existing foundation, pin the existing dependencies, and establish CI. P1 handles the ORM/auth integration. Neither packet is permission to implement the whole roadmap. Do not create/push a remote repository, upload source, apply hosted-service integrations, or deploy publicly without a separate request.

Keep status truthful in [status.md](status.md); proposed API tables must not be copied into live OpenAPI as implemented endpoints. Dependencies and schemas should appear only when the assigned packet needs them.

## 10. License and release scope

Use the included AGPL-3.0 text and `AGPL-3.0-only` metadata for original project code. The `only` choice is an explicit packaging default, not permission to adopt unknown future license versions. No custom non-commercial restriction is added. Preserve third-party notices and verify dependency compatibility. [S1][S2]

Provide a discoverable license/source location for the actual running build before sharing a network demo or release; include corresponding build/install sources, not users' documents or secrets. A link to unrelated upstream code or a stale version is not enough for modified deployments. See [licensing notes](license-recommendation.md). [S1]

The product is Scrawl and the repository is named `scrawl`. The public repository URL, security-reporting address and release infrastructure are still undecided. They must be supplied before public release, but none blocks local demo work.
