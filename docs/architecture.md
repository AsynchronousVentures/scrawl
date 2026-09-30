# Architecture: a real core with connected capabilities

The integration branch implements private native documents, identity/space access, immutable revisions, attachments, search, native/PDF/DOCX export, and selected-revision publishing. Publishing is disabled by default. [VALIDATION.md](../VALIDATION.md) records checks actually run; collaboration/comments and optional AI remain future work.

## One application, explicit composition

```text
HTTP / React web client / local administrative CLI
                 |
     verified principal + application operation
                 |
   core: identity, spaces, documents, attachments, search
                 |
       owned queries + transaction
                 |
              PostgreSQL

publishing / rendered export
                 |
        exported authorized core APIs
```

The arrows describe dependencies, not extra services. Keep Fastify and environment setup at the edge. The core owns rules; adapters translate HTTP/storage formats. Capabilities compose those rules rather than maintaining alternative document or authorization models.

Implemented organization:

```text
src/
  app.ts
  http/
  core/
    identity/
    spaces/
    documents/       # includes content and revisions
    attachments/
    search/
  capabilities/
    publishing/
    exporting/       # PDF/DOCX; native JSON remains a core operation
  shared/            # browser-safe native content contract
web/                 # React/Vite and generated OpenAPI client
```

Keep each module's contracts, operations, persistence and tests close together. One module entry point exports its supported operations. Do not impose a uniform five-layer hierarchy on trivial code. The API DTO layer is still explicit even when a single small mapper handles it.

## Rules for modules

A capability calls `documents.readRevision(...)` or a purpose-specific publication-candidate operation; it does not call `prisma.documentRevision.findMany(...)` from arbitrary code. Exported operations establish/recheck authorization and return purpose-specific values. A user ID in an HTTP request is never the actor.

Use a narrowly scoped explicit repository/query interface only where a real consumer needs it. No generic ORM wrapper, service locator or globally available bag of services. The application composition root supplies each capability's actual dependencies.

Prisma types and transaction implementations stay out of HTTP schemas and generated clients. An internal transaction context may be shared between trusted persistence operations where one atomic use case crosses modules. Do not open separate nested transactions and claim they commit together. Exact client mechanics depend on the verified Prisma version. [S7]

Enforce import boundaries for modules that exist; a small linter rule is enough initially. Allow reviewed cross-module read models only through a named interface with a visibility policy. This is a development boundary, not a sandbox for untrusted code in the same process.

## Transactions and authorization

For the demo, use a deliberately simple locking policy instead of a policy engine. All permission-changing and document-mutating operations in a space acquire the space row lock first, recheck the actor's effective membership, then lock the relevant document. Publication records are locked after the document. Use the same order in every operation.

Membership changes also lock that space row. This serializes an in-flight write relative to a revocation. A write already ordered before revocation may finish; a write ordered after it must fail. Reads started before revocation may complete, but new reads must use committed visibility, not membership cached indefinitely in a session. Document this boundary and test it with real overlapping transactions.

Space-wide write serialization is an intentional demo simplification, not a scalability claim. Replace it with a narrower tested scheme only when measurements or workload justify it. The core API contract must not depend on the lock implementation.

A content save checks the expected document version and creates/advances the revision atomically. A failed conditional write creates no orphan revision. A publication change and its document version bump also commit together. No network calls inside these transactions.

## Publishing without a reverse dependency

The optional publication capability stores one approved immutable revision and the source document's availability generation. Public resolution requires an active grant, a nonarchived document, and a matching generation. Archive increments `availabilityVersion`; unarchive leaves it unchanged, so an old grant cannot revive. Private saves never advance the public snapshot.

The capability owns grant writes through a trusted callback inside the core's locked document transaction. Core purpose-specific reads query the grant, lifecycle, selected revision, and attachment allowlist together. They never substitute the current private head or impersonate a trusted user. Core imports no publishing capability code. [ADR 0002](adr/0002-integration-storage-and-publication.md) records this explicit adjustment to the earlier prohibition on core publication-table queries; [public-publishing.md](public-publishing.md) defines the state model.

Anonymous DTOs contain only the approved title, native content, and publication time. Approved attachment URLs are rewritten in the public response, without changing the immutable private snapshot. Public file reads use the same active grant and selected revision's normalized references. Global disablement pauses public reads and publication writes while private workflows remain usable.

## Contracts and content

Fastify input/output schemas are the HTTP contract; generate OpenAPI from registered schemas. Auth endpoints keep the library's request/response semantics. [S3][S4][S6]

Use BlockNote's native standard blocks and supplied shadcn UI. The shared content contract remains browser-safe and imports official core schema/conversion utilities only; it cannot import Prisma, Fastify, server-util or jsdom. The backend content adapter performs a second official server-utility round trip after strict shared validation. Unknown content and unsafe URLs are rejected before permissive conversion can discard anything.

Persist `{format: "blocknote-json", schemaVersion: 1, editorVersion: "0.55.0", document: Block[]}` as immutable snapshots and derive plain text deterministically. HTML is a rendered view, not another source of truth. Existing restricted ProseMirror snapshots require an explicit offline preservation/conversion operation; startup and reads never silently migrate content or rewrite history. [ADR 0001](adr/0001-native-blocknote-documents.md) records this finite transition.

Attachments have immutable document-owned metadata and private bytes. Saved references are normalized into `RevisionAttachment`, whose composite foreign keys enforce same-document ownership. Removing a block does not delete historical bytes. Uploading a file does not create a revision or advance the document ETag, and discarding a local draft does not undo its upload. A failed upload removes only confirmed uncommitted bytes; ambiguous commit acknowledgements retain private bytes for explicit review.

Search is a core authorized read over current nonarchived revision heads. A stored generated weighted title/body vector and GIN index are derived data. Current session, role, and space membership are checked in the same SQL statement before matching, ranking, excerpts, or limits. The language-neutral `simple` dictionary does not imply English stemming. Reindexing does not rewrite immutable revisions.

## Runtime and dependencies

One backend process, PostgreSQL, and a private attachment directory outside frontend assets. Fresh development uses PostgreSQL 18; PostgreSQL 17 remains a compatibility target, with one Prisma migration history. No Redis, queue, vector database, dynamic module loading or microservices. Fastify's built-in plugin registration composes first-party route groups. [S12]

P1 uses Better Auth 1.7.6 and Prisma 7.10.0, with one pg pool shared by Prisma and readiness. Better Auth's generated auth model layout feeds the reviewed Prisma migration history; no second migration engine is used. Core identity resolves real sessions and rechecks current sessions/roles after transaction locks. Core spaces owns visibility queries and membership transactions. Core documents consumes those authorized space operations, owns document/revision transactions, and uses the browser-safe native content contract and a server-utility adapter. HTTP adapters only validate, translate, and serialize explicit DTOs. [S5]

Native export is an authorized current snapshot. PDF/DOCX exporters use the official BlockNote OSS mappings, bundled fonts/WASM, and permission-checked private images. They reject external media rather than fetch it and recheck authorization after rendering. A bounded synchronous exporter does not need an asynchronous job. Large import/export workloads may justify durable jobs later. Events that must survive crashes require durable delivery when introduced, never a correctness-critical in-memory emitter.

## Future integration boundaries

[ADR 0003](adr/0003-collaboration-checkpoints.md) resolves the proposed collaboration storage boundary: durable private Yjs live state and comments are separate from immutable explicit-save checkpoints. Search, exports, and publications consume checkpoints; local undo/discard must not overwrite another author's changes. Upstream experiments establish library behavior, not a working Scrawl collaboration runtime. Authenticated connections, durable persistence, checkpoint/restore, reconnect, and revocation remain implementation and acceptance gates before enabling that isolated capability. Optional AI follows this foundation and is not required for private workflows.

## Definition of a successful boundary

Turning off publishing leaves private creation, saves, history and export fully usable. Adding a publication creates no second document table. Neither the browser nor publishing can bypass the core's ownership/version/lifecycle checks. Tests demonstrate these properties; directories alone do not.
