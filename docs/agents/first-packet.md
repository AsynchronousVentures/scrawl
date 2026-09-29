# P0 — Verify the foundation

## Objective and stopping point

Establish a reproducible, honestly validated starting commit. **Stop before adding Prisma, authentication, spaces, documents or a frontend.** Those are separate work packets, not unresolved architecture debates.

## Read first

README.md, VALIDATION.md, docs/plan.md, docs/decisions.md, docs/architecture.md, and docs/agents/working-agreements.md. AGPL has been selected and applied; do not reopen the license decision or switch to MIT.

## Work

1. Inspect existing files and scripts. Report the actual runtime/tool availability. Use the target Node.js 24 runtime; do not claim a different Node major validates it.
2. Resolve compatible supported versions of the dependencies already used. Review licenses and advisories, commit package-lock.json and use `npm ci` afterward. Avoid a major migration merely because a newer package exists.
3. Run full typecheck, unit/config/HTTP tests, build, generated OpenAPI export, and the existing database integration suite against PostgreSQL. Correct foundation defects without replacing the entire app.
4. Add minimal CI running those checks with the same Node/PostgreSQL targets. Ensure database tests fail visibly when expected infrastructure is absent instead of silently skipping a required gate.
5. Verify README instructions and environment defaults. Keep development listeners/database exposure local. Confirm logs/errors do not include secrets or request bodies. Leave auth endpoints absent rather than adding a bypass.
6. Verify license file/package metadata and keep source/licensing release requirements in the plan. Do not invent a public source URL before a repository exists.
7. Update VALIDATION.md and docs/status.md with observed results. Capture any initial defect and fix in the completion report.

## Acceptance

A fresh environment can install from the reviewed lockfile and pass all actual foundation checks. OpenAPI includes only registered operational routes, not planned product endpoints. No .env, session, password, database dump or dependency directory is committed. CI definitions exist and local equivalents pass; state separately whether remote CI ran.

## Existing commands to verify

```sh
node --version
cp .env.example .env
npm install
# Review and commit the lockfile; use npm ci for subsequent installs.
docker compose up -d --wait postgres
npm run check
npm run test:db
npm run openapi:export
```

These are current foundation commands, not commands for the unimplemented demos. Do not claim a `demo:seed`, migration, bootstrap or frontend command already exists.

## Report and stop

Changed files; checks with exit/results; dependency pins; blockers; no domain migration yet; next packet P1. Do not create/push a remote repository or proceed to P1 without the next assignment.
