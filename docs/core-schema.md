# Initial schema brief — relational invariants before ORM syntax

This is an implementation brief, **not a generated or validated Prisma schema**. P1 chooses the exact adapter/client major. P2 translates these invariants into that version's schema plus reviewed SQL migrations where necessary.

## P1: identity and access

Use the authentication library's user, session, account and verification records. Keep its stable user ID; do not build another competing identity registry. Instance role is server-controlled (`administrator` or `member`); account creation/update input cannot self-assign administrator. The precise field/table placement follows the proven adapter setup.

`Space`: immutable ID, display name, creator ID, timestamps, integer lock version.

`SpaceMembership`: space ID, user ID, role (`reader` or `editor`), timestamps. Unique `(spaceId, userId)`. Membership edits and space creation require an administrator in the demos. Administrators have access to every space; this is not a design in which private content is hidden from the instance operator.

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

A concrete PostgreSQL approach is a deferred composite foreign key from `(Document.id, currentRevisionNumber)` to `(DocumentRevision.documentId, revisionNumber)`, plus the revision's document foreign key. This allows document + first revision creation within one transaction while enforcing the head at commit. Confirm generated-client behavior; use a reviewed SQL migration for deferrability rather than silently dropping the database constraint. A documented alternative is acceptable only with equivalent commit-time integrity tests.

The head number and lock version are different: moving/archiving/publishing may advance the lock without creating a content revision. An ETag reflects the selected representation's version; avoid embedding volatile membership or user-profile fields in that representation.

## Save algorithm

1. Resolve the real actor, validate the payload, start the transaction.
2. Acquire space lock, recheck access, acquire document lock in the standard order.
3. Verify active state and strong version precondition. Do not disclose state to unauthorized actors.
4. Build the next immutable revision and insert it.
5. Advance current revision and lock version in the same transaction.
6. Commit, map the DTO explicitly, return the new ETag.

Two writers with the same starting ETag must produce one success and one 412, with exactly one new revision. A forced failure between insert and head update rolls back both. A title-only change is still a content revision. A no-op save may return unchanged state; choose and document that policy before P2 acceptance.

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
