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
| Frontend timing | Thin UI after private-core tests, not after all backend capabilities |
| Publishing | Disabled by default, administrator action, selected-revision grant |
| Search/files | Add after the first three demos, with their own API-first tests |
| Dependencies | No speculative queue/cache/search service/plugin runtime |

Technical pins are decided in P0/P1 and documented with command output. Licensing choice is no longer pending. See [plan.md](plan.md), [architecture.md](architecture.md), and [sources.md](sources.md).

The BlockNote foundation replaces P2's restricted schema. Canonical no-op saves still keep the current revision/version; restore always appends history. Archive/unarchive changes lifecycle versions, preserves authorized history reads, and blocks content mutations while archived. The native format and future live-state/checkpoint boundaries are recorded in [ADR 0001](adr/0001-native-blocknote-documents.md); durable vocabulary is in [CONTEXT.md](../CONTEXT.md).
