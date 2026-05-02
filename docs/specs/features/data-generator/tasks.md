# Task Breakdown: Data Generator

**Feature ID**: `data-generator`
**Plan**: `./plan.md`
**Status**: `Done` (Retrospective)
**Last updated**: 2026-05-02

---

## Phase 1 — DataRepository

- [x] **T1**. `DataRepository` class at
      `packages/agent/src/data-generator/data-repository.ts` with
      methods: `clone`, `pull`, `commit`, `push`, `createBranch`,
      `switchBranch`.
- [x] **T2**. `readConfig` / `writeConfig` for `config.yml` —
      preserve unknown fields on write (forward-compat).
- [x] **T3**. `readItems` / `writeItem` / `removeItem` for the
      `items/` work (one JSON file per slug).
- [x] **T4**. `readCategories` / `writeCategories` /
      `readTags` / `writeTags` / `readBrands` / `writeBrands` for
      the corresponding YAML files.
- [x] **T5**. Unit tests for round-trip read/write per file format.

## Phase 2 — Generation modes

- [x] **T6**. `mergeItems(existing, newItems)` utility preserving
      `featured` and `order` when slugs match; tests cover insert,
      update, no-op cases.
- [x] **T7**. CREATE_UPDATE mode: merge new items with existing,
      keep items not in this batch.
- [x] **T8**. RECREATE mode: clear `items/` work before
      writing new items; reset `categories.yml` / `tags.yml` /
      `brands.yml` to the pipeline output.
- [x] **T9**. Both modes increment `config.yml.version` and update
      `metadata.updated_at`.

## Phase 3 — Service orchestration

- [x] **T10**. `DataGeneratorService` at
      `packages/agent/src/data-generator/data-generator.service.ts`
      with the public method:

            ```ts
            initialize(work, user, dto, opts: { logCollector, signal }): Promise<DataGeneratorResult>
            ```

- [x] **T11**. `initialize` flow:
    1. Resolve git token via `GitFacadeService`.
    2. Clone or pull data repository (create if missing for `mode === 'create'`).
    3. Read existing `config.yml` + items + taxonomy.
    4. Call `ItemsGeneratorService.generateItems()` with full context.
    5. Apply mode-specific merge.
    6. Write all files back to working tree.
    7. Commit + push (or commit + PR per work setting).
    8. Build `DataGeneratorResult` with stats + optional PR info.
- [x] **T12**. `signal` (AbortSignal) propagated into the items pipeline
      and into git operations so cancellation aborts in-flight work.
- [x] **T13**. `logCollector` updates streamed at every major step
      transition (clone, pipeline started, items merged, commit,
      push) — visible in the recent-logs panel.

## Phase 4 — PR mode

- [x] **T14**. Branch creation: `ever-update-<unix-timestamp>` from
      the work's default branch.
- [x] **T15**. Commit changes on the new branch with a clear
      "Ever Works: Update work items" message.
- [x] **T16**. Open PR via `GitFacadeService.createPullRequest` with
      a body summarising new/updated counts.
- [x] **T17**. Capture PR `{ branch, title, body, number, url }`
      into the `DataGeneratorResult.prUpdate` field for the markdown
      generator to reference.

## Phase 5 — Error handling

- [x] **T18**. Clone retry with exponential backoff (3 attempts).
- [x] **T19**. Push retry with backoff; final failure surfaces as a
      structured error in the result.
- [x] **T20**. PR creation falls back to direct commit if the user's
      git provider rejects PR creation.
- [x] **T21**. `normalizeGeneratorError` translates raw exceptions
      into `WorkGenerationError` codes for consistent UI display.

## Phase 6 — Pipeline integration

- [x] **T22**. Hook into `TriggerGenerationOrchestrator.run` so the
      data generator runs first; markdown + website generators run
      conditionally (only when items changed or already exist).
- [x] **T23**. Surface `hasExistingItems` flag so downstream
      generators know whether to run incremental updates.

## Phase 7 — Tests

- [x] **T24**. Unit tests for `DataGeneratorService.initialize` with
      mocked `DataRepository` and mocked `ItemsGeneratorService`.
- [x] **T25**. Unit tests for both modes (CREATE_UPDATE, RECREATE)
      verifying merge semantics.
- [x] **T26**. e2e test that runs an end-to-end mock generation
      against a temp git repo on disk.
- [x] **T27**. Cancellation test: AbortSignal during clone /
      pipeline / push leaves the data repo in a recoverable state.

## Phase 8 — Docs

- [x] **T28**. User-facing doc explaining repository structure and
      modes (lives under `docs/features/`).
- [x] **T29**. Cross-link from
      [`markdown-generator`](../markdown-generator/spec.md) and
      [`website-generator`](../website-generator/spec.md) specs.
- [x] **T30**. Retrospective spec / plan / tasks (this set).

## Phase 9 — Quality gates

- [x] **T31**. `pnpm format && pnpm lint && pnpm test && pnpm build`
      green.
- [x] **T32**. `pnpm --filter ever-works-docs build` produces no
      broken-link warnings.

## Definition of Done

- [x] Both generation modes produce identical outputs for a fixed input set
- [x] PR mode + direct mode both shipped, configurable per work
- [x] User-edited fields (`featured`, `order`) preserved in CREATE_UPDATE
- [x] Cancellation propagates into clone, pipeline, and push without leaving the repo dirty
- [x] Constitution gates in `spec.md` §9 confirmed satisfied
