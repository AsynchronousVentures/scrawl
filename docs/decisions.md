# Decisions and implementation defaults

## Confirmed product decisions

| Topic | Decision |
| --- | --- |
| Name | Scrawl; repository name `scrawl` |
| Ownership | Standalone Asynchronous Ventures OSS product |
| License family | AGPL; applied as AGPL-3.0-only in this pack |
| Deployment | Self-hosted, one installation with users/spaces; no tenant/billing system |
| Product | Private/team documentation plus explicit public publishing |
| Development | Backend-first; YAGNI; reuse maintained OSS libraries |
| Persistence preference | Prisma with PostgreSQL |
| Modularity | Solid document/access core with attached capabilities |
| Integrations | Build the documentation platform first; AI/chat postponed |

## Defaults for demo implementation

These are proposed engineering choices the agent may refine through a short decision record when evidence requires it, not permission to re-plan the product.

| Topic | Default |
| --- | --- |
| Runtime | Node.js 24; one TypeScript backend, npm initially |
| HTTP | Fastify, route schemas, generated OpenAPI, REST `/api/v1` |
| ORM/auth | Better Auth 1.7.6 / Prisma 7.10.0 verified against PostgreSQL in P1; exact pins and transitive overrides recorded in VALIDATION.md |
| First sign-in | Local library-managed account/session; closed registration; host CLI provisions users |
| OIDC | Optional integration after the local document loop; not a Demo A prerequisite |
| Permission model | Space reader/editor; instance administrator has all-space access |
| Content | Native BlockNote standard blocks, Scrawl version metadata, official shadcn UI/server utilities; strict security/resource validation |
| Save | Explicit save, immutable revision, optimistic concurrency |
| Reading and editing | Saved documents open read-only; authorized writers choose Edit. New drafts start editable. Save preserves undo; Done editing protects unsaved solo work and never rolls back shared content |
| Navigation and feedback | Reuse same-space navigation metadata while rechecking current access and fetching the requested saved document. Retain the inactive previous page until the read settles; never cache dirty bodies/ETags. Transient confirmations use supplied Base UI toasts; failures/conflicts/access loss remain persistent |
| Private links | Persisted space/document slugs in readable paths; UUIDs remain internal/API identities |
| Frontend timing | Thin UI after private-core tests, not after all backend capabilities |
| Publishing | Disabled by default, administrator action, selected-revision grant |
| Search/files | Private attachments and supplied exporters, then indexed search, before selected publishing; API-first permission tests |
| Dependencies | No speculative queue/cache/search service/plugin runtime |

Technical pins are decided in P0/P1 and documented with command output. Licensing choice is no longer pending. See [plan.md](plan.md), [architecture.md](architecture.md), and [sources.md](sources.md).

Private links use `/spaces/:spaceSlug/documents/:documentSlug`. Space slugs are unique across the installation; document slugs are unique within their space, including archived documents. Slugs are assigned from the initial saved name/title, stay stable through later edits/restores, and are not permission tokens. Normalize Latin accents to lowercase ASCII words, cap the base at 64 characters, and allocate `-2`, `-3` when needed. Names without ASCII words use `space` or `document` with the same collision policy. Creation locks and database uniqueness prevent duplicate links. The migration backfills existing names/current titles without changing history or versions. Existing UUID query bookmarks remain supported and become canonical readable paths after authorized loading; no alias registry is needed. Public publication URLs remain independent opaque approval IDs, so private names or later private titles cannot affect them. Access logs record route patterns rather than private slugs.

The BlockNote foundation replaces P2's restricted schema. Canonical no-op saves still keep the current revision/version; restore always appends history. Archive/unarchive changes lifecycle versions, preserves authorized history reads, and blocks content mutations while archived. The native format is recorded in [ADR 0001](adr/0001-native-blocknote-documents.md), and the live-state/checkpoint boundary in [ADR 0003](adr/0003-collaboration-checkpoints.md); durable vocabulary is in [CONTEXT.md](../CONTEXT.md).

Heading links use `#section-<URL-encoded native BlockNote block ID>` on the document's existing readable URL. Native IDs keep duplicate heading names distinct and retain links through a heading rename, without putting unsaved text in browser history. A deleted heading no longer resolves; a newly added heading is available to other sessions only after Save. [URI fragments](https://developer.mozilla.org/en-US/docs/Web/URI/Reference/Fragment) select content within the already authorized resource, and confer no access. Private views settle their initial authority/mode check before placing the section cursor. History and conflict views use separate DOM identifiers and do not change the document URL. Same-document section navigation preserves drafts, undo and ETags; cross-document navigation retains the existing discard guard.

Saved-document duplication requires an explicit source revision ID and new title. Core rechecks editing access under the space-before-document lock order and creates a solo root document in the same space with revision 1 and a fresh stable slug. Archived snapshots may be copied into active documents. Native blocks retain their fields and IDs; referenced private files get independent immutable bytes and document ownership, with only their private URLs rewritten. Source revisions, hierarchy, live state, comments and publication are not copied or changed. This creates a new document rather than mutating the source, so a source ETag is not required. The client uses the selected saved revision, preserves the current draft/conflict/ETag, and guards opening the copy. An uncertain response is never automatically retried. This supports reusable documentation without a template framework.

Host-only integrity verification uses a read-only repeatable-read PostgreSQL snapshot, keyset batches and streamed hashes of registered immutable attachment files. It reports counts and error categories rather than private identifiers or text. It never follows attachment symlinks, repairs data or enumerates unregistered files. This saved-content check is separate from backup/restore and live-room recovery. [PostgreSQL 18 isolation documentation](https://www.postgresql.org/docs/18/transaction-iso.html) defines the stable snapshot used throughout the scan.
