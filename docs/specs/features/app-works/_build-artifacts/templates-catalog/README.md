# Build artifacts — templates catalogue (listing repo + resolution + plan changes)

**Status:** draft, 2026-09-17. **Read-only work**: everything here is **new**; no existing file in the
worktree was modified, and nothing was committed.

**Prepared for:** the owner's decisions of 2026-09-17 about how templates are found and provisioned
(`ever-works/templates` as the listing; one `-template` repository per template, in a **code-bearing** or a
**metadata-only** shape; both the template and — when the source is separate — the app-source repository forked
into the user's account; the `-app` suffix; template provenance in the Work Information block).

## What is in this folder

| Path                                               | What it is                                                                                                                                                                                                                                                                       | Use it to                                                                                                                                              |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`ever-works-templates/`](./ever-works-templates/) | The **seed of the `ever-works/templates` listing repository**: `manifest.json` (7 template rows + 1 app-source row), `schema/templates-manifest.schema.json`, `licenses.yml`, `README.md`                                                                                        | Create the repository tomorrow: copy the folder, add `scripts/validate.mjs`, `.github/workflows/validate.yml`, `CONTRIBUTING.md`, `LICENSE`, then push |
| [`resolution-spec.md`](./resolution-spec.md)       | The **resolution algorithm**, implementable without guessing: the suffix scan and its limits, the metadata that classifies a candidate, the fallback order, the fork plan, the suffix rule, the provenance shape                                                                 | Cut APW-03's `AppBlueprintResolverService` work into tasks; answer "which repository does this Work build?"                                            |
| [`plan-changes.md`](./plan-changes.md)             | **Section-level additive edits** to `README.md`, APW-01, APW-03, APW-13 and `CONTRACTS.md`, each with the current text quoted and the proposed text written — plus one-line consequences in APW-02/04/05/06/08, `ACCEPTANCE.md`, `TRACKER.md`, the user docs and the Jira drafts | Apply the decision to the plan in six reviewable PRs (§8 there)                                                                                        |
| [`open-questions.md`](./open-questions.md)         | 14 genuinely undecidable items, each with a recommended default and the impact of deciding the other way                                                                                                                                                                         | Decide (or knowingly accept the defaults)                                                                                                              |

## The five load-bearing decisions, in one screen

1. **The listing is curation, not the source of truth.** A template exists because its repository exists in the
   catalog organization with a name ending in `template`; the platform reads that repository's own metadata
   (`.works/template.yml`, `.works/works.yml`). The listing adds the pin, the licence class, the
   managed-hosting decision and the verification — and it is what makes a template _listed_.
2. **Two shapes.** `code-bearing` = the template repository holds the app source, as a public fork of the
   original project with our metadata on top. `metadata-only` = our metadata only; the app source is a separate
   repository. `.works/template.yml` declares which.
3. **Two forks for `metadata-only`, one for `code-bearing`** — the app source first (it is the Work
   Repository: built, deployed, and the App spec's home), then the template; both with the member's own
   connection into the member's own account or organization. A failed template fork never fails the App Work.
4. **Roles are unchanged.** The app-code fork is the persisted `website` role — UI label **"Work Repository"**
   — named `<slug>-app` for an app template and `<slug>-website` otherwise. `data` and `work` keep their
   meanings; **no new `RepositoryRole` value exists**, and the template fork is provenance, not a role.
5. **A Work shows where it came from**: `sourceRepository.template`, rendered in the Work Information block as
   one more repository row — "Created from Template Repo" — with the existing public/private icon.

## What was verified by reading (not assumed)

Every claim about the existing platform was checked in this worktree on 2026-09-17:

| Claim                                                                                                         | Evidence                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Templates are already discovered by the `-template` suffix in the catalog organization                        | `packages/agent/src/template-catalog/template-catalog.service.ts:1047-1049` (`/template$/i`), discovery `:668-818`, org from `config.websiteTemplate.getCatalogOrganization()` at `:622`, `:670`                                                                                                                                                                                                    |
| The scan's limits                                                                                             | page size 100 / 50 pages `:671-672`; short-page stop `:701-703`; cap warning `:708-712`; curated-entry skip `:718-732`; 1 h sync TTL `:100`; 5 min attempt cooldown `:112`, applied `:639-643`; 8 s deadline `:114`, applied `:648-665`; description sanitizer `:1029-1045`                                                                                                                         |
| The catalog _reader_ pattern (raw read, cache TTLs, size guards, `SAFE_REPO_RE`)                              | `apps/api/src/works/works-template-catalog.service.ts:88-119`, `:274-311`, `:338-390`                                                                                                                                                                                                                                                                                                               |
| `RepositoryRole` is already persisted, and the UI labels are literal                                          | `packages/contracts/src/api/work/import-source.dto.ts:12`; `packages/contracts/src/domain/work-capabilities.ts:40-49`; `apps/web/messages/en.json:6300-6332` ("Data Repository", "Work Repository", "{provider} Repository")                                                                                                                                                                        |
| The Work Repository default name and the recorded-coordinates-first rule                                      | `packages/agent/src/entities/work.entity.ts:814-853` (`getDefaultRepositoryName('website')` → `<slug>-website`, `getRelatedRepository` prefers recorded coordinates)                                                                                                                                                                                                                                |
| The Work Information block, its repository rows and the existing public/private icon                          | `apps/web/src/components/works/detail/overview/WorkInfo.tsx:34-54` (`RepoVisibilityIcon`), `:61-100` (`RepositoryRow`), `:189-232` (the Repositories row); links from `apps/web/src/components/works/detail/WorkDetailContext.tsx:127-155`                                                                                                                                                          |
| The four website templates are the only `-template` repositories in the org today, and none carries `.works/` | `GET /orgs/ever-works/repos?per_page=100` → 63 repos, four names ending in `template`; `GET /repos/ever-works/<name>/contents/.works` → 404 for all four                                                                                                                                                                                                                                            |
| None of the three app template repositories exists yet, and neither does the listing repo                     | `GET /repos/ever-works/{templates,apps,cal-diy-template,umami-template,app-fixture-hello,app-fixture-hello-template}` → 404 on 2026-09-17                                                                                                                                                                                                                                                           |
| The upstream licences used by the seed rows                                                                   | `calcom/cal.diy` → MIT; `umami-software/umami` → MIT; the four website templates → AGPL-3.0 (GitHub's licence API, which the registry maps to `AGPL-3.0-only` through an alias)                                                                                                                                                                                                                     |
| The `ever-works/ever-works-website-template` → `ever-works/directory-web-template` rename                     | Both names return repo **id 912916449** (see `open-questions.md` OQ-09)                                                                                                                                                                                                                                                                                                                             |
| The manifest validates under its own schema, including 13 negative/positive cases                             | `ajv@8.18.0` draft-2020 build: baseline valid; app row without `shape` invalid; website row with `shape` invalid; production app row without a 40-hex sha invalid; `code-bearing` with a `repository` source invalid; unknown top-level key invalid; `template.repo` outside `ever-works` invalid; wrong suffix per kind invalid; duplicate `slug` **accepted by the schema** (so CI must check it) |

## What is deliberately not here

- **No repository was created, no branch, no commit.** The seed is a folder to copy.
- **No platform code.** The implementation tasks are cut in `plan-changes.md` §0 with owners.
- **No icons, no `evidence/`, no `scripts/validate.mjs`, no workflows.** They belong to the repository's own
  creation task (APW-03 T33, updated by `plan-changes.md` C-3.11); the file list and the seven cross-field
  checks CI must add are in the listing README §2.
- **No decision about the acceptance test estate.** `<e2e-upstream-org>` names stay placeholders
  (`ACCEPTANCE.md` §0.3).
