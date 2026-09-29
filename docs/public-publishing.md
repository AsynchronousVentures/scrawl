# Public publishing — proposed first capability

**Implementation timing:** P5 starts with supported text content; P7 adds the attachment-manifest portions below. The capability is planned, not present in the source.

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

The document core retains document identity, current revision, lock version, lifecycle state, and immutable revisions. The publishing capability owns a publication record referencing the source document and exact revision, the publisher/time, public identifier, active state, and an attachment allowlist derived from the approved revision.

Prefer a stable opaque public identifier over a title-based slug initially. No vanity slug redirect history is needed. A database constraint must keep publication revisions associated with the same document. A publication operation validates every document-owned attachment reference and does not fetch arbitrary external resources.

The initial published surface is the document's approved title/body and allowed files. It does not copy source-space names, private parent breadcrumbs, collaborator information, revision notes, internal source URLs, or full revision history into public metadata. User-authored text and literal links in the selected revision are themselves published content: show them in a preview, warn that it is public, and do not promise automatic secret detection.

## Lifecycle and atomicity

Publishing names the intended revision, checks the expected document version, rechecks publishing authority and document availability, and writes the grant in a coordinated transaction. A stale publish request cannot silently approve a newer revision. Private edits never advance the published revision automatically.

Required revocation is not an eventual event handler. Unpublish immediately invalidates the grant at the application boundary. Archive makes all grants unusable; unarchive must not reactivate them. Re-publishing requires a new explicit decision.

A recommended small mechanism for archive/recovery is a monotonic `availabilityVersion` owned by the document core. Increment it when lifecycle changes invalidate exposure. Each publication stores the approved version. Public resolution requires an active source and a matching version. Unarchive does not restore an old version. This prevents accidental republication without the core importing publishing internals. Adopt and test this mechanism when implementing publishing, not as an unused column in the identity milestone. An alternative must preserve the same tested behavior.

Disabling publishing globally prevents all anonymous reads. Re-enabling resumes still-active grants whose lifecycle generation still matches. Describe the switch as a pause, not permanent revocation; unpublish individual content to revoke its grant.

## Attachments, links, and caching

Private files remain outside any unrestricted static directory. Public file reads resolve through the active publication and its exact attachment allowlist. Files uploaded in newer internal revisions are not public. Blob identity is immutable: do not replace private bytes behind an attachment ID already referenced by a public revision.

Links do not recursively publish their targets. Public rendering must not resolve private target titles, create private previews, or expose the full private navigation tree. Add public navigation/search only over explicitly published projections; searching the internal latest revisions and filtering afterward is not valid.

Use the supported content renderer with strict URL and node rules. Do not enable arbitrary HTML/JavaScript as a shortcut to public pages. Inline HTML/SVG or other active file types need a deliberately safe treatment, not generic browser execution.

Start with `Cache-Control: no-store` on publication responses and file streams; do not add CDN or long-lived signed file URLs before revocation is designed. Unpublishing can stop future service access, but cannot erase copies already downloaded or captured by third parties. Say this in the publish UI. A public URL is not a secret or an authorization token.

## Proposed API surface

| Endpoint | Responsibility |
| --- | --- |
| `POST /api/v1/documents/{id}/publish` | Administrator publishes an explicitly named revision using `If-Match` |
| `POST /api/v1/documents/{id}/unpublish` | Administrator revokes its active publication using `If-Match` |
| `GET /api/v1/public/documents/{publicId}` | Anonymous read of the active published projection only |
| `GET /api/v1/public/documents/{publicId}/attachments/{attachmentId}` | Anonymous stream allowed by that active publication only |

Treat publication state changes as document-visible version changes and coordinate their updates through core operations in a transaction. This gives publish and unpublish a single meaningful document precondition rather than independent writes that race. Only add these routes to generated OpenAPI when they are implemented. No public write route exists.

P5 adds a simple read-only web view rendering this API on the installation's existing host after API acceptance passes. Public full-text search, hierarchical public navigation, themes, custom domains, public comments, and unlisted/expiring shares are not required for the first publishing slice.

## Acceptance evidence

Publish revision 2, then save revision 3 with an internal-only sentence and file. Anonymous JSON, rendered output, file requests, and metadata expose neither addition. A reader/editor cannot publish. A public request cannot select revision 1, source history, a private parent, or a different attachment by changing a URL. Unpublish blocks future reads. Archive and unarchive do not restore anonymous access. An old publish request fails after concurrent edits. Content imports start private and never restore public grants implicitly. Whole-instance backup may preserve grant records, but restoring an instance starts with global publishing disabled until an administrator reviews the destination and explicitly re-enables it.
