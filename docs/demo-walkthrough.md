# Demo walkthrough — target behavior, not an existing executable

Use synthetic content only. P3 implements the API harness; P4/P5 add browser flows. This document is the test script for those packets, not a claim the endpoints exist in the supplied foundation.

## Fixtures

Four real library-authenticated accounts: administrator, editor, reader, outsider. All credentials generated or supplied locally through safe input; no universal password committed. Each HTTP actor has its own session/cookie jar. Use `example.test` addresses.

One space called **Demo Handbook**, editor and reader memberships, outsider with no membership. A second restricted space can later support search tests. Demo data creation/reset requires explicit development-only invocation against a designated disposable database; never wipes an arbitrary DATABASE_URL.

Sample page: **Release checklist**. Revision 1 contains "Run tests before deploying." Revision 2 adds "Verify the backup." Revision 3 adds the intentionally obvious private marker `INTERNAL-DEMO-NOTE-7391`. The marker is synthetic, not an actual secret.

## Demo A — API/document engine

| Step | Action | Expected evidence |
| --- | --- | --- |
| 1 | Migrate a fresh disposable database and explicitly provision accounts | Real sessions work; anonymous product access is denied |
| 2 | Administrator creates space/grants membership | Outsider cannot list or read it; reader cannot administer |
| 3 | Editor creates the checklist | One document and revision 1 committed; response has ETag |
| 4 | Two isolated clients read the same document | Both receive the same starting version |
| 5 | Client A saves revision 2; client B saves against the old tag | A succeeds; B gets 412; exactly one revision added |
| 6 | Retry a mutation without If-Match | 428, with no write |
| 7 | Reader attempts edit/restore/archive | Denied; unchanged history |
| 8 | Outsider guesses document/revision IDs | Not-found policy; no title, body, revision or version disclosure |
| 9 | Editor restores revision 1 | A new revision contains restored content; intervening history remains |
| 10 | Export native JSON; validate/reload content with the supported parser | Matching content; no auth/session data |
| 11 | Archive then unarchive | History retained; only authorized lifecycle operations succeed |
| 12 | Revoke editor membership, then try a new request | Access denied; no stale session-based space grant |

In addition to the demo script, an integration test must force a transaction error between revision insert and head advance and assert total rollback. A happy-path script alone does not prove atomicity.

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
