# Apps catalog and Blueprint repositories — format reference

> **Normative** for the two repository shapes outside this monorepo that APW-03 reads: the **Apps
> catalog** `ever-works/templates` (`EVER_WORKS_APPS_CATALOG_REPO`; the drafts called it `ever-works/apps`, which is
> still accepted) and each **Blueprint repository** `ever-works/<app>-template`
> ([CONTRACTS.md §8](../CONTRACTS.md#8-catalog-repositories-outside-this-monorepo)). How the platform reads
> them is in [`plan.md` §2.4–§2.6](./plan.md); the App spec itself is [`schema.md`](./schema.md).

**Epic**: `APW-03-app-spec-and-catalog` · **Status**: `Draft` · **Created**: 2026-09-17
**Manifest schema**: `schemaVersion: 1` · **License registry schema**: `schemaVersion: 1`

---

## 1. Principles

1. **Catalog data, not platform code** (ADR-014, D4). Adding an App Blueprint is a pull request to
   `ever-works/templates` and to its Blueprint repository — never a platform release.
2. **Never a copy of the upstream source.** A Blueprint repository holds an App spec, a few overlay files
   the upstream lacks, tests and documentation. CI enforces it (§6, C9).
3. **Pinned, not floating.** Every manifest entry pins its Blueprint to a tag **and** a 40-character
   commit sha. The platform applies the sha, never a branch.
4. **Upstreams are data.** Upstream repository names and aliases in the manifest are matched against what a user
   pastes, against its current name after a rename, and — when the pasted repository is a fork — against the root
   repository of its fork network as the Git provider reports it (offered only with confirmation, spec FR-40). The
   catalog service never fetches them. A repository no entry lists (for example one generated per test run) gets a
   Blueprint only when the caller names the Blueprint `id` explicitly (spec FR-81).
5. **Red licenses never appear.** An entry whose license classifies `red` fails CI (D13), and the platform drops such a
   row if one is ever served ([CONTRACTS.md Resolution R-3](../CONTRACTS.md#0-program-audit-resolutions-binding-2026-09-17-against-develop-ee45946e5)).
6. **Amber needs the authors' agreement for managed hosting.** An `amber` entry may offer Ever Works Apps only when it
   records an upstream agreement (§3.1, R-3); without one it runs on **Your cluster** only, after the owner's
   attestation.

## 2. `ever-works/templates` layout

> **Repository name (2026-09-17).** The listing repository exists as **`ever-works/templates`** and that is what
> `EVER_WORKS_APPS_CATALOG_REPO` defaults to (CONTRACTS §7 and Resolution **R-29**). The drafts called it
> `ever-works/apps`; that name is **still accepted**, so an installation carrying it keeps working — see the note
> below on how to read the rest of this document.

```
ever-works/templates/
├── manifest.json                   # the App Blueprint index (§3)
├── licenses.yml                    # the license registry (§4)
├── schema/
│   ├── manifest.schema.json        # JSON Schema for manifest.json
│   ├── licenses.schema.json        # JSON Schema for licenses.yml
│   └── app-spec.schema.json        # vendored copy of the platform's App spec schema (schema.md §25)
├── icons/<id>.svg                  # one icon per entry, ≤ 32 KiB, no <script>, no external refs
├── evidence/<id>/<runId>.json      # verification run results written by the acceptance suite (APW-13)
├── scripts/validate.mjs            # every CI check in §6, runnable locally
├── CONTRIBUTING.md                 # §7
├── README.md
└── .github/
    ├── workflows/validate.yml      # on pull_request + push to main
    ├── workflows/schema-sync.yml   # weekly: open a PR when the platform schema changed
    ├── workflows/verify-expiry.yml # daily: open an issue 14 days before a verification expires
    └── CODEOWNERS                  # licenses.yml → legal reviewers; manifest.json → maintainers
```

**A pure listing (2026-09-26).** The repository holds no per-template folder and no copy of any Blueprint's App spec,
README or metadata: each template's spec lives only in its own repository's `.works/works.yml` (§5), which is the only
file the platform's Blueprint resolver reads (`APP_BLUEPRINT_SPEC_PATH` in
`packages/agent/src/apps-catalog/app-blueprint-resolver.service.ts`), and the listing's CI fetches that file from each
app row's repository to validate it (`ever-works/templates` PR #1 `542a96c` removed the earlier `cal-diy/` and
`umami/` copies; PR #2 `8437f29` made the Cal row metadata-only and dropped the fixture row). The tree above is the target shape; today the repository carries `manifest.json`,
`licenses.yml`, `schema/`, `tools/validate-specs.mjs`, `CONTRIBUTING.md`, `README.md` and
`.github/workflows/validate.yml`.

Releases are tags `vYYYY.MM.DD[.N]`. Production platforms pin `EVER_WORKS_APPS_CATALOG_REF` to a tag or
commit sha; the platform logs a warning on every uncached read of a mutable ref.

**Branch `e2e`** carries test-only entries and license fixtures for the acceptance suite (APW-13): it
branches from `main`, is never merged back, and no production platform pins a ref on it. Its fixture
licenses use `LicenseRef-ew-fixture-*` identifiers so they cannot collide with real ones.

## 3. `manifest.json`

```json
{
	"schemaVersion": 1,
	"apps": [
		/* entries */
	]
}
```

Limits: file ≤ 2 MiB; ≤ 1,000 entries; `id` unique. Unknown top-level keys are ignored by the platform
and rejected by CI.

### 3.1 Entry fields

| Field                              | Type     | Required        | Rules                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------- | -------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                               | string   | yes             | `^[a-z0-9][a-z0-9-]{0,63}$`, unique, never reused after removal.                                                                                                                                                                                                                                                                                                                                                                                                    |
| `name`                             | string   | yes             | 1–60 chars, plain text.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `summary`                          | string   | yes             | 1–160 chars, plain text.                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `description`                      | string   | no              | ≤ 2,000 chars, Markdown subset (paragraphs, lists, links, inline code).                                                                                                                                                                                                                                                                                                                                                                                             |
| `category`                         | enum     | yes             | `analytics` · `communication` · `content` · `crm` · `developer-tools` · `finance` · `forms` · `knowledge` · `marketing` · `productivity` · `project-management` · `scheduling` · `security` · `support` · `other`.                                                                                                                                                                                                                                                  |
| `tags`                             | string[] | no              | ≤ 8, each `^[a-z0-9][a-z0-9-]{0,39}$`.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `icon`                             | string   | yes             | `^icons/[a-z0-9-]+\.svg$`, file must exist.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `status`                           | enum     | yes             | `production` · `beta` · `placeholder`. Placeholders are listed but not selectable.                                                                                                                                                                                                                                                                                                                                                                                  |
| `default`                          | boolean  | no              | When several entries share an upstream, exactly one is `true`.                                                                                                                                                                                                                                                                                                                                                                                                      |
| `featured`                         | boolean  | no              | ≤ 12 featured entries in the file.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `upstreams[]`                      | array    | yes\*           | 1–5. \*Empty only for `placeholder`.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `upstreams[].repo`                 | string   | yes             | `owner/repo` (`^[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}$`), the current canonical name.                                                                                                                                                                                                                                                                                                                                                                            |
| `upstreams[].aliases`              | string[] | no              | ≤ 5 former names (GitHub renames and transfers) in the same format.                                                                                                                                                                                                                                                                                                                                                                                                 |
| `upstreams[].refs.branches`        | string[] | no              | ≤ 10 glob patterns the built branch must match. Default `["*"]`.                                                                                                                                                                                                                                                                                                                                                                                                    |
| `upstreams[].refs.tags`            | string   | no              | Semantic-version range a tag must satisfy when a tag is built (`>=7.0.0`).                                                                                                                                                                                                                                                                                                                                                                                          |
| `upstreams[].refs.exclude`         | string[] | no              | ≤ 10 glob patterns of branches or tags that must never match (for example tags cut before a relicense).                                                                                                                                                                                                                                                                                                                                                             |
| `blueprint.repo`                   | string   | yes\*           | `^ever-works/[a-z0-9-]+$`.                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `blueprint.version`                | string   | yes\*           | Semantic version; a tag `v<version>` must exist in the Blueprint repository.                                                                                                                                                                                                                                                                                                                                                                                        |
| `blueprint.sha`                    | string   | yes\*           | `^[0-9a-f]{40}$`; must equal the commit the tag points to.                                                                                                                                                                                                                                                                                                                                                                                                          |
| `license.spdx`                     | string   | yes\*           | SPDX expression of the **upstream** at the pinned refs.                                                                                                                                                                                                                                                                                                                                                                                                             |
| `license.class`                    | enum     | yes\*           | `green` · `amber` — must equal the class `licenses.yml` computes for `spdx`.                                                                                                                                                                                                                                                                                                                                                                                        |
| `managedHosting.allowed`           | boolean  | yes\*           | `false` when the license, a trademark or an operational reason rules out Ever Works Apps. `true` for an `amber` entry only with `managedHosting.upstreamAgreement` (C6).                                                                                                                                                                                                                                                                                            |
| `managedHosting.reason`            | string   | no              | ≤ 200 chars, shown when `allowed` is `false`.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `managedHosting.upstreamAgreement` | object   | no              | **Amber only.** The recorded agreement with the upstream's authors that permits hosting on Ever Works Apps: `{ reference, recordedAt }`. `reference` `^[A-Za-z0-9._-]{1,80}$` is an identifier of the agreement record kept in the private operations repository — never the agreement's text or terms; `recordedAt` ISO 8601 date. Adding, changing or removing it needs a legal-reviewer approval (§7 rule 3). Ignored (and a CI failure, C6) on any other class. |
| `trademark.notice`                 | string   | no              | ≤ 300 chars.                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `trademark.displayNameSuffix`      | string   | no              | ≤ 40 chars, e.g. `(community build)`; the platform's `display.name` becomes `"<name> <suffix>"`.                                                                                                                                                                                                                                                                                                                                                                    |
| `trademark.protectedPaths`         | string[] | no              | ≤ 50 globs copied into `display.protectedPaths`.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `minResources.cpu`                 | string   | yes\*           | Sum of requests across components, e.g. `750m`.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `minResources.memory`              | string   | yes\*           | e.g. `1536Mi`.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `minResources.storage`             | string   | no              | Sum of volumes and dependency storage, e.g. `10Gi`.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `minResources.buildMemory`         | string   | no              | e.g. `12Gi`; a hint for the build target.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `dependencies`                     | string[] | no              | Derived by CI from the App spec: subset of `postgres`, `redis`, `objectStorage`, `smtp`.                                                                                                                                                                                                                                                                                                                                                                            |
| `verified`                         | boolean  | yes\*           | Derived by CI from `verification.status` (§3.2); never hand-edited.                                                                                                                                                                                                                                                                                                                                                                                                 |
| `verification`                     | object   | when `verified` | §3.2.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `links.homepage` / `links.docs`    | string   | no              | `https://` URLs ≤ 300 chars; shown as text links, never fetched.                                                                                                                                                                                                                                                                                                                                                                                                    |

`yes*` = required unless `status` is `placeholder`.

### 3.2 Verification evidence

A verified entry proves a Blueprint builds, boots and passes its smoke tests on the platform at the
pinned sha. Evidence files are written by the acceptance suite (APW-13) under `evidence/<id>/<runId>.json`
and merged by pull request; this repository's CI computes `status` from them. The **Verified** badge is
shown only while `verified` is `true`, `blueprintSha` matches and `expiresAt` is in the future.

| Field               | Type    | Rules                                                                                                                                                                                                                                                               |
| ------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`            | enum    | `candidate` · `verified` · `at-risk` · `not-verified` — computed by CI: `at-risk` after one failed run at the current pin, `not-verified` after two consecutive failures or when the classified license differs from `license`; a pin change resets to `candidate`. |
| `verifiedAt`        | string  | ISO 8601; first passing run at the current pin.                                                                                                                                                                                                                     |
| `lastPassedAt`      | string  | ISO 8601; most recent passing run.                                                                                                                                                                                                                                  |
| `expiresAt`         | string  | ≤ `lastPassedAt` + 180 days.                                                                                                                                                                                                                                        |
| `blueprintSha`      | string  | Must equal `blueprint.sha`.                                                                                                                                                                                                                                         |
| `pinnedUpstreamSha` | string  | 40-hex upstream commit the passing runs built.                                                                                                                                                                                                                      |
| `canaryBehind`      | boolean | `true` when the latest canary run on the upstream head failed; informational only.                                                                                                                                                                                  |
| `platformVersion`   | string  | Platform release of the last passing run.                                                                                                                                                                                                                           |
| `verifiedBy`        | string  | GitHub login of the maintainer who merged the evidence.                                                                                                                                                                                                             |
| `evidence[]`        | array   | ≤ 10 most recent `{ path, runUrl, result }`; `path` under `evidence/<id>/`.                                                                                                                                                                                         |

`verified` MUST equal `status ∈ {verified, at-risk}`: one failed run keeps the badge while the failure is
investigated; a second removes it.

### 3.3 Example entry

```json
{
	"id": "cal",
	"name": "Cal.diy",
	"summary": "Open-source scheduling: booking pages, calendar sync and reminders.",
	"category": "scheduling",
	"tags": ["calendar", "booking", "nextjs"],
	"icon": "icons/cal.svg",
	"status": "beta",
	"default": true,
	"upstreams": [
		{
			"repo": "calcom/cal.diy",
			"aliases": ["calcom/cal.com"],
			"refs": { "branches": ["main"], "exclude": ["v6.*", "v5.*"] }
		}
	],
	"blueprint": {
		"repo": "ever-works/cal-template",
		"version": "1.0.0",
		"sha": "0123456789abcdef0123456789abcdef01234567"
	},
	"license": { "spdx": "MIT", "class": "green" },
	"managedHosting": { "allowed": false, "reason": "Upstream recommends personal, non-production use." },
	"trademark": {
		"notice": "Cal.diy® is a trademark of Cal.com, Inc.",
		"displayNameSuffix": "(community build)",
		"protectedPaths": ["apps/web/public/brand/**"]
	},
	"minResources": { "cpu": "500m", "memory": "1Gi", "storage": "10Gi", "buildMemory": "12Gi" },
	"dependencies": ["postgres", "smtp"],
	"verified": false,
	"verification": { "status": "candidate" },
	"links": { "homepage": "https://github.com/calcom/cal.diy" }
}
```

## 4. `licenses.yml`

The registry that classifies licenses for the license gate (D13). **Legal-reviewed before launch;**
every change needs a CODEOWNERS approval from the legal reviewers.

```yaml
schemaVersion: 1
updatedAt: 2026-09-17
classes: # CONTRACTS.md Resolution R-3
    green: { managedHosting: true, yourCluster: true, attestation: false }
    amber: { managedHosting: upstream-agreement, yourCluster: true, attestation: true }
    red: { managedHosting: false, yourCluster: true, attestation: true, catalog: false }
obligationsVocabulary:
    - attribution # keep copyright and license notices
    - state-changes # mark modified files
    - disclose-source # distributing binaries requires source
    - network-source-offer # users over a network must be offered the running version's source
    - same-license # derivative works keep the license
    - no-managed-hosting # may not be offered as a hosted service to third parties
    - no-commercial-use
    - no-competing-use
    - branding-must-remain
    - trademark-restrictions
licenses:
    - spdx: MIT
      name: MIT License
      class: green
      obligations: [attribution]
    - spdx: Apache-2.0
      name: Apache License 2.0
      class: green
      obligations: [attribution, state-changes]
    - spdx: AGPL-3.0-only
      name: GNU Affero General Public License v3.0 only
      class: green
      obligations: [attribution, disclose-source, same-license, network-source-offer]
    - spdx: BUSL-1.1
      name: Business Source License 1.1
      class: amber
      obligations: [no-managed-hosting]
      attestation:
          textId: busl-1.1-v1
          text: >-
              I have read this project's license and its Additional Use Grant, and my use of this App Work on my
              own cluster complies with them.
    - spdx: LicenseRef-example-noncommercial
      name: Example non-commercial license
      class: red
      obligations: [no-commercial-use, no-managed-hosting]
      attestation:
          textId: noncommercial-v1
          text: >-
              I will run this App Work only for purposes this license permits, and not commercially.
exceptions:
    - spdx: Classpath-exception-2.0 # "<license> WITH <exception>" keeps the base class unless listed
      effect: none
aliases:
    - { match: 'The MIT License', spdx: MIT }
unknown:
    class: amber # no license, or a text the registry cannot identify
    attestation:
        textId: unknown-license-v1
        text: >-
            I could not find a license the registry recognises. I confirm I have the right to run this software.
```

| Key                      | Rules                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `classes`                | Exactly `green`, `amber`, `red`, fixed as shown (R-3): `managedHosting` is `true` for green, `upstream-agreement` for amber (only with an entry's recorded agreement), `false` for red; `yourCluster` is `true` for all three, with `attestation` for amber and red; `red.catalog` is `false`. The platform rejects a registry that loosens any of these and keeps its last good copy.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `licenses[]`             | ≤ 300 entries; `spdx` unique; SPDX identifier or `LicenseRef-[A-Za-z0-9.-]+`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `licenses[].class`       | `green` · `amber` · `red`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `licenses[].obligations` | Values from `obligationsVocabulary`. `network-source-offer` ⇒ the source link contract (spec FR-61).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `licenses[].attestation` | Required for `amber` and `red`. `textId` `^[a-z0-9.-]{1,64}$`, unique; `text` ≤ 600 chars. Changing `text` requires a new `textId`, which invalidates earlier attestations.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `exceptions[]`           | ≤ 50. `effect`: `none`, `class:green`, `class:amber` or `class:red`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `aliases[]`              | ≤ 200. Maps a license title found in a file or package manifest to an SPDX id.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `unknown`                | Class and attestation used when detection finds nothing it can classify. Must not be `green`. An `unknown` classification is never eligible for Ever Works Apps (no catalog entry can carry an agreement for it). **The block's `class` key is advisory display metadata and never becomes a license class**: the platform computes `unknown` itself whenever detection finds no license or cannot classify the expression (NOASSERTION is red, not unknown — see Expressions), stores `class: 'unknown'` (plan §3.1), and the hosting rules for it are fixed — attestation before **Your cluster**, never **Ever Works Apps**, never listed in the Apps catalog (FR-57, R-3, ACC-03-30, ACC-03-47). An implementer therefore never reads `unknown.class`, and the key stays in the registry for operators reading the file. |
| Size                     | File ≤ 256 KiB.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

**Expressions.** `A OR B` takes the **best** class of its operands (green < amber < red); `A AND B` takes
the **worst**; `A WITH E` takes `A`'s class unless `E` is listed with a different `effect`. Obligations
are the union across every operand that decided the class. The fixed rank is **green < amber < unknown < red**,
and it is the rank used for OR, AND, a mixed repository and for deciding whether a class got worse or better
(FR-60, `previewUpstream.worse`): an operand the registry does not list — an unknown SPDX id, or an unlisted
`LicenseRef-*` — counts as `unknown`, so `MIT OR LicenseRef-x` is green while `MIT AND LicenseRef-x` is `unknown`,
and obligations come only from the operands that are listed. `unknown` sits between amber and red because it is
worse than a known-permissive-plus-agreement case and better than a licence that forbids the use outright; that is
why it never reaches managed hosting (above) while a `red` licence cannot run there even with an attestation.

**`NOASSERTION`.** A licence the Git provider found and could not identify (GitHub `spdx_id: NOASSERTION`) classifies
**red**. This is a fixed platform rule, not a registry row: no `licenses[]`, `aliases[]` or `exceptions[]` entry can
change it, and as an operand it counts as red (so `MIT AND NOASSERTION` is red and `MIT OR NOASSERTION` is green). A
repository with no licence file at all (SPDX `NONE`, or nothing detected) remains `unknown`. _(Owner decision
2026-09-25; `classifyLicenseExpression` in `packages/agent/src/app-license/license-classify.ts`.)_

## 5. Blueprint repository `ever-works/<app>-template`

```
ever-works/cal-template/
├── .works/works.yml        # App spec in `blueprint` mode. Since the 2026-09-17 correction to schema.md §3 that
│                           # mode **allows and expects** `source` and `blueprint` — a draft may carry both, and the
│                           # apply job composes the real `source` itself. What must hold: `blueprint.repo` names
│                           # this repository (schema.md §3), and `license` is optional.
├── overlay/                # files copied into the Work Repository at the same relative path
│   └── Dockerfile
├── overlay.yml             # one row per overlay file (below)
├── tests/
│   └── e2e/booking.spec.ts # optional Playwright test run by verify.yml
├── README.md               # required sections below
├── LICENSE                 # the Blueprint's own license: MIT
└── .github/workflows/verify.yml
```

**Required repository settings**: public; topic `ever-works-app-blueprint`; default branch `main`; tags
`vMAJOR.MINOR.PATCH`; description ≤ 160 chars.

**`overlay.yml`**

```yaml
files:
    - path: Dockerfile # destination in the Work Repository, relative
      mode: add-only # add-only (skip when the file exists) · replace (only through a pull request)
```

| Rule                                                                                                   |
| ------------------------------------------------------------------------------------------------------ |
| ≤ 50 overlay files; each ≤ 1 MiB; total ≤ 5 MiB.                                                       |
| Destination paths obey `RelPath` (schema.md §0) and may not be under `.github/`, `.git/` or `.works/`. |
| Every file under `overlay/` has exactly one row, and every row has a file.                             |

**`README.md`** must contain the headings `## What it runs`, `## Dependencies`, `## First run`,
`## Known limits`, `## License and trademarks`. The platform shows the first 64 KiB, sanitized.

**Versioning.** `PATCH` = overlay or test fix with no spec change; `MINOR` = additive spec change (a new
optional env entry, a new smoke test); `MAJOR` = anything an existing App Work must act on (a removed or
renamed env entry, a new required dependency, a changed `generate` rule). The platform offers `MINOR` and
`PATCH` upgrades as ordinary pull requests and labels `MAJOR` upgrades **Breaking** (spec FR-49).

## 6. CI validation in the catalog repository

`validate.yml` runs `scripts/validate.mjs` on every pull request and push to `main`. Every check fails the
run; none is advisory.

| #   | Check                                                                                                                                                                                                                                                                                                                                                                  |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | `manifest.json` and `licenses.yml` validate against their JSON Schemas; sizes and counts within §3–§4 limits.                                                                                                                                                                                                                                                          |
| C2  | `id` unique. An upstream `repo` or alias may appear in several entries only when exactly one of them is `default: true`.                                                                                                                                                                                                                                               |
| C3  | For every non-placeholder entry: the Blueprint repository exists, is public, carries the topic, the tag `v<version>` resolves to `sha`.                                                                                                                                                                                                                                |
| C4  | The Blueprint's `.works/works.yml` at `sha` validates in `blueprint` mode against `schema/app-spec.schema.json` **and** the platform's rules — C4 runs the published validator artifact `@ever-works/contracts` (subpath `./apps/validator`, APW-03 T57) **at the version pinned in `package.json`**, so the catalog never re-implements a platform rule. Zero errors. |
| C5  | `license.class` equals the class `licenses.yml` computes for `license.spdx`; a `red` class fails.                                                                                                                                                                                                                                                                      |
| C6  | `managedHosting.allowed` is `true` for an `amber` entry only when `managedHosting.upstreamAgreement` is present; `upstreamAgreement` appears on no other class; any pull request that adds, changes or removes it carries a legal-reviewer approval (R-3).                                                                                                             |
| C7  | `dependencies` equals the set derived from the Blueprint's App spec; `minResources.cpu` / `memory` ≥ the sum of component requests.                                                                                                                                                                                                                                    |
| C8  | `verification.status` recomputed from `evidence/<id>/*.json` equals the committed value; `verified` equals `status ∈ {verified, at-risk}`; `blueprintSha` = `blueprint.sha`; `expiresAt` ≤ `lastPassedAt` + 180 days; every `runUrl` is a workflow run URL.                                                                                                            |
| C9  | Overlay rules (§5), and no overlay file is byte-identical to a file at the same path in the upstream at the newest ref allowed by `refs` (source-copy guard).                                                                                                                                                                                                          |
| C10 | `icon` exists, ≤ 32 KiB, parses as SVG, contains no `<script>`, no `on*=` attribute and no external `href`.                                                                                                                                                                                                                                                            |
| C11 | Every `licenses[].attestation.textId` is unique; a changed `text` under an unchanged `textId` fails.                                                                                                                                                                                                                                                                   |
| C12 | `schema/app-spec.schema.json` is byte-identical to the schema the pinned validator artifact publishes (`@ever-works/contracts`, subpath `./apps/validator` — the same artifact C4 runs).                                                                                                                                                                               |

**The published validator artifact (C4, C12).** The rules C4 and C12 exercise live in the platform's own pure
validator modules, which sit in a package that is private; the catalog therefore cannot install them from there.
`@ever-works/contracts` — which is **not** private — gains a publishable entry point at `./apps/validator` that
re-exports the pure validator (`validateAppSpecDocument`, `validateAppSpecObject`, `APP_SPEC_ISSUE_CODES`) and
publishes the committed JSON Schema beside it (APW-03 T57, `.github/workflows/publish-app-spec-validator.yml`).
Nothing moves out of the agent package: it keeps re-exporting the same modules. This repository pins the exact
published version in its `package.json`, and C4/C12 fail when the pin and the vendored schema disagree — that is
what makes "passes CI but fails the platform" impossible.

`schema-sync.yml` runs weekly (Monday 04:00 UTC): it fetches `GET /api/schema/app-spec.schema.json` from
production and opens a pull request when it differs from the vendored copy.

### 6.1 Blueprint repository CI (`ever-works/<app>-template`)

A Blueprint repository runs three workflows. They are part of the contract: a repository without them cannot be
listed, because `verification.evidence` is produced by them.

| Workflow       | Trigger                            | What it does                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `validate.yml` | `pull_request`, `push` to `main`   | Validates `.works/works.yml` in **`blueprint` mode** with the pinned validator artifact (the same one C4 runs) and the vendored schema; validates `profiles/*.works.yml` (APW-13 T59) in **`data-repository` mode over a stub `source` block**, because a profile is a fork's App spec and always carries one. Zero errors.                                                                                       |
| `release.yml`  | tag `v*`                           | Prints the commit sha the tag points at, for the catalog pull request's `sha:` field. **It never writes `blueprint:` into `.works/works.yml`** — the file stays a pure App spec, and stamping it would make the mode it must satisfy inconsistent with the file the platform reads.                                                                                                                               |
| `verify.yml`   | `workflow_dispatch` (a maintainer) | Runs the repository's `tests/e2e/**` against a throwaway deployment and writes `evidence/<id>/*.json` (the shape §3.2 fixes). Only this run sets `verification.status`; C8 recomputes the committed value from those files. Inputs: `environment` (the platform environment it targets), `account` (the throwaway owner), `cluster` (the target it may deploy to). Secrets: `EVER_WORKS_E2E_UPSTREAM_TOKEN` only. |

`schema-sync.yml` is not a Blueprint workflow: it lives in the catalogue repository, where the vendored schema is.

## 7. Contribution rules

1. **One Blueprint per pull request** in `ever-works/templates`, linked to the Blueprint repository's release.
2. **New entries start as `beta`.** `production` requires `verified: true`.
3. **Two maintainer approvals** for a new entry; **one legal-reviewer approval** for any change to
   `licenses.yml` or to an entry's `license`, `trademark` or `managedHosting.upstreamAgreement` block. The agreement
   itself is filed in the private operations repository; the catalog carries only its reference.
4. **Evidence, not claims.** `verified` is set by a maintainer from a `verify.yml` run, never by the
   contributor.
5. **Removal.** Deleting an entry never breaks existing App Works: they keep their applied spec; the
   platform stops offering upgrades and shows the Blueprint as **No longer listed**. The `id` is retired
   permanently.
6. **Relicensing upstream.** When an upstream changes license, the entry's `license` block and
   `upstreams[].refs.exclude` are updated in the same pull request; a change to `red` removes the entry.
7. **No upstream source, no secrets, no generated credentials** in any Blueprint repository file.
8. **Security reports** about an upstream project go to that project's private disclosure channel, never
   into a Blueprint repository issue or README.

## 8. How the platform uses these files

| File                                                                            | Read by                             | Cached                          |
| ------------------------------------------------------------------------------- | ----------------------------------- | ------------------------------- |
| `manifest.json`                                                                 | Apps catalog service (plan §2.4)    | 1 h; 30 s after a failure       |
| `licenses.yml`                                                                  | Apps catalog service → license gate | 1 h; last good copy kept 7 days |
| `icons/<id>.svg`                                                                | Browser, `<img>` only               | Browser cache                   |
| Blueprint `README.md`, `.works/works.yml`, `overlay.yml`, `overlay/**` at `sha` | Blueprint application (plan §2.5)   | 1 h per `repo@sha`              |
| `schema/*.json`                                                                 | CI only                             | —                               |
