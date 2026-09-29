> Historical revision record only. Superseded by [revision 3](changes-v3.md); AGPL is now applied.

# Planning changes — revision 2

## Updated

- Entirely OSS product scope; no SaaS tenancy, billing, paid feature gates, or license activation.
- MIT recommended, with the permissive-fork tradeoff explained; license remains unapplied pending maintainer choice.
- Prisma replaces Drizzle in implementation plans. ORM/auth compatibility and real JSON response testing are part of the first implementation packet.
- Three boundaries: platform services, document/access core, and capabilities composed in one application.
- Public publishing moves into the first-product scope, with an independently selected revision, exact public-file grants, explicit revocation, and archive/unarchive safeguards.
- API proposal, milestones, decisions, agent instructions, and primary references are synchronized.

## Not changed or claimed

Executable source, dependencies, tests, and development configuration are unchanged. No Prisma dependency, document API, authentication, runtime plugin system, publication endpoint, or frontend was added. Historical foundation validation is not extended to these proposed modules. See [VALIDATION.md](../VALIDATION.md) for exact verification status.
