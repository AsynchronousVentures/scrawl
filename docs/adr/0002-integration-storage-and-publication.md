# Private files, derived search, and selected publication

Status: accepted for the integration branch. Runtime verification is recorded in VALIDATION.md.

Scrawl stores immutable, document-owned attachment metadata in PostgreSQL and bytes in a private application directory. Uploads require current editor access and an active saved document. The operation takes the space lock before the document lock, checks the document quota, writes an exclusive owner-only file, then commits metadata. Failed transactions remove only their own confirmed uncommitted file. An ambiguous commit acknowledgement retains private bytes rather than risking deletion of a committed attachment. A process crash can leave an inaccessible orphan file; no automatic directory wipe is part of reset or startup.

Every saved attachment reference is normalized into RevisionAttachment. Composite foreign keys constrain both the revision and attachment to the same document. Historical references retain bytes even when the current document removes a block. Uploading or discarding a local image does not create a content revision. Unsupported SVG/HTML/executable uploads are rejected, and untrusted images are decoded within a total pixel limit before storage.

Search uses a stored generated weighted title/body tsvector on immutable revisions, with a GIN index. The query selects current non-archived heads and applies the current session, role, and space grant inside the SQL statement before ranking or returning excerpts. The language-neutral simple dictionary avoids pretending all documents are English. Rebuilding the derived index never rewrites authored revisions.

Publishing is disabled by default. An administrator explicitly approves one immutable revision and the document's current availability version. Private edits never advance the published snapshot. Archive increases availabilityVersion; unarchive cannot revive a prior grant. Publish/unpublish use the core's space-before-document transaction and advance the document lock without creating a content revision.

The optional publishing capability owns grant writes through a trusted transaction callback. Core purpose-specific publication reads own the authoritative grant, lifecycle, revision, and attachment-allowlist checks. This deliberately extends the earlier rule that core did not query publication tables: central read policy prevents a capability from bypassing lifecycle or exposing a private head. Core still has no dependency on publishing capability code, and HTTP/client schemas contain no Prisma types.

Anonymous responses include only the approved title, native content, and publication time. Publication attachment URLs serve only references in that approved revision. Public reads use no-store responses, and disabling publishing denies all public reads. Re-enabling pauses/resumes still-valid grants; it does not recreate grants invalidated by archive or explicit unpublish.

Live collaboration remains a separate storage concern. A future Yjs document must not overwrite immutable revisions on every keystroke, and shared undo/discard must not revert another author's work. The native content ADR and collaboration issue record that boundary; collaboration is not represented as working until persistence, authenticated connections, reconnect, checkpoint, and revocation tests pass.
