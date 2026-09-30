# Implemented P1-P3 API and remaining proposals

Live/generated OpenAPI contains health routes, P1 identity/space operations, P2 document/revision/lifecycle operations, and P3 native export below. Publishing, search, and files remain proposals and are absent from OpenAPI. Auth routes retain library request semantics under their separate namespace.

## Authentication and principal

Use the selected library's session endpoints under `/api/auth/*`. Product endpoints use `/api/v1/*`. Do not rename or wrap every identity-provider operation without need. A small `/api/v1/me` response can expose the application's effective identity and role after successful authentication.

One deployment is one knowledge base, private by default with separately approved public projections. Do not accept arbitrary organization IDs to simulate multi-tenancy. Use server-resolved actor IDs and deny-by-default product access. Use local library-managed credentials/sessions, closed registration and explicit administrator provisioning/recovery for Demo A. Optional OIDC linking and richer onboarding are later assigned work, not prerequisites to the local demo.

P1 mounts only `POST /api/auth/sign-in/email`, `GET /api/auth/get-session`, and `POST /api/auth/sign-out`. HTTP registration, profile/role changes, provisioning, recovery, and impersonation are absent. Auth success JSON allowlists user fields and session expiry, excluding raw session tokens. Auth errors preserve native codes with generic status messages; credentials are conveyed through library-managed HttpOnly cookies. This is a deliberate response restriction to meet the P1 requirement that JSON DTOs contain no credentials.

`GET /api/v1/me` returns `{id, name, email, role}`. Space responses contain `{id, name, createdBy, createdAt, updatedAt, lockVersion}`. Space creation returns 201 with Location and ETag; read and membership mutations return ETag. PUT/DELETE membership returns the updated space DTO. A missing If-Match is 428; a stale single strong tag is 412; weak, wildcard, or multiple-tag syntax is 400. Check access before reporting these resource/precondition failures.

Space listing returns `{items, nextCursor}`, filters visibility in the query, and accepts `limit` (1-100, default 50) and a UUID `cursor`. Ordering is by immutable ID. Instances with no accessible spaces return an empty list, with no hidden totals. Authenticated unauthorized resource requests return the same 404 as missing resources. Anonymous product requests are denied. Cookie-based product writes require the exact configured Origin.

## Resource surface

| Method and path | Behavior |
| --- | --- |
| `GET /api/v1/me` | Effective authenticated user and instance role |
| `POST /api/v1/spaces` | Administrator creates a space |
| `GET /api/v1/spaces` | Only spaces the actor can access |
| `GET /api/v1/spaces/{id}` | Read authorized space |
| `PUT /api/v1/spaces/{id}/members/{userId}` | Administrator grants/changes access; require space version precondition |
| `DELETE /api/v1/spaces/{id}/members/{userId}` | Administrator revokes access; require space version precondition |
| `POST /api/v1/spaces/{id}/documents` | Editor creates a document and first revision atomically |
| `GET /api/v1/spaces/{id}/documents` | Bounded authorized listing, with a same-space parent filter only after P6 |
| `GET /api/v1/documents/{id}` | Current document representation plus `ETag` |
| `PATCH /api/v1/documents/{id}` | Title/content change with `If-Match`; same-space parent metadata added in P6 |
| `GET /api/v1/documents/{id}/revisions` | Bounded immutable history, without full bodies by default |
| `GET /api/v1/documents/{id}/revisions/{revisionId}` | Authorized revision snapshot; revision must belong to document |
| `POST /api/v1/documents/{id}/restore` | New revision copied from selected historical revision; `If-Match` required |
| `POST /api/v1/documents/{id}/archive` | Archive without erasing history; `If-Match` required |
| `POST /api/v1/documents/{id}/unarchive` | Restore availability; `If-Match` required |
| `GET /api/v1/search` | Query only authorized, nonarchived content |
| `POST /api/v1/documents/{id}/attachments` | Size-limited authorized upload |
| `GET /api/v1/attachments/{id}/content` | Authorized stream; never an unrestricted uploads directory |
| `GET /api/v1/documents/{id}/export` | Authorized current native JSON snapshot; no format or revision query |

Space-wide native export/import and administrator backup/restore are P8/P9 tasks; specify them after file and archive semantics are proven. Integration tokens, jobs, webhooks, external sources, and proposal workflows are deliberately absent. Public publishing is specified separately below.

## P2 document contracts

Create accepts `{title, content, changeNote?}`. PATCH accepts only `{title?, content?, changeNote?}` and requires title or content. Restore accepts `{revisionId, changeNote?}`. Archive/unarchive accept an optional empty object body. Actor IDs, space changes, lifecycle fields, revision numbers, and lock versions are never accepted from input. The exact content schema/limits and no-op/archive policy are in [core-schema.md](core-schema.md#p2-content-and-lifecycle-policy).

Create returns 201 with Location and ETag. Current read and successful mutations return 200 with ETag. Full document DTO fields are `{id, spaceId, currentRevisionNumber, lockVersion, createdAt, createdBy, updatedAt, archivedAt, archivedBy, revision}`. The nested current revision and single historical revision DTO have `{id, documentId, revisionNumber, title, content, plainText, authorId, createdAt, changeNote}`. Titles and bodies belong only to immutable revision snapshots.

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
| `content` | `format` (`prosemirror-json`), `schemaVersion` (1), `document` (validated native JSON) |

The snapshot is selected by the authorized current-head read and revalidated through the existing parser. Source IDs/timestamps are provenance, not authentication records. No profiles, emails, roles, memberships, authentication/account/session records, passwords, cookies, tokens, lifecycle fields, change notes, or historical snapshots are included. It is a single-document native format, not a backup or import system. Full portability remains P8/P9.

## Public publishing surface — proposed

See [public-publishing.md](public-publishing.md) for grant, lifecycle, and file semantics.

| Method and path | Behavior |
| --- | --- |
| `POST /api/v1/documents/{id}/publish` | Explicit administrator publication of a named revision; `If-Match` required |
| `POST /api/v1/documents/{id}/unpublish` | Revoke public access; `If-Match` required |
| `GET /api/v1/public/documents/{publicId}` | Active published revision only; no private metadata or selectable revision |
| `GET /api/v1/public/documents/{publicId}/attachments/{attachmentId}` | Stream only a file allowed by that active publication |

Publishing is disabled by default. Ordinary saves never change anonymous content. Document mutations and publication-state mutations coordinate through the core's lock/version operations. Public response schemas are separately allowlisted, not private DTOs with a few fields removed. No public search or browse endpoint exists until it can query only active published projections.

## Content envelope

```json
{
  "title": "Getting started",
  "content": {
    "format": "prosemirror-json",
    "schemaVersion": 1,
    "document": {
      "type": "doc",
      "content": [
        {"type": "paragraph", "content": [{"type": "text", "text": "Hello."}]}
      ]
    }
  }
}
```

Apply the exact supported node/mark schema and limits from the core content module. P2 rejects images, arbitrary HTML, and script nodes.

## Conditional writes

```http
GET /api/v1/documents/8f995ee4-3cf8-4b33-9f26-8163beb9f6f4

HTTP/1.1 200 OK
ETag: "doc-8f995ee4-3cf8-4b33-9f26-8163beb9f6f4-v7"
```

```http
PATCH /api/v1/documents/8f995ee4-3cf8-4b33-9f26-8163beb9f6f4
If-Match: "doc-8f995ee4-3cf8-4b33-9f26-8163beb9f6f4-v7"
Content-Type: application/json

{"title":"Updated getting started"}
```

A state-changing mutation returns a new ETag. P2 canonical no-op saves and repeated lifecycle transitions return the unchanged ETag after checking the current precondition; restore always creates a new revision and ETag. Another caller submitting the old tag receives 412. A missing required precondition receives 428. Restrict accepted preconditions to a single strong server-issued tag for these operations; reject wildcard or malformed input rather than allowing a client to opt out of concurrency protection. Ensure tags change whenever the selected representation changes. Do not include volatile or actor-dependent fields in that representation without accounting for them in the validator.

A revision insert and document head advance must commit together. The conditional database update (or row lock) is the actual protection; checking an ETag in JavaScript before an unconditional UPDATE is not.

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

Authenticated but unauthorized resource requests use the same not-found policy as missing resources; do not disclose titles or version numbers in errors. Authentication, permission checks, and resource lookups have a deliberate ordering.

## Contract ownership

Implement route schemas beside the owning module. Generate OpenAPI from executable schemas. Add response schemas as well as input validation so internal fields do not slip into the API. When the frontend arrives, generate its client from OpenAPI; do not import database schema types into it. Versioning starts at `/api/v1`, but this pre-release design remains subject to change until the first supported release.

## ORM and JSON boundary

Use Prisma in owning query/application modules, not as the shape of public responses. IDs are strings, timestamps are UTC ISO strings, structured content is validated JSON, and any large integers are decimal strings. Add contract tests that exercise actual HTTP serialization and ensure no ORM-specific values or private relation fields escape. A global JSON replacer is not a substitute for deliberately selected response fields.


## Packet boundaries

P1 implements identity/spaces; P2 document/revision/lifecycle routes; P3 native single-document export and the API demo. P4 is a thin client of that API. P5 implements text-only publishing before images exist. P6 adds search/nesting, P7 files and publication-scoped file reads, and P8/P9 complete portability/recovery. Rows through unarchive and native export are implemented. Search, attachments, and publication rows are proposals.

For HTTP semantics see [sources.md](sources.md) [S9][S10][S14]. No proposed route appears in executable OpenAPI until it has an implementation and tests.
