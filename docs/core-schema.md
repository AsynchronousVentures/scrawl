# Core schema and relational invariants

Identity/access, native documents/revisions, private attachments, derived search and selected-revision publication are implemented on the integration branch in [schema.prisma](../prisma/schema.prisma), with Prisma 7.10.0 and one reviewed migration history. Document hierarchies remain proposed; private collaboration has an experimental opt-in runtime.

## P1: identity and access

Use the authentication library's user, session, account and verification records. Keep its stable user ID; do not build another competing identity registry. Instance role is server-controlled (`administrator` or `member`); account creation/update input cannot self-assign administrator. P1 stores `role` on the auth-owned User with a `member` default and a database check. Better Auth's admin schema marks role and ban fields as server-only input. Host commands alone create accounts; auth-owned tables retain the library-generated field layout.

`Space`: immutable ID, display name, persisted unique slug, creator ID, timestamps, integer lock version.

`SpaceMembership`: space ID, user ID, role (`reader` or `editor`), timestamps. Unique `(spaceId, userId)`. Membership edits and space creation require an administrator in the demos. Administrators have access to every space; this is not a design in which private content is hidden from the instance operator.

P1 uses PostgreSQL UUIDs for Space IDs, UTC timestamps, a positive `lockVersion` starting at 1, and a composite membership primary key with a reader/editor role check. Every successful grant/change/revoke advances the space version, including repeated same-role grants or revocation of an already-absent membership.

Use text-compatible foreign keys for auth user IDs rather than assuming the library emits UUIDs. Product-owned IDs may use UUIDs represented as strings externally. User deletion is out of the demo scope; deactivation/revocation must not cascade-delete document history.

## P2: document identity and snapshots

`Document`: stable ID, space ID, persisted slug, currentRevisionNumber, monotonic lockVersion, availabilityVersion, createdAt, createdBy, updatedAt, archivedAt (nullable), archivedBy (nullable).

`DocumentRevision`: stable ID, document ID, revision number, title, content format, content schema version, producing editor version, body JSONB, derived plain text, author ID, timestamp, optional change note.

Constraints:

- Unique `(documentId, revisionNumber)`; revision numbers strictly increase per document.
- Unique space slug and `(spaceId, documentSlug)`; archived names remain reserved. Slugs are bounded lowercase ASCII navigation metadata and do not change when content titles change.
- The current head references a revision belonging to the same document.
- No committed document without an initial/current revision.
- Revision content is immutable through product operations; restoring inserts a new revision.
- Creator/author are derived from the verified actor, never trusted from request input.
- Archiving changes lifecycle, not content history. There is no hard-delete endpoint.

P2 uses a deferred composite foreign key from `(Document.id, currentRevisionNumber)` to `(DocumentRevision.documentId, revisionNumber)`, plus the revision's document foreign key. This allows document + first revision creation within one transaction while enforcing the head at commit. The reviewed SQL migration marks it DEFERRABLE INITIALLY DEFERRED, which Prisma schema syntax cannot express. Real PostgreSQL tests prove initial creation succeeds atomically and missing or cross-document heads fail at COMMIT. P2's user, space, document, and revision references are restrictive; product operations never update/delete a historical revision.

The head number and lock version are different: moving/archiving/publishing may advance the lock without creating a content revision. An ETag reflects the selected representation's version; avoid embedding volatile membership or user-profile fields in that representation.

## Save algorithm

1. Resolve the real actor, validate the payload, start the transaction.
2. Acquire space lock, recheck access, acquire document lock in the standard order.
3. Verify active state and strong version precondition. Do not disclose state to unauthorized actors.
4. Build the next immutable revision and insert it.
5. Advance current revision and lock version in the same transaction.
6. Commit, map the DTO explicitly, return the new ETag.

Two writers with the same starting ETag must produce one success and one 412, with exactly one new revision. A forced failure between insert and head update rolls back both. A title-only change is still a content revision. P2 returns 200 with unchanged timestamps, head, lock version, and ETag when the trimmed title and native canonical content equal the current snapshot. A change note alone is not a save; a supplied note is ignored on a no-op. Restoring always inserts a new revision, even if its content matches the head.

## Native BlockNote content and lifecycle policy

The BlockNote foundation supersedes P2's restricted body schema. Native content uses the pinned BlockNote 0.55.0 default schema and official server utilities. The envelope contains exactly `format: "blocknote-json"`, `schemaVersion: 1`, `editorVersion: "0.55.0"`, and `document: Block[]`. Schema/version metadata is Scrawl-owned; upstream native JSON is the blocks array without a version envelope. `DocumentRevision.contentEditorVersion` records the producing baseline instead of reconstructing it from a future runtime constant.

- All standard blocks: paragraph, heading (levels 1-6 and toggle headings), bullet/numbered/check/toggle list items, quote, divider, code, table, image, audio, video and file. Children retain nested blocks and stable unique block IDs.
- Native inline text/link content supports bold, italic, underline, strike, code, text color and background color. Native code marks are mutually exclusive with other marks/links; the validator refuses an unrepresentable combination rather than stripping it.
- Tables retain structured cells, text/styles, spans, header rows/columns, colors and widths. Invalid geometry is rejected before repair commands could rewrite cells.
- The browser-safe parser checks shape, official property types/enums, IDs, styles, safe colors and resource limits before native canonicalization. A semantic comparison proves normalization did not drop text, styles, links, properties or table geometry. The backend also uses `ServerBlockNoteEditor` conversion, native `node.check()` and a loss-free native round trip. No asynchronous HTML conversion or global DOM mutation is used in saves.
- Links accept absolute http/https/mailto without credentials, whitespace, controls, encoded controls or backslashes. Media accepts empty native placeholders or absolute http/https URLs. Exact private attachment and publication-scoped attachment paths are accepted; private references are checked against the same document inside revision creation. The server does not fetch external content URLs.
- Submitted and canonical envelopes remain bounded at 262144 UTF-8 bytes, depth 32 and 10000 counted blocks/inline runs/rows/cells. Aggregate scalar bytes are checked before large serialization. HTTP retains its separate request cap. Unsupported/malformed content is 400; byte/depth/node limits are 413.
- Plain text includes nested blocks, code/newlines, table cells separated by tabs and rows by newlines, and media captions. It is derived state; native blocks remain authoritative.

Migration `20260930020000_blocknote_native` adds the producing version and a reviewed format/body check in the existing history. It leaves old payloads intact for the explicit offline conversion command. Product routes do not maintain a parallel legacy parser. The finite converter archives original document/revision records privately before an atomic encoding upgrade, preserving metadata and heads, and refuses unrepresentable content. Strong tags now use `"doc-{id}-bn1-v{lockVersion}"`, so old representation tags cannot mutate upgraded documents. Retained PostgreSQL 17 data is preserved unchanged; upgrade rehearsals run on disposable copies. See [VALIDATION.md](../VALIDATION.md) for commands and observed results.

Title is trimmed, nonempty, and at most 200 characters; change notes are at most 2000 characters. Title, change-note, and body text reject NUL and lone UTF-16 surrogates, which cannot retain round-trip fidelity in PostgreSQL. Unsupported/malformed content is 400; content byte/depth/node limits are 413. Errors omit submitted values.

Administrators and space editors may create/save/restore/archive/unarchive; readers may list/read current and historical content. All mutations acquire the space lock, recheck the current session and membership, then acquire the document lock. Membership changes use the same space lock. Reads that started before revocation may complete; new reads use committed membership. No membership is cached as part of a document permission decision.

Archive/unarchive updates lifecycle fields and lockVersion without adding a revision. Repeating the current lifecycle state is a no-op with a required current ETag. Archived documents remain readable with history to authorized users, disappear from default listings, and reject save/restore with 409 until unarchived. `includeArchived=true` includes both active and archived documents. No hard delete, nesting, move, or publication state exists in P2.

## Selected-revision publishing, implemented on branch

`Document.availabilityVersion` starts at 1. A successful archive transition increases it; unarchive never restores an earlier value. This generation is separate from both content revision number and mutation lock version.

`Publication`: public ID, document ID (at most one current grant per document), revision number, approved availability version, active/revoked state, publisher/time, updatedAt. Constrain the revision reference to the same document. A small grant-state history is optional, not a prerequisite to the demo.

Publish/unpublish also advance document lockVersion atomically through a core transaction operation. Public content never reads currentRevisionNumber as its published head. Global publishing disabled means deny all public reads; re-enabling resumes still-active grants unless the document was archived or explicitly unpublished. The UI must describe this switch as a pause, not permanent revocation.

An administrator explicitly chooses a revision ID. Core checks current authorization under the space-before-document locks, the document ETag, lifecycle and exact revision attachment references. Anonymous DTOs contain only the selected title, native content and publication time. Scoped public attachment requests join the active grant, availability generation and selected revision allowlist. Newer private attachments remain inaccessible. Archive invalidation applies even after unarchive. See [ADR 0002](adr/0002-integration-storage-and-publication.md).

## Private attachments, implemented on branch

`Attachment` has immutable document-owned metadata, detected media type, byte count, SHA-256, uploader and timestamp. Bytes live in an owner-only application directory, never a static uploads directory. `RevisionAttachment` records saved references; composite foreign keys bind both endpoints to the same document. Metadata/reference triggers prevent update/delete. Upload creates no content revision, and removing a current block retains historical bytes.

Upload requires an active saved document and current editor access, rechecked under the same lock order. Limits are 10 MiB/file, 100 MiB/document including retained files, and 40 million total decoded image pixels. Allowed types are bounded; SVG, HTML and executables are rejected. Filename input is bounded and excludes path separators and controls. An ambiguous commit acknowledgement retains private bytes rather than deleting a possibly committed file. Crash orphans remain inaccessible until a future explicit cleanup operation.

## Indexed search, implemented on branch

Each revision has a stored generated weighted `tsvector`, title weight A and body weight B, using PostgreSQL's language-neutral `simple` dictionary and a GIN index. The migration backfills derived state without changing authored snapshots. Search selects only current, saved, non-archived heads, with current session validity, role and space grants inside the SQL statement before rank, excerpts or limit. It returns bounded plain-text excerpts, document/space IDs and saved titles, without counts or revision metadata.

Queries are parameterized, 1-200 trimmed characters, with optional space filtering and 1-50 results (20 by default). Rebuilding uses `REINDEX INDEX CONCURRENTLY`; it does not rewrite immutable revisions. Browser results render excerpts as text and reject stale asynchronous responses.

## Private live storage, experimental on branch

Authorized document read/list DTOs expose `editingMode: "solo" | "live"`, derived from the existing epoch pointer, independently of the application capability flag. This is response metadata, not a new Prisma field or permission. With collaboration disabled, enrolled documents show their immutable saved head read-only; live state and comments remain retained and unavailable, and solo content writes/restores remain rejected by core.

`Document.liveEpoch` is nullable. Existing solo documents keep a null pointer and unchanged history until explicit, authorized enrollment. `DocumentLive` stores the complete Yjs V1 state under a composite `(documentId, epoch)` primary key, with storage schema version 1, monotonic bigint sequence, and timestamps. A deferred composite foreign key requires the current epoch to belong to that document at commit. Old epochs remain private and retained after restore. Encoded state is limited to 8 MiB; update frames are limited to 1 MiB, with existing native content limits applied to their validated projection.

Core operations own the transaction, taking space share locks before document locks, followed by current actor/session share locks and a fresh permission check. Acceptance can include up to 128 authenticated connection principals, locked in stable user-before-session order. The resulting receipt includes only currently authorized connection IDs and read/write status; removed/expired recipients are omitted. Recovery uses the same row order. The transport applies this receipt before fan-out. Application startup attaches it only with explicit collaboration configuration and the database ownership lease. Enrollment derives state only from the saved head and advances the document lock once; readers cannot submit authored changes. Duplicate updates do not change sequence or timestamps. Live changes leave immutable revisions, indexed search, native export and selected publication unchanged. Ordinary snapshot update/restore refuse an enrolled document.

Explicit checkpoints require document ETag, epoch and observed sequence. Canonical no-ops append nothing; changed content uses the existing immutable revision/attachment transaction. Restore requires a clean native checkpoint, appends a new revision, advances the document lock once and atomically selects a fresh epoch. Archive preserves room state and history while refusing live operations. The opt-in runtime and supplied live editor are implemented; the retained demo remains solo. Current recipient checks, ownership, commit-before-broadcast and native browser workflows are recorded in [validation](../VALIDATION.md). Remaining activation requirements are in [ADR 0003](adr/0003-collaboration-checkpoints.md).

Private comment commands use the supplied Yjs thread store on a validated clone under the same write transaction. Author IDs and timestamps are server-derived, other-author edits fail, and current readers cannot write. Native relative anchors are resolved against this document/epoch; stale or foreign identities fail. Comment bodies use the supplied paragraph composer schema with separate bounded resources. Comment state and anchors remain live-only, leaving immutable revisions, search, export and publication content unchanged. Prepared transport serializes comment delivery with inbound edits and joining, applying only accepted state to current authorized recipients. HTTP/client adapters and startup are available behind the explicit feature setting; the retained preview does not enable it.

## Add only with the feature

A document hierarchy adds a same-space parent reference, cycle protection and explicit archive-with-children policy. Reject archive of a page with active children initially; no silent recursive hide/move. Cross-space moves are deferred.

Whole-instance backup and document export remain distinct. Future content import must remap IDs, preserve attribution as safe metadata, assign a destination space, and never escalate membership or restore public grants implicitly. No import or full backup system is implemented.

## Not in this schema

Tenants, subscriptions, model providers, external sources, connectors, embedding vectors, workflows, queues, webhooks, generic custom fields, arbitrary entity-link registries, feature entitlements, or runtime plugin manifests.

Prepared optional HTTP routes under `/api/v1/documents/{id}/live` expose authorized metadata/enrollment; epoch paths expose checkpoint/restore and native REST thread commands. `/live/users` resolves a bounded supplied ID list to current space-member or administrator display names only. The live feature is absent unless startup explicitly enables and supplies the capability. Authenticated `/api/v1/collaboration` reports that availability without returning room or user details. Strong ETags, explicit accepted sequence and epoch remain independent preconditions. HTTP never serializes encoded live state, connection audiences or identity/session records. Enrollment, checkpoint, restore and archive share the document mutex across epochs; core operations retain authorization and database transactions. The checkpoint's internal result separates its document DTO from delivery receipts.
