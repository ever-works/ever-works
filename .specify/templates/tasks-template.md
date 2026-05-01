# Task Breakdown: [FEATURE NAME]

> Ordered, granular tasks derived from `plan.md`. Each task is small enough
> to land in a single PR and ships with tests per Constitution Principle VI.

**Feature ID**: `[short-slug]`
**Plan**: `./plan.md`
**Status**: `Draft` | `Ready` | `In Progress` | `Done`
**Last updated**: YYYY-MM-DD

---

## How to use

- Tasks are sequential by default. Tasks marked `(parallel)` can run alongside
  their predecessor.
- Each task has explicit file paths so an implementer can pick it up cold.
- Use the checkbox to track progress as PRs land.
- Add new tasks at the bottom rather than renumbering.

## Phase 1 — Data model & contracts

- [ ] **T1**. Add `FeatureNameEntity` at `packages/agent/src/entities/feature-name.entity.ts`
    - Fields: …
    - Add to `packages/agent/src/entities/index.ts`
    - **Test**: `packages/agent/src/entities/__tests__/feature-name.entity.spec.ts`
- [ ] **T2**. Generate migration `pnpm typeorm migration:generate -d typeorm.config.ts -n AddFeatureName` from `apps/api/`
    - Verify the SQL is additive, forward-only, no `DROP COLUMN`.
- [ ] **T3** (parallel with T2). Add DTO `[FeatureName]Dto` at
      `packages/contracts/src/api/feature-name/feature-name.dto.ts`
    - Export from `packages/contracts/src/api/feature-name/index.ts`

## Phase 2 — Service layer

- [ ] **T4**. Add repository at
      `packages/agent/src/database/repositories/feature-name.repository.ts`
    - Methods: …
    - **Test**: `…repository.spec.ts`
- [ ] **T5**. Add service at `packages/agent/src/services/feature-name.service.ts`
    - Public methods: …
    - **Test**: `…service.spec.ts` with mocked repo
- [ ] **T6**. Wire into module at `packages/agent/src/services/directory.module.ts`

## Phase 3 — Plugin / facade (if applicable)

- [ ] **T7**. New capability interface at
      `packages/plugin/src/[capability]/index.ts`
- [ ] **T8**. Add facade method at
      `packages/agent/src/facades/[capability].facade.ts`
- [ ] **T9**. Implement in the canonical plugin package(s)

## Phase 4 — API surface

- [ ] **T10**. Add controller method at
      `apps/api/src/[module]/[module].controller.ts`
- [ ] **T11**. Add Swagger decorators (`@ApiOperation`, `@ApiResponse`)
- [ ] **T12**. Add e2e test at `apps/api/test/[module].e2e-spec.ts`

## Phase 5 — Web / CLI surface

- [ ] **T13**. New page at `apps/web/src/app/[locale]/[route]/page.tsx`
- [ ] **T14**. Server action at
      `apps/web/src/lib/actions/[feature].ts`
- [ ] **T15**. Playwright spec at `apps/web/e2e/[feature].spec.ts`
- [ ] **T16** (if CLI surface). Command at `apps/cli/src/commands/[feature].ts`

## Phase 6 — Background work (if applicable)

- [ ] **T17**. Trigger.dev task at
      `packages/tasks/src/tasks/trigger/[feature].task.ts`
- [ ] **T18**. Wire into `packages/tasks/src/tasks/trigger/index.ts`
- [ ] **T19**. Idempotency / concurrency safeguard
      (CAS update OR `DistributedTaskLockService.runExclusive`)

## Phase 7 — Docs & rollout

- [ ] **T20**. User-facing doc at `docs/features/[feature].md`; cross-link from
      `docs/features/index.md` and `apps/docs/sidebarsPlatform.ts`.
- [ ] **T21**. If a new plugin → add to canonical
      `docs/plugin-system/built-in-plugins.md` (Principle VIII)
- [ ] **T22**. Update spec status to `Implemented`; mark plan/tasks `Done`.
- [ ] **T23**. Run `pnpm format && pnpm lint && pnpm test && pnpm build` and
      confirm green.

## Definition of Done

- All checkboxes ticked.
- All tests in the new code passing locally and in CI.
- `pnpm format:check` and `pnpm lint` green.
- `pnpm --filter ever-works-docs build` produces no broken-link warnings.
- Constitution gates in `spec.md` §9 all confirmed satisfied.
