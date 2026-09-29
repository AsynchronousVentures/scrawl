# Revision 3 changes

## Applied

AGPL-3.0-only selected: full standard license text, project notice, package metadata and TypeScript SPDX/copyright headers. The license text is unchanged; no custom commercial restriction is added.

## Replanned

Three demo gates replace the prior all-backend-features-before-UI sequence: API core, thin private editor, then public publishing. Local library-managed authentication and explicit account-provisioning commands come first; optional OIDC is no longer a first-demo prerequisite.

P0 is foundation verification only. P1 owns the actual Prisma/auth integration. Work packets P0–P9, a copy-paste agent kickoff, schema brief, synthetic walkthrough and truthful status tracker are included. Existing architecture/API/publishing notes remain proposals, synchronized with the new sequence.

## Not implemented

No new authentication, document, publication, migration, storage, search or frontend feature. No dependency installation, lockfile, CI run, remote repository, deployment or provider application has been performed here. Source bodies are unchanged from revision 2 except license comments. See VALIDATION.md for checks actually performed.
