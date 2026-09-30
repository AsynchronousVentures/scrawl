# Demo walkthrough

Demo A is implemented and verified locally through P3. Demo B and Demo C remain acceptance scripts for later packets. Use synthetic content only. See [VALIDATION.md](../VALIDATION.md) for observed results and limits.

## Run Demo A

Requires Node.js 24, npm, Docker Compose, and free loopback ports 5433 and 3100. Run from the repository root. This uses its own private `.env.demo` and disposable PostgreSQL database `scrawl_demo_a`, separate from ordinary `.env` development configuration.

```sh
npm ci
npm run demo:init
docker compose --env-file .env.demo -f compose.demo.yaml up -d --wait postgres
npm run demo:setup -- --database scrawl_demo_a
npm run demo:serve
```

Leave the server running. In a second terminal at the repository root:

```sh
npm run demo:a
npm run demo:a
cat artifacts/demo/export.json
cat artifacts/demo/result.json
```

Each successful run creates a fresh "Demo Handbook" space and "Release checklist" document through actual HTTP requests. It leaves three immutable revisions and revokes its editor membership at the end. Repeating the runner preserves earlier spaces/documents and the four provisioned accounts. `result.json` records the latest successful run's IDs and assertion count; `export.json` is its current revision's native snapshot. Both are ignored, owner-only local files. They are written after the walkthrough assertions pass.

The runner exits nonzero on assertion, transport, or parser failure. It never retries creates or saves. A failed run can leave partial synthetic data and live sessions until expiry or explicit reset; it does not silently clean up. Failures before artifact writing preserve the latest successful files. Existing authentication rate limits remain active, so rapid repeated sign-ins can fail. The tested Linux runner uses distinct loopback source addresses for actors rather than bypassing those limits.

## Fixtures and explicit reset

`demo:init` exclusively creates owner-only `.env.demo` with locally generated authentication and database secrets. It refuses to overwrite existing configuration. `demo:setup` applies the existing Prisma migration history and uses the existing host operator operations to bootstrap/provision:

| Identity | Instance role | Per-run access |
| --- | --- | --- |
| `administrator@example.test` | Administrator | Creates space and manages memberships |
| `editor@example.test` | Member | Editor, with two separate authenticated cookie jars |
| `reader@example.test` | Member | Reader |
| `outsider@example.test` | Member | No membership |

Passwords are generated locally into ignored, owner-only `artifacts/demo/credentials.json`. Commands print only fixture emails and IDs. Do not print or share this file, `.env.demo`, cookies, or session tokens. The runner keeps cookie jars in memory and signs out all five sessions after a successful run.

Setup refuses an existing credential file or populated instance. Reset requires explicit confirmation of the fixed disposable database name. Both commands refuse production, missing development/disposable markers, non-demo database names, remote hosts, URL options, mismatched database settings, or a demo connection pool below two connections. They consume `.env.demo`, never an arbitrary ambient `DATABASE_URL`, and verify the actual connected database/user. Concurrent fixture commands are refused. Reset also refuses unexpected public tables.

Stop `demo:serve` with Ctrl-C before resetting. Reset deletes synthetic document/access/authentication rows and the credential manifest, preserves the migration ledger and private configuration, and does not provision automatically:

```sh
npm run demo:reset -- --database scrawl_demo_a
npm run demo:setup -- --database scrawl_demo_a
npm run demo:serve
```

Then run `npm run demo:a` in the second terminal again. Reset without `--database scrawl_demo_a` fails without changing data. The next setup generates new account IDs and passwords. Existing successful export/result files are retained as local artifacts until another successful run.

To remove this disposable database, first stop the server and explicitly reset as above, then:

```sh
docker compose --env-file .env.demo -f compose.demo.yaml down -v
rm .env.demo
```

This removes only this Compose project's demo volume. Keep `.env.demo` if retaining the database volume, since it contains that database's generated credentials. Port changes must keep `PORT`/`APP_ORIGIN` and `DEMO_DB_PORT`/`DATABASE_URL` consistent in the private file.

## Demo A assertions

Revision 1 contains "Run tests before deploying." Revision 2 adds "Verify the backup." Restoring revision 1 creates revision 3 with the original content and leaves revisions 1 and 2 intact. The private marker used in Demo C below is not added by Demo A.

| Step | Action | Asserted evidence |
| --- | --- | --- |
| 1 | Explicitly migrate/provision a fresh disposable database; sign in each actor | Real sessions and identities; anonymous product access denied |
| 2 | Administrator creates space/grants membership | Outsider sees no space; reader cannot administer |
| 3 | Editor creates the checklist | One document and revision 1; server ETag |
| 4 | Two isolated editor clients read the same document | Matching representation and starting ETag |
| 5 | Client A saves revision 2; client B submits the old tag | Success then 412; exactly one new revision; rejected write leaves head/history unchanged |
| 6 | Submit a mutation without If-Match | 428; unchanged head/history |
| 7 | Reader attempts edit/restore/archive/unarchive | 404; unchanged head/history |
| 8 | Outsider guesses document/revision IDs and attempts a write | 404 without resource fields or ETag; anonymous requests 401; unchanged history |
| 9 | Editor restores revision 1 | Revision 3 has a new ID and original content; intervening history preserved |
| 10 | Reader exports native JSON; outsider and anonymous clients try export | Authorized snapshot matches selected content through the existing parser; denied exports; exact allowlisted keys and no secret/session values |
| 11 | Editor archives; administrator unarchives | Only lifecycle lock versions advance; current content/history retained; default list excludes archived document |
| 12 | Administrator revokes editor; both existing editor sessions request again | Read/write/history/export denied; original cookie unchanged and `/me` still works; history unchanged |
| 13 | Sign out all authenticated clients | Subsequent `/me` requests return 401 |

The mandatory PostgreSQL suite separately preserves P2's actual overlapping-save race and forced failure between revision insertion and head advance. The runner demonstrates stale clients in sequence; it does not replace those transaction tests. P3 tests run the executable twice, verify persisted counts, inject a failed save and prove a nonzero exit with exactly one attempt, reject unsafe resets, explicitly reset/reseed, and run again.

## Native export scope

`GET /api/v1/documents/{id}/export` returns the current authorized snapshot as an `application/json` attachment, including for an archived document. Readers, editors, and administrators with access can export. Outsiders receive 404 and anonymous callers 401. There is no revision selector or format query.

The envelope contains `format: "scrawl-document"`, `exportVersion: 1`, minimal document/revision provenance, and `content` with `format: "prosemirror-json"`, `schemaVersion: 1`, and native document JSON. Provenance includes document/space/revision IDs, revision number/title, timestamps, and creator/author IDs. It excludes profiles, emails, roles, memberships, credentials, session data, and authentication records. Content is validated by the existing restricted parser in the core operation and revalidated/matched by the runner.

This is one current document snapshot, not complete revision history, bulk portability, import, or an instance backup. See [API contracts](api-design.md) for the exact field allowlists. The runner's export is revision 3, after restore, containing "Run tests before deploying.".

## Demo B — usable private wiki

Log in through the UI. Create and edit the checklist, save explicitly, reload, browse history, and restore a revision. Open the same page in two editor windows. Save the first, then the second. The conflict view must preserve the second window's local content and offer a deliberate path to compare/reconcile; it must not silently retry with a new ETag.

Log in as reader and outsider to demonstrate that hidden buttons are not the permission boundary. Exercise loading/error/empty states, keyboard navigation, and unsaved-change warnings. The UI and API must agree on revision identity.

## Demo C — selective public publishing

Enable publishing explicitly. Administrator previews and publishes revision 2. Use a completely separate unauthenticated browser/cookie jar to read the public view. Internally save revision 3 containing the private marker and a different title; the public page must still show revision 2's title/body.

Try changing public URLs to access private revision IDs, parent metadata, history and unrelated pages. All must fail or omit that material. Ordinary editors/readers cannot publish. Unpublish and issue a new anonymous request: not found. Re-publish explicitly, archive, then unarchive: anonymous access stays denied until another explicit publish action.

Turn global publishing off: private documentation still works and public access stops. Re-enabling resumes still-active grants only; it does not undo per-document revocation/archive invalidation. Display source/license information for the actual running build before sharing this demo remotely.

## Later acceptance additions

P6: searching `INTERNAL-DEMO-NOTE-7391` as an outsider returns nothing; archived pages disappear; same-space hierarchy cycle tests pass.

P7: publish a revision containing image A, then privately add B. Public readers can retrieve only A through the active publication. After unpublish, new file requests fail. Images retained in history remain available to authorized internal readers.

P8/P9: export/import into another empty database with fresh IDs/private grants; back up and restore database plus file bytes into a blank instance; migrate from the previous schema. Record commands, artifact sizes/checksums, and outcomes without publishing credentials.
