# Integration demo work

Work is on `integration/blocknote-demo`. GitHub's `main` contains the completed P4 checkpoint `445bae2`; integration work is not merged or released. The maintainer authorized this session to continue across packet boundaries, push the integration branch and maintain a draft PR. No merge, public tunnel or production deployment is authorized.

| Priority | Issue | State | Depends on |
| --- | --- | --- | --- |
| P0 | [Native BlockNote and finished private workflow](https://github.com/AsynchronousVentures/scrawl/issues/1) | In progress | Existing P0-P4 |
| P1 | [Private attachments and PDF/DOCX exports](https://github.com/AsynchronousVentures/scrawl/issues/2) | Planned | Native content |
| P1 | [PostgreSQL 18 and indexed authorized search](https://github.com/AsynchronousVentures/scrawl/issues/3) | Planned | Saved native content/text |
| P2 | [Selected-revision publishing](https://github.com/AsynchronousVentures/scrawl/issues/4) | Planned | Native content and attachment grants |
| P3 | [Durable collaboration and comments](https://github.com/AsynchronousVentures/scrawl/issues/5) | Planned, isolated until usable | Stable document/attachment/checkpoint contracts |

Optional AI is secondary. No paid provider calls are authorized and missing provider access is not a blocker. Search uses PostgreSQL, never embeddings or an external search service. Layout/export additions use available OSS BlockNote packages rather than a custom framework.

The original PostgreSQL 17 demo and volume remain intact. PostgreSQL 18 gets a separate fresh volume with the official `/var/lib/postgresql` mount. Retained-data upgrade rehearsals use disposable copies only. Destructive fixture commands continue to require an explicit development database marker and confirmation; no reset is implicit.

Commit/check results and runnable commands are recorded in [VALIDATION.md](../VALIDATION.md), with actual demo use in [the walkthrough](demo-walkthrough.md). Update this table at each integration milestone; completing work on the branch does not mean it was merged or released.
