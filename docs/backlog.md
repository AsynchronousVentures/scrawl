# Demo work packets

**All packets are implementation work unless status.md says otherwise.** Each packet is one bounded assignment; split a packet into smaller PRs rather than implementing future packets opportunistically. No calendar estimates are implied.

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

Prove headless validation/text extraction/native round trip for a small ProseMirror-compatible schema: paragraphs, headings, basic marks, bullet/ordered lists, links and code blocks. Restrict URL protocols and body size/depth/node count; reject unknown content instead of dropping it. No HTML or uploads yet.

Add document/revision migrations and commit-time head integrity; create/list/read/update; current ETag; immutable revision list/read/restore; archive/unarchive. Restrict updates to documented fields. Title/body snapshots are authoritative. Review parent/archive semantics only when nesting is introduced later.

**Acceptance:** real concurrent requests with the same ETag yield one save and one 412; missing precondition yields 428; forced mid-write failure creates no orphan/head mismatch; restored content receives a new revision number; revision IDs cannot cross documents; outsider gets no title/version; reader cannot mutate; unsupported nodes and oversized bodies fail safely.

**Do not build:** publication, autosave, branches, collaboration, comments, nested page UI, schema extensibility framework.

## P3 — Demo A harness and minimal export

**Depends on:** P2. **Goal:** a repeatable, headless product demo.

Build a small demo runner using actual HTTP authentication, synthetic fixtures and cookie isolation. Its seed/reset command is explicit, development-only, and refuses production/non-demo targets; never reset a database merely because the command was run. Provide native single-document export with content format/version and provenance, but no password/session/secret data. Generate OpenAPI from real routes. An interactive API explorer may be added locally, not exposed by default.

**Acceptance:** run [demo-walkthrough.md](demo-walkthrough.md) Demo A from a fresh migrated database; tests assert denials and stale writes rather than just printing requests. Exported content validates through the same parser. Create actions are not automatically retried. Record fixture identities but do not commit real credentials.

**Stop point:** demonstrate the API to the maintainer before a UI packet.

## P4 — Demo B, thin private-document UI

**Depends on:** P3. **Goal:** a usable private document loop, not a design-system project.

Add a React/Vite frontend and a typed client generated from live OpenAPI. Auth may use the official library client. Develop on a same-origin proxy; the deployed build should be served on the app origin. Use existing accessible components and the supported editor library. Keep navigation simple: space switcher, page list, document pane, Save, history, and archive action.

Add explicit save feedback, dirty state/navigation warning and a 412 conflict view that preserves the unsaved local document. Show the latest server version separately and require a deliberate retry/reconciliation. Never silently overwrite or replace local edits. Reader mode disables edits but relies on server authorization, not disabled buttons alone.

**Acceptance:** browser tests for login, create/edit, reload/persistence, history, restore-as-new, reader denial, two-tab collision without content loss, loading/error/empty states, and keyboard access. The UI accesses no Prisma/server internals. Native export is usable.

**Do not build:** auto-save, multiplayer cursors, page designer, public branding, AI toolbar, widget dashboard or a component-library rewrite.

## P5 — Demo C, public publishing as the first substantial capability

**Depends on:** P4. **Goal:** prove capabilities connect without bypassing the core.

Implement [public-publishing.md](public-publishing.md) API-first, then add administrator preview/publish/unpublish controls and an anonymous read-only view. Add publication/availability state only now. Publish an explicitly selected revision under the document version precondition; never advance the public revision on internal save. Separate public schemas from private DTOs. Start text-only with existing supported nodes; file publication is extended in P7.

Use the application's host, opaque stable public IDs, no-store caching, and no anonymous search/navigation/history. Private referenced-page titles or breadcrumbs are not resolved into the public DTO. Explain that literal content/links are public and unpublishing cannot erase already copied data. Add source/license access for the running build before sharing the demo over a network.

**Acceptance:** revision 2 public / revision 3 internal; newer title/body never leak; editor cannot publish; guessed revision IDs do not work; unpublish immediately denies new reads; archive/unarchive cannot revive an old grant; publishing off denies anonymous access while private API still works; stale publish fails. Public UI passes safe rendering tests.

**Stop point:** the three requested demos are complete only after observed acceptance results.

## P6 — Findability and lightweight organization

**Depends on:** P5. **Goal:** make a growing private wiki navigable.

Add PostgreSQL full-text search over current authorized nonarchived revisions, with title weighting and bounded query behavior. Keep result fields and snippets minimal. Add optional same-space parents, cycle validation and a basic tree once a flat list is insufficient. Choose a deterministic order; drag/drop ranking is optional and not a prerequisite.

**Acceptance:** query a unique term in a forbidden page and receive no title/body/snippet/count evidence; permissions applied in the database query before results; archive excludes search; edit refreshes text; rebuild works. Reject cross-space/cyclic/self parents and archive with active children. Define bounded pagination, including search behavior when documents change.

## P7 — Private attachments, then published attachment grants

**Depends on:** P5; may be independent of search after shared contracts settle.

Add immutable document-owned file metadata and local private storage, bounded uploads, normalized revision references, authenticated streams, and a visible image upload path. Prefer PNG/JPEG/WebP initially; do not inline active formats. Track staging/ready states and reconcile orphaned metadata/bytes; a database transaction does not include filesystem writes.

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

Summarize changed behavior and files; list actual commands with results; identify schema/migration effects and remaining risks; update status.md; give the next bounded packet. Do not merge, push, deploy or proceed automatically beyond the assigned scope.
