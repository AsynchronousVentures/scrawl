# License decision — AGPL selected and applied

The maintainer selected AGPL for this project. Revision 3 applies **AGPL-3.0-only** to original project material and package metadata. The `only` version is an explicit packaging default: it does not automatically offer future AGPL versions. SPDX distinguishes this from `AGPL-3.0-or-later`. The standard license's instructional appendix contains an illustrative "or later" notice; the project's own notice and metadata specify version 3 only. [S1][S2]

The full standard license is in [LICENSE](../LICENSE), with no custom no-commercial-use, no-hosting, field-of-use or attribution exception appended. Commercial forks remain possible subject to the applicable terms. This project is not claiming a no-resale license. [S1]

## Project notice

Copyright (C) 2026 Asynchronous Ventures and contributors.

This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, version 3 only.

This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more details.

A copy of the GNU Affero General Public License is provided in this repository's LICENSE file.

## Source availability for network deployments

Before sharing a running demo/release, implement a discoverable Source/License location associated with the actual running version. For modified network deployments, corresponding source must be available to interacting users under section 13; distribution of builds also needs its applicable license/source handling. A generic upstream link is not a substitute for the modified build's corresponding source. [S1]

For the product, plan build metadata (version/commit) and an operator-configured source archive/repository location or packaged source download. Include the scripts and inputs needed to build/install/run the covered software. Do not serve `.env`, credentials, user documents, database files or runtime uploads. A publicly accessible source link need not expose instance configuration or stored content. Verify this path before release; a placeholder URL is not compliance evidence.

## Source/license release checklist

Before a network demo or release:

- [ ] Preserve the project LICENSE, SPDX metadata, and third-party notices.
- [ ] Identify the running build and provide its matching corresponding source, including build/install inputs.
- [ ] Make the actual source/license location discoverable and test access to it.
- [ ] Exclude instance secrets, user documents, database files, and uploads from source downloads.

## Dependencies and contributions

Preserve dependency licenses and notices; this project cannot relicense third-party work merely by including it. Prefer compatible OSS modules and document any uncertain licenses before integration. P0 and P1 reviewed the resolved dependency license metadata and package notices; see [VALIDATION.md](../VALIDATION.md). Review again when dependencies change.

Contributions are accepted under the project license as described in CONTRIBUTING.md; no additional CLA, copyright assignment or signoff service is added here. Do not impose a new relicensing policy without an explicit decision.

The application's source-code license does not automatically apply to independent user-authored documents. Branding/trademark permissions are separate; no claimed registration or custom trademark policy is fabricated for Scrawl.

Sources: [sources.md](sources.md). This is implementation/compliance planning, not a legal opinion about a specific dispute. Tool sponsorship eligibility for this repository remains a separate matter and has not been promised.
