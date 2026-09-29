# Copy-paste development-agent kickoff

```text
We are building an entirely open-source, self-hosted documentation platform
as an Asynchronous Ventures project. Name: Scrawl. Repository: scrawl.
The selected license is AGPL-3.0-only; keep the included LICENSE and metadata.

Read AGENTS.md, README.md, VALIDATION.md, docs/plan.md, docs/decisions.md,
docs/architecture.md, docs/backlog.md, and docs/agents/first-packet.md.

Implement ONLY packet P0 now. Inspect and verify the supplied foundation;
do not replace it with a generated application template. Use Node.js 24,
TypeScript, Fastify and PostgreSQL, and retain npm unless a concrete blocker
requires a recorded change. Create and review the dependency lockfile,
run all existing checks including real PostgreSQL integration tests,
fix issues, and establish minimal CI. Do not claim tests passed if tooling
or infrastructure was unavailable.

Prisma and Better Auth are the planned P1 integration. Do not install or
implement them as unrelated work in P0. Do not write document APIs or a UI yet.

Architecture direction: platform services + a small document/access core +
first-party capabilities consuming explicit authorized core operations.
The core owns permissions, revisions and concurrency. Capabilities do not
get an unrestricted escape hatch into other modules' tables. Reuse maintained
OSS libraries; avoid generic repositories, speculative interfaces and a plugin SDK.

Product sequence after P0: real identity/access -> document/revision API ->
API demo -> thin editor/history UI -> selected-revision public publishing.
Private edits must never automatically replace the public version.

No tenants, billing, paid gates, AI, chat connectors, queues, Redis,
collaborative editing, autosave or runtime plugin loading. Use synthetic data
and example domains only. No default admin password or fake-auth header.

Keep planning, implementation and verification clearly separated. Update
VALIDATION.md and docs/status.md with exact commands/results and unresolved
risks. Do not invent a repository URL, expose the server publicly, install
hosted integrations, push, or merge without permission.

At completion, report what changed, tests actually run, migration impacts,
remaining blockers, and the next bounded packet. Stop after P0 for review.
```

For later sessions, replace the P0-specific assignment with one named packet from [backlog.md](../backlog.md). Keep the same product boundaries and reporting requirements. Do not send the entire backlog as an instruction to implement everything at once.
