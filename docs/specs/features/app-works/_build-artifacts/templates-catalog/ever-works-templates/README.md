# Ever Works — templates listing

> **Status: seed / draft (2026-09-17).** This folder is the seed content of the repository
> **`ever-works/templates`** — the owner's rename of the repository the plan calls the **Apps catalog**
> (`ever-works/apps`). Nothing here has been pushed; no repository `ever-works/templates` exists yet
> (verified 2026-09-17: `GET /repos/ever-works/templates` → 404). See
> [`../plan-changes.md`](../plan-changes.md) for the exact plan edits this seed depends on.

This repository is the **listing of the templates we keep** — one row per template repository, website
templates and app templates alike — so that we can see, in one place, what exists, what shape it is, what it
pins, what licence it carries and whether it is verified.

It is **not the machine source of truth for resolution**, and that distinction is the whole point of the
owner's decision:

| Question                                                                                           | Where the answer actually lives                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Does template X exist?                                                                             | The repository `ever-works/<x>-template`. The platform discovers templates by **scanning the catalog organization for repositories whose name ends in `template`** — `isStandardTemplateRepository` in `packages/agent/src/template-catalog/template-catalog.service.ts:1047-1049`, discovery loop `:668-818`, organization from `config.websiteTemplate.getCatalogOrganization()`. |
| Is it a website template or an app template, and does it carry the code or only metadata?          | The template repository's own metadata: `.works/template.yml` (shape, app source) and `.works/works.yml` (the App spec, `blueprint` mode).                                                                                                                                                                                                                                          |
| Which commit is pinned, what licence class applies, may it run on Ever Works Apps, is it verified? | **This repository** (`manifest.json` + `licenses.yml`). That is the curation this listing adds.                                                                                                                                                                                                                                                                                     |

So a new template becomes _usable_ the moment its repository exists and carries valid metadata — no pull
request here is needed for that. A pull request here is what makes it **listed**: badged, searchable in the
catalog browser, pinned for production, and eligible (or not) for managed hosting.

> **Why the repository is called `templates` and not `apps`.** It lists the whole template family — the four
> Website/Work templates we already have plus one row per OSS app we support — not only apps. The plan's
> _noun_ for the app-facing catalogue stays **Apps catalog** (the create flow offers "Browse the Apps
> catalog", APW-01 FR-46a); only the repository moves. See [`../open-questions.md`](../open-questions.md)
> OQ-01 for the alternative (renaming the noun too).

---

## 1. The two app-template shapes

Every app template is one of two shapes. The shape is declared in `.works/template.yml` and is what decides
**how many repositories get forked** when a user creates an App Work from it.

| Shape               | What the template repository holds                                                                                                                                                                                                                                              | What provisioning forks (in the user's own account, with the user's own connection)                                                                                                                                                                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`code-bearing`**  | The whole application codebase, kept in sync as a **public fork of the original project** with our metadata added (`.works/works.yml`, `.works/template.yml`, `README.md`, topic). Our commits sit on top of upstream's default branch; syncing means merging upstream into it. | **One fork**: the template repository. That fork **is** the App Work's Work Repository (role `website`) — it is built and deployed, and the App spec is applied into it.                                                                                                                                                        |
| **`metadata-only`** | Only our metadata: the App spec, optional overlay files, the App Blueprint `README.md`. **No upstream source.**                                                                                                                                                                 | **Two forks, in this order**: (1) the **app-source** repository named by `.works/template.yml:source.repo` — this one is the Work Repository, receives the applied App spec and is built and deployed; (2) the **template** repository — the user's own copy of the metadata, recorded as provenance, never a `RepositoryRole`. |

A third `appSource.mode` exists for an app that ships only as a published image: **`image`** — no app-source
repository, so provisioning forks the template repository only. None of the three golden-path templates uses
it today (`cal-diy` is `code-bearing`; `umami` and the fixture are `metadata-only` with a real app-source
repository, because both need the fork to evolve the code later).

Resolution, classification and fork order are specified precisely in
[`../resolution-spec.md`](../resolution-spec.md).

---

## 2. What lives here

```
manifest.json                            # the listing: one row per template repository (§4)
licenses.yml                             # the license registry (APW-03 catalog.md §4)
schema/
    templates-manifest.schema.json       # JSON Schema (draft 2020-12) for manifest.json
README.md                                # this file
```

Convention from the sibling catalogue repositories (`ever-works/works`, `ever-works/missions`) and from
APW-03 `catalog.md` §2 — **create these when the repository is created, not later**:

```
scripts/validate.mjs                     # schema + cross-field rules (CI gate, runnable locally)
.github/workflows/validate.yml           # runs validate.mjs on pull_request and push to main
CONTRIBUTING.md                          # §5 rules, in contributor language
LICENSE                                  # Apache-2.0 — this repository's own content
icons/<id>.svg                           # one per app row, ≤ 32 KiB, no <script>, no external refs
evidence/<id>/<runId>.json               # APW-13 verification evidence, merged by pull request
.github/CODEOWNERS                       # licenses.yml → legal reviewers; manifest.json → maintainers
```

Not part of this seed, and owned elsewhere: `.github/workflows/schema-sync.yml` and `verify-expiry.yml`
(APW-03 T33), the test-only **`e2e` branch** (APW-13 T33/T47), and — for a `code-bearing` template — the
fork-sync job that merges upstream into the template repository.

`scripts/validate.mjs` must check, beyond the JSON Schema (which cannot express these):

1. `slug` unique across `templates[]`; `template.repo` unique.
2. Every non-placeholder row names a repository that exists, is public, and carries the expected topic
   (`ever-works-app-blueprint` for app rows).
3. `template.ref` resolves and, for a non-placeholder **app** row, `template.ref` is the tag
   `v<blueprint.version>` and it resolves to `template.sha`.
4. `license.class` equals the class `licenses.yml` computes for `license.spdx` (a `red` class fails).
5. `managedHosting.allowed: true` on an `amber` row only with `managedHosting.upstreamAgreement` present, and
   `upstreamAgreement` on no other class (CONTRACTS R-3).
6. `appSources[].servesTemplates[]` names existing template slugs, and every `appSource.mode: repository`
   row has a matching entry in `appSources[]`.
7. A `metadata-only` row's template repository contains **no** file that is byte-identical to the same path in
   the app source at the pinned ref (the source-copy guard of APW-03 `catalog.md` §6 C9, now scoped to this
   shape only).

---

## 3. Listing

<!-- listing:start -->

| Slug                    | Template                                                                                                    | Kind    | Shape                                                                                               | Pinned                         | Licence               | Status      |
| ----------------------- | ----------------------------------------------------------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------- | ------------------------------ | --------------------- | ----------- |
| `directory-web`         | [`ever-works/directory-web-template`](https://github.com/ever-works/directory-web-template)                 | website | —                                                                                                   | `develop` (branch)             | AGPL-3.0-only · green | production  |
| `directory-web-minimal` | [`ever-works/directory-web-minimal-template`](https://github.com/ever-works/directory-web-minimal-template) | website | —                                                                                                   | `develop` (branch)             | AGPL-3.0-only · green | production  |
| `web`                   | [`ever-works/web-template`](https://github.com/ever-works/web-template)                                     | website | —                                                                                                   | `main` (branch)                | AGPL-3.0-only · green | production  |
| `web-minimal`           | [`ever-works/web-minimal-template`](https://github.com/ever-works/web-minimal-template)                     | website | —                                                                                                   | `main` (branch)                | AGPL-3.0-only · green | production  |
| `cal-diy`               | [`ever-works/cal-diy-template`](https://github.com/ever-works/cal-diy-template)                             | app     | `code-bearing`                                                                                      | tag `v0.1.0` (not created yet) | MIT · green           | placeholder |
| `umami`                 | [`ever-works/umami-template`](https://github.com/ever-works/umami-template)                                 | app     | `metadata-only` → `umami-software/umami`                                                            | tag `v0.1.0` (not created yet) | MIT · green           | placeholder |
| `app-fixture-hello`     | [`ever-works/app-fixture-hello-template`](https://github.com/ever-works/app-fixture-hello-template)         | app     | `metadata-only` → [`ever-works/app-fixture-hello`](https://github.com/ever-works/app-fixture-hello) | tag `v0.1.0` (not created yet) | MIT · green           | placeholder |

<!-- listing:end -->

`placeholder` is honest here: none of the three app template repositories exists yet. They are created by
APW-13 — `tasks.md` T24 (`app-fixture-hello-template`), T27 (`umami-template`), T28 (`cal-diy-template`) —
and a person sets `status` to `beta` and fills `template.sha` in the same pull request that publishes the
release tag.

The four website templates are the repositories the suffix scan already returns today: they are the only
repositories in `ever-works` whose name ends in `template` (verified 2026-09-17 against
`GET /orgs/ever-works/repos?per_page=100`, 63 repositories). Their `AGPL-3.0-only` class is **green** — AGPL
is copyleft, not a hosting restriction (README D13) — so it never gates managed hosting; the copyleft
obligations (`disclose-source`, `network-source-offer`) stay recorded in `licenses.yml` and surface as the
source-offer link, not as a refusal.

### Rows that are not templates

`ever-works/app-fixture-hello` appears under `appSources[]`, not under `templates[]`: it is the fixture
**application** (source only, no `.works/`), and its name does not end in `template`, so the suffix scan never
returns it. It is listed because the fixture's template row refers to it.

---

## 4. `manifest.json`

Envelope:

```jsonc
{
	"$schema": "./schema/templates-manifest.schema.json",
	"schemaVersion": 1,
	"generatedBy": "manual",
	"status": "seed", // "live" once the repositories exist
	"catalogOrganization": "ever-works",
	"updatedAt": "2026-09-17",
	"templates": [
		/* one row per template repository */
	],
	"appSources": [
		/* repositories a template row refers to, that are not templates */
	]
}
```

Fields that matter most (the JSON Schema is the full list):

| Field                                                   | Meaning                                                                                                                                                                                                                         |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `slug`                                                  | The listing key. For an app row it is also the App Blueprint `id` used by `POST /api/works` and `blueprintId` (APW-03 FR-81).                                                                                                   |
| `kind`                                                  | `website` (a Website/Work Template) or `app` (an App Blueprint).                                                                                                                                                                |
| `status`                                                | `production` · `beta` · `placeholder` · `deprecated`. A non-placeholder **app** row must pin a 40-hex `template.sha`; a non-placeholder **website** row keeps the existing branch-fork behaviour (`template.ref`, `sha: null`). |
| `role`                                                  | Always `website` — the persisted `RepositoryRole` the template's output feeds. Constant on purpose (see §6).                                                                                                                    |
| `workRepositorySuffix`                                  | `-app` for an app template, `-website` for a website template. A suffix, never a role.                                                                                                                                          |
| `template.repo` / `.ref` / `.sha` / `.isGitHubTemplate` | The template repository to fork or generate from, and its pin. `template.sha` **is** the plan's `blueprint.sha` — it is not repeated anywhere else in the row.                                                                  |
| `shape`                                                 | App rows only: `code-bearing` or `metadata-only` (§1).                                                                                                                                                                          |
| `appSource.mode`                                        | App rows only: `embedded` (the template holds the code) · `repository` (fork a second repository) · `image` (no app-source repository).                                                                                         |
| `blueprint`                                             | App rows only: `id`, semver `version`, `topic`, `verified`. `template.ref` must be the tag `v<version>` once published.                                                                                                         |
| `upstreams[]`                                           | App rows only: the upstream `owner/repo` values (plus renames as `aliases` and `refs` constraints) this template serves. This is what makes the suffix scan able to match a pasted URL.                                         |
| `license`                                               | `spdx`, `class` (`green`/`amber`/`red`) and where the classification came from.                                                                                                                                                 |
| `managedHosting`                                        | App rows only: `allowed`, an optional `reason`, and an optional `upstreamAgreement` (amber only).                                                                                                                               |
| `trademark`                                             | App rows only: `notice`, `displayNameSuffix`, `protectedPaths` — shown in the create form and enforced read-only for agents (APW-03 §8 `display.protectedPaths`).                                                               |
| `notes[]`                                               | Free text for the person keeping track. Never read by the platform.                                                                                                                                                             |

`licenses.yml` is the registry APW-03's license gate reads (`catalog.md` §4): three fixed classes (green,
amber, red), the obligations vocabulary, the attestation texts, and the aliases that map what a Git provider
reports (`AGPL-3.0`) onto an SPDX id (`AGPL-3.0-only`). Its fixture entries — `BUSL-1.1` (amber) and
`PolyForm-Noncommercial-1.0.0` (red) — exist for the acceptance lanes, which create their repositories in the
test organization only.

---

## 5. Adding or changing a template

1. **Create the repository first.** `ever-works/<name>-template`, public, topic `ever-works-app-blueprint`
   (app) or the existing website-template topics, default branch `main` (app) or the current convention
   (website), `README.md` with the required headings, and the metadata (`.works/template.yml`,
   `.works/works.yml` for an app).
2. **For a `code-bearing` template**, create it as a **fork of the upstream project**, then add our metadata
   as commits on the default branch: `.works/works.yml` (App spec, `blueprint` mode), `.works/template.yml`
   (`shape: code-bearing`), `README.md`, `.github/workflows/validate.yml`. Do not copy upstream files into a
   new repository — fork, so upstream sync and upstream pull requests keep working through the fork network.
3. **For a `metadata-only` template**, add only our metadata and declare the app source:
   `.works/template.yml` with `shape: metadata-only` and `source: { repo: <owner>/<repo> }`.
4. **Tag the release** `vMAJOR.MINOR.PATCH` and add the row here with that tag in `template.ref` and the tag's
   commit in `template.sha`.
5. **Open one pull request** with the row and, when a licence is new, the `licenses.yml` entry. CI validates;
   a maintainer merges; `EVER_WORKS_APPS_CATALOG_REF` for production moves to a tagged commit of this
   repository (APW-03 `catalog.md` §2).

Rules that are not negotiable:

- **No secrets and no generated credentials** in any template repository, ever.
- **A `metadata-only` template never contains application source**, and CI enforces it (check 7 in §2).
- **A `code-bearing` template contains exactly one thing that is not ours: the upstream project itself, as a
  fork.** Everything else we add is metadata. Its licence is the upstream's, classified here.
- **Never edit a template repository's upstream files to work around a product limit** — that is what the
  overlay files and the App spec are for.

---

## 6. Repository roles — the rule this listing must not break

`RepositoryRole` is `'data' | 'work' | 'website'` (`packages/contracts/src/api/work/import-source.dto.ts:12`)
and the mapping is documented in the platform (`packages/contracts/src/domain/work-capabilities.ts:40-49`).
There is **no new role** for templates, and none is added:

| Role      | UI label                | What it holds for an App Work                                                                                                                         |
| --------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `website` | **Work Repository**     | The app code — the fork that is built and deployed. Named `<slug>-app` (app template) or `<slug>-website` (website template / the unchanged default). |
| `data`    | Data Repository         | The Work's _data_. Not used by an App Work.                                                                                                           |
| `work`    | "{provider} Repository" | The generated, never-deployed output repository. Not used by an App Work.                                                                             |

A user's own fork of the **template** repository is therefore **not** a role: it is recorded as provenance
(§7) and linked in the UI, nothing more.

---

## 7. What the user sees — and a warning about the word "template"

When a user creates a Work from a template, the "Work Information" block shows a
**"Created from [public/private icon] Template Repo"** line with the template repository as a link, rendered
exactly like the Work's other repositories. The persisted provenance lives with the Work
(`sourceRepository.template`), and APW-01 owns writing it and rendering the line — see
`docs/specs/features/app-works/README.md` §1 and [`../plan-changes.md`](../plan-changes.md) §2.

⚠️ **"Template repository" is an overloaded phrase in this program.** Three different things use it:

1. an **App Blueprint repository** — `ever-works/<app>-template`, this listing's subject;
2. a **Website/Work Template repository** — the same suffix, a different kind (`directory-web-template`);
3. GitHub's **template-repository setting** — a repository checkbox, which is what the fixture application
   `ever-works/app-fixture-hello` carries so the acceptance harness can generate per-run upstreams from it
   (`APW-13` plan §4.1; `ACCEPTANCE.md` §0.3).

Only (1) and (2) end in `template` _and_ are listed here. (3) is a setting on a repository that is otherwise
an ordinary app source — and the plan currently writes "template repository" for it and for (1) in the same
breath, which is how `ever-works/app-fixture-hello` and `ever-works/app-fixture-hello-template` get confused.
Resolution must never treat a GitHub template-repository setting as an App Blueprint.

---

## 8. License

This repository's own content is **Apache-2.0** (as `ever-works/works` and `ever-works/missions` are). Each
template repository carries its own licence, and each app template additionally records the **upstream
project's** licence in `manifest.json` for the license gate.
