# Scrawl demo-first build plan

**Owner:** Asynchronous Ventures

**Project:** Scrawl (`scrawl`)

**License:** AGPL-3.0-only

**Revision:** 5, 2026-09-30

**Status:** P0-P4 are completed historical checkpoints. The integration branch adds native BlockNote, private attachments/export, PostgreSQL 18/search and selected-revision publishing. [Status](status.md) and [validation](../VALIDATION.md) separate implemented and verified behavior from remaining work.

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
| Contributor preview / v0.1 candidate | Search, optional document hierarchy, private images, portability, onboarding/recovery, packaging and operational checks | Find only authorized content, export/import, restore an instance, and upgrade from the previous schema. | P6–P9 |

A local demo is not a production release. Demos use synthetic documents and files without requiring email delivery, an external IdP or vendor accounts. Authentication and permissions are real. These gates remain acceptance checkpoints; the maintainer authorized the current integration session to continue across the earlier packet review boundaries.

## 3. Scope discipline

**Required for Demo A:** current scaffold verification; Prisma/PostgreSQL; maintained authentication with closed registration; explicit local owner bootstrap; administrator-provisioned demo users; reader/editor space access; validated text documents; create/read/update; revision list/read/restore; archive/unarchive; bounded listings; native JSON export; generated OpenAPI; error and permission tests.

**Add for Demo B:** React/Vite; BlockNote's standard editor and official shadcn UI; explicit Save; navigation; history; conflict comparison preserving local edits; accessible loading/error/empty states. Use the API, including authentication. No frontend database access or duplicated business permissions. Preserve the approved charcoal/sage document layout.

**Add for Demo C:** disabled-by-default publishing; administrator publish/unpublish; selected revision and safe public DTO; anonymous read-only page; no accidental republication after archive/unarchive; source/license access in the interface before network distribution.

**Separate future work:** same-space document hierarchies, full native import/export, release backup/recovery/upgrade runbooks, usable team onboarding, and an optional identity-provider integration when assigned. Search and private files are part of the current integration sequence.

**Excluded from this product direction:** tenants, billing, subscriptions, license activation, paid editions, entitlements, and seat accounting.

**Outside the integration scope:** chat connectors, proposal/approval workflows, embedding search, arbitrary custom blocks, groups/SCIM, per-document private ACL exceptions, scheduled or expiring shares, custom domains, theme builder, webhooks, Redis, queues, plugin marketplace, event bus, microservices, and a generic plugin SDK. Use the available OSS BlockNote packages for the assigned document integrations rather than rebuilding their behavior.

## BlockNote implementation sequence

The maintainer's BlockNote decision supersedes the earlier editor restrictions and the feature ordering where it conflicts. Historical P0-P4 acceptance remains useful.

1. **Native private-document foundation:** all standard BlockNote blocks/styles and official shadcn UI, strict native validation/server utilities, persistence, heading outline, rendering, revisions/restore, native export, and explicit save/undo/discard/conflict protections. Preserve retained source content and history. Rehearse finite conversion only on disposable copies, with a private original-data archive before applying it; ask before changing or resetting retained data.
2. **Private attachments and supplied exporters:** native upload/resolution hooks backed by immutable document-owned bytes and revision reference retention; authorized offline PDF/DOCX exports through the OSS XL packages. Disable vendor asset proxies and arbitrary external fetching. Multi-column layouts or further exporters need matching versioned native validation/rendering and a verified available OSS package; they are not implied by the current PDF/DOCX paths. Record quota, orphan recovery and retention limits before broad use.
3. **PostgreSQL 18 and search:** a fresh 18 volume with retained 17 compatibility; weighted indexed search over current saved authorized content, then the real keyboard-accessible search dialog. Never attach a 17 volume to an 18 image. Rehearse upgrades on disposable copies, keeping the original database and volume intact.
4. **Selected-revision publishing:** administrator approval under the document ETag, exact attachment allowlists, an anonymous read-only projection and immediate revocation. Publishing defaults off. Private saves never advance public content; archive invalidates old approval even after unarchive.
5. **Isolated collaboration and comments:** durable server-authorized Yjs state, immutable checkpoints, restore epochs and user-scoped undo, followed by supplied comment stores/UI with server-checked mutations. Implement and test [the live-state contract](adr/0003-collaboration-checkpoints.md) before enabling live sessions. Incomplete work stays isolated and unavailable in the working demo.
6. **Optional AI:** an opt-in provider integration through the supplied accept/reject UI and authorized editing operations, after the document contracts are stable. No provider is required to run Scrawl. Missing provider access is not a blocker, and this session does not authorize paid provider calls.

[The integration backlog](integration-backlog.md) tracks priorities, dependencies and actual branch status. The maintainer authorized reviewable commits, integration-branch pushes and a draft PR for this session. No merge, public tunnel or production deployment is authorized. Document hierarchies, full portability and release hardening remain separate work.

## 4. Stack and version policy

Use TypeScript, Node.js 24, Fastify, PostgreSQL 18 and Prisma, retaining PostgreSQL 17 compatibility. Keep npm and the existing backend and React/Vite `web/` packages. The application serves its built frontend and API on one origin; Vite development uses the same-origin proxy.

Fastify route schemas own validation and HTTP serialization; generate OpenAPI from them. A typed JSON Schema helper is acceptable when it reduces duplication. Database models are not response DTOs. [S3][S4]

Retain the tested Better Auth/Prisma/Fastify baseline and version-matched documentation. Change a pin only for a demonstrated blocker or security requirement, with observed compatibility checks; do not mix ORM majors or hand-write an authentication adapter. [S5][S6][S7]

P1 retains Fastify, Swagger generation, and `pg`, and pins Better Auth 1.7.6 with Prisma/client/adapter-pg 7.10.0. Compatibility and targeted transitive advisory fixes are recorded in [VALIDATION.md](../VALIDATION.md). One migration history owns the entire schema. Auth model generation feeds reviewed Prisma migrations rather than a second migration engine. [S5]

Use BlockNote 0.55.0 native blocks with Scrawl's explicit schema/version metadata and official server utilities. Keep strict security/resource validation without reducing its standard editing schema. Core/React/shadcn/server-util are MPL-2.0; later XL packages use their GPL OSS licensing path. Backend pins remain unchanged. Native JSON snapshots do not replace the durable Yjs state required by future collaboration. See [the foundation decision](adr/0001-native-blocknote-documents.md).

## 5. The core/capability boundary

**Platform:** environment, process lifecycle, database connection lifecycle, HTTP setup, request context, logging.

**Core:** authentication boundary, access, spaces, document identity, native content validation, revision history, lifecycle, attachment ownership and the authoritative search/publication read policies.

**Capabilities:** supplied exporters, selected-revision publishing, and later document integrations. Capabilities call exported authorized core operations and own their additional behavior and records. Publishing owns grant writes through a narrowly scoped trusted transaction callback; core purpose-specific reads enforce the grant, lifecycle and selected-revision/file visibility. There is no reverse import from core to capability code. See [ADR 0002](adr/0002-integration-storage-and-publication.md).

Keep one application with explicit dependency injection and ordinary module registration. Do not build a service locator, plugin manifest, hook bus, or BaseRepository. Extract shared behavior when it is real; do not introduce interfaces around every function. Details and transaction coordination are in [architecture.md](architecture.md).

## 6. Initial domain decisions

| Entity | Responsibility |
| --- | --- |
| Auth-owned user/session/account records | Library-managed credentials and sessions; stable user ID; server-controlled instance role |
| Space and membership | Explicit reader/editor access; instance administrators are privileged across all spaces |
| Document | Stable ID, space, current revision reference, lock version, archive state and monotonic availability version |
| DocumentRevision | Immutable numbered title/body snapshot with author/time/change note |
| Publication | Selected revision, public identifier, publisher/time and revocation/lifecycle grant |
| Attachment and revision reference | Immutable document-owned bytes/private metadata and exact historical retention/visibility |

No second tenant/user system. Users are not automatically members of all spaces. Documents may start at a space root; document hierarchy is added only with its cycle and visibility rules. Title/body belong to the revision, not competing copies on document and revision rows. [core-schema.md](core-schema.md) records the initial constraints.

An internal save is visible to authorized teammates immediately. It is not a private personal draft or a public publish. Use explicit Save initially; delay autosave until revision and failure behavior are decided.

Restoring revision 2 when the current revision is 5 produces revision 6 containing restored content. Metadata-only changes increment the document lock version without inventing a content revision. No hard delete in the demos.

## 7. API correctness rules

Use `/api/v1` for private product routes, `/api/public` for intentionally anonymous publication reads, and the auth library's separate route namespace. IDs are strings, dates UTC ISO strings, content validated native JSON. Return explicit DTOs and standard problem responses; do not send ORM records, stack traces, SQL, or hidden fields. Bound bodies, page sizes, cursors and queries.

Require one strong server-issued ETag in `If-Match` for existing-resource mutations. Missing precondition: 428. Stale precondition: 412. Validate access before revealing existence/version. Atomically check the version, insert the revision, and advance the head. HTTP headers without a conditional database write are not concurrency protection. [S9][S10]

Use real PostgreSQL for authorization, migration, concurrency, rollback and publication tests. A mocked ORM cannot demonstrate these guarantees. Current Prisma documentation describes transaction support; select the exact API for the pinned major. [S7]

Revocation, archive and unpublish are synchronous correctness boundaries, not eventually delivered events. Read operations filter by visibility before returning titles, snippets, counts, history or attachments. Queries and internal callers use the same policy.

Native export is a document format, not a database backup. Whole-instance backup and content portability are separate P8/P9 deliverables. Imported documents start private and do not silently re-create public grants.

## 8. Security and local-demo defaults

Use real library-managed credentials/sessions, closed registration, explicit owner bootstrap, and admin-created users through a small local command. No SMTP or IdP is required for Demo A. No magic user headers, fixed admin passwords, permissive signup fields, anonymous writes, or frontend role assertions. Initial recovery requires trusted host/operator access and the library's supported account/session APIs.

Default to loopback, same-origin and synthetic fixtures. Preserve CSRF/origin enforcement, secure production cookies, rate limits and session revocation. Never log secrets, credentials, request bodies or document content. No remote fetching of URLs embedded in content. Private attachments are never mounted as a static public directory. `PUBLIC_PUBLISHING_ENABLED=false` is the default; enabling it alone grants no document access.

The application must remain usable without an AI provider or any account with the project maintainer. No telemetry or outbound vendor calls by default.

## 9. Agent workflow

Work in small reviewable commits through the currently authorized integration sequence. Historical packet boundaries remain useful regression and review checkpoints, not mandatory stops for this session. Report changed files, migration effects, actual commands/results and unresolved risks at each milestone. A failed check is work to resolve, not a reason to disable the check.

P0 verified the supplied foundation and established pins/CI; P1 proved the ORM/auth integration. Their completed scope remains historical. The expanded integration authorization does not include unrelated roadmap work, merging, a public tunnel or production deployment. Preserve retained data and the approved prototype; ask before a destructive reset.

Keep status truthful in [status.md](status.md); proposed API tables must not be copied into live OpenAPI as implemented endpoints. Dependencies and schemas should appear only when the assigned packet needs them.

## 10. License and release scope

Use the included AGPL-3.0 text and `AGPL-3.0-only` metadata for original project code. The `only` choice is an explicit packaging default, not permission to adopt unknown future license versions. No custom non-commercial restriction is added. Preserve third-party notices and verify dependency compatibility. [S1][S2]

Provide a discoverable license/source location for the actual running build before sharing a network demo or release; include corresponding build/install sources, not users' documents or secrets. A link to unrelated upstream code or a stale version is not enough for modified deployments. See [licensing notes](license-recommendation.md). [S1]

The product is Scrawl and its repository is [AsynchronousVentures/scrawl](https://github.com/AsynchronousVentures/scrawl). Security reporting and release-operation requirements must be settled before a public release; they do not block the authorized local integration demo.
