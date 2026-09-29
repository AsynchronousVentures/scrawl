# Primary references

Consulted 2026-09-29. Upstream package instructions can change or redirect to another major. Recheck support/security and pin a tested combination when implementing. Architectural choices, task ordering and acceptance tests are project proposals, not upstream guarantees.

- **[S1]** Standard AGPL-3.0 text, including sections 2, 5, 6 and 13: https://spdx.org/licenses/AGPL-3.0-only.html
- **[S2]** SPDX exact license identifier and version-choice distinction: https://spdx.org/licenses/AGPL-3.0-only.html
- **[S3]** Fastify validation/serialization and application-owned schemas: https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/
- **[S4]** Fastify Swagger/OpenAPI generation: https://github.com/fastify/fastify-swagger
- **[S5]** Better Auth Prisma adapter; current guide specifies Prisma 7 and delegates migrations: https://better-auth.com/docs/adapters/prisma
- **[S6]** Better Auth Fastify integration: https://better-auth.com/docs/integrations/fastify
- **[S7]** Prisma transaction mechanics and version differences: https://www.prisma.io/docs/orm/fundamentals/transactions and https://www.prisma.io/docs/guides/upgrade-prisma-orm/postgresql
- **[S8]** Tiptap content storage/export and collaboration caveats: https://tiptap.dev/docs/guides/output-json-html
- **[S9]** HTTP semantics/conditional requests and 412: https://www.rfc-editor.org/rfc/rfc9110.html
- **[S10]** Required preconditions, 428: https://www.rfc-editor.org/rfc/rfc6585.html
- **[S11]** PostgreSQL full-text search: https://www.postgresql.org/docs/current/textsearch-intro.html
- **[S12]** Fastify plugins/encapsulation: https://fastify.dev/docs/latest/Reference/Plugins/
- **[S13]** Node supported releases: https://nodejs.org/en/about/previous-releases
- **[S14]** Problem details for HTTP APIs: https://www.rfc-editor.org/rfc/rfc9457.html

## Included license provenance

The included LICENSE is an unmodified full standard AGPL v3 license document, copied from an existing local distribution of that standard license because direct artifact downloads were unavailable. No implementation code from that distribution was copied or made a dependency. The title, version, license terms and source-availability provision were checked against the primary SPDX rendering above; P0 subsequently established byte-for-byte equivalence with https://www.gnu.org/licenses/agpl-3.0.txt. The exact included file checksum is recorded in VALIDATION.md. Preserve the canonical text and the project-specific version-3-only notice.

The full license text itself grants permission to distribute verbatim copies. Its FSF copyright line refers to the license document, not ownership of this application. [S1]
