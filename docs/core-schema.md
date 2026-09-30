# Initial schema brief — relational invariants before ORM syntax

P1 identity/access and P2 documents/revisions are implemented in [schema.prisma](../prisma/schema.prisma) with Prisma 7.10.0 and one reviewed migration history. Sections for P5 onward remain implementation briefs, not implemented models.

## P1: identity and access

Use the authentication library's user, session, account and verification records. Keep its stable user ID; do not build another competing identity registry. Instance role is server-controlled (`administrator` or `member`); account creation/update input cannot self-assign administrator. P1 stores `role` on the auth-owned User with a `member` default and a database check. Better Auth's admin schema marks role and ban fields as server-only input. Host commands alone create accounts; auth-owned tables retain the library-generated field layout.

`Space`: immutable ID, display name, creator ID, timestamps, integer lock version.

`SpaceMembership`: space ID, user ID, role (`reader` or `editor`), timestamps. Unique `(spaceId, userId)`. Membership edits and space creation require an administrator in the demos. Administrators have access to every space; this is not a design in which private content is hidden from the instance operator.

P1 uses PostgreSQL UUIDs for Space IDs, UTC timestamps, a positive `lockVersion` starting at 1, and a composite membership primary key with a reader/editor role check. Every successful grant/change/revoke advances the space version, including repeated same-role grants or revocation of an already-absent membership.

Use text-compatible foreign keys for auth user IDs rather than assuming the library emits UUIDs. Product-owned IDs may use UUIDs represented as strings externally. User deletion is out of the demo scope; deactivation/revocation must not cascade-delete document history.

## P2: document identity and snapshots

`Document`: stable ID, space ID, currentRevisionNumber, monotonic lockVersion, createdAt, createdBy, updatedAt, archivedAt (nullable), archivedBy (nullable).

`DocumentRevision`: stable ID, document ID, revision number, title, content format, content schema version, body JSONB, derived plain text, author ID, timestamp, optional change note.

Constraints:

- Unique `(documentId, revisionNumber)`; revision numbers strictly increase per document.
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

## P2 content and lifecycle policy

The headless schema uses `prosemirror-model@1.25.12`, with no DOM or database dependency. Envelope fields are exactly `format: "prosemirror-json"`, `schemaVersion: 1`, and `document`. The authoritative body is the native canonical node JSON; plain text is derived from it.

- Nodes: `doc`, `paragraph`, `heading`, `text`, `bulletList`, `orderedList`, `listItem`, `codeBlock`, and `hardBreak`.
- Marks: `bold`, `italic`, `code`, and `link`. Marks apply only to inline nodes; code blocks disallow marks.
- Grammar: doc contains one or more blocks; lists contain list items; each item starts with a paragraph; headings/paragraphs contain inline nodes; code blocks contain text only. Empty paragraphs/code blocks are valid; an empty doc is not.
- Attributes: heading level 1-6, default 1; ordered-list start 1-2147483647, default 1; code-block language null or an ASCII token of 1-64 characters; link href only, at most 2048 characters. Unknown fields/attributes are rejected before native decoding, which can otherwise discard attributes.
- URLs: absolute `http`, `https`, or `mailto` only. Reject credentials, whitespace/control characters, encoded controls, and backslashes. No remote fetching occurs.
- Limits: both submitted and canonical serialized envelopes are at most 262144 UTF-8 bytes; depth at most 32 with doc at depth 1; at most 10000 nodes, including doc and text before native text coalescing; at most four unique marks per inline node. Aggregate scalar bytes are checked before large serialization allocations. HTTP also retains the P0 1 MiB request cap.
- Canonicalization: native defaults are filled, marks are ordered, and equivalent adjacent text nodes are merged. No unsupported content is silently dropped. Plain text joins text blocks with newlines, preserves empty blocks/code/hard breaks, and omits list labels and mark decoration.

Title is trimmed, nonempty, and at most 200 characters; change notes are at most 2000 characters. Title, change-note, and body text reject NUL and lone UTF-16 surrogates, which cannot retain round-trip fidelity in PostgreSQL. Unsupported/malformed content is 400; content byte/depth/node limits are 413. Errors omit submitted values.

Administrators and space editors may create/save/restore/archive/unarchive; readers may list/read current and historical content. All mutations acquire the space lock, recheck the current session and membership, then acquire the document lock. Membership changes use the same space lock. Reads that started before revocation may complete; new reads use committed membership. No membership is cached as part of a document permission decision.

Archive/unarchive updates lifecycle fields and lockVersion without adding a revision. Repeating the current lifecycle state is a no-op with a required current ETag. Archived documents remain readable with history to authorized users, disappear from default listings, and reject save/restore with 409 until unarchived. `includeArchived=true` includes both active and archived documents. No hard delete, nesting, move, or publication state exists in P2.

## P5: actual capability state

Add `Document.availabilityVersion` when publishing is introduced; archive increases it, unarchive never restores an earlier value.

`Publication`: public ID, document ID (at most one current grant per document), revision number, approved availability version, active/revoked state, publisher/time, updatedAt. Constrain the revision reference to the same document. A small grant-state history is optional, not a prerequisite to the demo.

Publish/unpublish also advance document lockVersion atomically through a core transaction operation. Public content never reads currentRevisionNumber as its published head. Global publishing disabled means deny all public reads; re-enabling resumes still-active grants unless the document was archived or explicitly unpublished. The UI must describe this switch as a pause, not permanent revocation.

## P6–P8: add only with the feature

Nesting adds a same-space parent reference, cycle protection and explicit archive-with-children policy. Reject archive of a page with active children initially; no silent recursive hide/move. Cross-space moves are deferred.

Attachments add immutable document-owned metadata/storage keys and normalized revision-to-attachment references. This both supports historical retention and makes a publication allowlist precise. No reuse across documents in the initial model.

PostgreSQL search derives its indexed text from current authorized nonarchived revisions. An index is rebuildable derived state, not authoritative content. Whole-instance backup and document export are distinct: content import remaps IDs, preserves attribution as safe metadata, assigns a destination space, and never escalates membership or restores public grants implicitly.

## Not in this schema

Tenants, subscriptions, model providers, external sources, connectors, embedding vectors, workflows, queues, webhooks, generic custom fields, arbitrary entity-link registries, feature entitlements, or runtime plugin manifests.
