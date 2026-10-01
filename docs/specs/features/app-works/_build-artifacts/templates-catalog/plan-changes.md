# Plan changes — the template-repo decisions of 2026-09-17

**Status:** draft build artifact, 2026-09-17, for owner review. **Additive only: no existing file was
modified in producing this document.** Every quoted "current" line was read in the
`plan/any-repo-as-work` worktree on 2026-09-17 and is cited as `file:line`; proposed text is written so it can
be pasted.

**What changed in the owner's model** (binding, 2026-09-17):

1. `ever-works/templates` (a **listing** of the templates we keep, "mostly for us to keep track") **replaces
   `ever-works/apps`** as the catalog repository. Resolution is driven by the **`-template` suffix scan** of
   the catalog organization; the listing is curation, not the source of truth.
2. A template repository comes in **two shapes**: **code-bearing** (it holds the whole codebase, kept in sync
   as a public fork of the original project with our metadata added) and **metadata-only** (it holds only our
   metadata and refers to the original app repository).
3. Provisioning forks the **template repository and, when the source is separate, the app-source repository**
   into the user's own account — both modifiable by the user.
4. Roles are unchanged: `RepositoryRole = 'data' | 'work' | 'website'`; the app-code fork is the **Work
   Repository** (`website`), `-app` is an optional **suffix** on it, and the generated public repo stays the
   existing `work` role.
5. A Work shows its **template provenance** — "Created from [public/private icon] Template Repo", with the
   template repository as a URL — in the **Work Information** block.

The seed artifacts that go with these changes are in this folder:
[`ever-works-templates/`](./ever-works-templates/) (the listing repo seed) and
[`resolution-spec.md`](./resolution-spec.md) (the algorithm).

---

## 0. Change list, with owners

| #      | File (section)                                                              | Change                                                                                                                      | Owner                           |
| ------ | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| C-1.1  | `README.md` §2 D4                                                           | Rename the catalog repo; state the two shapes; restate the resolution order around the suffix scan; state the two-fork rule | program README (owner-approved) |
| C-1.2  | `README.md` §1 vocabulary                                                   | Rename the row's repository; keep the noun "Apps catalog"                                                                   | program README                  |
| C-1.3  | `README.md` §2 D3                                                           | "the data repository" → the Work Repository                                                                                 | program README                  |
| C-1.4  | `README.md` §8 open questions                                               | Close item 4 (naming collision) with the shape discriminator; re-word the "never a copy" default                            | program README                  |
| C-2.1  | `APW-01/spec.md` §4.1 FR-2                                                  | Role mapping: exactly one repository role, the **Work Repository** (`website`)                                              | APW-01                          |
| C-2.2  | `APW-01/plan.md` §3.1                                                       | `works.sourceRepository` shape for kind `app`: `relatedRepositories.website`, provenance block, template fork               | APW-01                          |
| C-2.3  | `APW-01/spec.md` §4.4 (new FR)                                              | The `-app` / `-website` suffix rule                                                                                         | APW-01                          |
| C-2.4  | `APW-01/spec.md` §4.6 (new FR) + `plan.md` §6                               | The provenance write and the Work Information line                                                                          | APW-01                          |
| C-2.5  | `APW-01/spec.md` §3.1 S1/S5, §4.4 FR-18/19                                  | Two-fork create path; qualify "never a second fork"                                                                         | APW-01                          |
| C-3.1  | `APW-03/catalog.md` §1.1–§1.2                                               | Repository rename + the two shapes                                                                                          | APW-03                          |
| C-3.2  | `APW-03/catalog.md` §2                                                      | Layout of `ever-works/templates`                                                                                            | APW-03                          |
| C-3.3  | `APW-03/catalog.md` §3                                                      | Envelope: `templates[]` with a `kind` discriminator                                                                         | APW-03                          |
| C-3.4  | `APW-03/catalog.md` §5                                                      | Blueprint repository layout for both shapes + `.works/template.yml`                                                         | APW-03                          |
| C-3.5  | `APW-03/catalog.md` §6                                                      | C9 becomes shape-conditional; new C13–C15                                                                                   | APW-03                          |
| C-3.6  | `APW-03/catalog.md` §7 rule 7                                               | "No upstream source" becomes shape-scoped                                                                                   | APW-03                          |
| C-3.7  | `APW-03/spec.md` §4.3 FR-27                                                 | Default catalog repository                                                                                                  | APW-03                          |
| C-3.8  | `APW-03/spec.md` §4.4 FR-39/43/44                                           | Resolution order with the suffix scan; classification; caching                                                              | APW-03                          |
| C-3.9  | `APW-03/plan.md` §2.4/§2.5                                                  | Env default, index cache, resolver diagram                                                                                  | APW-03                          |
| C-3.10 | `APW-03/schema.md` §3                                                       | Blueprint mode: note that `template.yml` is separate and never applied                                                      | APW-03                          |
| C-3.11 | `APW-03/tasks.md` T33                                                       | Create the listing repository from this seed                                                                                | APW-03                          |
| C-4.1  | `APW-13/spec.md` §4.7 FR-50                                                 | Relax "never contain upstream source code"                                                                                  | APW-13                          |
| C-4.2  | `APW-13/spec.md` §5.1                                                       | Blueprint repository row: two shapes                                                                                        | APW-13                          |
| C-4.3  | `APW-13/plan.md` §2.1, §4, §6, §7                                           | `apps` → `templates`; declare each template's shape; `code-bearing` for Cal.diy                                             | APW-13                          |
| C-4.4  | `APW-13/tasks.md` T24, T27, T28                                             | Shape declaration + the code-bearing fork setup                                                                             | APW-13                          |
| C-4.5  | `APW-13/blueprints/*/README.md`                                             | "no upstream source" wording; per-shape sentence                                                                            | APW-13                          |
| C-5.1  | `CONTRACTS.md` §0 (new R-26)                                                | One normative anchor for shapes + the two-fork rule                                                                         | APW-01 + APW-03                 |
| C-5.2  | `CONTRACTS.md` §2                                                           | `sourceRepository.template` row; `relatedRepositories.website` for kind `app`                                               | APW-01                          |
| C-5.3  | `CONTRACTS.md` §7                                                           | `EVER_WORKS_APPS_CATALOG_REPO` default                                                                                      | APW-03                          |
| C-5.4  | `CONTRACTS.md` §8                                                           | Repository rows: the listing repo, both shapes, the fixture pair                                                            | APW-03 / APW-13                 |
| C-6.x  | APW-02, APW-04, APW-05, APW-08, ACCEPTANCE, TRACKER, user docs, Jira drafts | Consequences of C-2.1/C-2.5 — pointer fixes, mostly one line each                                                           | named per row                   |

---

## 1. `docs/specs/features/app-works/README.md`

### C-1.1 · §2 D4 — the catalogue repository, the two shapes, and the two forks

**Current (`README.md:130-137`):**

> **D4 — App Blueprints are catalog data, not platform code (ADR-014).**
> The **Apps catalog** `ever-works/apps` publishes `manifest.json` (+ a JSON Schema and `licenses.yml`).
> Each entry maps one or more upstream repositories (`owner/repo`, optional ref range) to a **Blueprint
> repository** `ever-works/<app>-template` that contains the App spec, optional overlay files (for example a
> Dockerfile the upstream lacks), smoke tests and documentation — **never a copy of the upstream source**.
> Resolution order when a user pastes a URL: (1) manifest match on upstream `owner/repo`; (2) a
> `ever-works/*-template` repository carrying the topic `ever-works-app-blueprint` **and** a valid App spec
> (the `-template` suffix alone is not enough — Website Templates use it too); (3) the App Provisioner.

**Proposed (replace the whole decision):**

> **D4 — Templates live in their own repositories; the listing is curation (ADR-014).**
> Every template is its own repository in the catalog organization, named with the **`-template`** postfix —
> Website/Work Templates and App Blueprints alike. The platform **discovers them by scanning the catalog
> organization and keeping repositories whose name ends in `template`** (the rule the Website Template
> catalog already uses), then reads each repository's own metadata: `.works/template.yml` (is this an app
> template, which shape, where is the app source) and `.works/works.yml` (the App spec, `blueprint` mode). A
> template is therefore usable the moment its repository exists — no catalogue pull request is needed for
> that.
>
> The repository **`ever-works/templates`** is the **listing**: `manifest.json` (one row per template
> repository, website and app alike, + a JSON Schema), `licenses.yml` and CI. It is "mostly for us to keep
> track" — it adds the **pin** (`template.sha`), the licence class, the trademark and protected-path data,
> the managed-hosting decision and the verification evidence, and it is what makes a template **listed**
> (badged and searchable). It is not what makes a template exist, and a listing row never overrides what a
> template repository says about itself.
>
> **Two shapes.** An app template is either:
>
> - **code-bearing** — the template repository holds the whole codebase, kept in sync as a **public fork of
>   the original project** with our metadata added. Provisioning forks **one** repository, and that fork is
>   the App Work's Work Repository.
> - **metadata-only** — the template repository holds only our metadata (the App spec, optional overlay
>   files, the Blueprint `README.md`) and refers to the original app repository for the source. Provisioning
>   forks **two**: the app source first (it is the Work Repository, built and deployed, and receives the App
>   spec), then the template repository (the user's own copy of the metadata), both with the member's own Git
>   connection into the member's own account or organization (D2).
>
> Resolution order when a user pastes a URL: (1) an explicit Blueprint id; (2) a listing match on upstream
> `owner/repo` (including renames and the fork-network root); (3) the suffix scan of the catalog organization
> — a `*-template` repository that declares this upstream in its own metadata and carries a valid App spec
> (the `-template` suffix alone is not enough — Website Templates use it too); (4) the App Provisioner. The
> exact algorithm, its limits and the fork plan are specified in
> `_build-artifacts/templates-catalog/resolution-spec.md`.

**Owner:** the program README (this is an owner decision; the epic specs must follow it).

### C-1.2 · §1 vocabulary — the row that names the repository

**Current (`README.md:61`):**

> | The catalog listing App Blueprints | **Apps catalog** — `ever-works/apps` (a runtime-loaded catalog repo, ADR-014) | "marketplace" (reserved for EW-299), "store" |

**Proposed:**

> | The repository listing every template we keep (Website Templates and App Blueprints) | **Templates listing** — `ever-works/templates` (ADR-014) | "marketplace" (reserved for EW-299), "store" |
> | The curated index of App Blueprints the platform reads (pin, licence class, managed-hosting decision, verification) | **Apps catalog** — the `templates[]` rows of `kind: app` in `ever-works/templates:manifest.json` | — |

The **noun** "Apps catalog" stays: it is what the create flow offers ("Browse the Apps catalog",
`APW-01/spec.md:400`, `:465`) and what 84 lines of the plan mean by it. Only the _repository_ changes. See
`open-questions.md` OQ-01 for the alternative.

### C-1.3 · §2 D3 and the rest of "the data repository"

**Current (`README.md:125-128`):**

> **D3 — The App spec lives in the data repository.**

**Proposed:**

> **D3 — The App spec lives in the Work Repository.**

The `RepositoryRole` note added to §1 on 2026-09-17 already resolves the vocabulary; D3's heading is the one
remaining place where the decision contradicts it. Same one-word treatment for `README.md:141` ("a pull
request to the data repository") and `README.md:147` ("writes one Ever Works workflow into the data
repository"). The mechanical sweep of the _epics_ is C-6.6.

### C-1.4 · §8 open questions — item 4

**Current (`README.md:340-342`):**

> 4. **Blueprint repository naming** — `<app>-template` (owner's suggestion) collides in suffix with Website
>    Templates. _Default: keep `<app>-template` and require the `ever-works-app-blueprint` topic plus a valid
>    App spec (D4)._

**Proposed:**

> 4. **Blueprint repository naming** — _Answered (owner, 2026-09-17): the collision is the design._ One
>    `-template` postfix for every template repository; what separates them is their own metadata —
>    `.works/template.yml` with `kind: app`, or a `.works/works.yml` valid in `blueprint` mode. The scan may
>    not treat a suffix or a topic alone as proof (see D4).

---

## 2. `APW-01-app-work-kind` — the kind, the create path, the suffix and the provenance

### C-2.1 · `spec.md` §4.1 FR-2 — the role mapping

**Current (`APW-01-app-work-kind/spec.md:245-248`):**

> - **FR-2.** An App Work MUST have: Deploy, Builds, App environment, Tasks, Knowledge base and schedules
>   **on**; Items, taxonomy, comparisons, community pull-request intake, item import/export, source validation
>   and the website generator **off**; exactly one repository role, the data repository. Builds and App
>   environment MUST be off for every other kind (Resolution R-7).

**Proposed (one phrase changes, the rest is untouched):**

> - **FR-2.** An App Work MUST have: Deploy, Builds, App environment, Tasks, Knowledge base and schedules
>   **on**; Items, taxonomy, comparisons, community pull-request intake, item import/export, source validation
>   and the website generator **off**; exactly one repository role — the **Work Repository** (persisted
>   `website`), never the `data` role, which holds a Work's data (`README.md` §1 repository-role note). The
>   capability set is therefore `repos: { data: false, work: false, website: true }`. Builds and App
>   environment MUST be off for every other kind (Resolution R-7).

**Owner:** APW-01. **Depends on:** C-5.2. **Consequence:** C-6.6 (Task paths).

### C-2.2 · `plan.md` §3.1 — what `works.sourceRepository` holds for an App Work

**Current (`APW-01-app-work-kind/plan.md:222`, abridged to the load-bearing part):**

> | `works.sourceRepository` (`simple-json`) | `{ url, owner, repo, type: 'app_link' \| 'app_fork' \| 'app_private_copy', importedAt,
`relatedRepositories: { data: { owner, repo } }`, `upstream?: { owner, repo, defaultBranch }`,
`blueprintId?: string, createdByThisWork?: boolean }`— **top-level`owner`/`repo`= the data repository**,
because`GitFacadeService.getRepoDir` clones the top-level pair; …

**Proposed (replaces that row; still no new column, still `simple-json`):**

> | `works.sourceRepository` (`simple-json`) | `{ url, owner, repo, type: 'app_link' \| 'app_fork' \| 'app_private_copy', importedAt, `relatedRepositories`**now holding`website`instead of`data`** — `{ website: { owner, repo } }`, `upstream?: { owner, repo, defaultBranch }`, `blueprintId?: string`, `template?: { owner, repo, url, visibility, kind, shape?, blueprintId?, version?, sha?, forkedRepo?, resolvedAt }`, `createdByThisWork?: boolean }`— top-level`owner`/`repo` **= the Work Repository** (`website`role: for a`code-bearing`template the fork of the template repository, for a`metadata-only`template the fork of the app-source repository), because`GitFacadeService.getRepoDir`clones the top-level pair and every build/deploy path follows it.`relatedRepositories.website`carries the same pair so`Work.getWebsiteRepo()` resolves it (`packages/agent/src/entities/work.entity.ts:814-853`); the `data`role is **not** written for kind`app`. `template`is the provenance block (C-2.4) and is written even when no fork of the template repository was made.`blueprintId` keeps its meaning (the Blueprint shown in the preview, applied on ready). |

**Also in the same table (`plan.md:216`):** `| works.owner | Data repository owner … |` → `| works.owner | Work Repository owner … |`.
**And the flow diagram (`plan.md:189`, `:193`):** `G{"own App Work on same data repo?"}` → `G{"own App Work on the same Work Repository?"}`; `H -- link --> I["data repo = upstream coords"]` → `I["Work Repository = upstream coords"]`.

**Owner:** APW-01. **Consumers:** APW-02 (readiness for both forks), APW-03 (apply target), APW-04, APW-05, APW-08, APW-11.

### C-2.3 · `spec.md` §4.4 — new FR for the `-app` / `-website` suffix

**Current (`APW-01-app-work-kind/spec.md:301-305`):**

> - **FR-20.** **Private copy** MUST be available only when the repository is at most 500 MB as GitHub
>   reports it, … and is named after the upstream, adding `-copy`, then `-copy-2` up to `-copy-5` when
>   taken.

**Proposed — insert after FR-20, leaving FR-20 untouched:**

> - **FR-20a.** The App Work's **Work Repository** name MUST be chosen once, at creation, from the template it
>   was created from: **`<slug>-app`** when that template is an app template, and **`<slug>-website`**
>   otherwise (the unchanged default for Website/Work Templates and for every non-`app` kind). The chosen
>   repository name and its owner MUST be persisted in `sourceRepository.relatedRepositories.website` and in
>   the top-level `sourceRepository.owner`/`repo`; no reader may re-derive a name when the coordinates are
>   recorded (`work.entity.ts:835-841`). A Work whose recorded name uses the other suffix, or that the user
>   renamed, MUST be respected and never renamed, and the platform MUST NOT rename a repository it created.
>   The suffix is a naming convention only — **the persisted role stays `website` and no new `RepositoryRole`
>   value is added** (owner decision, 2026-09-17). A name conflict follows FR-24 (adopt, or the existing
>   conflict code) and is never resolved by adding a numeric suffix; `-copy` variants remain **Private copy**
>   only (FR-20).

**Owner:** APW-01. Acceptance: `ACC-01-21` (new) — "An App Work created from an app template records
`<slug>-app`; one created from a Website Template records `<slug>-website`; both render in Work Information
without a rename."

### C-2.4 · `spec.md` §4.6 + `plan.md` §6 — the provenance write and the UI line

**Current:** nothing. `grep -n 'provenance|Created from|templateRepository|Work Information'`
`APW-01-app-work-kind/` returns **no matches**, although `README.md:93-97` already assigns the write to APW-01:

> **Template provenance (owner decision, 2026-09-17).** A Work created from a template must show where it came
> from: in the **"Work Information"** block, **"Created from [public/private icon] Template Repo"**, with the
> template repository as a **URL** rendered like the Work's other repositories. The DB side is additive (the
> template coordinates are already implied by the fork relationship; store them explicitly so the UI needs no
> GitHub round-trip), and APW-01 owns the create-path write.

**Proposed — new FR in §4.6 (Preparing and the initial source file):**

> - **FR-29b.** Creating an App Work from a template MUST record the template's provenance — owner, name,
>   https URL, visibility snapshot, `kind` (`website` \| `app`), `shape` when it is an app template, the
>   Blueprint id/version/commit when one was applied, the user's own copy of the template repository when one
>   was created, and the resolution timestamp — in `sourceRepository.template` (C-2.2). It MUST be written in
>   the same transaction as the Work row so the UI needs no Git-provider round-trip. It MUST be written for
>   every create path that used a template (listing match, suffix-scan match, explicit Blueprint id) and MUST
>   NOT be written for a linked repository or for an App Work with no template.

> - **FR-29c.** The Work's **"Work Information"** block MUST show the provenance as one more repository row —
>   **"Created from Template Repo"** — with the existing public/private icon (`Lock`/`Unlock`) and the
>   template repository as a link, rendered exactly like the Work's other repository rows, and the row MUST be
>   absent when no template was used. Component and i18n anchors: `apps/web/src/components/works/detail/overview/WorkInfo.tsx`
>   (the Repositories row, `:189-232`; `RepositoryRow` `:61-100`; `RepoVisibilityIcon` `:34-54`),
>   link building in `apps/web/src/components/works/detail/WorkDetailContext.tsx:139-155`, keys beside
>   `info.repositories` in `apps/web/messages/en.json:6300-6332`.

**Also in `plan.md` §6 (the create pipeline):** add a step after the persistence transaction — "11. Record
`sourceRepository.template` (FR-29b) in the same transaction; the Web `WorkInfo` row is rendered from it
(FR-29c)."

**Owner:** APW-01 (write **and** UI line — the same epic that owns the create path, per `README.md:97`).

### C-2.5 · two forks on the create path

**Current (`APW-01-app-work-kind/spec.md:197-199`):**

> - **S21 — Fork is slow.** After 15 minutes of preparing, the card reads **"Your fork is taking longer than
>   15 minutes."** with **Try again** and **Open on GitHub**; **Try again** resumes waiting and never asks
>   GitHub for a second fork.

**Current (`APW-01-app-work-kind/plan.md:201-203`):**

> The provider write (fork request or empty-copy creation) happens **after** every validation and **before**
> persistence, because GitHub decides the fork's final name. If persistence fails afterwards, the fork stays
> on GitHub and the next identical request adopts it (FR-25) — never a second fork.

**Proposed — add one qualifying sentence in both places (the statements stay true, they just stop being
ambiguous):**

> "…never asks GitHub for a **second fork of the same upstream into the same account**. A `metadata-only`
> template's second fork is a **different repository** (the template repository, not the app source) and is
> governed by FR-18c below."

> - **FR-18c.** When the resolved template is **`metadata-only`**, creation MUST fork **two** repositories
>   with the member's own connection: (1) the **app source** named by the template — this fork is the Work
>   Repository, it is what the first write (R-4) and the App spec application target, and its readiness gates
>   `preparing → ready`; (2) the **template repository** — issued immediately after (1) is accepted, recorded
>   in `sourceRepository.template.forkedRepo`, and **not on the critical path**: its readiness MUST NOT delay
>   `ready`, MUST NOT fail the App Work, and on failure the provenance falls back to the catalog repository
>   and the failure is shown with a retry action. When the template is **`code-bearing`**, creation forks
>   **one** repository — the template — which is both the Work Repository and the provenance repository.
>   Existing-fork adoption (FR-19) is applied **per repository**, independently for each of the two.

**Owner:** APW-01 (create path); APW-02 owns readiness for the second fork (C-6.1).

---

## 3. `APW-03-app-spec-and-catalog` — the catalogue format and the resolver

### C-3.1 · `catalog.md` §1.1–§1.2 — rename and the two shapes

**Current (`catalog.md:15-18`):**

> 1. **Catalog data, not platform code** (ADR-014, D4). Adding an App Blueprint is a pull request to
>    `ever-works/apps` and to its Blueprint repository — never a platform release.
> 2. **Never a copy of the upstream source.** A Blueprint repository holds an App spec, a few overlay files
>    the upstream lacks, tests and documentation. CI enforces it (§6, C9).

**Proposed:**

> 1. **Catalog data, not platform code** (ADR-014, D4). Adding an App Blueprint is a pull request to
>    `ever-works/templates` and to its Blueprint repository — never a platform release. (The repository was
>    renamed from `ever-works/apps` on 2026-09-17; it lists Website/Work Templates as well as App
>    Blueprints, and its App rows are the Apps catalog.)
> 2. **Two shapes, declared by the Blueprint repository itself.** A Blueprint repository is either
>    **`code-bearing`** — it holds the whole application codebase, kept in sync as a public fork of the
>    original project with our metadata added — or **`metadata-only`** — it holds an App spec, a few overlay
>    files the upstream lacks, tests and documentation, and **no upstream source**. The shape is declared in
>    `.works/template.yml` and verified by CI (§5, §6 C9/C13–C15). A `metadata-only` Blueprint repository
>    never contains upstream source; a `code-bearing` one contains exactly one thing that is not ours — the
>    upstream project, as a fork.
> 3. _(the old 3–6 renumber unchanged)_

**Owner:** APW-03. This principle is quoted verbatim elsewhere — C-4.1, C-4.2, C-4.5, C-6.7.

### C-3.2 · `catalog.md` §2 — the repository layout

**Current (`catalog.md:3-6` and `:32-35`):**

> > **Normative** for the two repository shapes outside this monorepo that APW-03 reads: the **Apps
> > catalog** `ever-works/apps` and each **Blueprint repository** `ever-works/<app>-template`
>
> ## 2. `ever-works/apps` layout
>
> ```
> ever-works/apps/
> ```

**Proposed:** `ever-works/apps` → **`ever-works/templates`** in both places, plus the seed files this folder
supplies:

> ```
> ever-works/templates/
> ├── manifest.json                   # the listing: one row per template repository, website and app (§3)
> ├── licenses.yml                    # the license registry (§4)
> ├── schema/
> │   ├── templates-manifest.schema.json   # JSON Schema for manifest.json
> │   ├── licenses.schema.json
> │   └── app-spec.schema.json        # vendored copy of the platform's App spec schema (schema.md §25)
> ├── icons/<id>.svg                  # one icon per app entry, ≤ 32 KiB, no <script>, no external refs
> ├── evidence/<id>/<runId>.json      # verification run results written by the acceptance suite (APW-13)
> ├── scripts/validate.mjs            # every CI check in §6, runnable locally
> ├── CONTRIBUTING.md                 # §7
> ├── README.md                       # §9 — what the listing is, and what the platform reads
> └── .github/…                       # validate.yml, schema-sync.yml, verify-expiry.yml, CODEOWNERS
> ```

**Owner:** APW-03 (the seed content is `_build-artifacts/templates-catalog/ever-works-templates/`).
**Note:** the file name `schema/manifest.schema.json` becomes
`schema/templates-manifest.schema.json` because the manifest now lists both kinds.

### C-3.3 · `catalog.md` §3 — the envelope

**Current (`catalog.md:63-73`):**

> ```json
> {
> 	"schemaVersion": 1,
> 	"apps": [
> 		/* entries */
> 	]
> }
> ```
>
> Limits: file ≤ 2 MiB; ≤ 1,000 entries; `id` unique. …

**Proposed:**

> ```json
> {
> 	"$schema": "./schema/templates-manifest.schema.json",
> 	"schemaVersion": 1,
> 	"generatedBy": "manual",
> 	"status": "live",
> 	"catalogOrganization": "ever-works",
> 	"updatedAt": "YYYY-MM-DD",
> 	"templates": [
> 		/* one row per template repository; `kind` is `website` or `app` */
> 	],
> 	"appSources": [
> 		/* repositories a row refers to as its app source, that are not templates themselves */
> 	]
> }
> ```
>
> Limits: file ≤ 2 MiB; ≤ 1,000 rows; `slug` unique; `kind: app` rows are the Apps catalog entries of §3.1.
> The catalog service reads **only** `kind: app` rows; `kind: website` rows exist so the listing covers the
> whole template family and so the Website Template catalog can be cross-checked against it. Unknown
> top-level keys are ignored by the platform and rejected by CI.

Two field-name notes for the reader, so nothing is duplicated:

- `blueprint.repo` → **`template.repo`**, `blueprint.sha` → **`template.sha`**, `blueprint.version` →
  `blueprint.version` (unchanged). The plan's §3.1 rules keep their meaning: a non-placeholder app row pins
  `template.sha` (40-hex) and `template.ref` is the tag `v<blueprint.version>`.
- `id` → **`slug`** (the same value; `slug` is the house word in `ever-works/works` and `ever-works/missions`).

**Owner:** APW-03. **Consequence:** the mapper (`apps-catalog.mapper.ts`, `plan.md:213`) reads
`manifest.templates` and skips `kind !== 'app'`; one test each for "a website row never appears in the
catalog" and "an app row's `template.sha` maps to `blueprint.sha`" (ACC-03-50/51, new).

### C-3.4 · `catalog.md` §5 — the Blueprint repository, both shapes

**Current (`catalog.md:261-276`):**

> ## 5. Blueprint repository `ever-works/<app>-template`
>
> ```
> ever-works/cal-diy-template/
> ├── .works/works.yml        # App spec in `blueprint` mode: no `source`, no `blueprint` block (schema.md §3)
> ├── overlay/                # files copied into the data repository at the same relative path
> │   └── Dockerfile
> ├── overlay.yml             # one row per overlay file (below)
> ├── tests/
> │   └── e2e/booking.spec.ts # optional Playwright test run by verify.yml
> ├── README.md               # required sections below
> ├── LICENSE                 # the Blueprint's own license: MIT
> └── .github/workflows/verify.yml
> ```
>
> **Required repository settings**: public; topic `ever-works-app-blueprint`; default branch `main`; tags
> `vMAJOR.MINOR.PATCH`; description ≤ 160 chars.

**Proposed — keep the `metadata-only` layout as-is (add `.works/template.yml`) and add the second shape:**

> ## 5. Blueprint repository `ever-works/<app>-template`
>
> **Required repository settings** (both shapes): public; topic `ever-works-app-blueprint`; default branch
> `main`; tags `vMAJOR.MINOR.PATCH`; description ≤ 160 chars; `.works/template.yml` declaring `kind: app` and
> `shape`.
>
> **Shape `metadata-only`**
>
> ```
> ever-works/umami-template/
> ├── .works/template.yml     # kind: app · shape: metadata-only · source.repo: <owner>/<repo>
> ├── .works/works.yml        # App spec in `blueprint` mode: no `source`, no `blueprint` block (schema.md §3)
> ├── overlay/ · overlay.yml · tests/ · README.md · LICENSE
> └── .github/workflows/verify.yml
> ```
>
> **Shape `code-bearing`** — a **GitHub fork of the upstream project**, with our metadata committed on top of
> the default branch and nothing else:
>
> ```
> ever-works/cal-diy-template/        # fork of calcom/cal.diy
> ├── <the entire upstream tree at the pinned commit, unmodified>
> ├── .works/template.yml     # kind: app · shape: code-bearing · source.repo: calcom/cal.diy
> ├── .works/works.yml        # App spec in `blueprint` mode
> ├── README.md               # ours, replacing nothing upstream publishes under that name — see the rule below
> └── .github/workflows/verify.yml   # added; upstream workflows stay disabled in forks (APW-02)
> ```
>
> Rules for the `code-bearing` shape:
>
> | #   | Rule                                                                                                                                                                                                                                                                                      |
> | --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
> | K1  | The repository MUST be a fork: `isFork: true` with fork-network root (or parent) equal to `source.repo`. CI checks it (C13).                                                                                                                                                              |
> | K2  | Our commits MUST be additive: `.works/**`, our `README.md` only when upstream has none or ours replaces it deliberately, and CI. Any other modification of an upstream file is a review failure — upstream changes belong in a pull request to the project (APW-09), not in the template. |
> | K3  | The template MUST be refreshed by merging the upstream default branch, and the merge MUST be a reviewed pull request that re-runs verification at the new pin (C15).                                                                                                                      |
> | K4  | Upstream workflows MUST stay disabled (APW-02 Actions hygiene) — a `code-bearing` template spends the template owner's minutes, not a member's.                                                                                                                                           |
> | K5  | No overlay file is needed or allowed: the code is here. Overlay rules (§5 below) apply to `metadata-only` only.                                                                                                                                                                           |

**Owner:** APW-03. The `metadata-only` rules (overlay limits, README headings, versioning) are unchanged.

### C-3.5 · `catalog.md` §6 — the CI checks

**Current (`catalog.md:316`):**

> | C9 | Overlay rules (§5), and no overlay file is byte-identical to a file at the same path in the upstream at the newest ref allowed by `refs` (source-copy guard). |

**Proposed:**

> | C9 | `metadata-only` rows only: overlay rules (§5), and no overlay file is byte-identical to a file at the same path in the upstream at the newest ref allowed by `refs` (source-copy guard). A `code-bearing` row has no `overlay/` and fails if it has one. |
> | C13 | `.works/template.yml` exists, validates, and its `shape` matches reality: `code-bearing` ⇒ the repository is a fork whose root/parent is `source.repo`; `metadata-only` ⇒ `source.repo` differs from the repository itself and no upstream source file is present. |
> | C14 | Every file a `code-bearing` template adds on top of its fork point is under `.works/`, is `README.md`, or is under `.github/` — checked with `GET /repos/{owner}/{repo}/compare/{upstreamSha}...{sha}` and an allow-list; any other changed upstream path fails the run. |
> | C15 | A `code-bearing` template's pinned commit is not behind its upstream's default branch by more than the configured staleness window (default 30 days), and the merge commit that brought the current pin in is a reviewed pull request. |

**Owner:** APW-03.

### C-3.6 · `catalog.md` §7 rule 7

**Current (`catalog.md:338`):**

> 7. **No upstream source, no secrets, no generated credentials** in any Blueprint repository file.

**Proposed:**

> 7. **No secrets and no generated credentials** in any Blueprint repository file, ever. **No upstream
>    source** in a `metadata-only` Blueprint repository — that shape holds our metadata only (C9). A
>    `code-bearing` Blueprint repository contains the upstream source **by definition**, as a fork, and only
>    as a fork (C13/C14).

### C-3.7 · `spec.md` §4.3 FR-27

**Current (`APW-03-app-spec-and-catalog/spec.md:250-252`):**

> - **FR-27.** The catalog MUST be read from the configured catalog repository and ref (default
>   `ever-works/apps` at `main`), and a warning MUST be logged on every uncached read of a ref that is not a
>   40-character commit or a version tag.

**Proposed:** default becomes **`ever-works/templates` at `main`** (one string; `main` and the warning rule
unchanged).

### C-3.8 · `spec.md` §4.4 FR-39/FR-43/FR-44 — resolution

**Current (`APW-03-app-spec-and-catalog/spec.md:287-303`, the three load-bearing FRs):**

> - **FR-39.** Resolution MUST follow D4: (1) manifest match; (2) Blueprint repository probe; (3) none, handed
>   to the App Provisioner.
> - **FR-43.** The probe MUST try at most 2 names (`ever-works/<repo>-template`,
>   `ever-works/<owner>-<repo>-template`, slugified), use at most 3 Git provider reads, accept a repository
>   only with the Blueprint topic and a spec valid in `blueprint` mode, label it **Unlisted Blueprint**, and
>   never mark it verified or managed-hosting eligible. No free-text search MUST be used.
> - **FR-44.** Resolutions MUST be cached per canonical upstream for 1 hour when found and 10 minutes when
>   not, return within 5 seconds at the 95th percentile, and resolve to "none" with reason `lookupFailed` on
>   a provider error without blocking creation.

**Proposed:**

> - **FR-39.** Resolution MUST follow D4: (1) an explicit Blueprint `id`; (2) a **listing match** on the
>   upstream repository (renames and fork-network root included); (3) the **suffix scan** of the catalog
>   organization — repositories whose name ends in `template`, each judged by its **own metadata**
>   (`.works/template.yml`, `.works/works.yml` in `blueprint` mode); (4) none, handed to the App Provisioner.
> - **FR-43.** The scan MUST walk the catalog organization at 100 repositories per page for at most 50 pages,
>   MUST skip a repository already named by a listing row, MUST treat a repository as an app template **only**
>   when its own metadata says `kind: app` (the `-template` suffix and the topic are never sufficient), MUST
>   validate its App spec in `blueprint` mode with zero errors, MUST verify the declared `shape`
>   (`code-bearing` ⇒ a fork of `source.repo`; `metadata-only` ⇒ `source.repo` is a different repository), and
>   MUST label a hit that no listing row names an **Unlisted Blueprint** — never verified, never
>   managed-hosting eligible. Before the scan it MUST try the two direct names of today's probe
>   (`ever-works/<repo>-template`, `ever-works/<owner>-<repo>-template`). It MUST NOT use free-text search,
>   MUST fetch nothing outside the catalog organization, and MUST be bounded by an 8-second deadline, a 1-hour
>   index cache and a 5-minute re-attempt cooldown so a throttled Git provider can never stall creation.
> - **FR-44.** Resolutions MUST be cached per canonical upstream for 1 hour when found and 10 minutes when
>   not, return within 5 seconds at the 95th percentile, and resolve to "none" with reason `lookupFailed` on
>   a provider error without blocking creation. Added reasons, append-only: `shapeMismatch`,
>   `templateShapeUnknown`, `sourceForkFailed`, `templateForkFailed` (meanings in
>   `_build-artifacts/templates-catalog/resolution-spec.md` §3.2).

**Owner:** APW-03. User scenario S17 (`spec.md:144`) gains one clause: "…exists with the topic, a
`.works/template.yml` declaring `kind: app` and a spec valid in `blueprint` mode".

### C-3.9 · `plan.md` §2.4/§2.5

- **`plan.md:209`** — `EVER_WORKS_APPS_CATALOG_REPO` (default `ever-works/apps`, …) → **`ever-works/templates`**.
- **`plan.md:212`** — the cache entry `apps-catalog:<repo>:<ref>` gains a sibling
  `templates-index:<org>` holding `{ repos, fetchedAt, truncated }` (TTL 1 h, 5-minute attempt cooldown,
  8-second deadline) — the index the scan walks.
- **`plan.md:234`** (resolver diagram) — replace
  `├─► probe ever-works/<slug(repo)>-template, ever-works/<slug(owner)>-<slug(repo)>-template` with the
  scan-then-probe order of FR-43, and add the classification step (`shape` from `template.yml`) before the
  hit is returned.
- **`plan.md:876`** — "`ever-works/apps` seeded with the schema and CI" → "`ever-works/templates` seeded from
  the listing seed (manifest, both schemas, `licenses.yml`), with CI".

**Owner:** APW-03.

### C-3.10 · `schema.md` §3

**Current (`schema.md:80`):**

> | Apps catalog CI, on a Blueprint repository | `blueprint` | Structure, §21, §22. `source` and `blueprint` are **forbidden** (`blueprint_mode_forbidden_key`); `license` is optional. |

**Proposed (append one sentence; the rule itself does not change):**

> … `license` is optional. The template's own shape and app-source coordinates do **not** live here — they are
> read from `.works/template.yml` beside this file, which is never applied to a Work and never copied into a
> user's repository (APW-03 `catalog.md` §5).

**Owner:** APW-03. Rationale: `.works/template.yml` keeps `blueprint` mode's forbidden-key rule intact, so
nothing about the applied spec's meaning changes.

### C-3.11 · `tasks.md` T33

**Current (`tasks.md:456-457`):**

> - [ ] **T33. The `ever-works/apps` catalog repository** _(outside this monorepo)_.
>       **Create** in `ever-works/apps`: `manifest.json` (`schemaVersion: 1`, empty `apps`), `licenses.yml` …

**Proposed:** rename to **`ever-works/templates`**, and create the repository **from the seed** in
`docs/specs/features/app-works/_build-artifacts/templates-catalog/ever-works-templates/` (listing README,
`manifest.json` with the four website rows and the three app rows, `schema/templates-manifest.schema.json`,
`licenses.yml` with the amber and red fixture entries APW-13 needs), then add T33's remaining files
(`schema/licenses.schema.json`, `schema/app-spec.schema.json` from T8, `scripts/validate.mjs` with the checks
of `catalog.md` §6 plus the seven cross-field checks listed in the listing README §2,
`.github/workflows/{validate,schema-sync,verify-expiry}.yml`, `.github/CODEOWNERS`, `CONTRIBUTING.md`,
`LICENSE`). **Done when** additionally: the manifest validates against its own schema in CI, and
`GET /repos/ever-works/templates` is public with `validate.yml` required on `main`.

**Owner:** APW-03.

---

## 4. `APW-13-golden-paths` — the fixtures that prove it

### C-4.1 · `spec.md` §4.7 FR-50

**Current (`APW-13-golden-paths/spec.md:318`):**

> - **FR-50.** Fixture and Blueprint repositories never contain upstream source code or any credential.

**Proposed:**

> - **FR-50.** Fixture repositories never contain a credential, and Blueprint repositories never contain a
>   credential. A **`metadata-only`** Blueprint repository never contains upstream source code either. A
>   **`code-bearing`** Blueprint repository contains the upstream project **as a fork** and adds nothing to it
>   beyond its own metadata (APW-03 `catalog.md` §5 K1–K5); that shape is what the Cal.diy golden path
>   exercises.

### C-4.2 · `spec.md` §5.1 — the entity table

**Current (`APW-13-golden-paths/spec.md:341`):**

> | **Blueprint repository** | Defined by the program: one App Blueprint, never upstream source. | `ever-works/app-fixture-hello-template`, `ever-works/umami-template`, `ever-works/cal-diy-template`. |

**Proposed:**

> | **Blueprint repository** | Defined by the program: one App Blueprint, in one of two shapes — `metadata-only` (our metadata only) or `code-bearing` (the project as a public fork, plus our metadata). | `ever-works/app-fixture-hello-template` and `ever-works/umami-template` (**metadata-only** — source: `ever-works/app-fixture-hello`, `umami-software/umami`); `ever-works/cal-diy-template` (**code-bearing** — a fork of `calcom/cal.diy`). |

### C-4.3 · `plan.md` §2.1, §4, §6, §7

- **`plan.md:81`** — the architecture diagram's `│ apps  (catalog: manifest, e2e branch,` → `│ templates (catalog: manifest, e2e branch,`.
- **`plan.md:294-315`** — add one line per template: `Shape: metadata-only (source: umami-software/umami)` and
  `Shape: code-bearing (fork of calcom/cal.diy)`.
- **`plan.md:317-318`** — Cal.diy's "sources and refresh procedure" becomes a **fork-sync procedure**: the
  template is a public fork; refreshing the pin means merging upstream's default branch into the template and
  re-running verification (APW-03 `catalog.md` §5 K3, C15).
- **`plan.md:243`** — keep `profiles/*` where they are (they are the fixture Blueprint's files); no change
  beyond the shape sentence.
- **`plan.md:135-160`** — evidence files stay in the same repository, now named `ever-works/templates`
  (`evidence/<id>/<runId>.json`).

**Owner:** APW-13.

### C-4.4 · `tasks.md` T24, T27, T28

**Current (`tasks.md:262-264`, `:288-289`, `:295-296`):** each is "**Create** from
`docs/.../blueprints/<x>/` … topic; `validate.yml`."

**Proposed:** each task gains two lines —

- `**_works/template.yml**: kind: app · shape: <metadata-only | code-bearing> · source: { repo: <owner>/<repo>, defaultBranch: <branch> }.`
- for `code-bearing` (T28 only): `**Fork first**: create the repository as a fork of `calcom/cal.diy`, then commit `.works/template.yml`, `.works/works.yml`and our`README.md`on top of the default branch; set the topic and disable inherited workflows (APW-02). **Done when**:`isFork: true`, the fork root is `calcom/cal.diy`, `validate.yml` is green, and the CI source-copy check (C14) reports only allowed added paths.`

**Owner:** APW-13. **Depends on:** C-3.4/C-3.5.

### C-4.5 · the three Blueprint READMEs

**Current (`APW-13-golden-paths/blueprints/cal-diy/README.md:7-8`):**

> This Blueprint tells Ever Works how to build and run a fork of `calcom/cal.diy` as an App Work. It contains
> **no upstream source**: only `.works/works.yml` and this README.

**Proposed (Cal.diy only — the other two READMEs get the `metadata-only` sentence):**

> This Blueprint tells Ever Works how to build and run a fork of `calcom/cal.diy` as an App Work. It is a
> **`code-bearing`** Blueprint: this repository **is** a public fork of `calcom/cal.diy`, and everything we add
> to it is metadata — `.works/template.yml`, `.works/works.yml`
> and this README. Provisioning forks this repository once, into the member's own account; that fork is the
> App Work's Work Repository and is what gets built. Refreshing the pin means merging upstream's default
> branch (see "Refreshing the pin").

**Also:** `blueprints/cal-diy/README.md:64` ("The pin lives in the Apps catalog entry's ref range (APW-03) and
in the comment at the top of `works.yml`") → "The pin lives in the listing row (`ever-works/templates`,
`template.ref` = the release tag, `template.sha` = its commit) and in the comment at the top of `works.yml`."

**Owner:** APW-13.

---

## 5. `CONTRACTS.md`

### C-5.1 · §0 — one normative anchor (new R-26)

**Proposed (append to the resolution table; R-1…R-25 are untouched):**

> | R-26 | Template shapes and the two-fork rule | A template repository is **`code-bearing`** (it holds the app source, as a public fork of the original project, plus our metadata) or **`metadata-only`** (our metadata only; the app source is a separate repository). The shape is declared in `.works/template.yml` in the template repository and verified by the catalog's CI; listing rows may not contradict it. Provisioning forks the **template** repository always and the **app-source** repository as well when the shape is `metadata-only`, both with the member's own connection into the member's own account (D2/FR-15), the **app-source fork first** because it is the Work Repository. The **template fork is never a `RepositoryRole`**; it is recorded as provenance. The Work Repository is the persisted `website` role and its name takes the `-app` suffix for app templates or `-website` otherwise; **no new `RepositoryRole` value is added**. | 01, 02, 03, 04, 05, 08, 13, README D4 |

**Owner:** APW-01 + APW-03 jointly (the two epics that must not disagree).

### C-5.2 · §2 — the persisted rows

**Current (`CONTRACTS.md:237`, the APW-01 row):**

> Added by APW-01: `sourceRepository.blueprintId` (the Blueprint shown in the create preview, applied on
> ready); `APP_SOURCE_REPOSITORY_TYPES` is a new constant — `IMPORT_SOURCE_TYPES` is **not** widened …;
> top-level `sourceRepository.owner/repo` = **the Work Repository** (`website` role …); …

**Proposed — keep that row and add two:**

> | Added by APW-01 (R-26): `sourceRepository.relatedRepositories.website` = the Work Repository for kind `app` (the `code-bearing` template fork, or the `metadata-only` app-source fork); the `data` role is not written for kind `app`; `sourceRepository.template` = the template provenance `{ owner, repo, url, visibility: 'public' \| 'private', kind: 'website' \| 'app', shape?, blueprintId?, version?, sha?, forkedRepo?, resolvedAt }` — additive inside the existing `works.sourceRepository` `simple-json`, **no migration**; written whenever a create path used a template | APW-01 | APW-02, 03, 04, 05, 08, 11 |
> | `.works/template.yml` in each app template repository (added by APW-03, R-26): `{ schemaVersion, kind: 'app', shape: 'code-bearing' \| 'metadata-only', source: { repo, defaultBranch, aliases?, refs? }, specPath?, overlayPath? }` — read by the resolver, never applied to a Work | APW-03 | APW-01, 13 |

**Note for the table's `Work.sourceRepository.type` row (`CONTRACTS.md:236`):** its "how the data repository
relates to the upstream" wording becomes "how the **Work Repository** relates to the upstream".

### C-5.3 · §7 — the environment variable

**Current (`CONTRACTS.md:401`):**

> | `EVER_WORKS_APPS_CATALOG_REPO` | env | `ever-works/apps` | APW-03 |

**Proposed:** default **`ever-works/templates`**. The variable _name_ stays (it is the Apps catalog's reader,
and renaming it would touch config in every environment for no gain) — `open-questions.md` OQ-03.

### C-5.4 · §8 — the repositories

**Current (`CONTRACTS.md:430-432`):**

> | `ever-works/apps` | APW-03 | `manifest.json` (App Blueprint index), `schema/app-spec.schema.json`, `licenses.yml`, CI validation; …
> | `ever-works/<app>-template` | APW-13 | one App Blueprint: `.works/works.yml` (kind `app`), overlay files, smoke tests, `README.md`; topic `ever-works-app-blueprint` …
> | `ever-works/app-fixture-hello` | APW-13 | the acceptance fixture application (source only, no `.works/`); its Blueprint is `ever-works/app-fixture-hello-template` |

**Proposed:**

> | `ever-works/templates` (renamed from `ever-works/apps`, 2026-09-17) | APW-03 | the listing: `manifest.json` (one row per template repository, `kind: website\|app` + `appSources[]`), `schema/templates-manifest.schema.json`, `licenses.yml`, CI validation; also `evidence/<id>/` (written by APW-13) and the test-only `e2e` branch — formats normative in APW-03 `catalog.md`; the `templates[]` rows of `kind: app` are the Apps catalog |
> | `ever-works/<app>-template` | APW-13 | one App Blueprint, in one of two shapes (R-26): **`metadata-only`** — `.works/template.yml` (`shape: metadata-only`, `source.repo`), `.works/works.yml` (kind `app`, `blueprint` mode), overlay files, smoke tests, `README.md`; **`code-bearing`** — a public fork of `source.repo` carrying the whole codebase, plus `.works/template.yml`, `.works/works.yml`, `README.md` and CI. Both: topic `ever-works-app-blueprint`. Layout: APW-03 `catalog.md` §5 |
> | `ever-works/app-fixture-hello` | APW-13 | the acceptance fixture **application** — source only, no `.works/`; it is marked as a **GitHub template repository** so the estate helper can generate per-run upstreams from it (`ACCEPTANCE.md` §0.3). It is **not** an App Blueprint repository and its name does not end in `template`; the Blueprint is `ever-works/app-fixture-hello-template`. The plan's use of "template repository" for both must be read as this distinction |

**Owner:** APW-03 (first and second rows), APW-13 (third).

---

## 6. Consequences in other files (one-line pointers, not redesigns)

| #      | File · line                                                                                                    | Change                                                                                                                                                                                                                                                                                                                             | Owner   |
| ------ | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| C-6.1  | `APW-02/spec.md:33-39`                                                                                         | "nothing ever asks GitHub for a second fork" → "…a second fork of the same upstream"; add readiness + sync rows for the second (template) fork and for a `code-bearing` template's fork-of-a-fork (`parent` = our template, root = upstream).                                                                                      | APW-02  |
| C-6.2  | `APW-02/plan.md:112-117`                                                                                       | `forkRepository(owner, repo, { organization?, name?, waitForReady? })` already accepts `name` — note that the create path now passes it (`<slug>-app`/`<slug>-website`, FR-20a) and that one Work may own two fork readiness targets.                                                                                              | APW-02  |
| C-6.3  | `APW-04/spec.md:38-39`, `plan.md:34`                                                                           | The Provisioner's pull request goes to the **Work Repository** (not "the data repository"); its clone target is `relatedRepositories.website` for kind `app`.                                                                                                                                                                      | APW-04  |
| C-6.4  | `APW-05/spec.md:77`, `plan.md:79`                                                                              | The one build workflow and the `EW_` secrets are written into the **Work Repository**; for a `code-bearing` template that is the template fork, so inherited upstream workflows must stay disabled there (APW-02).                                                                                                                 | APW-05  |
| C-6.5  | `APW-06/spec.md:420,462`                                                                                       | "Source" links / PR branches name the **Work Repository**.                                                                                                                                                                                                                                                                         | APW-06  |
| C-6.6  | `APW-08/plan.md:26-28,69-70,148`, `APW-08/spec.md:228`                                                         | Task workspaces, `.works/works.yml` reads and delivery must resolve the **Work Repository** for kind `app` (`task-workspace.service.ts:219-220` currently hard-codes `getRepoOwner()`/`getDataRepo()` = the `data` role; for an App Work that name does not exist). Without this, every Task on an App Work targets `<slug>-data`. | APW-08  |
| C-6.7  | `APW-03/user-doc-draft.md:61` ("Blueprints never copy the app's source code…"), `:128-134` (contributor steps) | Rewrite for two shapes: "A `metadata-only` Blueprint never copies the app's source code…; a `code-bearing` Blueprint is a fork of the project and adds only Ever Works metadata." Contributor steps say `ever-works/templates` and `.github/workflows` validation.                                                                 | APW-03  |
| C-6.8  | `ACCEPTANCE.md:92,162,1258`                                                                                    | `ever-works/apps` → `ever-works/templates` (test catalog ref, evidence location, the CI test path).                                                                                                                                                                                                                                | APW-13  |
| C-6.9  | `ACCEPTANCE.md:87-88`                                                                                          | Name the fixture pair explicitly (`ever-works/app-fixture-hello` = application and GitHub template repository; `ever-works/app-fixture-hello-template` = Blueprint) so the two are never conflated in a lane.                                                                                                                      | APW-13  |
| C-6.10 | `TRACKER.md:16`                                                                                                | "Needs the `ever-works/apps` catalog repository" → `ever-works/templates`.                                                                                                                                                                                                                                                         | APW-03  |
| C-6.11 | `docs/internal/app-works-implementation-plan.md` (open-items table)                                            | Add one row: "Template shapes + two-fork provisioning — answered 2026-09-17; the Cal.diy template is `code-bearing`, Umami and the fixture are `metadata-only`."                                                                                                                                                                   | program |
| C-6.12 | `_build-artifacts/open-decisions/jira-tickets.md:198,213,473`                                                  | `EW-820`'s description and the "blocked by an owner action" note move from `ever-works/apps` to `ever-works/templates`; `EW-820`'s external-repository paragraph gains the two shapes.                                                                                                                                             | program |
| C-6.13 | `README.md:193` (D13)                                                                                          | One clause: the licence gate classifies the **upstream** project, which for a `code-bearing` template is the same project the template forks.                                                                                                                                                                                      | program |

---

## 7. Already landed — do not re-propose

The working tree already contains the vocabulary half of the 2026-09-17 decision. Leave these alone:

| Already written                                                                                                                        | Where                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Repository-role note (`data`/`work`/`website`, the `-app` suffix allowed, "an App Work's app-code fork … is the Work Repository")      | `README.md:78-91` (uncommitted)                           |
| Template-provenance note (the UI line, the create-path owner)                                                                          | `README.md:93-97` (uncommitted)                           |
| `R-4` renamed to "First write into the Work Repository"; the app-spec example's `branch:` comment                                      | `CONTRACTS.md:47`, `:87` (uncommitted)                    |
| §2 vocabulary fix ("earlier text … uses 'the data repository' for the repository that holds app code") and the corrected APW-01 row    | `CONTRACTS.md:224-231`, `:237` (uncommitted)              |
| APW-06's deploy route correction, APW-12's ZITADEL answer, EXISTING-SUBSTRATE's `tasks.checks` / `taskIsolationTargetRepo` corrections | unrelated uncommitted edits — not part of this change set |

---

## 8. Suggested application order (one PR per row)

1. **C-1.x** (program README decisions) — everything else cites D4.
2. **C-5.1 + C-5.2 + C-5.3** (CONTRACTS R-26 + the persisted shape + the env default).
3. **C-2.x** (APW-01: role mapping, `sourceRepository`, suffix rule, provenance FR + UI).
4. **C-3.x** (APW-03: catalog format, resolution FRs, tasks) together with the listing seed in this folder.
5. **C-4.x** (APW-13: shapes for the three golden-path templates, the code-bearing fork setup, the fixture wording).
6. **C-6.x** (pointer fixes) — may ride along with 3–5, but each names its own owner.

The listing repository itself can be created **after step 4** and before step 5: it needs the format, and
step 5 needs a place to list what it creates.
