# Development recovery

This is a trusted, host-only PostgreSQL 18 recovery workflow for a stopped development instance. It is implemented on the integration branch, not released. Native JSON exports remain individual content snapshots.

Keep the application and every other connection to the source database stopped throughout backup. PostgreSQL's [custom-format dump](https://www.postgresql.org/docs/18/app-pgdump.html) provides a consistent database snapshot; Scrawl must coordinate the private filesystem separately. The command refuses another connected backend and checks source record/file fingerprints again after capture. This is not an online backup system.

The backup contains database records, including authentication/session data, all saved revisions, grants, personal favorites, publications, stored experimental live rooms/comments, and the matching private attachment files. The complete manifest is written last. Files/directories must be owner-only, with no symbolic links or unfamiliar private-storage filenames. Inside this checkout, new private output must use ignored `artifacts/` or `var/`, never source or frontend assets. Do not upload these archives to Git, issues, evidence or the application.

Runtime configuration and secrets are managed separately. Preserve the private environment file, `AUTH_SECRET`, cookie/origin settings and any local demo credential file with equivalent protection. The archive does not contain an environment file or recover plaintext passwords. This is an application database backup, not a cluster backup: PostgreSQL roles, ownership, ACLs, server configuration and tablespaces are not restored. The target connection role owns restored objects.

## Commands

Requires native `pg_dump` and `pg_restore` 18, or `--client-container NAME` naming the existing PostgreSQL 18 container whose loopback port matches `DATABASE_URL`. It does not start a server or change a volume. The password is passed in the child environment, never in command arguments or output. `--demo` reads the guarded owner-only `.env.demo` in the current directory; otherwise the npm command reads the ordinary local `.env`.

For a stopped local development application with a matching database/private-storage configuration:

```sh
install -d -m 700 artifacts/private-recovery
npm run recovery -- backup \
  --output artifacts/private-recovery/first-checkpoint \
  --application-stopped \
  --client-container scrawl-autonomous18-postgres-1

npm run recovery -- restore \
  --backup artifacts/private-recovery/first-checkpoint \
  --database scrawl_recovery_rehearsal \
  --storage var/recovery-rehearsal-files \
  --trusted \
  --client-container scrawl-autonomous18-postgres-1
```

Change the container name to the actual existing local server, or omit that option when native 18 clients are installed on the host. Never copy a connection URL into shell arguments. The script rejects production, remote targets and schema-specific URLs. Restore database names must start with `scrawl_recovery_`; the database and storage directory must both be new. Restore storage cannot be inside the immutable backup. Repeat execution deliberately refuses existing outputs/targets, preserving them.

For the current retained synthetic demo, first deliberately stop its application using the process instructions in [the walkthrough](demo-walkthrough.md#restart-the-current-demo). Then use its matching private configuration and existing container:

```sh
cd /home/dev/t3/projects/scrawl/artifacts/demo18
install -d -m 700 artifacts/private-recovery
node --import ../../node_modules/tsx/dist/loader.mjs ../../scripts/recovery.ts backup \
  --demo --application-stopped \
  --output artifacts/private-recovery/first-checkpoint \
  --client-container scrawl-demo-a18-postgres-1

node --import ../../node_modules/tsx/dist/loader.mjs ../../scripts/recovery.ts restore \
  --demo --trusted \
  --backup artifacts/private-recovery/first-checkpoint \
  --database scrawl_recovery_rehearsal \
  --storage var/recovery-rehearsal-files \
  --client-container scrawl-demo-a18-postgres-1
```

These retained-demo commands are instructions, not a claim that this session stopped or backed up that preview. Restart the original preview using the walkthrough, with its original configuration. To inspect a recovered application, use a separate protected development configuration pointing at the new database and storage directory, a free loopback port and matching local origin. Do not point it at the original database or expose a new tunnel. Preserve the original auth secret if validating existing signed sessions. Verify fresh authentication, grants, saved content and private/public file boundaries before relying on recovered data.

Restore validates the complete manifest and archive/file hashes before creating a database. Native [single-transaction restore](https://www.postgresql.org/docs/18/app-pgrestore.html) fails on any restore error. The tool compares restored public-table record fingerprints and runs the saved-content/private-file integrity scan. Failure removes only resources that this invocation successfully created. It never cleans or drops a preexisting target. If cleanup itself fails, inspect the explicitly named new target before retrying; a nonzero exit is not success. Only trusted archives are accepted, since native restore executes SQL.

## Verification and limits

Run the owned synthetic recovery rehearsal on the existing test server:

```sh
SCRAWL_PG_CLIENT_CONTAINER=scrawl-autonomous18-postgres-1 NODE_ENV=test \
  node --env-file-if-exists=.env --import tsx --test test/integration/recovery.test.ts
```

The test creates fresh source/restore databases on that server, migrates the existing history, provisions real synthetic accounts and exercises the actual HTTP API. It captures rich revisions, private files, selected public content, favorites and a stored native live comment. It checks existing sessions, fresh login, reader/outsider isolation, indexed search, publication file allowlists and conditional writes after restore. It also verifies malformed/incomplete archives, traversal, tampered/symlink files, existing targets, native failure cleanup and unchanged source history. Its owned databases and private temporary files are removed afterward.

Current limits are a two-minute native-tool deadline, a 1 GiB dump, a 1 MiB manifest and the application's existing per-file upload limit. Record fingerprinting aggregates each public table in memory on PostgreSQL; large-instance scalability is unverified. The native dump preserves other database objects, but the application record comparison covers `public` tables. Encryption/offsite storage, scheduled backups, production recovery, recovery across servers/roles, reconnecting browser live sessions and cluster-level disaster recovery remain unverified. No new migration or dependency is required.
