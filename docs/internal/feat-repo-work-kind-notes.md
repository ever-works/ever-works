# Repository Work kind — a code repository as a first-class Work (self-build slice D, EW-766)

Branch `feat/repo-work-kind`, based on `origin/develop`.

Adds `repo` — chip label **Repository** — to the Work kind vocabulary so a
plain code repository (`ever-works/ever-works`, `directory-web-template`, the
website repo, …) can be a Work that Tasks, Goals and fleet runs attach to.
The data repository of a Repository Work IS the code repository; nothing is
generated, provisioned or deployed for it — and, after the review pass,
nothing is ever deleted, rewritten or committed into it by the platform's
content pipelines either.

---

## What shipped

### Contracts (`@ever-works/contracts`)

- `USER_SELECTABLE_WORK_KINDS` gains `'repo'` (and therefore `WORK_KINDS`,
  `normalizeWorkKind`, `isUserSelectableWorkKind`).
- `WORK_KIND_CAPABILITIES.repo`: items off (`labelKey: 'items'`), taxonomy /
  comparisons / community PR / import-export / source validation off,
  `deploy: false`, `kb: true`, metrics `['agents', 'open-tasks', 'days-active']`
  (all pre-existing `WorkMetricId`s), `repos: { data: true, work: false, website: false }`.
- `isRepositoryWorkKind()` — a KIND test, deliberately not a capability test
  (the content pipelines are not capability-gated for any other kind).
- Tests: the "every user-selectable kind is deployable" invariant became
  "every user-selectable kind that provisions a website repository is
  deployable" plus two explicit pins — `repo` is the only selectable kind
  without a website repo, and no kind deploys without one. New `repo`
  describe block covers normalize / selectable / capabilities / metrics.

### Agent (`@ever-works/agent`)

- `CreateWorkDto.repositoryUrl?: string` (optional, ≤ 400 chars, trimmed).
  `kind` keeps its `@IsIn([...USER_SELECTABLE_WORK_KINDS, 'default'])`
  whitelist, so `repo` passes DTO validation on both `POST /api/works` and
  `POST /api/works/quick-create` — but quick-create builds its
  `CreateWorkDto` without `repositoryUrl` (`QuickCreateWorkDto` has none), so
  `createWork` rejects it with 400 before any row exists (see below).
- `works/repository-work-source.ts` — `parseRepositoryWorkSource(url)`: pure,
  dependency-free parser for **GitHub** `owner/repo` URLs (`.git`, trailing
  slash, `www.`, `http`, scheme-less accepted; credentials, query, fragment,
  deeper paths, ssh remotes and every other host — including `gitlab.com`
  and `bitbucket.org`, see follow-ups — rejected). Repository names may
  start with a dot (`.github`, `.dotfiles`); owners may not. Owner/repo case
  is preserved — `getDataRepo()` is used verbatim in clone URLs.
- `works/repository-work-guard.ts` — the ONE place the "never touch a
  Repository Work's repositories" rule lives: `isRepositoryWork`,
  `assertNotRepositoryWork(work, action)` (400), `hasRepositoryRole` /
  `assertRepositoryRole(work, role)` (400, derived from
  `WORK_KIND_CAPABILITIES.repos`). Every data-repository writer calls it
  instead of testing `work.kind` inline.
- `WorkLifecycleService.createWork`, `kind === 'repo'` branch — all of it
  **before any side effect**:
    - parses the URL; missing / unparseable → 400;
    - refuses (400) a URL hosted on a different provider than the DTO's
      `gitProvider` instead of silently overriding the choice;
    - verifies the caller can read the repository through their OWN
      connected account (`gitFacade.hasRepositoryAccess`, the same probe the
      import analyser runs); not found / not accessible / no connection → 400;
    - refuses (409) a repository another account already wraps — the git
      facade's on-disk checkout is keyed by `owner/repo`, so two tenants
      pointing at one third-party repo would share and clobber one working
      copy with two tokens; collaborators join the existing Work as members
      (`WorkRepository.findRepositoryWorksWrapping`);
    - skips website-template validation (`websiteTemplateId: null`), the Ever
      Works Deploy quota (`deployProvider: null`, same posture as
      `createCompanyWork`), the managed Ever Works Git repo provisioning
      (`storageProvider === 'ever-works-git'` is overridden by the URL's
      provider), and the post-create `dataGenerator.getItems` clone;
    - persists `owner`, `gitProvider` / `storageProvider` from the URL,
      `sourceRepository = { url, owner, repo, type: 'link_existing', relatedRepositories: { data: { owner, repo } } }`,
      `generateStatus = { status: 'generated', step: 'linked' }` and
      `syncIntervalMinutes = 0` (otherwise the EW-628 poller would hit the
      wrapped repo's API with the owner's token every five minutes, forever).
- `WorkLifecycleService.deleteWork` (**the P1**): for a Repository Work the
  delete never reaches the git provider — the `data` role IS the wrapped
  repo, and the `work` / `website` fallbacks (`<slug>`, `<slug>-website`)
  resolve to live names under the third-party owner (with the default slug,
  `<slug>` is the wrapped repo again). An explicit
  `delete_data_repository: true` is refused with 400; the `work` / `website`
  roles are skipped for every kind that never provisions them (so a Company
  Work no longer attempts `<slug>-website` either); the local-checkout
  cleanup is skipped for the kind because that checkout, if it exists, is
  another Work's.
- Refusals (400 via the shared guard) on every other data-repository writer
  reachable for the kind: `WorkGenerationService.generateItems` /
  `updateItemsGenerator` / `regenerateMarkdown` / `updateReadme` /
  `submitItem` / `removeItem` / `updateItemMetadata` / `extractItemDetails`
  (when scoped to a Work) / `bulkCaptureImages` / `updateDomainType` /
  `updateWebsiteRepository`; `WorkLifecycleService.syncFromDataRepository`
  and `updateWork` (a `deployProvider` for the kind);
  `WorkScheduleService.updateSchedule` (the `PUT /works/:id/schedule` / MCP
  `update_schedule` upsert — enable and pause alike, since both commit
  `.works/works.yml` into the wrapped repo and a schedule would only tick
  into the generator's 400);
  `WebsiteUpdateService.updateRepository` (every caller funnels through it,
  incl. `DeployService` and the template auto-update poller);
  `CommunityPrProcessorService.processWork` (the schedule skips the kind
  quietly); `ItemHealthService.checkItem`;
  `ComparisonGenerationService.generateNextComparison` /
  `generateManualComparison`; `RepositoryManagementService.updateRepositoryVisibility`
  (any role). `RepositoryManagementService.getRepositoriesStatus` lists only
  the roles the kind provisions, and `WorkQueryService.workItems` answers
  `[]` without cloning.
- `.works/works.yml` schema: `repo` spec
  (`source.{repo,branch}`, `tasks.{base_branch,checks}`, `branding`) added to
  `KIND_SPEC_SCHEMAS`; `tasks.checks` is bounded (≤ 20 entries, ≤ 500 chars
  each) and documented as a trust boundary — anyone who can land a commit in
  the wrapped repo authors those strings; `works.v2.schema.json` regenerated.

### API (`apps/api`)

- `DeployService.deploy` refuses a Repository Work with 400 **before** the
  deploy facade resolves a provider (one `workRepository.findById`): a repo
  Work persists `deployProvider: null`, so the facade would otherwise throw
  `NoDeployProviderError` first and the kind-specific message would never be
  seen. Covers direct calls and `deployBatch`. Two spec cases (refusal with
  the facade mocked to throw the way production does; `awesome-repo` stays
  on the existing path).
- The controller needs no change: it delegates to the agent DTO and
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
  `WorkTemplatePicker.KIND_TO_CHIP_TYPE` deliberately has no `repo` entry
  (no website-template facet; documented inline).
- New `components/works/RepositoryWorkForm.tsx`: URL + derived name / slug /
  description, submits through the manual `createWork` server action with
  `kind: 'repo'` + `repositoryUrl`. Rendered by `new-work-client` whenever
  the effective kind is `repo` — in place of both `WorkAICreator` and
  `WorkImportForm`, whatever the creation mode. Its client-side URL pattern
  mirrors the API (GitHub only; dot-leading repo names allowed).
- The `createWork` server action requires a connected personal git provider
  for `kind: 'repo'` even under managed storage — the API verifies access
  with the caller's own account, so managed storage is no shortcut.
- Repository chip routing: `/new` and the Works composer send the composer
  text (a repo URL, typically) to `/works/new?mode=manual&kind=repo&prompt=…`
  instead of opening a chat turn — there is nothing for the chat AI to
  generate. `new-work-client` does the same in-page. One unit test per site.
- Work detail: the Generator tab (`WorkTabs`), the generator page and the
  schedule page are not offered for the kind (the API refuses every
  generator action and the schedule upsert); Settings hides the
  repository-visibility and community-PR cards; the delete dialog offers
  only the repository checkboxes the kind provisions (none for a Repository
  Work). Items and the provider-repository settings were already
  capability-gated; the Deploy tab is hidden because `configCache` is null
  for the kind. `WorkTabs`, `SettingsForm` and `DeleteComponent` each carry
  a unit spec pinning the gate for `repo` against `default`.
- i18n: `dashboard.newPage.chips.repo`, `newPage.chipDescriptions.repo`,
  `workCreation.kinds.repo`, `workCreation.kindDescriptions.repo`,
  `workKind.repo` and the `workCreation.repo.*` form block added to **all 21**
  locale files (localized, same posture as `campaign`); `urlHelp` names
  GitHub only. No literal dots in any leaf key.
- e2e: `flow-work-kind-template-activation-deep.spec.ts` keeps `repo` OUT of
  the verbatim round-trip loop (registration is verified against the
  caller's own GitHub connection, which API-registered e2e users lack) and
  pins the create contract with three dedicated `repo` tests: missing
  `repositoryUrl` → 400 naming the field; non-GitHub / unparseable URL →
  400; valid URL with no connected account → 400. The happy path is
  unit-covered with a mocked git facade.

### Docs

- `docs/features/creating-a-work.md`: **Repository** row in the creation
  methods table + a "Repository Works" section (GitHub only).
- `docs/agent-services/works-yml-schema.md`: `repo` in the kind list + spec
  example + the `tasks.checks` trust-boundary note.

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
   `data` role explicitly.
2. **"Make the create path reject nothing."** A `repo` Work without a
   repository is a contradiction, and the alternative — silently pointing
   the fleet at a `<slug>-data` repo nobody created — is the failure mode
   the codebase already documents as a bug. The branch therefore rejects a
   missing, unparseable, unreachable, provider-mismatched or already-wrapped
   `repositoryUrl` **for `kind: 'repo'` only**; every other kind is untouched
   and ignores the field. This is the one place the brief's fallback wording
   was not followed, deliberately.
3. **"The resolver must not pick a website template."** The agent-side
   `WebsiteTemplateResolverService.resolveForWork` always returns a
   template (its return type is non-nullable, and four services depend on
   that). Rather than change it, the create path never gives it a
   `websiteTemplateId` to resolve and the capability registry keeps the
   website generator away from `repo` Works; the web-side picker is gated.
4. **`repo` vs `awesome-repo`.** The existing kind already contains the
   word "repo"; the new one is the plain `repo` the brief asked for. Tests
   pin that the two never collide in `normalizeWorkKind`, capabilities, the
   guard, or the delete path.
5. **Program spec note.** `Workspace/knowledge/notes/2026-09-02-self-build-fleet-program.md`
   does not exist in the Workspace checkout on this machine; the slice was
   implemented from the brief alone.
6. **"Nothing is generated for it" was not the same as "nothing can write
   into it."** The first cut gated four `WorkGenerationService` entry points
   and left item submission, comparisons, source validation, community-PR
   intake, the website-template sync, repository-visibility flips and —
   worst — `deleteWork` open for the kind. The review pass closed all of
   them behind the one shared guard (`repository-work-guard.ts`) so a new
   pipeline cannot forget the check.

---

## Verification

Run from the worktree root unless noted. Counts are from the final run on
this branch.

| Check                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Result                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `cd packages/agent && npx jest src/works/__tests__ src/services/__tests__/work-lifecycle src/services/__tests__/work-generation.service.spec.ts src/services/__tests__/repository-management.service.spec.ts src/community-pr src/generators/website-generator/website-update.service.spec.ts src/services/__tests__/work-query.service.spec.ts src/services/__tests__/item-health.service.spec.ts`                                                                                                                                                                                                        | 15 suites, 495 tests passed |
| `cd packages/agent && npx jest src/works-config` (incl. the `works.v2.schema.json` drift guard)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 13 suites, 177 tests passed |
| `cd apps/api && npx jest deploy.service`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 2 suites, 78 tests passed   |
| `cd apps/web && npx vitest run src/components/works/RepositoryWorkForm.unit.spec.tsx src/components/new/NewPageClient.unit.spec.tsx src/components/works/WorksCreateComposer.unit.spec.tsx "src/app/[locale]/(dashboard)/works/new/new-work-client.unit.spec.tsx" src/app/actions/dashboard/works.unit.spec.ts src/components/works/shared/WorkKindBadge.unit.spec.tsx src/lib/ai/tools/tool-selection.unit.spec.ts src/lib/ai/tools/tool-selection.realistic.unit.spec.ts src/lib/ai/tools/generated/registry-parity.unit.spec.ts src/components/works/detail/overview/resolve-work-metrics.unit.spec.ts` | 10 files, 154 tests passed  |
| `cd packages/agent && npx tsc --noEmit -p tsconfig.json`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | clean (exit 0)              |
| `cd apps/api && npx tsc -p tsconfig.build.json --noEmit`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | clean (exit 0)              |
| `cd apps/web && npx tsc --noEmit`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | clean (exit 0)              |
| `npx prettier --check` on every changed file (locale JSON and docs included)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | clean                       |

Not run here: Playwright e2e (needs a live API + registered user). The
`repo` tests in `flow-work-kind-template-activation-deep.spec.ts` are all
refusal cases that need no external credentials.

---

## Follow-ups

- **A Repository Work's Overview** could show the repository coordinates
  and default branch prominently; today they are only visible through the
  generic repository info block.
- **`.works/works.yml` for a Repository Work** is written into the user's
  code repository by `WorksConfigWriter` like any other kind (on a
  `deployProvider` change, on a schedule upsert and on the generation
  paths — all of which the kind now refuses). That is the intended place
  for `spec.tasks.base_branch` / `checks`, but nothing reads those two keys
  yet — `TaskWorkspaceService` still takes the base branch from
  `work.taskIsolationBaseBranch` / the repo default. Whatever consumes
  `checks` must treat it as untrusted (see the schema comment).
- **GitLab / Bitbucket**: refused by the parser (and the web form) until a
  git-provider plugin for them exists; only `github` ships today. When one
  lands, add its `HOST_RULES` entry and resolve `owner` as every path
  segment but the last (GitLab nested groups).
- **One Repository Work per repository per account**: a second account is
  refused with 409 because the local checkout is keyed by `owner/repo`. A
  per-Work checkout key in `GitOperations` would lift that; until then,
  collaborators join the Work as members.
- **KB mirror** (`kb: true`) still commits `.content/kb/**` into the wrapped
  repository's default branch — by design for the kind, but worth a
  PR-based mode for protected branches.
- **PostHog gate**: the chip is fail-open like every other kind; create a
  `works-repo` flag (`active: false`) to hide it before launch if wanted.
