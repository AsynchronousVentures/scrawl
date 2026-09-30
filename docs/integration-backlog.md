# Integration demo work

Work is on `integration/blocknote-demo`. GitHub's `main` contains the completed P4 checkpoint `445bae2`; integration work is not merged or released. The maintainer authorized this session to continue across packet boundaries, push the integration branch and maintain a draft PR. A later explicit request authorizes public Tailscale Funnel access for the synthetic Scrawl preview and stale-preview cleanup. No merge or production deployment is authorized.

| Priority | Issue | State | Depends on |
| --- | --- | --- | --- |
| P0 | [Native BlockNote and finished private workflow](https://github.com/AsynchronousVentures/scrawl/issues/1) | Implemented on branch; full 41-case browser and both DB regressions passed | Existing P0-P4 |
| P1 | [Private attachments and PDF/DOCX exports](https://github.com/AsynchronousVentures/scrawl/issues/2) | Implemented and verified on branch | Native content |
| P1 | [PostgreSQL 18 and indexed authorized search](https://github.com/AsynchronousVentures/scrawl/issues/3) | Implemented and verified on branch; retained-data copy rehearsal passed | Saved native content/text |
| P2 | [Selected-revision publishing](https://github.com/AsynchronousVentures/scrawl/issues/4) | Implemented and verified on branch; default off | Native content and attachment grants |
| P3 | [Durable collaboration and comments](https://github.com/AsynchronousVentures/scrawl/issues/5) | Storage/auth/checkpoint/undo contract resolved; isolated runtime work remains | Stable document/attachment/checkpoint contracts |

Optional AI is secondary. No paid provider calls are authorized and missing provider access is not a blocker. Search uses PostgreSQL, never embeddings or an external search service. Layout/export additions use available OSS BlockNote packages rather than a custom framework.

The original PostgreSQL 17 demo and volume remain intact. PostgreSQL 18 gets a separate fresh volume with the official `/var/lib/postgresql` mount. Retained-data upgrade rehearsals use disposable copies only. Destructive fixture commands continue to require an explicit development database marker and confirmation; no reset is implicit.

Draft PR: [#6](https://github.com/AsynchronousVentures/scrawl/pull/6). Pushed implementation checkpoints are native `7bc8621`, PostgreSQL `f3920c7`, search `9ce29dd`, attachments/exports `847dff4`, publishing `01989a2`, connected application `0cf2d80`, and final draft/navigation hardening `9874740`. The complete database regression passed 86/86 on both 17.11 and 18.6; the clean browser run passed 41/41. The final delayed-read and opener-isolation regressions passed in that clean run; the [complete hosted matrix](https://github.com/AsynchronousVentures/scrawl/actions/runs/36680339346) passed on code checkpoint `9874740` against PostgreSQL 17 and 18. Documentation-only commits follow that code checkpoint. Demo A passed 368 assertions, rich seeding was repeat-safe, and fresh sessions verified the persistent private demo.

Collaboration is not described as an external-access blocker: its application runtime is still work to implement. [ADR 0003](adr/0003-collaboration-checkpoints.md) resolves durable room epochs, immutable checkpoints, local-only undo, restore, recipient authorization and private comments. Narrow upstream runtime proofs passed, but protected CRDT validation, actual persistence/authenticated sockets, recovery/reconnect and browser handoff must pass before enabling it. Optional AI remains secondary and unimplemented.

The private-workflow issue also includes readable links: persisted space/document slugs, collision-safe creation, stable links after title saves/restores, authorized direct loading and retained UUID query bookmarks. The seventh migration backfills navigation metadata without changing content/history/versions. Full local regression passed 92 database tests on both 17 and 18, 43 real browser workflows with no retries/skips, and the persistent Funnel acceptance with canonical links/reloads. This remains implemented on the integration branch, awaiting review and not merged or released.

Commit/check results and runnable commands are recorded in [VALIDATION.md](../VALIDATION.md), with actual demo use in [the walkthrough](demo-walkthrough.md). Update this table at each integration milestone; completing work on the branch does not mean it was merged or released.
