# Template resolution — precise algorithm (draft for implementation)

**Status:** draft build artifact, 2026-09-17. **Read-only work** — no existing file was modified by producing
this document; the plan edits it implies are in [`plan-changes.md`](./plan-changes.md).

**What this replaces.** It is the normative algorithm for D4's resolution order
(`README.md:130-137`) and APW-03 FR-39…FR-44, extended by the owner's 2026-09-17 model: templates are
discovered by the `-template` suffix in the catalog organization, every template lives in its own repository,
a template repository is either **code-bearing** or **metadata-only**, and provisioning forks the template
repository **and, when the app source is separate, the app-source repository too**.

**How to read the citations.** `file:line` references are to the `ever-works-platform` worktree at
`plan/any-repo-as-work`, verified by reading on 2026-09-17. Nothing here is inferred from memory.

---

## 1. Inputs, outputs, and the one thing that is already true today

### 1.1 Inputs

| Input                     | Source                                                                                                                                       | Notes                                                                                                                                                                                                                                                  |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Pasted repository         | the user                                                                                                                                     | `owner/repo`, GitHub only, parsed by the existing Repository Work rules (APW-01 FR-6).                                                                                                                                                                 |
| Catalog organization      | `config.websiteTemplate.getCatalogOrganization()` — read at `packages/agent/src/template-catalog/template-catalog.service.ts:622` and `:670` | The org the suffix scan walks. Never a user-supplied org: `SAFE_REPO_RE = /^ever-works\/[a-z0-9-]+$/` (`apps/api/src/works/works-template-catalog.service.ts:114`) exists so a hostile manifest cannot point the platform at attacker-controlled code. |
| Explicit `blueprintId`    | `POST /api/works`, `POST /api/works/app-source/inspect` (APW-01)                                                                             | Highest precedence — it is how the acceptance harness names the fixture Blueprint (APW-03 plan `:245-248`).                                                                                                                                            |
| Listing (`manifest.json`) | `ever-works/templates` (renamed from `ever-works/apps`)                                                                                      | Curation: pin, licence class, managed-hosting decision, verification.                                                                                                                                                                                  |
| Template metadata         | each `-template` repository                                                                                                                  | **The source of truth for existence and shape.**                                                                                                                                                                                                       |

### 1.2 Outputs

```ts
type TemplateResolution =
	| {
			source: 'explicit' | 'listing' | 'scan' | 'probe';
			kind: 'app'; // a usable app template
			template: { owner; repo; ref; sha; shape; topics };
			entry?: ListingEntry;
	  }
	| {
			source: 'listing' | 'scan';
			kind: 'website'; // a website template
			template: { owner; repo; ref; sha };
	  }
	| { source: 'none'; reason: 'notListed' | 'lookupFailed' | 'shapeMismatch' | 'blueprintNotFound' };
```

`kind: 'website'` is _not_ an App Blueprint: for an app Work it means "the `-template` repository carries no
app metadata" and resolution continues (it can still be the source of a **Website** Work, and an App Work
created from it gets no App spec → the App Provisioner).

### 1.3 What already ships (do not rebuild it)

The website-template discovery in `packages/agent/src/template-catalog/template-catalog.service.ts` is the
working prototype of exactly this scan and **already implements the owner's rule**:

| Behaviour                                                          | Code                                                                 |
| ------------------------------------------------------------------ | -------------------------------------------------------------------- |
| Keep repositories whose name ends in `template` (case-insensitive) | `isStandardTemplateRepository` — `:1047-1049` (`/template$/i`)       |
| Walk the catalog org, 100 per page, stop on a short page           | `:668-706` (`perPage = 100`, `maxPages = 50`)                        |
| Warn when the page cap is hit                                      | `:708-712`                                                           |
| Skip repositories already represented by a curated entry           | `:718-732` (builds a coordinate set from `listWebsiteTemplates()`)   |
| Sync gate: 1 h                                                     | `WEBSITE_DISCOVERY_SYNC_TTL_MS` — `:100`                             |
| Re-attempt cooldown after **any** outcome: 5 min                   | `WEBSITE_DISCOVERY_ATTEMPT_COOLDOWN_MS` — `:112`, applied `:639-643` |
| Hard deadline so a throttled GitHub never stalls a request: 8 s    | `WEBSITE_DISCOVERY_DEADLINE_MS` — `:114`, applied `:648-665`         |
| Sanitize third-party text before persisting/showing it             | `sanitizeDiscoveredDescription` — `:1022-1045`                       |

APW-03's `AppsCatalogService` copies the _reader_ pattern from
`apps/api/src/works/works-template-catalog.service.ts` (see `EXISTING-SUBSTRATE.md:57`) — tokenless raw read
with an authenticated fallback, 1 h cache, 30 s negative cache, 8 s timeout, size guards
(`apps/api/src/works/works-template-catalog.service.ts:88-119`, `:274-311`, `:338-390`) — and those numbers
carry over to this algorithm unchanged.

---

## 2. The metadata a template repository carries

### 2.1 `.works/template.yml` — new, required for an app template

`source` and `blueprint` are **forbidden** inside a `blueprint`-mode `.works/works.yml`
(`schema.md:80`), so the shape and the app-source coordinates need their own file. It is read **only** by the
catalog/resolver; it is never applied to a Work and never copied into the user's repositories.

```yaml
# .works/template.yml — the template repository's own metadata (app templates only)
schemaVersion: 1
kind: app

# code-bearing : this repository contains the application source (a public fork of the
#                project, with our metadata added). One fork at provisioning.
# metadata-only: this repository contains only our metadata. The application source is
#                `source.repo` — a second, separate fork at provisioning.
shape: metadata-only

source:
    repo:
        umami-software/umami # owner/name of the upstream project. Required in BOTH shapes:
        #   code-bearing  → this repository is a fork of it
        #   metadata-only → the app source lives there and is forked separately
    defaultBranch: master
    aliases: [umami-software/umami-app] # ≤ 5 former names, matched case-insensitively
    refs: { branches: [master], tags: '>=3.4.0' } # optional: which upstream refs this template serves

# Optional, defaults shown
specPath: .works/works.yml
overlayPath: overlay.yml
```

Rules:

| #   | Rule                                                                                                                                                                                                                                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | `kind` must be `app`. A `.works/template.yml` with any other `kind` is ignored (the resolver falls back to §2.2).                                                                                                                                                                                                         |
| T2  | `shape` is `code-bearing` \| `metadata-only`. Absent ⇒ the candidate is treated as **metadata-only but not auto-provisionable** — see T6.                                                                                                                                                                                 |
| T3  | `source.repo` is required and must parse as `owner/name`.                                                                                                                                                                                                                                                                 |
| T4  | `shape: code-bearing` **requires** `source.repo` to be this repository's fork network root (or its immediate parent): the resolver reads the repository once (APW-02 adds `source`/`parent` to `getRepository`, CONTRACTS §3) and requires `isFork === true` with `source.full_name ?? parent.full_name === source.repo`. |
| T5  | `shape: metadata-only` **requires** `source.repo` to differ from this repository's `owner/name`.                                                                                                                                                                                                                          |
| T6  | T4/T5 failing is `shapeMismatch`: the candidate is **not** used for an automatic fork. It may still be shown as an **Unlisted Blueprint** with the mismatch surfaced, and resolution continues with the next candidate.                                                                                                   |
| T7  | A candidate with **no** `template.yml` whose `.works/works.yml` validates in `blueprint` mode is a metadata-only candidate _only if_ a listing row (or an explicit `blueprintId`) names its app source; otherwise it resolves as `shapeMismatch` (we know the spec but not where the code is).                            |
| T8  | Secrets, tokens and generated credentials never appear in this file (APW-03 `catalog.md` §7 rule 7).                                                                                                                                                                                                                      |

### 2.2 Fall-back discriminator (no `template.yml` yet)

| Candidate carries                                                                        | Classification                                                                                                                                 |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `.works/works.yml` valid in `blueprint` mode with root `kind: app` (or `spec.kind: app`) | **app template**                                                                                                                               |
| `.works/template.yml` with `kind: app`                                                   | **app template**                                                                                                                               |
| neither                                                                                  | **website template** — the `-template` suffix alone is not enough (README D4 `:136-137`). Ignored by the app path; usable by the website path. |

Verified today: none of the four website template repositories carries a `.works/` directory at all
(`GET /repos/ever-works/<name>/contents/.works` → 404 for `directory-web-template`,
`directory-web-minimal-template`, `web-template`, `web-minimal-template`, 2026-09-17), and all four are
code-bearing by nature — the template repository holds the site code and **the fork is the Work Repository**.
`code-bearing` is therefore not a new concept: it is the behaviour Website Templates have always had.

---

## 3. The algorithm

```text
resolve({ owner, repo, ref?, blueprintId?, viewer }):

  ── Step 0 · canonicalize ────────────────────────────────────────────────────────────────
  0.1  parse owner/repo (Repository Work rules). Invalid ⇒ none(invalidUrl) — APW-01 owns the code.
  0.2  READ the repository once (this read is needed by steps 2 and 3 anyway):
         { fullName, defaultBranch, isFork, parent, sourceRoot, topics, archived, visibility }
  0.3  canonical = fullName as the provider reports it (follows renames/transfers, APW-01 S30).
  0.4  lookupKeys = [ canonical, sourceRoot ?? parent, the pasted pair ]   (deduplicated, lower-cased)
  0.5  if archived ⇒ continue; the create form refuses archived repositories, resolution does not.

  ── Step 1 · explicit blueprintId (highest precedence) ──────────────────────────────────
  1.1  look the id up in the listing → if found and selectable ⇒ return {source:'explicit', entry}
       (ref constraints still apply when the entry lists this upstream; verification counts).
  1.2  else probe the scanned index for a candidate whose blueprint.id matches ⇒ {source:'explicit'}
  1.3  else ⇒ none(blueprintNotFound)                                   [unchanged from today]

  ── Step 2 · listing match (curation wins) ───────────────────────────────────────────────
  2.1  match lookupKeys against every app row's upstreams[].repo and upstreams[].aliases,
       case-insensitively, ignoring null template.repo rows.
  2.2  >1 match ⇒ the row with default:true, and offer up to 5 others (FR-42).
  2.3  a match through a fork/sourceRoot key is a fork match: offered only with explicit
       confirmation (FR-40) — it is still a match, never a silent one.
  2.4  hit ⇒ return {source:'listing', entry, template:{repo, ref, sha, shape from template.yml}}

  ── Step 3 · suffix scan of the catalog organization (the owner's discovery) ──────────────
  3.0  cheap pre-step: the two-name direct probe (unchanged, FR-43)
         ever-works/<slug(repo)>-template
         ever-works/<slug(owner)>-<slug(repo)>-template
       ≤ 2 repository reads. A hit is validated exactly like a scan candidate (step 3.4) and
       returned as {source:'probe'} (Unlisted Blueprint).
  3.1  index = getOrBuildTemplateIndex(catalogOrganization)        [limits below]
  3.2  candidates = index.filter(name matches /template$/i)
  3.3  for each candidate, in stability order (listing rows first, then alphabetical):
         skip when the candidate's coordinates are already represented by a listing row
           (the curated-entry skip, template-catalog.service.ts:718-732)
         skip when archived, disabled, private-without-access, or its default branch is empty
         read .works/template.yml (if present) and .works/works.yml at the default branch
         classify per §2.2 → website templates are skipped here
         match source.repo / aliases / refs against lookupKeys  → no match ⇒ next candidate
         validate shape per T4/T5                              → mismatch ⇒ record + next candidate
         validate the .works/works.yml in `blueprint` mode      → 0 errors required (FR-43)
         ⇒ return {source:'scan', template, entry?: listing row}
  3.4  a scan hit is an **Unlisted Blueprint** unless a listing row names it: never marked verified,
       never managed-hosting eligible (FR-43), and applied at the head sha resolved now, recorded so
       the applied state stays reproducible.
  3.5  no candidate ⇒ none(notListed)

  ── Step 4 · nothing matched ⇒ the App Provisioner ───────────────────────────────────────
  4.1  create the App Work with no Blueprint (FR-29a) and call
       AppProvisioningService.start({ workId, trigger: 'auto-create' })   (CONTRACTS §3)
  4.2  the Provisioner studies the repository, writes the App spec, and — when the result is worth
       keeping — proposes it as a Blueprint (`app.provision.blueprint_suggested`, APW-04).
  4.3  the App Work is fully usable meanwhile: the user's own repositories exist, the Work
       Repository is recorded, and only the App spec is missing.
```

### 3.1 Index limits (all inherited, all binding)

| Limit                | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Why                                                                                                                                                                 |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Page size / page cap | `perPage = 100`, `maxPages = 50` (≤ 5 000 repositories)                                                                                                                                                                                                                                                                                                                                                                                                              | `template-catalog.service.ts:671-672`; a warning is logged when the cap is hit (`:708-712`).                                                                        |
| Stop condition       | a page shorter than `perPage`                                                                                                                                                                                                                                                                                                                                                                                                                                        | `:701-703`.                                                                                                                                                         |
| Freshness            | 1 h (`WEBSITE_DISCOVERY_SYNC_TTL_MS`, `:100`)                                                                                                                                                                                                                                                                                                                                                                                                                        | One index per catalog org per hour; the index is a `CACHE_MANAGER` entry `templates-index:<org>` holding `{ repos, fetchedAt, truncated }`.                         |
| Re-attempt cooldown  | 5 min after **any** outcome (`:112`, `:639-643`)                                                                                                                                                                                                                                                                                                                                                                                                                     | A failing or empty scan must not re-run a 50-page fetch on every create.                                                                                            |
| Deadline             | 8 s (`:114`, `:648-665`)                                                                                                                                                                                                                                                                                                                                                                                                                                             | On the deadline the resolver serves the last good index (or none) and step 3 is skipped — creation never blocks on the scan.                                        |
| Curated-entry skip   | candidates whose coordinates a listing row already names are skipped                                                                                                                                                                                                                                                                                                                                                                                                 | `:718-732`; keeps one source of truth per repository.                                                                                                               |
| Match work           | Building the index: 1 `listRepositories` request per 100 repositories. Per **candidate** (only names ending in `template` — 4 in `ever-works` today): 1 file read (`template.yml`), plus 1 more (`works.yml`) only when the first is absent, plus 1 repository read only for a `code-bearing` shape check. Candidate metadata is cached under `templates-index:<org>:<repo>@<headSha>` for 1 h, so the steady-state cost of a resolution is **zero** provider reads. | Bounded by the page cap and cut short by the deadline; the per-candidate work scales with the number of templates we keep, never with the size of the organization. |
| Cache of results     | `1 h` on a hit, `10 min` on a miss, keyed by canonical upstream (`+ blueprintId` when given)                                                                                                                                                                                                                                                                                                                                                                         | FR-44, unchanged.                                                                                                                                                   |
| Latency envelope     | p95 ≤ 5 s; on provider error ⇒ `none(lookupFailed)` and creation proceeds                                                                                                                                                                                                                                                                                                                                                                                            | FR-44, unchanged.                                                                                                                                                   |

**Security, unchanged and non-negotiable:** the scan reads **only** repositories in the catalog organization,
and `source.repo` / `upstreams[]` / `aliases` / `links` are matched as _data_ — they are never fetched as code
(FR-31; `catalog.md` §1.4). A `code-bearing` template is forked **from the catalog org**, never from an
upstream named inside a file.

### 3.2 Reason codes

Existing codes stay; these are added (append-only, APW-03 owns the enum):

| Code                   | Meaning                                                                                           | User-facing behaviour                                                                                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `shapeMismatch`        | §2.1 T6/T7: the repository does not match its declared shape.                                     | The candidate is not offered for automatic provisioning; the App Provisioner path runs. Recorded on the provisioning record, never as a silent fallback.                             |
| `templateShapeUnknown` | The candidate is an app template with no `template.yml` and no listing row naming its app source. | Same.                                                                                                                                                                                |
| `sourceForkFailed`     | The app-source fork (metadata-only) failed or timed out.                                          | The App Work fails preparation with the existing fork failure codes; **nothing** is half-created: the App Work row is deleted and the orphan fork is adopted on retry (FR-24/FR-25). |
| `templateForkFailed`   | The template fork (metadata-only, second) failed or timed out.                                    | **The App Work still becomes ready.** Provenance falls back to the catalog repository and the Upstream tab names the failure with a retry action.                                    |

---

## 4. What gets forked, in what order, into whose account

The fork plan is a pure function of `shape` and `appSource.mode`:

| Shape / mode                   | Fork 1                         | Fork 2                      | Work Repository (role `website`) | Provenance template repository                       |
| ------------------------------ | ------------------------------ | --------------------------- | -------------------------------- | ---------------------------------------------------- |
| `code-bearing` (`embedded`)    | `ever-works/<app>-template`    | —                           | Fork 1                           | Fork 1 (the same repository)                         |
| `metadata-only` (`repository`) | `source.repo` (the app source) | `ever-works/<app>-template` | Fork 1                           | Fork 2, or the catalog repository when Fork 2 failed |
| `metadata-only` (`image`)      | `ever-works/<app>-template`    | —                           | Fork 1                           | Fork 1                                               |

Order and failure semantics:

1. **Both forks use the member's own Git connection into the member's own account or one of their
   organizations** — never a platform organization (D2, FR-15). GitHub allows one fork per account per
   network, so a shared platform organization could not hold two customers' forks, and upstream pull requests
   must come from the user.
2. **Fork 1 first, always**, because Fork 1 is the Work Repository: it is what the first write
   (`commitFiles` or a setup pull request, R-4), the App spec application (APW-03 `app-blueprint-apply`) and
   the first Build (APW-05) target. Creation issues the fork request, persists the Work and the
   `work_upstream_states` row in one transaction, and dispatches APW-02's readiness handler — the existing
   APW-01 create path (`plan.md:186-203`, `:498-504`) with the repository pair changed from the
   data-repository pair to the Work Repository pair (§5).
3. **Fork 2 (metadata-only only) is issued immediately after Fork 1's request is accepted, and its readiness
   is not on the critical path.** It must not delay `preparing → ready`, must not fail the App Work, and must
   not change what is built. APW-02 tracks it as a second readiness target on the same Work; on failure the
   provenance falls back to the catalog repository and the failure is visible with a retry action
   (`templateForkFailed`).
4. **Adoption beats creation, per repository.** If the member already has a fork of _that_ repository in the
   chosen owner, it is adopted and no fork request is made (FR-19) — independently for Fork 1 and Fork 2.
5. **"Never a second fork" keeps its meaning.** APW-01 S21 (`spec.md:197-199`, `plan.md:203`, `plan.md:854`)
   and APW-02 (`spec.md:38-39`) forbid asking GitHub for a second fork **of the same upstream into the same
   account**. Forking a _different_ repository (the template) is not that, and none of those statements may be
   read as forbidding it — but the wording must be qualified so nobody "fixes" the second fork away
   (`plan-changes.md` §6).
6. **`-copy` naming stays private-copy-only.** FR-20's `-copy`, `-copy-2`…`-copy-5` variants apply to
   **Private copy** of the app source. Neither fork of a template is ever renamed with a numeric suffix; a
   name conflict follows FR-24 (adopt, or fail with the existing conflict code).

What is written where, once the repositories exist:

| Fact                             | Where it is persisted                                                                                                                                                                                                                                                      |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The Work Repository (owner/repo) | `relatedRepositories.website` — **and** `sourceRepository.owner/repo`, because `GitFacadeService.getRepoDir` clones the top-level pair (`APW-01 plan.md:222`).                                                                                                             |
| The upstream the Work follows    | `sourceRepository.upstream {owner, repo, defaultBranch}` — the **original project**, not our template. For a `code-bearing` fork the Work's `parent` is our template and its fork-network root is the original, which is exactly what FR-40's root-first matching expects. |
| The template the Work came from  | `sourceRepository.template` (§7) — never a `RepositoryRole`.                                                                                                                                                                                                               |
| The applied pin                  | `WorkAppSpecState.blueprintSha` (APW-03) — for a listing row, `template.sha`; for an Unlisted candidate, the head sha resolved at apply time.                                                                                                                              |

---

## 5. Roles: no new persisted value, and what "Work Repository" means here

`RepositoryRole` stays `'data' | 'work' | 'website'`
(`packages/contracts/src/api/work/import-source.dto.ts:12`); the mapping stays as documented at
(`packages/contracts/src/domain/work-capabilities.ts:40-49`) and in `README.md:78-91`. **No new role value is
added for templates, app sources, or generated repositories.** Concretely, for an App Work:

| Role                              | Used?                | Named                            | Meaning                                                                                                                                 |
| --------------------------------- | -------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `website` → **"Work Repository"** | **yes, exactly one** | `<slug>-app` or `<slug>-website` | The app-code fork: the Work's deliverable, the App-spec holder, the build and deploy target.                                            |
| `data` → "Data Repository"        | no                   | —                                | The Work's _data_. An App Work's data lives in the platform and in its App spec; the capability set turns this role off for kind `app`. |
| `work` → "{provider} Repository"  | no                   | —                                | The generated, never-deployed output repository. Not part of an App Work.                                                               |

Consequences that must be carried by other epics (they are the price of mapping the app-code fork to
`website`, which the owner confirmed):

- `Work.getWebsiteRepo()` / `getRelatedRepository('website')` already read
  `sourceRepository.relatedRepositories.website` and only fall back to `<slug>-website`
  (`packages/agent/src/entities/work.entity.ts:814-853`) — recorded coordinates always win, so both suffixes
  work with no entity change.
- Task workspaces and the Provisioner currently clone the **data** role
  (`task-workspace.service.ts:219-220` via `getRepoOwner()`/`getDataRepo()`; APW-04 `plan.md:34`;
  `EXISTING-SUBSTRATE.md:100`). For kind `app` those paths must resolve the **Work Repository**. Without that
  change every Task on an App Work would target `<slug>-data`, a repository that does not exist. Owner:
  APW-08 (with APW-04's provisioning input).

### 5.1 The `-app` / `-website` suffix rule

| Situation                                                                             | Work Repository name                                       |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Created from an **app** template                                                      | `<slug>-app`                                               |
| Created from a **website** template                                                   | `<slug>-website` (unchanged)                               |
| Any other kind / legacy path                                                          | `<slug>-website` (unchanged: `work.entity.ts:843-853`)     |
| A Work whose coordinates were recorded under the other suffix, or renamed by the user | **whatever is recorded** — never renamed, never re-derived |

Rules:

1. The suffix is chosen **once, at creation**, from the template's kind, and is written into
   `relatedRepositories.website.repo` together with the fork it names. The persisted role and the persisted
   coordinates are the truth; the derived name is only a fallback for Works that predate the field.
2. Both suffixes are legal forever, in both directions: the UI resolves links through
   `WorkDetailContext.tsx:127-155`, which already refuses to invent a name when roles are recorded
   (`rolesAreRecorded`) — the same rule applies to `-app`.
3. The platform **never renames** a repository it created, and never rewrites coordinates to match the
   convention. A mismatch is a rename by the user (APW-01 S30), not an error.
4. Naming does not interact with `work`-role naming (`<slug>`) or `data`-role naming (`<slug>-data`).

---

## 6. Nothing matched — the App Provisioner hand-off

`none(...)` is a **success**, not an error: the App Work exists, the user's repositories exist, the Work
Repository is recorded, and only the App spec is missing (APW-01 FR-29a). The resolver must:

1. return within the FR-44 envelope (`none` on provider error, reason `lookupFailed`), and
2. leave the create flow able to call `AppProvisioningService.start({ workId, trigger: 'auto-create' })`
   (CONTRACTS §3, `APW-04`), which studies the repository in an isolated workspace with no secrets.

The Provisioner never sees the template repositories; that is the whole point of the split.

---

## 7. Template provenance — what is persisted and what is shown

**Persisted (additive; APW-01's "no new table, no new column" constraint is respected by putting it inside
the existing `sourceRepository` `simple-json` column, `APW-01 plan.md:222`):**

```ts
// packages/contracts/src/api/work/import-source.dto.ts — SourceRepository gains one optional block
interface SourceRepository<TImportedAt = string> {
	// …existing fields unchanged…
	template?: {
		owner: string; // the template repository the Work was created from
		repo: string;
		url: string; // https URL built from the provider, never from user input
		visibility: 'public' | 'private'; // snapshot, so the UI needs no GitHub round-trip
		kind: 'website' | 'app';
		shape?: 'code-bearing' | 'metadata-only'; // app templates only
		blueprintId?: string; // the listing slug / Apps catalog id
		version?: string; // semver of the pinned release
		sha?: string; // the applied template commit (40-hex)
		forkedRepo?: { owner: string; repo: string }; // the user's own copy of the template, when made
		resolvedAt: string; // ISO 8601
	};
}
```

`RepoVisibility` (`import-source.dto.ts:44-48`) is **not** widened: the template's visibility travels inside
the block above, because `RepoVisibility` is a role map and the template is not a role.

**Shown (APW-01 owns both the write and the line):**

- The "Work Information" block is `apps/web/src/components/works/detail/overview/WorkInfo.tsx` — the
  **Repositories** row (`:189-232`) renders one `RepositoryRow` per role, each with the existing
  public/private icon (`RepoVisibilityIcon`, `:34-54`, using `Lock`/`Unlock`).
- The provenance line is one more row in that list: label **"Created from Template Repo"**, the row's link
  pointing at the template repository, `isPrivate` from `template.visibility`, with the same ⓘ explainer
  treatment as the other rows. The icon the owner asked for is the existing one — no new icon work.
- The link comes from the same helper as the other repository links
  (`WorkDetailContext.tsx:139-155`), so it is encoded and provider-correct by construction, and it renders as
  plain text (not a dead `#` link) when the URL is unknown (`WorkInfo.tsx:81-99`).
- When `forkedRepo` exists, the line links to the user's own copy (the repository they can modify); otherwise
  it links to the catalog repository. Both are named in the ⓘ body. See `open-questions.md` OQ-05.
- i18n keys land beside the existing ones in `apps/web/messages/en.json` (`info` block, `:6290-6332`).

---

## 8. Worked examples

| Case                                                                                                   | Resolution                                                               | Fork plan                                                               | Work Repository                                                           |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ | ----------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `calcom/cal.diy` (listing row `cal-diy`, `code-bearing`)                                               | Step 2 — listing match on `upstreams[0].repo`, applied at `template.sha` | 1 fork: `ever-works/cal-diy-template` → `<member>/<slug>-app`           | The fork; `parent = ever-works/cal-diy-template`, root = `calcom/cal.diy` |
| `umami-software/umami` (listing row `umami`, `metadata-only`)                                          | Step 2 — listing match                                                   | 2 forks: `umami-software/umami` first, then `ever-works/umami-template` | The app-source fork, at the template's pinned spec                        |
| `ever-works/app-fixture-hello` in the test estate (explicit `blueprintId: app-fixture-hello`)          | Step 1 — explicit id, then Step 2 on the `e2e` branch listing            | 2 forks, same as Umami                                                  | The app-source fork                                                       |
| A per-run generated upstream not in any catalog                                                        | Step 3 — scan finds nothing; Step 4                                      | —                                                                       | The Work is created, then the App Provisioner studies it                  |
| `ever-works/directory-web-template` used for a Website Work                                            | Step 2/3 → `kind: 'website'`                                             | 1 fork (existing behaviour)                                             | The fork; suffix `-website`                                               |
| A candidate whose `template.yml` says `code-bearing` but the repository is not a fork of `source.repo` | `shapeMismatch` → candidate skipped → Step 4                             | —                                                                       | The Work is created, Provisioner path                                     |

---

## 9. What proves this (tests to write with the implementation)

| #    | Test                                                                                                                                           | Proves            |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| R-1  | A repository named `*-template` **without** app metadata is never resolved as an App Blueprint                                                 | §2.2, D4          |
| R-2  | The scan is capped at 50 pages, warns, and serves the last good index on the 8 s deadline                                                      | §3.1              |
| R-3  | A second resolution inside 5 minutes after a failed scan does not re-fetch                                                                     | §3.1 cooldown     |
| R-4  | A repository already named by a listing row is skipped by the scan                                                                             | §3.1 curated skip |
| R-5  | `shape: code-bearing` on a non-fork candidate yields `shapeMismatch` and the Provisioner path                                                  | T4/T6             |
| R-6  | `metadata-only` yields exactly two forks in order, app source first                                                                            | §4                |
| R-7  | A failed template fork leaves the App Work ready and provenance pointing at the catalog repository                                             | §3.2, §4.3        |
| R-8  | No resolution path fetches a host or repository outside the catalog org (fetch-spy test)                                                       | FR-31             |
| R-9  | A Work created from an app template is named `<slug>-app`; from a website template `<slug>-website`; recorded coordinates always win over both | §5.1              |
| R-10 | `TemplateResolution` never produces a new `RepositoryRole` value (contract test on the enum)                                                   | §5                |
| R-11 | `sourceRepository.template` round-trips and the Work Information row renders with a public and with a private template                         | §7                |

---

## 10. Open items

Anything this algorithm cannot settle from the material is in [`open-questions.md`](./open-questions.md) with
a recommended default — notably OQ-02 (whether the listing must be a gate at all), OQ-04 (the exact fork order
when the member already has one of the two forks), OQ-05 (which copy the provenance line links to) and OQ-06
(whether `template.yml` should be folded into `.works/works.yml` later).
