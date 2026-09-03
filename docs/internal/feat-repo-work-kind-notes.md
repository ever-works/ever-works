# Repository Work kind — a code repository as a first-class Work (self-build slice D, EW-766)

Branch `feat/repo-work-kind`, based on `origin/develop`.

Adds `repo` — chip label **Repository** — to the Work kind vocabulary so a
plain code repository (`ever-works/ever-works`, `directory-web-template`, the
website repo, …) can be a Work that Tasks, Goals and fleet runs attach to.
The data repository of a Repository Work IS the code repository; nothing is
generated, provisioned or deployed for it.

---

## What shipped

### Contracts (`@ever-works/contracts`)

- `USER_SELECTABLE_WORK_KINDS` gains `'repo'` (and therefore `WORK_KINDS`,
  `normalizeWorkKind`, `isUserSelectableWorkKind`).
- `WORK_KIND_CAPABILITIES.repo`: items off (`labelKey: 'items'`), taxonomy /
  comparisons / community PR / import-export / source validation off,
  `deploy: false`, `kb: true`, metrics `['agents', 'open-tasks', 'days-active']`
  (all pre-existing `WorkMetricId`s), `repos: { data: true, work: false, website: false }`.
- Tests: the "every user-selectable kind is deployable" invariant became
  "every user-selectable kind that provisions a website repository is
  deployable" plus two explicit pins — `repo` is the only selectable kind
  without a website repo, and no kind deploys without one. New `repo`
  describe block covers normalize / selectable / capabilities / metrics.

### Agent (`@ever-works/agent`)

- `CreateWorkDto.repositoryUrl?: string` (optional, ≤ 400 chars, trimmed).
  `kind` keeps its `@IsIn([...USER_SELECTABLE_WORK_KINDS, 'default'])`
  whitelist, so `repo` is accepted by both `POST /api/works` and
  `POST /api/works/quick-create` automatically.
- `works/repository-work-source.ts` — `parseRepositoryWorkSource(url)`: pure,
  dependency-free parser for GitHub / GitLab / Bitbucket `owner/repo` URLs
  (`.git`, trailing slash, `www.`, `http`, scheme-less accepted; credentials,
  query, fragment, deeper paths, ssh remotes and unknown hosts rejected).
  Owner/repo case is preserved — `getDataRepo()` is used verbatim in clone
  URLs.
- `WorkLifecycleService.createWork`, `kind === 'repo'` branch:
    - resolves the source **before any side effect**; missing / unparseable
      `repositoryUrl` → `400 BadRequestException`;
    - skips website-template validation (`websiteTemplateId: null`), the Ever
      Works Deploy quota (`deployProvider: null`, same posture as
      `createCompanyWork`), the managed Ever Works Git repo provisioning
      (`storageProvider === 'ever-works-git'` is overridden by the URL's
      provider), and the post-create `dataGenerator.getItems` clone;
    - persists `owner`, `gitProvider` / `storageProvider` from the URL,
      `sourceRepository = { url, owner, repo, type: 'link_existing', relatedRepositories: { data: { owner, repo } } }`,
      and `generateStatus = { status: 'generated', step: 'linked' }`.
      Everything else in `createWork` is untouched; no generation is queued
      (`POST /api/works` never queued one — only `quick-create` does).
- `.works/works.yml` schema: `repo` spec
  (`source.{repo,branch}`, `tasks.{base_branch,checks}`, `branding`) added to
  `KIND_SPEC_SCHEMAS`; `works.v2.schema.json` regenerated.

### API (`apps/api`)

No code change — the controller already delegates to the agent DTO and
`WorkLifecycleService`.

### Web (`apps/web`)

- Kind vocabulary everywhere it is enumerated: `work-kinds/catalog.ts`
  (`GitBranch` icon, teal tone), `NewPageClient` (chip, placeholder examples,
  intent label, canvas route, `CHIP_TO_WORK_KIND`), `/new` page
  `VALID_CHIP_TYPES`, `new-work-client` (`InitialWorkKind`, order, icon,
  placeholders, intent), `/works/new` page `VALID_WORK_KINDS`,
  `WorksCreateComposer`, `WorkAICreator` (type only + template-picker gate),
  `work.tools.ts` (`workKindSchema`, `createWorkManual.repositoryUrl`),
  server action `works.ts` (`aiWorkKindSchema`, `createWorkSchema.repositoryUrl`,
  prompt label), `lib/api/work.ts` / `works.ts` DTOs.
- New `components/works/RepositoryWorkForm.tsx`: URL + derived name / slug /
  description, submits through the manual `createWork` server action with
  `kind: 'repo'` + `repositoryUrl`. Rendered by `new-work-client` whenever
  the effective kind is `repo` — in place of both `WorkAICreator` and
  `WorkImportForm`, whatever the creation mode.
- Repository chip routing: `/new` and the Works composer send the composer
  text (a repo URL, typically) to `/works/new?mode=manual&kind=repo&prompt=…`
  instead of opening a chat turn — there is nothing for the chat AI to
  generate. `new-work-client` does the same in-page.
- Template picker: `WorkAICreator` renders `WorkTemplatePicker` only when
  `getWorkCapabilities(kind).repos.website` is true. The server-side
  `WebsiteTemplateResolverService` is unchanged — a Repository Work never
  reaches the website generator (`repos.website: false`, `websiteTemplateId`
  persisted as `null`); its fall-through to `classic` is documented in its
  spec, not relied on.
- i18n: `dashboard.newPage.chips.repo`, `newPage.chipDescriptions.repo`,
  `workCreation.kinds.repo`, `workCreation.kindDescriptions.repo`,
  `workKind.repo` and the `workCreation.repo.*` form block added to **all 21**
  locale files (localized, same posture as `campaign`). No literal dots in any
  leaf key.
- e2e: `flow-work-kind-template-activation-deep.spec.ts` loops over `repo`
  too, sending `repositoryUrl` for it (public `ever-works/ever-works`).

### Docs

- `docs/features/creating-a-work.md`: **Repository** row in the creation
  methods table + a "Repository Works" section.
- `docs/agent-services/works-yml-schema.md`: `repo` in the kind list + spec
  example.

---

## Where the brief and the code disagreed

1. **"Import or manual create can register an existing repo without the
   analyzer?"** Neither could as-is. `WorkImportService.initiateImport`
   always parses through `SourceRepoAnalyzerService`, and even its
   `link_existing` path persists only the top-level `owner`/`repo` — never
   the `data` role — so `Work.getDataRepo()` would have fallen back to the
   derived `<slug>-data` repo (the same field-by-field fallback EW-028 fixed
   for managed storage). The manual path had no repository input at all.
   The smallest additive change was a `repositoryUrl` field on
   `CreateWorkDto` plus a `repo`-only branch in `createWork` that writes the
   `data` role explicitly. ~110 lines of agent code, well under the ~300 budget.
2. **"Make the create path reject nothing."** A `repo` Work without a
   repository is a contradiction, and the alternative — silently pointing
   the fleet at a `<slug>-data` repo nobody created — is the failure mode
   the codebase already documents as a bug. The branch therefore rejects a
   missing or unparseable `repositoryUrl` with a 400 **for `kind: 'repo'`
   only**; every other kind is untouched and ignores the field. This is the
   one place the brief's fallback wording was not followed, deliberately.
3. **"The resolver must not pick a website template."** The agent-side
   `WebsiteTemplateResolverService.resolveForWork` always returns a
   template (its return type is non-nullable, and four services depend on
   that). Rather than change it, the create path never gives it a
   `websiteTemplateId` to resolve and the capability registry keeps the
   website generator away from `repo` Works; the web-side picker is gated.
4. **`repo` vs `awesome-repo`.** The existing kind already contains the
   word "repo"; the new one is the plain `repo` the brief asked for. Tests
   pin that the two never collide in `normalizeWorkKind` or capabilities.
5. **Program spec note.** `Workspace/knowledge/notes/2026-09-02-self-build-fleet-program.md`
   does not exist in the Workspace checkout on this machine; the slice was
   implemented from the brief alone.

---

## Verification

Run from the worktree root unless noted.

| Check                                                                                                                                                                                                                                                                 | Result                      |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `cd packages/contracts && npx vitest run src/domain`                                                                                                                                                                                                                  | 2 files, 46 tests passed    |
| `cd packages/agent && npx jest src/works/__tests__ src/services/__tests__/work-lifecycle.create-defaults.spec.ts src/entities/__tests__/work.provider-repository.spec.ts src/generators/website-generator/website-template-resolver.service.spec.ts src/works-config` | 17 suites, 261 tests passed |
| `cd apps/web && npx vitest run` (WorkKindBadge, NewPageClient, new-work-client, WorksCreateComposer, tool-selection unit specs)                                                                                                                                       | 5 files, 58 tests passed    |
| `cd packages/contracts && npx tsc --noEmit -p tsconfig.json`                                                                                                                                                                                                          | see PR body                 |
| `cd packages/agent && npx tsc --noEmit -p tsconfig.json`                                                                                                                                                                                                              | see PR body                 |
| `cd apps/api && npx tsc -p tsconfig.build.json --noEmit` (after `turbo build --filter=@ever-works/agent`)                                                                                                                                                             | see PR body                 |
| `cd apps/web && npx tsc --noEmit`                                                                                                                                                                                                                                     | see PR body                 |
| `works.v2.schema.json` drift guard (`emit-json-schema.spec.ts`)                                                                                                                                                                                                       | regenerated and green       |

Not run here: Playwright e2e (needs a live API + registered user). The
`repo` addition to `flow-work-kind-template-activation-deep.spec.ts` follows
the existing per-kind loop exactly and adds only the required
`repositoryUrl`.

---

## Follow-ups

- **`POST /api/works/quick-create` with `kind: 'repo'`** is accepted by the
  DTO whitelist (it spreads `USER_SELECTABLE_WORK_KINDS`) and then calls
  `generateItems` on the new Work. Nothing in the web app sends that; a
  guard (`400` for `repo` on quick-create, or simply skipping generation) is
  a one-line follow-up once product decides which.
- **Work detail surfaces** already hide Items / Deploy / provider-repo
  settings through `getWorkCapabilities`, but a Repository Work's Overview
  could show the repository coordinates and default branch prominently;
  today they are only visible through the generic repository info block.
- **`.works/works.yml` for a Repository Work** is written into the user's
  code repository by `WorksConfigWriter` like any other kind. That is the
  intended place for `spec.tasks.base_branch` / `checks`, but nothing reads
  those two keys yet — `TaskWorkspaceService` still takes the base branch
  from `work.taskIsolationBaseBranch` / the repo default.
- **GitLab / Bitbucket**: the parser maps them to `user-gitlab` /
  `user-git`, matching the storage vocabulary, but only the GitHub git
  provider plugin exists today, so fleet clones of those repos will fail at
  `gitFacade.getAccessToken` until those providers ship.
- **PostHog gate**: the chip is fail-open like every other kind; create a
  `works-repo` flag (`active: false`) to hide it before launch if wanted.
