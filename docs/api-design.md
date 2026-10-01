# Implemented API and remaining proposals

Generated OpenAPI describes the implemented health, identity/space, document/revision/lifecycle, search, attachment, export, and publishing routes below. Publishing is mounted but disabled by default. Auth routes retain library request semantics under their separate namespace. [VALIDATION.md](../VALIDATION.md) records observed checks separately from implementation.

## Authentication and principal

Use the selected library's session endpoints under `/api/auth/*`. Product endpoints use `/api/v1/*`. Do not rename or wrap every identity-provider operation without need. A small `/api/v1/me` response can expose the application's effective identity and role after successful authentication.

One deployment is one knowledge base, private by default with separately approved public projections. Do not accept arbitrary organization IDs to simulate multi-tenancy. Use server-resolved actor IDs and deny-by-default product access. Use local library-managed credentials/sessions, closed registration and explicit administrator provisioning/recovery for Demo A. Optional OIDC linking and richer onboarding are later assigned work, not prerequisites to the local demo.

P1 mounts only `POST /api/auth/sign-in/email`, `GET /api/auth/get-session`, and `POST /api/auth/sign-out`. HTTP registration, profile/role changes, provisioning, recovery, and impersonation are absent. Auth success JSON allowlists user fields and session expiry, excluding raw session tokens. Auth errors preserve native codes with generic status messages; credentials are conveyed through library-managed HttpOnly cookies. This is a deliberate response restriction to meet the P1 requirement that JSON DTOs contain no credentials.

`GET /api/v1/me` returns `{id, name, email, role}`. Space responses contain `{id, name, slug, createdBy, createdAt, updatedAt, lockVersion, access}`. P4 adds `access: "reader" | "editor"`, derived for the authenticated caller by core authorization. Administrators have effective editor access. This describes current controls; it is not a permission token or a substitute for rechecking access inside every operation. Space creation returns 201 with Location and ETag; read and membership mutations return ETag. PUT/DELETE membership returns the updated space DTO. A missing If-Match is 428; a stale single strong tag is 412; weak, wildcard, or multiple-tag syntax is 400. Check access before reporting these resource/precondition failures.

Space listing returns `{items, nextCursor}`, filters visibility in the query, and accepts `limit` (1-100, default 50) and a UUID `cursor`. Ordering is by immutable ID. Instances with no accessible spaces return an empty list, with no hidden totals. Authenticated unauthorized resource requests return the same 404 as missing resources. Anonymous product requests are denied. Cookie-based product writes require the exact configured Origin.

Administrator access management uses two read operations. `POST /api/v1/users/lookup` accepts only `{email}` and returns the same minimal account profile as `/me`, normalized by exact email. The POST keeps the email out of request URLs; it does not create accounts, change roles or recover credentials. Missing accounts and non-admin callers both receive 404; unauthenticated callers receive 401. `GET /api/v1/spaces/{id}/members` returns `{spaceId, lockVersion, items: [{user, role}], nextCursor}` with the corresponding strong space ETag. Limits are 1-100 (default 50); cursors are auth user IDs of up to 128 characters. Profiles contain only ID, name, email and instance role. Neither response includes credentials, auth accounts, sessions or tokens. Membership reads acquire the space lock before checking and stabilizing the current administrator; writes retain their existing space preconditions and lock order.

## Resource surface

| Method and path | Behavior |
| --- | --- |
| `GET /api/v1/me` | Effective authenticated user and instance role |
| `POST /api/v1/users/lookup` | Administrator exact-email lookup of an existing account, without provisioning or credential fields |
| `POST /api/v1/spaces` | Administrator creates a space |
| `GET /api/v1/spaces` | Only spaces the actor can access |
| `GET /api/v1/spaces/{id}` | Read authorized space |
| `GET /api/v1/spaces/{id}/members` | Administrator bounded current grant list with space ETag; no member-directory access for readers/editors |
| `PUT /api/v1/spaces/{id}/members/{userId}` | Administrator grants/changes access; require space version precondition |
| `DELETE /api/v1/spaces/{id}/members/{userId}` | Administrator revokes access; require space version precondition |
| `POST /api/v1/spaces/{id}/documents` | Editor creates a document and first revision atomically |
| `GET /api/v1/spaces/{id}/documents` | Bounded authorized listing; no document hierarchy or parent filter |
| `GET /api/v1/documents/{id}` | Current document representation plus `ETag` |
| `PATCH /api/v1/documents/{id}` | Title/content change with `If-Match` |
| `GET /api/v1/documents/{id}/revisions` | Bounded immutable history, without full bodies by default |
| `GET /api/v1/documents/{id}/revisions/{revisionId}` | Authorized revision snapshot; revision must belong to document |
| `POST /api/v1/documents/{id}/restore` | New revision copied from selected historical revision; `If-Match` required |
| `POST /api/v1/documents/{id}/archive` | Archive without erasing history; `If-Match` required |
| `POST /api/v1/documents/{id}/unarchive` | Restore availability; `If-Match` required |
| `GET /api/v1/search` | Query only authorized, nonarchived content |
| `POST /api/v1/documents/{id}/attachments` | Size-limited authorized upload |
| `GET /api/v1/attachments/{id}/content` | Authorized stream; never an unrestricted uploads directory |
| `GET /api/v1/documents/{id}/export` | Authorized current native JSON snapshot; no format or revision query |
| `GET /api/v1/documents/{id}/exports/{format}` | Authorized current or selected immutable revision as PDF or DOCX |

Space-wide import/export and administrator backup/restore remain proposals. Integration tokens, jobs, webhooks, external sources, and proposal workflows are absent. Public publishing is specified separately below.

## P2 document contracts

Create accepts `{title, content, changeNote?}`. PATCH accepts only `{title?, content?, changeNote?}` and requires title or content. Restore accepts `{revisionId, changeNote?}`. Archive/unarchive accept an optional empty object body. Actor IDs, space changes, lifecycle fields, revision numbers, and lock versions are never accepted from input. The exact content schema/limits and no-op/archive policy are in [core-schema.md](core-schema.md#native-blocknote-content-and-lifecycle-policy).

Create returns 201 with Location and ETag. Current read and successful mutations return 200 with ETag. Full document DTO fields are `{id, slug, spaceId, spaceSlug, currentRevisionNumber, lockVersion, createdAt, createdBy, updatedAt, archivedAt, archivedBy, revision}`. The nested current revision and single historical revision DTO have `{id, documentId, revisionNumber, title, content, plainText, authorId, createdAt, changeNote}`. Titles and bodies belong only to immutable revision snapshots.

Readable web paths resolve through `GET /api/v1/spaces/by-slug/:slug` and `GET /api/v1/spaces/:id/documents/by-slug/:slug`. Both enforce current access in core and return the same DTO/ETag as UUID reads. Missing and unauthorized slugs return 404 without titles/content/version disclosure; anonymous reads return 401. Slugs are 1-80 lowercase ASCII letters/digits separated by single hyphens. Mutation, revision, export and cursor APIs continue to use immutable UUIDs. Private slugs never become public metadata or authorization capabilities.

Document lists return `{items, nextCursor}` with lifecycle metadata and a top-level current title, without bodies/revision relations. They accept `limit` 1-100 (default 50), UUID `cursor`, and boolean `includeArchived` (default false), ordered by immutable document ID. Revision lists return the same pagination envelope with revision metadata but no content/plainText, newest first; their numeric cursor is the last revision number returned, exclusive. Both queries are bounded. Current and historical reads require access to the owning space; revision IDs are always scoped to the requested document.

Readers and outsiders cannot mutate and receive 404 without titles, content, versions, or ETags. Anonymous requests receive 401. Valid authenticated editor/admin mutations use exactly one strong document ETag: missing 428, stale 412, malformed/weak/wildcard/multiple 400. Archived saves/restores return 409 after access and precondition checks. Malformed content returns 400 and content byte/depth/node limit violations return 413; failures leave history/head unchanged.

## P3 native export contract

`GET /api/v1/documents/{id}/export` is a read operation with the same core authorization as current document reads, including archived documents. It returns 200 `application/json` with `Content-Disposition: attachment; filename="scrawl-document-{id}.json"`. Anonymous callers receive 401, outsiders or revoked members 404. Unknown query parameters are rejected with 400; there is no historical revision selector or Markdown conversion.

The separately allowlisted response has exactly these fields:

| Object | Fields |
| --- | --- |
| Root | `format` (`scrawl-document`), `exportVersion` (1), `document`, `revision`, `content` |
| `document` | `id`, `spaceId`, `createdAt`, `createdBy` |
| `revision` | `id`, `revisionNumber`, `title`, `createdAt`, `authorId` |
| `content` | `format` (`blocknote-json`), `schemaVersion` (1), `editorVersion` (`0.55.0`), `document` (validated native BlockNote blocks) |

The snapshot is selected by the authorized current-head read and revalidated through the existing parser. Source IDs/timestamps are provenance, not authentication records. No profiles, emails, roles, memberships, authentication/account/session records, passwords, cookies, tokens, lifecycle fields, change notes, or historical snapshots are included. It is a single-document native format, not a backup or import system.

## Search contract

`GET /api/v1/search` requires an authenticated session and accepts `q` (1-200 characters, containing a non-whitespace character), optional UUID `spaceId`, and `limit` (1-50, default 20). Unknown query fields are rejected. The response is `{items: [{id, spaceId, title, excerpt}]}`, without counts, cursors, versions, or historical snapshots. Excerpts are plain text bounded to 320 characters, not HTML highlighting.

The query applies current session, role, and membership inside SQL and searches only current nonarchived heads. Results sort by weighted title/body rank, then document ID. Plain words use PostgreSQL's language-neutral `simple` configuration and AND semantics, without stemming, prefix matching, or a custom Boolean query language. An inaccessible or nonexistent space filter returns the same empty list. `search:rebuild` rebuilds the derived GIN index without rewriting content or revision metadata.

## Attachment and rendered export contracts

`POST /api/v1/documents/{id}/attachments` accepts raw `application/octet-stream` bytes and a required `x-file-name` header containing a percent-encoded UTF-8 filename. The decoded filename is at most 200 characters and cannot contain controls or path separators. A successful upload returns 201 `{id, name, mimeType, size, url}`, with a permission-checked `/api/v1/attachments/{id}/content` URL. Uploads require current editor/admin access to an active saved document. They do not create a revision or advance the document ETag.

Files are bounded to 10 MiB each and 100 MiB per document. Content detection allows PNG/JPEG/GIF/WebP, PDF, DOCX/XLSX/PPTX, supported audio/video, and checked UTF-8 text (`.txt`, `.md`, `.csv`, `.log`). SVG, HTML, executables, and unknown types return 415; invalid filenames/corrupt images return 400, size/quota violations 413, and archived uploads 409. Images are decoded within a total pixel bound. Bytes and metadata are immutable, stored privately, and retained for historical references. Native saves/restores reject missing or cross-document attachment references without changing history. Discarding an unsaved block does not remove its already uploaded file.

Private attachment reads require current document access, including archived documents. Streams use safe filenames, `nosniff`, a sandbox CSP, and `no-store`; no uploads directory is public. Readers cannot upload, and outsiders or revoked members cannot retrieve private bytes.

`GET /api/v1/documents/{id}/exports/{format}` accepts `pdf` or `docx` and optional UUID `revisionId` belonging to that document. It returns the corresponding binary download using official BlockNote OSS exporters. Private PNG/JPEG/GIF images are embedded; WebP is rendered as PNG. Files/audio/video remain authenticated links. External media is rejected with 422 and never fetched. Embedded assets are bounded to 20 MiB, rendering failures return 422, and authorization is rechecked before returning compiled bytes. These are rendered snapshots, not backups, a bulk export, or a public export endpoint.

## Public publishing surface

See [public-publishing.md](public-publishing.md) for grant, lifecycle, and file semantics.

| Method and path | Behavior |
| --- | --- |
| `GET /api/v1/publishing` | Authenticated `{enabled, mayPublish}` availability |
| `GET /api/v1/documents/{id}/publication` | Authorized publication status and current document ETag |
| `POST /api/v1/documents/{id}/publication` | Administrator approves `{revisionId}`; `If-Match` required |
| `DELETE /api/v1/documents/{id}/publication` | Administrator revokes public access; `If-Match` required |
| `GET /api/public/publications/{publicId}` | Anonymous approved title/content only; no selectable revision |
| `GET /api/public/publications/{publicId}/attachments/{attachmentId}` | Stream only a file referenced by that valid selected publication |

`PUBLIC_PUBLISHING_ENABLED=false` denies publication writes and all anonymous reads with 404. Authenticated availability/status remain usable. Status and successful publication mutations return `{publication, lockVersion}` with the normal document ETag. `publication` is null or `{publicId, revisionId, revisionNumber, publishedAt, active}`; `active` reflects the grant and lifecycle, while availability reports the global pause separately.

Publishing requires an administrator and a same-document revision. A visible reader/editor receives 403; an outsider receives 404 without document information. Missing/stale preconditions return 428/412, cross-document revision selection 404, and publishing an archived document 409. Accepted publish/unpublish operations advance the document lock version atomically without creating a revision. Ordinary saves never change anonymous content, and archive/unarchive cannot revive an old grant.

Anonymous JSON is exactly `{title, content, publishedAt}`, with a separately allowlisted native content envelope and no private document/space/revision IDs, versions, authors, or history. Approved attachment URLs are rewritten to the publication-scoped route after checking the selected revision's normalized allowlist; private snapshots remain unchanged. Public responses use `no-store`. Unknown query fields are rejected, and no revision selector, public write, search, or browse endpoint exists. `/publications/{publicId}` is the same-origin read-only frontend path, not the JSON API.

## Content envelope

```json
{
  "title": "Getting started",
  "content": {
    "format": "blocknote-json",
    "schemaVersion": 1,
    "editorVersion": "0.55.0",
    "document": [
      {
        "id": "paragraph-1",
        "type": "paragraph",
        "props": {"backgroundColor": "default", "textColor": "default", "textAlignment": "left"},
        "content": [{"type": "text", "text": "Hello.", "styles": {}}],
        "children": []
      }
    ]
  }
}
```

The contract uses all 14 standard BlockNote blocks, all 7 styles, nested blocks, and advanced table cells. Strict validation rejects unknown properties/content, unsafe URLs, and lossy conversion. Limits include 256 KiB canonical JSON, nesting depth 32, and 10,000 nodes. The backend also checks an official server-utility round trip. Image/media blocks are supported; raw HTML/script nodes are not. Literal HTML text remains text. The API accepts only native version 1; legacy storage conversion is an explicit offline operator workflow, not a runtime compatibility layer.

## Conditional writes

```http
GET /api/v1/documents/8f995ee4-3cf8-4b33-9f26-8163beb9f6f4

HTTP/1.1 200 OK
ETag: "doc-8f995ee4-3cf8-4b33-9f26-8163beb9f6f4-bn1-v7"
```

```http
PATCH /api/v1/documents/8f995ee4-3cf8-4b33-9f26-8163beb9f6f4
If-Match: "doc-8f995ee4-3cf8-4b33-9f26-8163beb9f6f4-bn1-v7"
Content-Type: application/json

{"title":"Updated getting started"}
```

A state-changing mutation returns a new ETag. P2 canonical no-op saves and repeated lifecycle transitions return the unchanged ETag after checking the current precondition; restore always creates a new revision and ETag. Another caller submitting the old tag receives 412. A missing required precondition receives 428. Restrict accepted preconditions to a single strong server-issued tag for these operations; reject wildcard or malformed input rather than allowing a client to opt out of concurrency protection. Ensure tags change whenever the selected representation changes. Do not include volatile or actor-dependent fields in that representation without accounting for them in the validator.

A revision insert and document head advance must commit together. The conditional database update (or row lock) is the actual protection; checking an ETag in JavaScript before an unconditional UPDATE is not.

Publication changes use the same document precondition and advance its lock without a content revision. Uploads have no document ETag precondition because they do not change saved content; core still locks the space/document and rechecks access, lifecycle, and quota. A later save that references an upload uses the ordinary document precondition.

## Problems

Use `application/problem+json`, with standard `type`, `title`, and `status`, plus stable application `code` and `requestId`. Do not expose database errors or submitted secrets. Example:

```json
{
  "type": "about:blank",
  "title": "Precondition Failed",
  "status": 412,
  "code": "DOCUMENT_VERSION_CONFLICT",
  "requestId": "e4dca779-3971-4b0a-92f3-77098560e5ab"
}
```

Private resource discovery and editor mutations use the same not-found policy for unauthorized and missing resources, without titles or version numbers. Publishing has an explicit administrator-only 403 for an already authorized reader/editor; outsiders still receive 404. Disabled, revoked, or invalid anonymous publications return 404. Authentication, permission checks, and resource lookups have a deliberate ordering.

## Contract ownership

Implement route schemas beside the owning module. Generate OpenAPI from executable schemas and the frontend's typed client from that OpenAPI. Response schemas accompany input validation so internal fields do not slip into the API. The browser imports no database schema types. Private product versioning starts at `/api/v1`; anonymous projections use `/api/public`. This pre-release contract remains subject to change until the first supported release.

## ORM and JSON boundary

Use Prisma in owning query/application modules, not as the shape of public responses. IDs are strings, timestamps are UTC ISO strings, structured content is validated JSON, and any large integers are decimal strings. Add contract tests that exercise actual HTTP serialization and ensure no ORM-specific values or private relation fields escape. A global JSON replacer is not a substitute for deliberately selected response fields.


## Implementation and proposal boundaries

P1-P4 established identity/spaces, revisions/lifecycle, native export and Demo A, and the private React client. The current integration sequence replaces the old text-only packet restrictions: native BlockNote documents, attachments and rendered exports, PostgreSQL 18/search, then selected-revision publishing. Those HTTP surfaces are implemented; runtime results remain in validation/status documents.

Durable collaboration/comments are the next isolated integration, with storage/checkpoint policy in [ADR 0003](adr/0003-collaboration-checkpoints.md), followed by optional AI. Neither is an implemented HTTP/WebSocket contract here. Document hierarchies, public search/navigation, bulk import/export, full backup/restore, SSO, and integration-token/job/webhook/proposal workflows remain separate proposals. Do not include speculative routes in executable OpenAPI.

For HTTP semantics see [sources.md](sources.md) [S9][S10][S14]. No proposed route appears in executable OpenAPI until it has an implementation and tests.
