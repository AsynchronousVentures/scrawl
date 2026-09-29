# Architecture — a real core with connected capabilities

**Status:** intended boundaries; only system/foundation source exists now.

## One application, explicit composition

```text
HTTP / later web client / local administrative CLI
                 |
     verified principal + application operation
                 |
   core: identity, access, spaces, documents
                 |
       owned queries + transaction
                 |
              PostgreSQL

publishing / search / portability
                 |
        exported authorized core APIs
```

The arrows describe dependencies, not extra services. Keep Fastify and environment setup at the edge. The core owns rules; adapters translate HTTP/storage formats. Capabilities compose those rules rather than maintaining alternative document or authorization models.

Target organization, created only as needed:

```text
src/
  app.ts
  platform/
  core/
    identity/
    access/
    documents/       # includes content and revisions
    attachments/     # P7, not now
  capabilities/
    publishing/      # P5
    search/          # P6
    portability/     # small export in P3; full import/export in P8
web/                 # P4; no package before a real UI exists
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

P5 adds an explicit publication capability. It stores the exact revision and the source document's exposure generation, then resolves a public projection only when the document is active and that generation still matches. The core increments its availability generation when archive invalidates exposure. Unarchive cannot lower the generation.

This is a small lifecycle contract required by an actual capability, not an excuse to add a generation column during identity work. The core never imports publishing tables or an event handler. Anonymous resolution uses an intentionally public-view operation, not an arbitrary trusted-user bypass to private reads. [public-publishing.md](public-publishing.md) defines the state model.

## Contracts and content

Fastify input/output schemas are the HTTP contract; generate OpenAPI from registered schemas. Auth endpoints keep the library's request/response semantics. [S3][S4][S6]

Use a restricted ProseMirror-compatible document schema that runs headlessly. A shared content-schema module can later be consumed by the editor, but it cannot import the database or server-only dependencies. Validate node types, marks, attributes, links, byte/depth/node limits. Do not just accept arbitrary JSON and hope the editor sanitizes it. [S8]

Persist revision snapshots and derive plain text deterministically. HTML is a rendered view, not a second source of truth. Add no collaboration server or CRDT state in these demos.

## Runtime and dependencies

One backend process and PostgreSQL. Add a private file volume in P7. No Redis, queue, vector database, dynamic module loading or microservices. Fastify's built-in plugin registration is sufficient for composing first-party route groups. [S12]

Prisma and Better Auth are not installed in the starting scaffold. Evaluate a version-matched supported pair, record the versions, commit one migration history, and replace the readiness pool coherently rather than keeping redundant database clients accidentally. Better Auth's guide generates schema and delegates migration to Prisma. [S5]

A small exporter does not need an asynchronous job. Large import/export workloads may justify durable jobs later; do not add them before measuring the synchronous limits. Events that must survive crashes require durable delivery when introduced, never a correctness-critical in-memory emitter.

## Definition of a successful boundary

Turning off publishing leaves private creation, saves, history and export fully usable. Adding a publication creates no second document table. Neither the browser nor publishing can bypass the core's ownership/version/lifecycle checks. Tests demonstrate these properties; directories alone do not.
