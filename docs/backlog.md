# Demo work packets

P0-P4 below record the completed historical checkpoints and their acceptance criteria. [Status](status.md) distinguishes current implementation from verified behavior. The maintainer authorized this integration session to cross the earlier packet review boundaries, using small reviewable commits rather than another redesign. No calendar estimates are implied.

The current dependency sequence is native BlockNote/private workflow, private attachments and supplied exporters, PostgreSQL 18 with 17 compatibility and authorized search, selected-revision publishing, isolated durable collaboration/comments, then optional AI. [The integration backlog](integration-backlog.md) tracks that work and its review state. The historical packet numbering does not override this sequence. Integration-branch pushes and a draft PR are authorized; merging, a public tunnel and production deployment are not.

## P0 — Verify and lock the existing foundation

**Depends on:** nothing. **Goal:** a trustworthy starting commit.

Read README/VALIDATION, run the existing source on Node 24, resolve compatible dependencies, commit the first lockfile, and add minimal CI with PostgreSQL. Verify the standard AGPL file and package metadata. Document exact commands and observed results. Keep existing npm scripts unless a change solves a real problem.

**Acceptance:** install from lockfile; full typecheck/build; config/HTTP tests; actual database readiness test; generated OpenAPI contains only implemented routes. No credentials or generated database contents in Git. A source/license release checklist exists; no invented repository/source URL.

**Do not build:** auth, Prisma domain models, UI, document routes, generic scaffolding generators.

**Handoff:** [first-packet.md](agents/first-packet.md).

## P1 — Real identity, Prisma and space access

**Depends on:** P0. **Goal:** real authenticated access without an external service.

Prove a maintained, supported Better Auth/Prisma combination with Fastify/PostgreSQL, select exact pins and version-matched documentation, and commit the initial migrations. Begin with local library-managed credentials and sessions, closed registration and an operator CLI to bootstrap the initial admin and create synthetic users. CLI secrets are hidden-input or generated, never flags saved in shell history or fixed shared passwords. Prove a recovery command using supported library APIs, including session revocation. Do not hand-write hashing or OAuth.

Add `/api/v1/me`, administrator space creation, access-filtered listing/read, and administrator membership grant/revoke. Keep role assignment server-side. Test actual session cookies, allowed origins/CSRF, logout and revocation. Keep one migration engine. Replace or integrate the old readiness pool deliberately.

**Acceptance:** migration from empty DB; bootstrap cannot overwrite/seize an existing instance; reader can read an assigned space but cannot administer; editor cannot self-promote; outsider cannot discover it; anonymous is denied. Auth DTOs and logs contain no credentials. A revoked user cannot make a subsequent authorized request. Concurrent membership changes cannot silently overwrite.

**Do not build:** OIDC/SSO UI, mail service, invite campaigns, organization/tenant plugins, API keys, documents.

## P2 — Content schema, documents and safe revisions

**Depends on:** P1. **Goal:** the reusable document engine.

The original P2 checkpoint proved headless validation/text extraction/native round trip for a small ProseMirror-compatible schema: paragraphs, headings, basic marks, bullet/ordered lists, links and code blocks. The native BlockNote foundation supersedes those feature restrictions while preserving strict URL/resource validation and rejecting unknown or lossy content. This section records the original document-engine guarantees, not a restriction on the current native editor.

Add document/revision migrations and commit-time head integrity; create/list/read/update; current ETag; immutable revision list/read/restore; archive/unarchive. Restrict updates to documented fields. Title/body snapshots are authoritative. Review parent/archive semantics only when document hierarchies are introduced later.

**Acceptance:** real concurrent requests with the same ETag yield one save and one 412; missing precondition yields 428; forced mid-write failure creates no orphan/head mismatch; restored content receives a new revision number; revision IDs cannot cross documents; outsider gets no title/version; reader cannot mutate; unsupported nodes and oversized bodies fail safely.

**Do not build:** publication, autosave, branches, collaboration, comments, nested page UI, schema extensibility framework.

## P3 — Demo A harness and minimal export

**Depends on:** P2. **Goal:** a repeatable, headless product demo.

Build a small demo runner using actual HTTP authentication, synthetic fixtures and cookie isolation. Its seed/reset command is explicit, development-only, and refuses production/non-demo targets; never reset a database merely because the command was run. Provide native single-document export with content format/version and provenance, but no password/session/secret data. Generate OpenAPI from real routes. An interactive API explorer may be added locally, not exposed by default.

**Acceptance:** run [demo-walkthrough.md](demo-walkthrough.md) Demo A from a fresh migrated database; tests assert denials and stale writes rather than just printing requests. Exported content validates through the same parser. Create actions are not automatically retried. Record fixture identities but do not commit real credentials.

**Historical review checkpoint:** demonstrate the API before adding the original UI. Demo A remains a required regression in the integration sequence.

## P4 — Demo B, thin private-document UI

**Depends on:** P3. **Goal:** a usable private document loop, not a design-system project.

Add a React/Vite frontend and a typed client generated from live OpenAPI. Auth may use the official library client. Develop on a same-origin proxy; the deployed build should be served on the app origin. Use existing accessible components and the supported editor library. Keep navigation simple: space switcher, page list, document pane, Save, history, and archive action.

Add explicit save feedback, dirty state/navigation warning and a 412 conflict view that preserves the unsaved local document. Show the latest server version separately and require a deliberate retry/reconciliation. Never silently overwrite or replace local edits. Reader mode disables edits but relies on server authorization, not disabled buttons alone.

**Acceptance:** browser tests for login, create/edit, reload/persistence, history, restore-as-new, reader denial, two-tab collision without content loss, loading/error/empty states, and keyboard access. The UI accesses no Prisma/server internals. Native export is usable.

**Do not build:** auto-save, multiplayer cursors, page designer, public branding, AI toolbar, widget dashboard or a component-library rewrite.

## N1: native BlockNote foundation after P4

The maintainer approved BlockNote and its official shadcn integration as the document foundation. This supersedes the earlier restricted editor/schema and feature ordering. Preserve P0-P4 authorization, concurrency, rollback, immutable history and draft protections.

Use all standard native blocks/styles, official shadcn editing UI and server conversion utilities. Version the native `Block[]` contract explicitly; update validation, persistence, reading/editing, nested heading outline, history/restore and native JSON export together. Prove safe rich editing through real sessions and PostgreSQL. Checkpoint the old baseline and preserve every existing snapshot with a private original-data archive before an explicit transactional format conversion. Rehearse on disposable copies; do not change the retained PostgreSQL 17 database or volume. Ask before changing or resetting real data. No permanent runtime compatibility layer for prototype fixtures is needed.

**Acceptance:** standard blocks/styles, tables and nested content round-trip without dropped data; rich UI/links/keyboard undo work; explicit Save and Discard retain their revision semantics; reload/history/restore/export use native content; stale writes retain complete drafts; authorization and all earlier transaction tests remain effective. Capture actual application evidence and keep this foundation reviewable while continuing the authorized integration sequence.

**Following sequence:** private attachments and OSS PDF/DOCX exporters; PostgreSQL 18 and indexed authorized search; selected-snapshot publishing; isolated durable Yjs collaboration then supplied comments; optional provider-backed AI. [ADR 0003](adr/0003-collaboration-checkpoints.md) resolves live storage, checkpoints, scoped undo/discard, restore epochs and publication before collaboration wiring. [ADR 0002](adr/0002-integration-storage-and-publication.md) defines file/search/publication policy. Further XL layouts/exporters need matching native schemas and verified available packages. Missing AI provider access is not a blocker, and no paid provider calls are authorized.

## P5: Demo C, selected-revision publishing

**Depends on:** the native foundation and private attachment contracts. The current integration sequence places this after PostgreSQL 18/search. **Goal:** prove capabilities connect without bypassing the core.

Implement selected-revision publishing API-first, then add administrator preview/publish/unpublish controls and an anonymous read-only view. Publishing defaults off. Publish an explicitly selected immutable native revision under the document version precondition; never advance the public revision on an internal save or future live editing. Include only the exact attachment allowlist recorded for that revision. Separate public schemas from private DTOs. The optional capability owns grant writes through the core's authorized transaction; core purpose-specific queries own public grant/lifecycle/revision/file visibility as recorded in ADR 0002.

Use the application's host, opaque stable public IDs, no-store caching, and no anonymous search/navigation/history. Private referenced-page titles or breadcrumbs are not resolved into the public DTO. Explain that literal content/links are public and unpublishing cannot erase already copied data. Add source/license access for the running build before sharing the demo over a network.

**Acceptance:** revision 2 public / revision 3 internal; newer title/body/files never leak; readers/editors cannot publish; guessed revision IDs and unrelated files do not work; unpublish immediately denies new reads; archive/unarchive cannot revive an old grant; publishing off denies anonymous access while private API still works; stale/missing preconditions fail without changing history. Publication and lock changes commit together. Public UI passes safe rendering tests.

**Review checkpoint:** Demo C is complete only after observed acceptance results. Continue within the current authorized sequence; unfinished collaboration stays isolated from the working demo.

## P6 — Findability and lightweight organization

**Depends on:** saved native content/plain text and current identity/membership policy for search. Search is integrated before publishing; document hierarchies remain a separate future assignment. **Goal:** make a growing private wiki navigable.

Add PostgreSQL full-text search over current authorized nonarchived heads, with title weighting, a language-neutral dictionary, bounded queries and plain excerpts. Apply current session/role/membership checks in SQL before ranking and limits. Keep the native content/history authoritative; generated vectors and their GIN index are rebuildable derived state. Use a fresh PostgreSQL 18 volume and preserve PostgreSQL 17 compatibility, rehearsing retained-data upgrades only on disposable copies.

Optional same-space parents, cycle validation and a basic tree remain future work once a flat list is insufficient. Choose a deterministic order; drag/drop ranking is optional and not a prerequisite. Search does not authorize document hierarchy work in this session.

**Acceptance:** query a unique term in a forbidden page and receive no title/body/snippet/count evidence; permissions applied in the database query before results; archive excludes search; edit refreshes text; rebuild works. Bound search results and verify consistency with committed changes. Future hierarchy acceptance must reject cross-space/cyclic/self parents and archive with active children.

## P7 — Private attachments, then published attachment grants

**Depends on:** native document ownership and revision references for private files; selected-revision publishing for public file grants. Private files/export precede search/publishing in the current sequence.

Add immutable document-owned file metadata and local private storage, bounded MIME-checked uploads, normalized same-document revision references, authenticated streams, quotas and native upload/resolution hooks. Do not inline active formats. Use exclusive owner-only files and coordinated metadata commits; remove only a failed operation's confirmed uncommitted bytes. An ambiguous commit acknowledgement retains bytes, and process-crash orphans need explicit inspection rather than an automatic directory wipe. A database transaction does not include filesystem writes.

Use the supplied OSS PDF/DOCX exporters with authorized immutable snapshots and private asset resolution. Keep rendering offline, bound asset bytes, reject unsupported external media instead of fetching it, and recheck access before returning the result. These downloads are rendered documents, not a full backup/import format. Additional layouts/exporters need their matching native schema and verified packages.

Extend publishing with an exact allowlist of attachments referenced by the selected revision. Private-only new uploads remain private. Public stream authorization resolves through the active publication on every request. Retain blobs referenced by history. Define quotas and cleanup before inviting broad use.

**Acceptance:** outsider cannot fetch a guessed file; path traversal rejected; content/size limits enforced; bytes cannot be swapped under a stable attachment ID; revision-only references survive restore; unpublished/historical unrelated files denied publicly; unpublish revokes public streams for new requests; failure between metadata/bytes is recoverable.

## P8 — Portability you can actually test

**Depends on:** P6/P7. **Goal:** no lock-in to the database or editor.

Define a versioned native bundle with document content, revision metadata, relationships, attachment manifest/checksums and bytes. Separate it from credentials and from administrator whole-instance backup. Import into an authorized destination with ID remapping and collision policies; start private. Validate archive paths, byte limits, expansion limits and checksums before writes; do not accept arbitrary ZIP entry paths or unlimited extraction.

Add a useful Markdown export with documented losses. Prefer maintained conversion/archive libraries after license review. Report unsupported nodes/fields instead of discarding them. Split large work only when measured synchronous limits require it.

**Acceptance:** native export/import round trip into a fresh installation preserves intended content/files/history relationships without granting membership or public access; malicious/corrupt bundles fail safely; Markdown limitations are explicit. Exports never contain auth/session secrets.

## P9 — Contributor preview and release hardening

**Depends on:** P8. **Goal:** a reproducible development preview, then a deliberate v0.1 release gate.

Add app/container packaging and upgrade/migration instructions; no required cloud services. Test backup and restore of database plus private files to a blank instance. Verify instance-base-URL/cookie/proxy settings, origin handling, limits, rate limiting, browser security policy, and recovery. Finish a usable admin/user provisioning path; a documented CLI is acceptable for an early preview, but account/session safety is mandatory. Add optional OIDC only with an assigned need and tested account-linking rules.

Confirm the public Scrawl repository URL and private security reporting before public release. Produce dependency license inventory, verify corresponding-source access for the running release, and preserve notices. Do not imply review-service OSS sponsorship covers this new repository without confirmation. No paid service is needed for tests or runtime.

**Acceptance:** fresh checkout -> install/test/run; frozen lockfiles; empty + previous-schema migrations; app and files restored; admin recovery tested; source/license link points at the actual build; no P0–P8 critical gate unverified. Publishing restored content requires an explicit operator decision after instance recovery.

## Required completion report for every packet

Summarize changed behavior and files; list actual commands with results; identify schema/migration effects and remaining risks; update status.md. Work through the current authorized sequence in reviewable commits and the integration draft PR. The earlier packet stop boundaries do not require new permission in this session. Do not merge, create a public tunnel, deploy to production or expand into unrelated roadmap work.
