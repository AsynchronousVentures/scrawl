# Implementation status

Recorded 2026-09-29 after local P0 verification. See [VALIDATION.md](../VALIDATION.md) for commands, versions, initial failures, fixes, and limits.

| Area | Status |
| --- | --- |
| Project identity | Scrawl; repository name `scrawl`; no public URL supplied |
| AGPL-3.0-only license and package metadata | Applied; LICENSE matches official GNU text byte-for-byte |
| Demo plan, backlog, schema brief and agent handoff | Written; P1 onward remains proposed |
| Foundation source/tests | Supplied scaffold retained; serializer/error handling fixed; 25 config/HTTP/logging tests pass |
| P0 runtime, dependencies, build and OpenAPI | Verified on Node 24; exact pins and reviewed lockfile; `npm ci` and all foundation checks pass |
| P0 PostgreSQL | Real PostgreSQL 17 readiness test passes; unavailable database fails visibly |
| P0 CI | Workflow added for Node 24/PostgreSQL 17; local commands pass; hosted execution not run |
| P1 Prisma/auth/access | Not implemented |
| P2 documents/revisions | Not implemented |
| P3 API demo/export | Not implemented |
| P4 thin UI | Not implemented |
| P5 public publishing | Not implemented |
| P6-P9 search/files/portability/release | Not implemented |
| Public repository/source URL and private security reporting | Still required before public release |
| New-project review-service OSS eligibility | Not confirmed; not a runtime dependency |

P0 is complete locally and ready for review. No schema/migration changes or local blockers. No push, hosted integration, remote CI run, or deployment occurred. Temporary database resources were removed after verification. Next packet is P1, only when assigned.
