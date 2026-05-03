# Task Breakdown: Website Generator

**Feature ID**: `website-generator`
**Plan**: `./plan.md`
**Status**: `Done` (Retrospective)
**Last updated**: 2026-05-02

---

## Phase 1 — Template configuration

- [x] **T1**. Define `WEBSITE_TEMPLATE_CONFIG` at
      `packages/agent/src/website-generator/config/website-template.config.ts`
      with `owner`, `repo`, and default `branch`.
- [x] **T2**. Allow per-work beta opt-in: `useBetaVersion: true`
      pulls from the template's `stage` branch instead of `main`.

## Phase 2 — Existence check

- [x] **T3**. `WebsiteGeneratorService` at
      `packages/agent/src/website-generator/website-generator.service.ts`.
- [x] **T4**. Resolve target repo name as `{work-slug}-web`.
- [x] **T5**. Check if the target repo exists via
      `GitFacadeService.repositoryExists(owner, name)`. If yes,
      log "skipped — already exists" and return success.

## Phase 3 — DUPLICATE method

- [x] **T6**. Clone the template repository to a temp working
      work.
- [x] **T7**. Create the empty target repository via
      `GitFacadeService.createRepository(name, { description, private: false })`.
- [x] **T8**. Switch the local clone's remote to the new target repo URL.
- [x] **T9**. Force-push the cloned content to the target repo.
- [x] **T10**. Cleanup: remove the temp working work.
- [x] **T11**. Unit tests cover: success, target-create failure,
      push failure (with cleanup verified).

## Phase 4 — CREATE_USING_TEMPLATE method

- [x] **T12**. Call
      `GitFacadeService.createRepositoryFromTemplate({ templateOwner, templateRepo, owner, name, description, private: false })`.
- [x] **T13**. On error (org policy / unsupported), fall back to
      DUPLICATE; log the fallback transition.
- [x] **T14**. Unit tests cover: template-feature succeeds,
      template-feature fails → DUPLICATE succeeds.

## Phase 5 — Service orchestration

- [x] **T15**. `initialize(work, user, creationMethod, opts)` flow:
    1. Resolve git token via `GitFacadeService`.
    2. Compute target repo name.
    3. Existence check → skip if exists.
    4. Run the chosen creation method (with fallback for
       `CREATE_USING_TEMPLATE`).
    5. Return `{ success, repositoryUrl }`.
- [x] **T16**. Cancellation: thread `AbortSignal` into clone /
      push / API calls; abort cleanly.
- [x] **T17**. Conditional invocation: orchestrator only calls
      `WebsiteGeneratorService.initialize` when
      `newItemsCount > 0 || hasExistingItems` (no point creating a
      website for an empty work).

## Phase 6 — Template auto-update

- [x] **T18**. `WebsiteUpdateService` at
      `packages/agent/src/website-generator/website-update.service.ts`.
- [x] **T19**. `BranchSyncService` performing per-file three-way
      merge against the template's latest commit.
- [x] **T20**. Conflict handling: surface as a PR on the user's
      website repo for review rather than auto-resolving.
- [x] **T21**. Update tracking fields (`lastChecked`, `lastUpdated`,
      `lastError`) on `Work.websiteAutoUpdate`.
- [x] **T22**. Auto-update flow runs inside the regular generation
      task **only when** `websiteAutoUpdate.enabled === true`.

## Phase 7 — API surface

- [x] **T23**. `UpdateWebsiteRepositoryDto` with `autoUpdate?` and
      `useBetaVersion?` fields.
- [x] **T24**. `PUT /api/works/:id/website-auto-update`
      controller method on `apps/api/src/works/works.controller.ts`.
- [x] **T25**. `POST /api/works/:id/website-update` to trigger
      an immediate template merge.
- [x] **T26**. e2e tests cover both endpoints with role gating.

## Phase 8 — Web UI

- [x] **T27**. Website tab on the work detail page showing:
    - repo URL with copy button
    - auto-update toggle
    - beta opt-in toggle
    - "Update from template now" button with loading state
- [x] **T28**. Surface `lastError` on the panel when present, with
      a retry action.

## Phase 9 — Tests

- [x] **T29**. Unit tests for the service with mocked
      `GitFacadeService` covering: existence skip, DUPLICATE,
      CREATE_USING_TEMPLATE, fallback, cancellation.
- [x] **T30**. Unit tests for `WebsiteUpdateService` /
      `BranchSyncService` covering the three-way merge.
- [x] **T31**. e2e test that runs against a temp git repo verifying
      the duplicate-and-push flow end to end.

## Phase 10 — Docs

- [x] **T32**. User-facing doc explaining the website repo, naming
      convention, and customization options under `docs/features/`.
- [x] **T33**. Cross-link from
      [`data-generator`](../data-generator/spec.md) and
      [`markdown-generator`](../markdown-generator/spec.md) specs,
      and from the deployment guide.
- [x] **T34**. Retrospective spec / plan / tasks (this set).

## Phase 11 — Quality gates

- [x] **T35**. `pnpm format && pnpm lint && pnpm test && pnpm build`
      green.
- [x] **T36**. `pnpm --filter ever-works-docs build` produces no
      broken-link warnings.

## Definition of Done

- [x] First-run creation works on personal accounts and orgs (with fallback)
- [x] Repeat runs skip creation, do not clobber the user's repo
- [x] Auto-update opt-in with beta toggle landed and exposed in the UI
- [x] Template merge surfaces conflicts as a PR for user review
- [x] Constitution gates in `spec.md` §9 confirmed satisfied
