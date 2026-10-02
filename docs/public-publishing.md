# Selected-revision public publishing

The integration branch implements this optional capability with native BlockNote content and document-owned attachments. `PUBLIC_PUBLISHING_ENABLED` defaults to `false`. [ADR 0002](adr/0002-integration-storage-and-publication.md) records the accepted storage and core-policy boundary; [VALIDATION.md](../VALIDATION.md) records actual results.

**Requirement:** A private/team knowledge base can also publish selected documentation for anonymous readers. This is not multi-tenancy, a public editing system, or a generic website builder.

## Exposure model

Publishing is disabled by default. Enabling it does not make any existing content public. Initially an instance administrator must explicitly publish a document; readers and editors cannot widen access through ordinary saves. This authority can later be delegated through a specific role when that need is demonstrated.

Publishing approves one immutable revision of one document, including its title and body. Internal readers see the current saved revision. Anonymous readers see only the approved public revision:

```text
Internal head: revision 12
Public grant: revision 9
Save revision 13 -> public still sees revision 9
Publish revision 13 -> public now sees revision 13
Unpublish -> public route returns not found
```

Internal edits are shared with authorized teammates, not private personal drafts. Public publishing does not require a separate document copy, approval queue, scheduled release, or autosave subsystem.

## Minimal persistent state

The document core retains document identity, current revision, lock version, lifecycle state, availability version, and immutable revisions. The publishing capability owns one publication record per document, referencing its exact approved revision, availability version, publisher/time, stable public UUID, and active state. Composite foreign keys keep the selected revision associated with that document. The attachment allowlist comes from normalized `RevisionAttachment` references for that selected revision, rather than a second copy of attachment ownership.

The opaque public identifier stays stable across explicit republishes. There are no title slugs or redirect history. A publication operation validates every document-owned attachment reference and does not fetch arbitrary external resources. If rewriting approved attachment URLs would exceed the native content size limit, approval fails with 413 before changing the grant or document version.

Anonymous JSON is exactly `{title, content, publishedAt}`. It does not copy source document/space/revision IDs, versions, authors, private navigation, collaborator information, revision notes, or full revision history into public metadata. Approved attachment URLs are rewritten in this response to publication-scoped URLs without changing the immutable private snapshot. User-authored text and literal links in the selected revision are themselves published content: preview the selection, warn that it becomes public, and do not promise automatic secret detection.

## Lifecycle and atomicity

Publishing names the intended revision, checks the expected document version, rechecks administrator authority and document availability, and writes the grant through a trusted capability callback in the core's transaction. The operation locks space before document and advances the document lock version without creating a content revision. Missing preconditions return 428; stale preconditions return 412. An authorized reader/editor receives 403, while outsiders receive 404 without source information. A stale publish request cannot silently approve a newer revision. Private edits never advance the published revision automatically.

Required revocation is not an eventual event handler. Unpublish immediately invalidates the grant at the application boundary. Archive makes all grants unusable; unarchive must not reactivate them. Re-publishing requires a new explicit decision.

The core owns monotonic `availabilityVersion`, starting at 1 and incrementing when an active document is archived. Each publication stores its approved version. Unarchive leaves the generation unchanged. Core purpose-specific public reads query the active grant, nonarchived document, matching generation, selected immutable revision, and attachment allowlist together. They never read the current private head or bypass authorization through an administrator identity. The capability owns grant writes; core imports no capability code. This authoritative read policy is the explicit ADR 0002 adjustment to the earlier ban on core publication-table queries.

Disabling publishing globally prevents all anonymous reads and publication writes. Authenticated availability/status and private workflows remain usable. Re-enabling resumes still-active grants whose lifecycle generation matches. The switch is a pause, not permanent revocation; unpublish individual content to revoke its grant. Repeated accepted publication commands still advance the document lock; unpublish does not delete history or erase the stored grant record.

## Attachments, links, and caching

Private files remain outside any unrestricted static directory. Public file reads resolve through the active publication and its exact attachment allowlist. Files uploaded in newer internal revisions are not public. Blob identity is immutable: do not replace private bytes behind an attachment ID already referenced by a public revision.

Links do not recursively publish their targets. Public rendering must not resolve private target titles, create private previews, or expose the full private navigation tree. Add public navigation/search only over explicitly published projections; searching the internal latest revisions and filtering afterward is not valid.

The read-only frontend uses the same native BlockNote renderer and strict URL/content validation as private documents. Raw HTML/script content is rejected; literal HTML text stays text. Uploaded SVG, HTML, executables, and unsupported file types are rejected rather than exposed as active browser content. Public attachment streams use `nosniff` and a sandbox CSP with safe disposition filenames.

Publication responses and file streams use `Cache-Control: no-store`. There is no CDN or long-lived signed file URL. Unpublishing stops future service access but cannot erase copies already downloaded or captured by third parties. The publish UI must state that limitation. A public URL is not a secret or an authorization token.

## Implemented API surface

| Endpoint | Responsibility |
| --- | --- |
| `GET /api/v1/publishing` | Authenticated `{enabled, mayPublish}` availability |
| `GET /api/v1/documents/{id}/publication` | Authorized publication status plus current document ETag |
| `POST /api/v1/documents/{id}/publication` | Administrator approves `{revisionId}` using `If-Match` |
| `DELETE /api/v1/documents/{id}/publication` | Administrator revokes its publication using `If-Match` |
| `GET /api/public/publications/{publicId}` | Anonymous `{title, content, publishedAt}` for the valid selected grant |
| `GET /api/public/publications/{publicId}/attachments/{attachmentId}` | Anonymous immutable stream referenced by that valid selected revision only |

Status and successful mutations return `{publication, lockVersion}` with the normal document ETag. `publication` is null or `{publicId, revisionId, revisionNumber, publishedAt, active}`. `active` describes grant/lifecycle validity; the availability route reports the global pause separately. Disabled writes and unavailable anonymous grants return 404. Unknown query fields are rejected, and public requests have no historical revision selector. These routes are generated into OpenAPI from implemented schemas. No public write route exists.

The read-only web route is `/publications/{publicId}` on the application origin; it requests the anonymous JSON API above and exposes no private controls or navigation. It is distinct from the API path. There is no separate public deployment.

## Verification and future proposals

Acceptance checks cover an approved old revision remaining public after private title/body/file changes, reader/editor publication denial, outsider isolation, missing/stale preconditions, cross-document revision selection, selected-revision attachment allowlists, and immediate unpublish/archive revocation. Unarchive cannot revive a grant, and disabling the capability leaves private operations usable. Tests and browser results actually run belong in [VALIDATION.md](../VALIDATION.md), rather than being inferred from these requirements.

Public full-text search, hierarchical navigation, themes, custom domains, public comments, and unlisted/expiring shares remain proposals. The next collaboration/comments integration is private and follows [ADR 0003](adr/0003-collaboration-checkpoints.md); it must not make live unsaved changes or comment threads public. Future content import must start private and never restore grants implicitly. A future whole-instance backup may preserve grant records, but restoring to a destination must start with global publishing disabled until an administrator reviews and explicitly re-enables it.
