# Task Breakdown: App Work kind & create from any repository URL

> Ordered tasks derived from [`plan.md`](./plan.md). Each is small enough to land in one PR and ships with
> tests per **Constitution VI**. This epic adds no migration (plan §3.1); slot `1792010000000` stays reserved.

**Epic ID**: `APW-01-app-work-kind`
**Spec**: [`./spec.md`](./spec.md) · **Plan**: [`./plan.md`](./plan.md)
**Status**: `Draft`
**Last updated**: 2026-09-17

---

## How to use

- Tasks are **sequential by default**. `(parallel)` means it may run alongside its predecessor.
- Every task names the exact files to create or modify. An implementer should never have to guess a path.
- Every task carries **Test** (the spec file and what it asserts, or the command that runs it) and **Done when**
  (an observable, checkable condition).
- "Done when" is stated explicitly for every task and is checkable without reading the diff.
- Add new tasks at the bottom of their phase rather than renumbering (T39–T40 were added by the program audit;
  T41–T43 by the 2026-09-17 ordering pass).
- Phase boundaries are ship boundaries: `develop` must be green and deployable at the end of each phase.
- A task marked **(own PR)** merges by itself, ahead of its phase, because another epic binds or compiles against
  what it creates; the PR description names the ordering. The program merge order lives in `TRACKER.md`.
- **Prerequisites (exact tasks — every one of them is merged before this epic's P1; the program merge order in
  `TRACKER.md` places them there).** The earlier line named only "APW-03 P1", but the symbols this epic compiles
  against are not all in APW-03 P1:
    - **APW-02** P0 (its T1–T8) and P1 (its T9–T34, T43, T44) — checkout keys and `waitForReady` (T2–T5),
      `findExistingFork` (T17), the `getRepository` extensions (T16), `WorkUpstreamState` and its repository
      (T12–T14), the readiness job and the `APP_FORK_READY_HANDLER` token (T23–T24), the dispatcher symbols and
      runtime bindings (T31), the setup-pull-request follow-through (T43), `createBranchFromSha` (T18) and the
      non-production readiness deadline (T44).
    - **APW-03 P1** — T1 (the contracts barrel) and T12 (`AppSpecService`).
    - **APW-03 P2 — the "Wave 1 catalog seam", which lands before this epic's P1**: T22 (`commitFiles?` and the
      facade wrapper), T24 (`AppsCatalogService`), T26 (the Blueprint resolver and `AppSourceCatalogAdapter`,
      which **binds this epic's T11 port**), T28 with T53 (the apply job and the `app.blueprint.matched`
      record) and T32 (`AppsCatalogBrowser`).
    - **APW-06 T1–T3 only** — `packages/contracts/src/apps/app-runtime.ts`, `supportsApps` /
      `isAppDeploymentPlugin` on `IDeploymentPlugin`, and `packages/agent/src/app-runtime/ports.ts` with
      `APPS_TIER_POLICY` and `DisabledAppsTierPolicy`. Types, symbols and closed defaults only; no runtime
      behaviour, so they carry no dependency on APW-01.
    - **APW-13 P0** — its T1–T5: the fake GitHub, its contract test, the harness runner and the
      `EVER_WORKS_E2E_FAKES` switch. T40 and the T30 ship gate need them.
      **T11 lands first, on its own**, immediately after APW-02 T15, because APW-03 T26 binds the port T11 creates.
      APW-03 P3's `AppLicenseService` (its T42) and APW-04's `AppProvisioningService` merge **after** this epic: both
      are injected `@Optional()`, and until they land the calls are skipped and their tests use a typed fake. Only
      those two bindings are optional — the symbols exist before this epic merges. Tasks below name the
      APW-02/03/04/06/10/13 symbols they consume; they never re-declare them.
- **Program audit resolutions** ([CONTRACTS §0](../CONTRACTS.md#0-program-audit-resolutions-binding-2026-09-17-against-develop-ee45946e5))
  applied here: R-1 (T2), R-2 (T6), R-3 (T12, T22), R-4 (T13, T15, T24), R-5 (T12, T13, T14), R-6 (T12, T13, T17),
  R-7 (T3), R-12 (T2, T22, T28), R-15 (T39), R-22 (no suite under `apps/api/test/`).
- No task in this file performs a real GitHub write. Live-provider scenarios run in APW-13's suite against a
  throwaway repository in a test organization.
- Test commands run from the monorepo root unless a task says otherwise: contracts
  `cd packages/contracts && npx vitest run <path>`; agent `cd packages/agent && npx jest <path>`; API
  `cd apps/api && npx jest <path>`; web unit `cd apps/web && npx vitest run <path>`; web e2e
  `cd apps/web && npx playwright test <path>`; MCP `cd apps/mcp && npx vitest run <path>`; tasks
  `cd packages/tasks && npx vitest run <path>`.

---

# Phase P1 — Create an App Work from any GitHub URL

_Delivers spec FR-1…FR-53 (incl. FR-29a, FR-40a, FR-46a) and ACC-01-01…ACC-01-20._

## P1.1 — Contracts

- [ ] **T1. The `app` kind.**
      **Modify** `packages/contracts/src/domain/work-kind.ts` — append `'app'` to
      `USER_SELECTABLE_WORK_KINDS` (after `'repo'`), document it in the JSDoc beside `repo`, and add
      `isAppWorkKind(value)` (kind test, loose input, never throws).
      **Modify** `packages/contracts/src/domain/index.ts` — export `isAppWorkKind` if the barrel re-exports by name.
      **Test**: extend `packages/contracts/src/domain/__tests__/domain.spec.ts` — `normalizeWorkKind('APP ')`
      is `app`; `isAppWorkKind` false for `repo`, `awesome-repo`, `application`, `null`.
      **Done when**: T1 and T3 land in **one PR** and `pnpm --filter @ever-works/contracts test` is green with both.
      T1 cannot be met on its own: appending `'app'` to `USER_SELECTABLE_WORK_KINDS` while `WORK_KIND_CAPABILITIES`
      (`Record<WorkKind, …>`) has no `app` entry turns `work-capabilities.spec.ts:105-127` red with a `TypeError`,
      the type-check red, and `work-kind-docs-parity.spec.ts` red until `docs/features/work-kinds.md` gains its
      **App** row — and both of those only arrive in T3. T2 and the remaining P1 tasks still follow T3.
      (_No task is renumbered and nothing is removed: T1 keeps its id, its content and its own test; only its
      completion condition now names the PR it must ship in._)

- [ ] **T2 (parallel with T1). App source contracts in the shared App Works folder (Resolution R-1).**
      **Create** `packages/contracts/src/apps/app-source.ts` with `APP_SOURCE_REPOSITORY_TYPES`,
      `AppSourceRepositoryType`, `AppUpstreamRef`, `APP_DEPLOY_TARGET_CHOICES` (`none`, `your-cluster`,
      `ever-works-apps` — R-12), `AppDeployTargetChoice`, `APP_REPOSITORY_MODES`, `AppRepositoryMode`,
      `APP_SOURCE_REASON_CODES` (24 codes), `AppSourceReasonCode`, `AppModeAvailability`, `AppTargetOwner`
      (incl. `existingForkChecked: boolean`), `AppDeployTargetAvailability` (`extends AppModeAvailability` with
      `providerId?: string`, set only when the target is available and is not `none` — FR-33/FR-34),
      `AppSourceInspectRequest`, `AppSourceInspectResponse` (incl. `deployTargets` and the P1
      `scanIncomplete: boolean`) and the Blueprint prompt shape (`{ name, description?, required }`, never a
      value — FR-55), plus the nine numeric constants
      exactly as in [plan §3.2](./plan.md).
      **Modify** `packages/contracts/src/apps/index.ts` — `export * from './app-source.js';` (**Create** it, and add
      `export * from './apps/index.js';` to `packages/contracts/src/index.ts`, if APW-03 T1 has not landed).
      **Modify** `packages/contracts/src/api/work/import-source.dto.ts` — `import type { AppSourceRepositoryType,
AppUpstreamRef } from '../../apps/app-source.js'`; widen `SourceRepository.type` to
      `ImportSourceType | AppSourceRepositoryType`; add `upstream?: AppUpstreamRef`, `blueprintId?: string` and
      `createdByThisWork?: boolean`. **Do not touch `IMPORT_SOURCE_TYPES`.**
      **Test**: **create** `packages/contracts/src/apps/__tests__/app-source.spec.ts` — pins the mode list, the 24
      reason codes, the three deploy target choices, every constant (`15`, `60_000`, `8_000`, `30`, `512_000`, `5`,
      `120_000`, `600_000`, `10_000`), that `scanIncomplete` is a required boolean, that `existingForkChecked` is a
      required boolean and that `AppDeployTargetAvailability.providerId` is optional, and that `IMPORT_SOURCE_TYPES`
      still has exactly four members.
      **Done when**: `import { AppSourceInspectResponse } from '@ever-works/contracts'` type-checks in `apps/api` and
      `apps/web` (`pnpm --filter ever-works-api type-check`, `pnpm --filter ever-works-web type-check`), and
      `git grep -n "app-source.dto" packages/contracts` returns nothing.
      **Note**: `APP_REPOSITORY_MODES`, `AppDeployTargetChoice` and the reason codes keep their existing members —
      this task adds fields and types, it renames and removes nothing.

- [ ] **T3. Capabilities for `app`, the two new flags, and the replaced invariants (Resolution R-7).**
      **Modify** `packages/contracts/src/domain/work-capabilities.ts` — add `readonly builds: boolean` and
      `readonly appEnvironment: boolean` to `WorkCapabilities`, set both `false` in `DIRECTORY_CAPABILITIES` and in
      every existing kind entry, and append the `app` entry from [plan §3.2](./plan.md) (both `true`) with a comment
      citing README D1 and R-7.
      **Modify** `packages/contracts/src/domain/__tests__/work-capabilities.spec.ts` — add an `app` describe
      block (deploy/kb/builds/appEnvironment on; items, taxonomy, comparisons, communityPr, importExport,
      sourceValidation off; repos data only; metrics `agents`, `open-tasks`, `deploy-status`, `days-active`). Replace
      the pin "keeps `repo` the only user-selectable kind without a website repository" with "only `repo` and `app`
      lack a website repository", and "never deploys a kind that has no website repository" with "a kind without a
      website repository deploys only when it is `app`". Leave every `repo` assertion as is.
      **Modify** `docs/features/work-kinds.md` — add the **App** row so `work-kind-docs-parity.spec.ts` passes.
      **Test**: `packages/contracts/src/domain/__tests__/work-capabilities.spec.ts` — the `app` block above, and for
      every `WorkKind` other than `app` both `builds` and `appEnvironment` are `false`;
      `packages/contracts/src/domain/__tests__/work-kind-docs-parity.spec.ts` passes with the new row.
      **Done when**: `pnpm --filter @ever-works/contracts test` is green, exactly one kind has `builds === true`, and
      the diff of the spec file removes no `repo` assertion.

- [ ] **T4 (parallel with T3). Source-sync signature.**
      **Modify** `packages/agent/src/import/source-sync-support.ts` — widen `supportsWorkSourceSync`'s
      parameter to `string | null | undefined`; the whitelist is unchanged.
      **Test**: extend `packages/agent/src/import/__tests__/source-sync-support.spec.ts` — `app_link`,
      `app_fork`, `app_private_copy` answer `false`.
      **Done when**: `cd packages/agent && npx tsc --noEmit -p tsconfig.json` is clean.

## P1.2 — Entity, DTO, settings (no migration)

- [ ] **T5. `CreateWorkDto` fields.**
      **Modify** `packages/agent/src/dto/create-work.dto.ts` — add `repositoryMode?` (`@IsOptional`,
      `@IsIn(APP_REPOSITORY_MODES)`) and `targetOwner?` (`@IsOptional`, `@IsString`, `@MaxLength(100)`,
      `@Matches(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/)`, trimmed) and `blueprintId?` (`@MaxLength(100)`,
      `@Matches(/^[a-z0-9][a-z0-9-]{0,99}$/)`) and `autoProvision?` (`@IsOptional`, `@IsBoolean` — kind `app`
      only, default `true`, `false` is the member's decline of FR-29a's automatic start); extend the `kind` and
      `repositoryUrl` `@ApiPropertyOptional` descriptions to cover `app`.
      **The two required fields are required on the DTO, not only in the service** (FR-12, T18's assertion):
      `repositoryMode` gains `@ValidateIf((o) => normalizeCreateWorkKind(o.kind) === 'app')` + `@IsDefined()`, and
      `targetOwner` gains the same `@ValidateIf((o) => normalizeCreateWorkKind(o.kind) === 'app')` predicate
      widened with `&& (o.repositoryMode === 'fork' || o.repositoryMode === 'private-copy')`, plus
      `@IsDefined()`, so the pipe answers
      `400 repositoryMode must be defined` before the controller runs. `normalizeCreateWorkKind` is the existing
      loose-kind normalizer; every other kind and every existing field keeps its current validation exactly.
      **Test**: **create** `packages/agent/src/dto/create-work.dto.app.spec.ts` — class-validator accepts
      `{ kind: 'app', repositoryMode: 'fork', targetOwner: 'my-org' }`, accepts
      `{ kind: 'app', repositoryMode: 'link' }` without an owner, and accepts `autoProvision: false`; rejects
      `repositoryMode: 'mirror'`, `targetOwner: '../x'`, a missing `repositoryMode` for `kind: 'app'`
      (`repositoryMode must be defined`), a missing `targetOwner` for `fork` and for `private-copy`, and a
      non-boolean `autoProvision`; every non-`app` kind still validates without either field (ACC-01-03); run
      `cd packages/agent && npx jest src/dto/create-work.dto.app.spec.ts`.
      **Done when**: the OpenAPI document generated by `apps/api` lists the four fields on `CreateWorkDto`.

- [ ] **T6 (parallel with T5). Activity types (Resolution R-2).**
      **Modify** `packages/agent/src/entities/activity-log.types.ts` — append `APP_SOURCE = 'app_source'` in an
      "App Works (APW-01)" block; rows store the dotted event (`app.source.linked` · `forked` · `copied` · `failed`) in
      `action`, per [plan §3.3](./plan.md). Append only; no migration.
      **Test**: extend `packages/agent/src/entities/__tests__/activity-log.types.spec.ts` — pins
      `['APP_SOURCE', 'app_source']`; every pre-existing pair unchanged.
      **Done when**: the spec is green and no existing enum member moved.

- [ ] **T7 (parallel with T5). Instance setting.**
      **Modify** `packages/agent/src/config/index.ts` — add `everWorks.apps.worksEnabled()` reading
      `EVER_WORKS_APP_WORKS_ENABLED === 'true'` (default `false`), beside the other `*_ENABLED` getters.
      **Modify** `apps/api/.env.example` — document the variable with `false`.
      **Test**: extend `packages/agent/src/config/config.spec.ts` — unset ⇒ `false`, `'true'` ⇒ `true`,
      `'1'` ⇒ `false`.
      **Done when**: the spec is green and `apps/api/.env.example` contains `EVER_WORKS_APP_WORKS_ENABLED=false`.

- [ ] **T7b. The web chip must fail CLOSED for `app` (R-6 says so; the shipped helper does the opposite).**
      **Modify** `apps/web/src/lib/feature-flags/work-kinds.ts` — today it is documented as **fail-open**
      ("DEFAULT IS ENABLED … a missing flag, or an `undefined` value → the chip is ENABLED"; only an explicit
      `false` disables it, `:13-20,75-76`), which would leave the **App** chip visible whenever the PostHog flag
      is missing — exactly the case R-6 must prevent. Add `app` to a fail-CLOSED set for this one kind: the chip
      renders only when the flag resolves strictly `true` **and** the API-side gate agrees.
      **Test**: extend the existing work-kinds spec — missing flag ⇒ App chip absent; `false` ⇒ absent;
      `true` ⇒ present; every other `works-<kind>` flag keeps its fail-open behaviour (pin that too, so the
      change is provably scoped to `app`).
      **Done when**: the spec is green and no other kind's flag semantics changed.
      (_Why this is a task in APW-01:_ CONTRACTS §7/R-6 require the fail-closed chip, but no epic owned the file
      that implements it.)

- [ ] **T8. Repository lookups.**
      **Modify** `packages/agent/src/database/repositories/work.repository.ts` — add
      `findAppWorksByDataRepository(userId, owner, repo)` (kind `app`, indexed `owner`, `data` role compared
      case-insensitively in memory, the same portable split as `findRepositoryWorksWrapping`) and
      `findWorksUsingRepository(owner, repo, { kinds: ['repo', 'app'] })` returning `{ id, userId, kind,
relation }` for the conflict checks. Do not change `findRepositoryWorksWrapping`.
      **Test**: **create** `packages/agent/src/database/repositories/__tests__/work.repository.app-lookups.spec.ts`
      — case-insensitive match, other kinds ignored, a row with a missing data owner never matches (ACC-01-09).
      **Done when**: the new spec and the existing `findRepositoryWorksWrapping` specs pass unchanged.

## P1.3 — Services

- [ ] **T9. App Work guard.**
      **Create** `packages/agent/src/works/app-work-guard.ts` — `APP_WORK_REFUSAL = 'is an App Work'`,
      `isAppWork(subject)`, `assertNotAppWork(subject, action)` throwing `BadRequestException` in the exact
      message shape of `assertNotRepositoryWork`.
      **Test**: **create** `packages/agent/src/works/__tests__/app-work-guard.spec.ts` — refuses `app`,
      passes `repo`, `default`, `directory`, unknown kinds (ACC-01-11).
      **Done when**: the spec is green and `packages/agent/src/works/repository-work-guard.ts` has no diff.

- [ ] **T10. Writer refusals.**
      **Modify**, adding one `assertNotAppWork` (or `isAppWork` skip) line beside each existing repo check,
      per [plan §4.4](./plan.md):
      `packages/agent/src/services/work-generation.service.ts` (`ensureNotRepositoryWork`),
      `packages/agent/src/services/work-schedule.service.ts` (`updateSchedule`),
      `packages/agent/src/comparison-generator/comparison-generation.service.ts` (both entry points),
      `packages/agent/src/services/item-health.service.ts` (`checkItem`),
      `packages/agent/src/community-pr/community-pr-processor.service.ts` (schedule skip + `processWork`),
      `packages/agent/src/services/repository-management.service.ts` (`updateRepositoryVisibility`),
      `packages/agent/src/services/work-query.service.ts` (`workItems` ⇒ `[]`),
      `packages/agent/src/services/work-lifecycle.service.ts` (`syncFromDataRepository`, post-create
      `getItems` skip),
      `packages/agent/src/works-config/services/works-config-repository-sync.service.ts` (`syncWork` no-op),
      `packages/agent/src/services/knowledge-base-git-mirror.service.ts` (skip commit/push for `app`).
      **Test**: add one `app` case beside the `repo` case in
      `packages/agent/src/services/__tests__/work-generation.service.spec.ts`,
      `packages/agent/src/services/__tests__/work-schedule.service.spec.ts`,
      `packages/agent/src/services/__tests__/item-health.service.spec.ts`,
      `packages/agent/src/community-pr/community-pr-processor.service.spec.ts`,
      `packages/agent/src/services/__tests__/repository-management.service.spec.ts`,
      `packages/agent/src/services/__tests__/work-query.service.spec.ts` (item listing `[]` with no clone call) and
      `packages/agent/src/services/__tests__/work-lifecycle.service.spec.ts` (`syncFromDataRepository` refused);
      **create** `packages/agent/src/comparison-generator/comparison-generation.service.app-work.spec.ts` (both
      entry points refuse), `packages/agent/src/works-config/__tests__/works-config-repository-sync.app.spec.ts`
      (no write, no push) and `packages/agent/src/services/__tests__/knowledge-base-git-mirror.app.spec.ts` (no
      commit, no push) — together ACC-01-11.
      **Done when**: every row of plan §4.4 has a green `app` assertion and every `repo` assertion is unchanged.

- [ ] **T11. Catalog port and module wiring. (Own PR, before APW-03 P2 — TRACKER merge order.)**
      **Create** `packages/agent/src/app-works/app-source-catalog.port.ts` — `AppSourceCatalogPort`
      (`matchBlueprint({ owner, repo, blueprintId? })`, `classifyLicense(spdx)`, plus the optional `matchSource`,
      `prompts` and `displayName` fields of [plan §7](./plan.md)) and
      `APP_SOURCE_CATALOG_PORT = Symbol('APP_SOURCE_CATALOG_PORT')` exactly as [plan §7](./plan.md).
      **Create** `packages/agent/src/app-works/app-prompted-values.port.ts` — `AppPromptedValuesPort`
      (`storePrompted(workId, values)`), `APP_PROMPTED_VALUES_PORT = Symbol('APP_PROMPTED_VALUES_PORT')` and its
      no-op default (plan §7).
      **Modify** `packages/agent/src/app-works/index.ts` (created by APW-02 T15) — export both ports.
      **Modify** `packages/agent/src/app-works/app-works.module.ts` (created by APW-02 T15) — import the
      modules exporting APW-03's `AppSpecService`, `AppBlueprintApplyService`, `AppLicenseService` and APW-04's
      `AppProvisioningService` when present (each consumer injects them `@Optional()`), and provide + export this
      epic's services as T12–T15 add them.
      **Modify** `packages/agent/src/services/work.module.ts` — import `AppWorksModule` so
      `WorkLifecycleService` can receive `AppWorkCreateService`; `AppWorkCreateService` must not inject any
      provider of `WorkModule` (slug checks go through `WorkRepository`), so no module cycle is introduced.
      **Test**: extend `packages/agent/src/services/work.module.spec.ts` — the module graph compiles with and without
      APW-03/04 providers registered.
      **Done when**: `@ever-works/agent/app-works` resolves from `apps/api` and `packages/tasks`, and the port file
      matches the shape APW-03 T26 binds without any change to this task's PR.

- [ ] **T12. `AppSourceInspectorService`.**
      **Create** `packages/agent/src/app-works/app-source-inspector.service.ts` — `inspect(url, user, opts)`
      implementing [plan §2.2](./plan.md): `config.everWorks.apps.worksEnabled()` first (refuses every client alike,
      R-6); parser; `GitFacadeService.getRepository` (APW-02 fields); 403 classification from APW-02's typed provider
      errors; owners via `getUser` + `getOrganizations` (first 30, A–Z) with the `forkTemplateForUser`
      case-insensitive match; `findExistingFork` per owner; `.gitattributes` `filter=lfs` probe through
      `getFileContent`; conflict lookups (T8) that expose another account's usage as a boolean only;
      `APP_SOURCE_CATALOG_PORT.matchBlueprint` with the optional `blueprintId` and `classifyLicense` (`@Optional()`,
      try/catch ⇒ `unavailable`/`unknown`) per the license preview rule of [plan §7](./plan.md), returning the
      match's `matchSource`, `displayName` and `prompts` (FR-55, FR-56); `deployTargets`
      (`none` always available; `your-cluster` when an installed deploy plugin reports `supportsApps`, else
      `cluster_target_unavailable`; `ever-works-apps` only when `AppsTierPolicy.isOpen()` — injected
      `@Optional()`, absent ⇒ `managed_hosting_unavailable`; R-5, R-12), **each available non-`none` target
      carrying the `providerId` the create request will persist**; default-mode rules FR-17/FR-18; a
      provider-call counter charged per actual call — the fixed checks first (repository read 1, default-branch
      read ≤ 1, caller read 1, organizations read 1, `.gitattributes` read 1 = ≤ 5), then `findExistingFork` in
      owner order (the caller first, then organizations A–Z, ≤ 30 in P1), starting a new owner only while **at
      least 3 calls remain** of the 15-call budget. Owners the budget did not reach keep their computed
      `available`, get `existingForkChecked: false` and **no** reason code, and the response sets
      `scanIncomplete: true` — never `rate_limited` or `unavailable` (FR-7, FR-9); a 60 s in-memory cache keyed by
      `userId + lower(owner/repo)` (bypassed when `opts.fresh`).
      **Modify** `packages/agent/src/app-works/index.ts` — export it.
      **Test**: **create** `packages/agent/src/app-works/__tests__/app-source-inspector.service.spec.ts` —
      setting off ⇒ `app_works_disabled` before any provider call; every reason code; the default-mode matrix; the
      call cap; cache hit/miss/fresh; own-fork paste (parent becomes upstream); existing renamed fork found per owner
      (ACC-01-04); organization owners listed from the member's connection only (ACC-01-03); private-copy
      availability (ACC-01-05); renamed repository (`movedFrom`); empty repository; archived; 512 000 KB boundary
      (512 000 allowed, 512 001 refused); another account's link ⇒ Link unavailable, Fork available (ACC-01-09);
      facade spies record zero write calls (ACC-01-06); `deployTargets` with the policy unbound, closed and open,
      and **never `available: true` without a `providerId` for a non-`none` target**; the Blueprint match carrying
      its `matchSource`, `displayName` and prompt descriptors, and a source-only preview carrying none
      (ACC-01-21, ACC-01-22); three scan cases — a **30-organization fixture with no forks** gives ≤ 15 recorded
      provider calls, the caller checked, every organization still `available: true`, the organizations the scan
      did not reach flagged `existingForkChecked: false` and the response `scanIncomplete: true`; a
      **2-organization fixture** gives `scanIncomplete: false`; and **no unreached owner carries a reason code**
      (ACC-01-26).
      **Done when**: no test path can produce a mode or deploy target `available: true` alongside a reason code, and
      no unscanned owner is reported as having no fork.

- [ ] **T13. `AppWorkCreateService`.**
      **Create** `packages/agent/src/app-works/app-work-create.service.ts` — `create(dto, user)` implementing
      the steps of [plan §4.2](./plan.md) (including step 6a), injecting `AppSourceInspectorService`,
      `DistributedTaskLockService`, `GitFacadeService`, `DeployFacadeService`, `WorkRepository`,
      `WorkUpstreamStateRepository` (APW-02), `APP_FORK_READINESS_DISPATCHER` (APW-02), `EventEmitter2`,
      `APP_SOURCE_CATALOG_PORT` (for the Blueprint resolution of step 6a and the `blueprint_mismatch` refusal),
      `APPS_TIER_POLICY` — the token imported from `packages/agent/src/app-runtime/ports.ts` (APW-06 T3, merged
      ahead of this epic) and injected `@Optional()`, an unbound token meaning closed (R-5) — and
      `APP_PROMPTED_VALUES_PORT` (`@Optional()`; unbound ⇒ the values are logged as dropped, never a refusal).
      Error bodies `{ status: 'error', code, message, details? }`. Persist `sourceRepository.blueprintId` and
      `sourceRepository.blueprintMatchSource` from step 6a (never from the request alone),
      `sourceRepository.createdByThisWork` = `true` only when this request issued the fork request or created the
      private-copy repository (R-4), and `sourceRepository.autoProvision = false` **only** when the request carried
      `autoProvision: false` (plan §4.2 step 10; absent means on, so no migration and no existing caller moves).
      The deploy target of step 4 is persisted as the resolved plugin id — the
      managed choice as the `apps-tier` plugin's id, **never** the literal `'ever-works'` — and its `providerId` is
      echoed in `appSource.deployTarget`.
      **Modify** `packages/agent/src/services/work-lifecycle.service.ts` — in `createWork`, branch to
      `AppWorkCreateService.create` when `isAppWorkKind(normalizedKind)`; append the service to the
      constructor **last** and `@Optional()` (the positional-spec arity rule the class documents); skip
      `resolveProviderDefaults` for the kind.
      **Modify** `packages/agent/src/app-works/app-works.module.ts` — provide + export `AppWorkCreateService`,
      `AppSourceInspectorService`.
      **Test**: **create** `packages/agent/src/app-works/__tests__/app-work-create.service.spec.ts` — a facade
      spy proves zero provider writes and zero repository writes before step 9 for every refusal, including each of
      the eight ACC-01-07 codes; setting off ⇒ `400 app_works_disabled` (R-6); lock not acquired ⇒
      `409 create_in_progress`; same slug within 600 000 ms ⇒ `alreadyExisted` (ACC-01-08); after ⇒
      `409 app_work_exists`; adopted fork issues no fork call and persists `createdByThisWork: false` (ACC-01-04);
      a fork request persists `createdByThisWork: true` (ACC-01-02); organization target uses the member's
      connection (ACC-01-03); copy name ladder stops at `-copy-5` and the shell is private (ACC-01-05); transaction
      failure after the fork leaves no row and a retry adopts the fork; the Work row and its `WorkUpstreamState`
      row are written through **one** `withTransaction` manager (both creates receive it; a throw rolls both back
      and leaves the fork); the state row's `dataOwner` / `dataRepo` / `dataDefaultBranch` / `upstreamStatus` /
      `actionsState` / `nextSyncAt` match plan §4.2 step 10's per-relation table — in particular
      `actionsState: 'not_applicable'` for `link` and a private copy whose `dataDefaultBranch` is the upstream's; `null` dispatch records
      `dispatch_unavailable`; `deployProvider: 'ever-works'` refused while `AppsTierPolicy` is unbound or closed
      (ACC-01-12); the managed choice persisted as the `apps-tier` plugin id and **never** as the literal
      `'ever-works'`; onboarding deploy default never applied; the Blueprint step-6a matrix — no id sent plus a
      catalog match ⇒ that id and `matchSource: 'manifest'` persisted, no id sent plus `none`, `unavailable` or an
      unbound port ⇒ no `blueprintId` and create still succeeds, id sent and equal to the match ⇒ the match's own
      source kept, id sent for an unlisted repository ⇒ `explicit`, unknown id ⇒ `400 blueprint_mismatch` with zero
      provider and zero repository writes (ACC-01-21); a renamed fork in an organization the scan did not reach is
      still adopted at create with no fork request (ACC-01-26); a request carrying `appEnv` succeeds with the port
      unbound and calls `storePrompted` once per name when it is bound, while no read response contains a value
      (ACC-01-22); `autoProvision: false` persists `sourceRepository.autoProvision === false` while an omitted or
      `true` field leaves the property **absent**, and `link` with no owner still succeeds (ACC-01-28); the
      readiness dispatch is called once with
      `{ workId, attempt: 1, reason: 'initial', providerId, credentialVersion }` — **no `relation` field**, per
      APW-02's dispatcher payload — and `providerId` / `credentialVersion` are the values captured before the
      transaction, not re-read after it.
      **Done when**: `createWork` for every non-`app` kind passes its existing specs unchanged.

- [ ] **T14. Update and delete semantics.**
      **Modify** `packages/agent/src/services/work-lifecycle.service.ts` —
      `updateWork`: freeze `owner` for `app` (same shape as `repo`), restrict `deployProvider` to `null` or an
      apps-capable plugin, map it exactly as T13's step 4 (`'ever-works'` accepted only as an input alias for the
      managed target and rewritten to the apps-tier plugin id; the literal is never persisted), refuse the managed
      target unless `AppsTierPolicy.isOpen()` (R-5);
      `deleteWork`: the App branch of [plan §4.3](./plan.md) — `=== true` only, link refused, upstream
      full-name guard, admin check through `getRepository(...).permissions.admin`, partial-failure message,
      per-Work checkout removal (`checkoutKey: 'work:<id>:data'`, APW-02). (The workload removal of R-15 is T39.)
      **Test**: **create** `packages/agent/src/services/__tests__/work-lifecycle.app-kind.spec.ts` — the full
      delete matrix (link + flag ⇒ 400; fork + omitted ⇒ kept; fork + `true` + admin ⇒ deleted; fork + `true`
      without admin ⇒ kept with message; Work Repository equal to upstream ⇒ never deleted; provider failure
      ⇒ row deleted, message names the repository) and the update rules (ACC-01-10).
      **Done when**: the new spec is green and `packages/agent/src/services/__tests__/work-lifecycle.delete.spec.ts`
      passes unchanged.

- [ ] **T15. `AppSourceInitializerService` (the ready handler, Resolution R-4).**
      **Create** `packages/agent/src/app-works/app-source-initializer.service.ts` implementing APW-02's
      `AppForkReadyHandler.onDataRepositoryReady({ workId })` per [plan §6](./plan.md): `AppSpecService.initialize`;
      **Blueprint path** (`sourceRepository.blueprintId` **and the default-branch file does not already record that
      same Blueprint with `spec.source`**) ⇒ `AppBlueprintApplyService.request(workId, blueprintId, { userId,
matchSource: sourceRepository.blueprintMatchSource ?? 'explicit', confirmForkMatch: false })`, no file write
      here, and outcome **`blueprint_requested`** — which means readiness **stays `preparing`** with
      `readinessReason: 'blueprint_applying'` (no `readyAt`, no `app.fork.ready`, no APW-04 `forkReady`, no
      `nextSyncAt`), APW-03's apply job reporting back through APW-02's `APP_SOURCE_APPLY_REPORTER`; when the file
      already records the Blueprint, fall through to the minimal path so the `setup_merged` re-invocation returns
      `unchanged` and runs its follow-ups exactly once. APW-03's `applyInProgress` refusal also returns
      `blueprint_requested`; any other apply refusal is `failed/blueprint_<code>`. **Minimal path** ⇒ never clones:
      `getLatestCommit` + `getFileContent('.works/works.yml')`, parse with the works-config loader,
      prototype-pollution strip, set `version`/`kind`/`spec.source`, content compare; when `createdByThisWork` (fork
      or private copy) ⇒ one `GitFacadeService.commitFiles` on the default branch (`nonFastForward` ⇒ re-read head,
      ≤ 3 retries); otherwise (link, pasted or adopted fork) ⇒ setup pull request from `ever-works/app-setup`,
      created with **`GitFacadeService.createBranchFromSha(owner, repo, 'ever-works/app-setup', head.sha)`** —
      **never `createBranch` with a sha**: the existing `createBranch` resolves `heads/<fromRef>` and so takes a
      branch name only, and a sha passed to it 404s (`git.facade.ts:692-697`,
      `github-api.service.ts:576-580`) — reusing an open pull request when there is one, reusing an existing branch
      with the branch's own head as `baseSha` when there is not, and returning `waiting_for_setup_pr` with URL and
      number; `GitOperationNotSupportedError` from either capability ⇒ `failed/provider_unsupported`; refusal on
      unparseable or other-kind files; follow-ups only when the source is on the default branch (`initialized` or
      `unchanged`): `AppLicenseService.request` and — when **`AppSpecService.hasValidAppSpec(workId, sha)`** is
      false, which a `source`-only file always is — `AppProvisioningService.start({ workId, trigger: 'auto-create'
})`; one Activity row per outcome via `ActivityLogService.log` with `{ blueprint: boolean, setupPullRequest:
boolean }`.
      **Modify** `packages/agent/src/app-works/app-works.module.ts` — provide **and export**
      `AppSourceInitializerService`.
      **Modify** `apps/api/src/app-works/app-works.module.ts` (created by APW-02 T27) — bind
      `APP_FORK_READY_HANDLER` with `useExisting: AppSourceInitializerService`. **The handler runs in the API
      process**: every dependency it needs (the database, `ActivityLogService`, APW-03's and APW-04's services, the
      dispatchers) lives in API-side injection, and it clones nothing.
      **Modify** `apps/api/src/trigger/trigger-internal.controller.ts` — add
      `@Optional() private readonly appSourceInitializerService?: AppSourceInitializerService` **appended last**
      (the controller's arity rule) and `AppSourceInitializerService: this.appSourceInitializerService` to
      `remoteMap`; `onDataRepositoryReady` is **not** added to `RETRY_SAFE_REMOTE_METHODS`.
      **Modify** `packages/tasks/src/trigger/worker/modules/trigger-worker.module.ts` — bind
      `APP_FORK_READY_HANDLER` to `createRemoteProxy(apiClient, 'AppSourceInitializerService')`. **Do not provide
      the class or import `AppWorksModule` in the worker**: it has no database module and no `ActivityLogService`.
      **Test**: **create** `packages/agent/src/app-works/__tests__/app-source-initializer.service.spec.ts` —
      Blueprint path requests apply and writes nothing, returns `blueprint_requested` and emits no readiness
      (ACC-01-19); a re-invocation on a file that already records the Blueprint returns `unchanged` with zero
      `request` calls and its follow-ups once, and an `applyInProgress` refusal still returns `blueprint_requested`;
      created fork ⇒ exactly one `commitFiles` on the default branch and zero `cloneOrPull` calls (ACC-01-02);
      link ⇒ zero default-branch writes, one `createBranchFromSha` call **whose 4th argument equals the mocked
      `getLatestCommit` sha** followed by `commitFiles` with that same `baseSha`, **zero `createBranch` calls**, one
      setup pull request, source relation `link`, Activity `app.source.linked` (ACC-01-01); missing
      `createBranchFromSha` ⇒ `failed/provider_unsupported` and no pull request; an existing branch is reused with
      the branch's own head as `baseSha`; adopted fork ⇒ setup pull request, never `commitFiles` on the default
      branch (ACC-01-04); retry reuses the open pull request (ACC-01-17); keys preserved; unchanged ⇒ no commit;
      unparseable ⇒ untouched + failed; other kind ⇒ untouched + failed; **provisioning**: created fork on the
      minimal path ⇒ `start` exactly once while `validationStatus` is still `missing`, post-merge re-invocation on
      a source-only file ⇒ `start` once, `unchanged` on a file that already holds a valid full spec ⇒ `start` not
      called, a full spec with errors ⇒ `start` called (ACC-01-19); `sourceRepository.autoProvision === false` ⇒
      `start` **not** called on the created-fork path or on the post-merge re-invocation, while the license request
      still runs and the Activity row is the same `app.source.*` row (ACC-01-28); Activity payloads contain no body
      text.
      **Done when**: running the handler twice on the same Work produces exactly one commit (created fork) or exactly
      one open setup pull request (link), the spec's facade spy records zero `cloneOrPull` calls, and
      `apps/api/src/trigger/trigger-internal.controller.spec.ts` lists `AppSourceInitializerService` in `remoteMap`
      with `onDataRepositoryReady` in its method allow-list.

- [ ] **T16. Deploy refusal until the App runtime.**
      **Create** `packages/agent/src/app-works/app-work-deploy-route.port.ts` — `AppDeployRoute`
      (`request(input: AppDeployRequest): Promise<AppDeployRequestOutcome>`), the two plain-JSON shapes, and
      `APP_WORK_DEPLOY_ROUTE = Symbol('APP_WORK_DEPLOY_ROUTE')` exactly as [plan §7](./plan.md). **This epic
      declares the token** — like `APP_WORK_DELETION_PORT` (T39) and `APP_PROMPTED_VALUES_PORT` (T11) — so this
      task names no symbol another epic owns.
      **Modify** `packages/agent/src/app-works/index.ts` — export the port.
      **Modify** `apps/api/src/plugins-capabilities/deploy/deploy.service.ts` — beside the `repo` refusal
      (~198), refuse `isAppWorkKind` with `409 { code: 'app_runtime_unavailable', message: 'Deploying App
Works arrives with the App runtime.' }` **before** `getPluginAndTokenAndSettings` whenever the token is
      unbound; inject `APP_WORK_DEPLOY_ROUTE` `@Optional()` and **appended last** (the class's arity rule). When
      the token is bound the refusal is replaced by a delegation to it, never by the website workflow dispatch.
      APW-06 T34 binds the token with `useExisting: AppDeployRequestService` in the same file and takes the App
      path over.
      **Test**: extend `apps/api/src/plugins-capabilities/deploy/deploy.service.spec.ts` — `app` refused before
      `getPluginAndTokenAndSettings` is called, with the facade mocked to throw as production does (ACC-01-12), and
      the same spec re-run with the token bound ⇒ the refusal is replaced by the App path and the route receives
      the request exactly once.
      **Done when**: no `app` Work can reach the website workflow dispatch (the spec's dispatch spy records zero calls)
      and the port's shapes match what APW-06 T34 consumes without a change to this task's PR.

## P1.4 — API

- [ ] **T17. Inspect endpoint.**
      **Create** `apps/api/src/works/dto/app-source-inspect.dto.ts` — `AppSourceInspectRequestDto`
      (`repositoryUrl` ≤ 400 trimmed, `gitProvider?`, `blueprintId?`) and `AppSourceInspectResponseDto` (Swagger
      mirror of the contract, incl. `deployTargets`).
      **Create** `apps/api/src/works/app-source.controller.ts` — `@Post('works/app-source/inspect')`,
      `@HttpCode(200)`, `@Throttle({ long: { limit: 30, ttl: 60_000 } })`, `@ApiOperation`; delegates to
      `AppSourceInspectorService` (which owns the setting check, R-6).
      **Modify** `apps/api/src/works/works.module.ts` — register the controller.
      **Test**: **create** `apps/api/src/works/app-source.controller.spec.ts` — throttle metadata; setting off ⇒
      400 `app_works_disabled` whatever `User-Agent` or client header the request carries (ACC-01-13); invalid URL ⇒
      400; provider refusals ⇒ 200 with reasons; a `POST works/app-source/inspect` is not routed to any `works/:id`
      handler.
      **Done when**: `cd apps/api && pnpm test` is green.

- [ ] **T18. Create endpoint coverage.**
      **Modify** `apps/api/src/works/works.controller.ts` — `@ApiResponse` entries for `409` and `503` on
      `POST works` (no behaviour change; the service branch is T13).
      **Test**: extend `apps/api/src/works/works.controller.crud.spec.ts` — `kind: 'app'` with mode/owner
      reaches the service; missing `repositoryMode` ⇒ 400 naming the field; quick-create with `kind: 'app'` ⇒
      400 before any row (quick-create carries no mode).
      **Done when**: the OpenAPI JSON shows the new response codes.

- [ ] **T19 (parallel with T18). MCP parity.**
      **Modify** `apps/mcp/src/openapi-tools/whitelist.ts` — add `inspect_app_source` with
      `annotations: { readOnlyHint: true }` in the Works block; update the block's count comment.
      **Test**: **create** `apps/mcp/test/whitelist-app-works.spec.ts` (sibling of
      `apps/mcp/test/whitelist-missions-ideas.spec.ts`) and extend `apps/mcp/test/tool-registration.spec.ts` — the
      tool registers and is read-only. The field assertion must not stop at that suite's own fixture: it builds
      hand-written `sampleOperations` and never loads the API's OpenAPI, so add the real check in
      `apps/api/src/works/works.controller.crud.spec.ts` (or a second MCP suite that reads the committed
      `apps/api` OpenAPI snapshot), asserting that the generated `create_work` input schema lists
      `repositoryMode`, `targetOwner`, `blueprintId` and `autoProvision` — with `appEnv` present and marked
      write-only — because that generated schema is the only thing the MCP tool actually exposes (ACC-01-14).
      **Done when**: `pnpm --filter ever-works-mcp test` is green and the four create fields are asserted against
      the generated OpenAPI document, not against a hand-written fixture.

## P1.5 — Web

- [ ] **T20. Flag semantics for `app`.**
      **Create** `apps/web/src/lib/work-kinds/flag-gated-kinds.ts` — `HIDDEN_WHEN_DISABLED_WORK_KINDS = ['app'] as const`
      and `isHiddenWhenDisabled(value)`, importable from client components (no `server-only`). It is the single
      list behind both the fail-closed flag set and the chip removal of T23.
      **Modify** `apps/web/src/lib/feature-flags/work-kinds.ts` — `FAIL_CLOSED_WORK_KINDS` = that list; for those
      values, missing key, missing flag, `undefined`, error and timeout all add the value to the disabled set, and
      pre-seed them so the partial set a timeout returns cannot re-enable the kind.
      **Modify** the same file (and the server-side caller that reads it) — when **no PostHog client is configured
      at all** (no `POSTHOG_API_KEY`), the fail-closed set is decided by the runtime instance setting read
      **server-side at request time** (`EVER_WORKS_APP_WORKS_ENABLED`, the API twin — never a build-time
      `NEXT_PUBLIC_*` variable), so chip and API always agree. This is what makes the chip visible in the PR e2e
      lane, in local development and on a self-hosted install without PostHog, and every other `works-<kind>` flag
      keeps its fail-open behaviour untouched (FR-47).
      **Test**: **create** `apps/web/src/lib/feature-flags/work-kinds.unit.spec.ts` — `app` disabled without
      PostHog **and** the runtime setting unset; **enabled** without PostHog and the runtime setting `true`;
      disabled with a PostHog client and a missing flag, an `undefined` value, an error or a timeout that returns a
      partial set; enabled only on an explicit `true` with a client; `blog` still fail-open in all of those cases
      (ACC-01-13, ACC-01-25); **create** `apps/web/src/lib/work-kinds/flag-gated-kinds.unit.spec.ts` — the list is
      exactly `['app']` and `isHiddenWhenDisabled` is false for every other kind.
      **Done when**: an instance with no PostHog key and the setting off shows no **App** chip, an instance with no
      PostHog key and the setting on shows it, and no other kind's flag semantics changed.

- [ ] **T21. Client plumbing.**
      **Modify** `apps/web/src/lib/api/work.ts` — `CreateWorkDto` + `repositoryMode?`, `targetOwner?`,
      `blueprintId?`; `workAPI.inspectAppSource(body)`.
      **Modify** `apps/web/src/app/actions/dashboard/works.ts` — `workKindSchema` + `'app'`;
      `aiWorkKindSchema` excludes `['repo', 'app']`; schema fields + `superRefine`; personal-connection gate for
      `app`; `inspectAppSourceAction`.
      **Create** `apps/web/src/lib/work-kinds/app-source-reasons.ts` — reason code ⇒ i18n key map.
      **Test**: extend `apps/web/src/app/actions/dashboard/works.unit.spec.ts` — `app` requires mode and owner;
      managed storage does not bypass the connection gate; AI path rejects `app`. **Create**
      `apps/web/src/lib/work-kinds/app-source-reasons.unit.spec.ts` — every one of the 24 codes maps to a key
      present in `en.json`.
      **Done when**: `pnpm --filter ever-works-web type-check` is clean.

- [ ] **T22. The create form.**
      **Create** `apps/web/src/components/works/app/AppWorkForm.tsx`,
      `apps/web/src/components/works/app/AppSourcePreviewCard.tsx`, `apps/web/src/components/works/app/AppModeCards.tsx`,
      `apps/web/src/components/works/app/AppTargetOwnerPicker.tsx` and
      `apps/web/src/components/works/app/AppDeployTargetPicker.tsx` and
      `apps/web/src/components/works/app/AppBlueprintPrompts.tsx` per [plan §5.2–5.3](./plan.md) and spec §6.1–6.3,
      including the **Paste a URL** / **Browse the Apps catalog** tabs that mount APW-03's `AppsCatalogBrowser` (a pick
      fills the URL, carries `blueprintId` and runs inspect once), the R-3 license chip copy, the deploy target
      picker defaulting to **None — don't deploy yet** (R-12) with availability from inspect's `deployTargets`,
      the **Let an agent work out how to run it** checkbox (spec §6.2 — rendered only when the preview carries no
      matched Blueprint and no `blueprintId` was picked, ticked by default, with its spend-help line, submitted as
      `autoProvision` and sent **only** when unticked), and
      `data-testid`s `app-work-url`, `app-work-check`, `app-work-mode-<mode>`, `app-work-owner`,
      `app-work-deploy-none`, `app-work-deploy-your-cluster`, `app-work-deploy-ever-works-apps`,
      `app-work-auto-provision`, `app-work-submit`.
      **Submit carries the Blueprint and the target, never a guess.** On the **Paste a URL** tab, when the current
      preview has `blueprint.status === 'matched'` the submit payload sends `blueprintId = preview.blueprint.id`;
      clearing the URL or the preview clears it. For a non-`none` deploy target the payload sends the target's
      **`providerId`** from `preview.deployTargets[choice]` — the picker never invents an id (FR-34).
      **`AppBlueprintPrompts`** renders the preview's prompt descriptors (name, description, `Required`) for a
      matched Blueprint, one input per prompt, never pre-filled from a stored value; its answers are collected into
      the write-only `appEnv` field of the submit payload, and while a `Required` prompt is empty the submit button
      is disabled with `Fill in the values the app needs first.` (FR-55).
      **Test**: **create** `apps/web/src/components/works/app/AppWorkForm.unit.spec.tsx`,
      `apps/web/src/components/works/app/AppModeCards.unit.spec.tsx`,
      `apps/web/src/components/works/app/AppBlueprintPrompts.unit.spec.tsx` and
      `apps/web/src/components/works/app/AppTargetOwnerPicker.unit.spec.tsx` — inspect only on click/Enter; URL change
      clears the preview; disabled cards announce reasons (every ACC-01-07 code); `↑`/`↓` skip disabled; owner switch
      re-derives without a request; private-copy trade-off copy shown before submit (ACC-01-05); submit label per mode;
      single-flight submit (ACC-01-08); **None** selected by default and Ever Works Apps disabled with its reason
      (ACC-01-12); a catalog pick fills the URL, keeps `blueprintId` and inspects exactly once (ACC-01-19);
      run a provider check proving that an owner the preview did not check (`existingForkChecked: false`) is still
      selectable and shows no existing-fork line (ACC-01-26); paste with a matched preview ⇒ the submit payload
      carries that `blueprintId`, no match ⇒ it omits it, URL change ⇒ it is cleared (ACC-01-21); prompts render with
      their required markers, a `Required` prompt left empty disables submit with its copy, and the submitted
      `appEnv` holds the typed values (ACC-01-22); a non-`none` target submits its `providerId` (ACC-01-27); the
      provisioning checkbox is **absent** for a matched Blueprint and **present and ticked** without one, unticking
      it submits `autoProvision: false`, ticking it back omits the field, and changing the mode, the owner or the
      deploy target never resets it (ACC-01-28).
      **Done when**: the form renders every spec §6.3 reason string from a fixture.

- [ ] **T23. Chips and routing.**
      **Modify** `apps/web/src/components/new/NewPageClient.tsx`,
      `apps/web/src/app/[locale]/(dashboard)/new/page.tsx`,
      `apps/web/src/app/[locale]/(dashboard)/works/new/page.tsx`,
      `apps/web/src/app/[locale]/(dashboard)/works/new/new-work-client.tsx`,
      `apps/web/src/components/works/WorksCreateComposer.tsx`,
      `apps/web/src/components/works/WorkAICreator.tsx` (type only),
      `apps/web/src/lib/work-kinds/catalog.ts` — the `app` chip, icon, placeholders, intent, canonical-URL
      routing to `/works/new?mode=manual&kind=app&prompt=…`, and `AppWorkForm` rendering, per
      [plan §5.2](./plan.md). A kind that `isHiddenWhenDisabled` matches **and** `disabledSet` contains (T20) is
      left **out of `allChips` / `workKindChips` / the composer's chip list** instead of being marked
      `comingSoon`, so a disabled App chip is _absent_ as FR-47/S24/ACC-01-13 require; every other disabled kind
      still renders its inert **SOON** chip, `ALL_NEW_CHIP_VALUES` / `ALL_WORK_KIND_CHIP_VALUES` keep `app` (they
      feed flag evaluation) and the existing `effectiveChip` / `effectiveKind` / `initialType` fallbacks stay, so
      `?type=app` and `?kind=app` degrade exactly as they do today.
      **Test**: extend `apps/web/src/components/new/NewPageClient.unit.spec.tsx`,
      `apps/web/src/app/[locale]/(dashboard)/works/new/new-work-client.unit.spec.tsx` and
      `apps/web/src/components/works/WorksCreateComposer.unit.spec.tsx` — one routing case each; a pasted URL with
      credentials routes with no `prompt`; with `app` disabled the **App** chip is absent from every one of those
      surfaces (no **SOON** chip, no rendered chip whose label is `App`) while `blog` and `store` still render
      theirs as **SOON** unchanged (ACC-01-13).
      **Done when**: the existing `repo` routing tests pass unchanged.

- [ ] **T24. App Work page.**
      **Create** `apps/web/src/components/works/app/AppSourceRelation.tsx` and
      `apps/web/src/components/works/app/AppSourceStatusCard.tsx` (consumes APW-02's `workAPI.getUpstream` and
      `retryUpstreamReadinessAction`; states preparing, timed out, failed, waiting for the setup pull request, setup
      pull request closed).
      **Modify** `apps/web/src/components/works/detail/WorkHeader.tsx`,
      `apps/web/src/app/[locale]/(dashboard)/works/[id]/page.tsx`,
      `apps/web/src/components/works/detail/WorkTabs.tsx`,
      `apps/web/src/app/[locale]/(dashboard)/works/[id]/generator/page.tsx`,
      `apps/web/src/app/[locale]/(dashboard)/works/[id]/generator/schedule/page.tsx`,
      `apps/web/src/components/works/detail/settings/SettingsForm.tsx`,
      `apps/web/src/components/works/detail/settings/SourceSettings.tsx`,
      `apps/web/src/components/works/detail/settings/DeleteComponent.tsx`,
      `apps/web/src/components/activity-log/ActivityTypeBadge.tsx`.
      Hiding the Generator tab is not enough on its own: both generator routes guard with
      `isRepositoryWorkKind(work.kind)` today (`generator/page.tsx:44`, `generator/schedule/page.tsx:92`), so an
      App Work opening `/works/:id/generator` directly would still render the generator surface (spec S10). Each
      page gains `isAppWorkKind(work.kind)` **beside** the existing `repo` guard — the same refusal, the same
      redirect/not-found shape the `repo` branch already uses, and the existing `repo` guard untouched.
      **Test**: **create** `apps/web/src/components/works/app/AppSourceStatusCard.unit.spec.tsx` (5 s poll while
      preparing, stops at 240 polls; 30 s poll while waiting for the setup pull request, stops at 120 polls; teardown
      on unmount and on terminal states; relation header and ready transition — ACC-01-02; waiting copy with **Open
      pull request** and the closed-without-merge copy with **Try again** — ACC-01-17); extend
      `apps/web/src/components/works/detail/WorkTabs.unit.spec.tsx` (generator hidden for `app`) and
      `apps/web/src/components/works/detail/settings/DeleteComponent.unit.spec.tsx` (link note; fork checkbox needs
      typed name; payload flag only then — ACC-01-10); **create**
      `apps/web/src/app/[locale]/(dashboard)/works/[id]/generator/page.unit.spec.tsx` and
      `apps/web/src/app/[locale]/(dashboard)/works/[id]/generator/schedule/page.unit.spec.tsx` — an App Work
      renders neither generator page (the `app` case) while a `repo` Work still renders both exactly as today (the
      unchanged case, ACC-01-11); **create**
      `apps/web/src/components/activity-log/ActivityTypeBadge.unit.spec.tsx` (the `app_source` label).
      **Done when**: an App Work page shows the relation line and no Items/Generator/Comparisons surface, and both
      generator routes refuse an App Work even when opened by URL.

- [ ] **T25. Chat tool.**
      **Modify** `apps/web/src/lib/ai/tools/work.tools.ts` — `workKindEnum` + `'app'` with its description;
      `createWorkManual` gains `repositoryMode`, `targetOwner`, `confirmed`; returns `ConfirmationRequired`
      for `kind === 'app'` unless `confirmed === true`, naming the repository to be created or the repository a setup
      pull request will be opened on.
      **Test**: extend `apps/web/src/lib/ai/tools/tool-selection.unit.spec.ts` and **create**
      `apps/web/src/lib/ai/tools/work.tools.app.unit.spec.ts` — unconfirmed ⇒ no `createWork` call; confirmed ⇒ one
      call with mode/owner; the AI creator schema rejects `app` (ACC-01-14).
      **Done when**: `apps/web/src/lib/ai/tools/generated/registry-parity.unit.spec.ts` passes.

## P1.6 — Background

- [ ] **T26. Wire dispatch and handler.**
      **Modify** `packages/agent/src/app-works/app-work-create.service.ts` — inject
      `APP_FORK_READINESS_DISPATCHER` (APW-02) and call it after commit with **APW-02's payload**:
      `{ workId, attempt: 1, reason: 'initial', providerId, credentialVersion }`. `relation` is never sent — APW-02
      reads it from the `WorkUpstreamState` row — and `providerId` / `credentialVersion` are captured at the
      enqueue site (the `packages/agent/src/tasks/credential-version.service.ts` pattern) so APW-02 T32's
      "drained credentials skip" can drop a run whose connection rotated or was disconnected in between.
      **Modify** `packages/tasks/src/trigger/worker/modules/trigger-worker.module.ts` only if T15's binding is missing.
      **Test**: **create** `packages/tasks/src/trigger/worker/modules/__tests__/trigger-worker.app-works.spec.ts`
      (sibling of `trigger-workflow-run.module.spec.ts`) — `APP_FORK_READY_HANDLER` resolves to
      `AppSourceInitializerService`; extend `packages/agent/src/app-works/__tests__/app-work-create.service.spec.ts` —
      dispatch is called once, after the transaction commits, with the four payload fields and **no `relation`**,
      and a provider whose credential version moved between capture and dispatch is still dispatched with the
      captured value; run
      `cd packages/tasks && npx vitest run src/trigger/worker/modules/__tests__/trigger-worker.app-works.spec.ts`.
      **Done when**: both specs are green and a local dispatch against a fixture Work runs the handler once.

## P1.7 — i18n, tests, docs

- [ ] **T27. i18n keys.**
      **Modify** `apps/web/messages/en.json` — every key in [plan §8](./plan.md) with spec §6 copy verbatim,
      including the keys added by the program audit: `dashboard.workCreation.app.promptsTitle`,
      `promptsHint`, `promptRequired`, `promptsIncomplete`, the Blueprint setup-note variants
      (`linkSetupNoteBlueprint`, `existingForkSetupNoteBlueprint`), the Blueprint-delete note
      `deleteAppStoredDataTypeToConfirm`, the skipped-import note `dashboard.settings.import.appSkipped`, and the
      `preparingBlueprintTitle` / `preparingBlueprintBody` pair for `blueprint_applying`.
      **Modify** the 20 sibling locale files in `apps/web/messages/` (localised where a translator is available,
      English otherwise; `apps/web/scripts/sync-locale-parity.mjs` seeds missing leaves). No leaf key contains `.`.
      **Test**: **create** `apps/web/src/components/works/app/app-works-messages.unit.spec.ts` (pattern of
      `apps/web/src/components/tasks/tasks-kanban-messages.unit.spec.ts`) — loads all 21 files in
      `apps/web/messages/`, asserts every leaf under `dashboard.workCreation.app`, `dashboard.workDetail.appSource`,
      the `dashboard.workDetail.settings.deleteApp*` leaves, the four chip/kind `app` keys,
      `dashboard.settings.import.appSkipped` and
      `dashboard.activity.filters.types.appSource` exists in every file, and that no leaf key under those trees
      contains `.` (ACC-01-18). It also asserts the failure copy of spec §6.4: every leaf in
      `dashboard.workDetail.appSource.failedReason` exists, the `autoProvision` label and its help line exist, the
      Name/Slug/Description/slug-help/invalid-slug/Cancel/create-failed leaves exist, and rendering each of the
      readiness reason codes (`works_yml_unparseable`, `works_yml_other_kind`, `push_rejected`,
      `provider_unsupported`, `too_large_for_private_copy`, `uses_lfs`, `handler_failed:<code>`, an unknown code,
      `retry_limit_reached`) yields English copy and never the raw code; run
      `cd apps/web && npx vitest run src/components/works/app/app-works-messages.unit.spec.ts`.
      **Done when**: the spec is green over the 21 files.

- [ ] **T28. e2e.**
      **Create** `apps/web/e2e/flow-app-work-create-refusals.spec.ts` — `invalid_url` (400 names the field),
      `provider_not_connected`, quick-create refuses `app`, the **client half** of the instance-setting refusal
      (the **App** chip is absent and the create form is unreachable), and — **when the lane runs with
      `EVER_WORKS_APP_WORKS_ENABLED=false`** — the full `app_works_disabled` refusal for both inspect and create
      (ACC-01-06, ACC-01-07, ACC-01-13). The PR lane runs that setting **on** (ACCEPTANCE §0.2) and one API
      process serves the whole shard, so no Playwright spec can flip it per test; the **server half** of ACC-01-13
      is therefore proven where it is observable — the API Jest specs of T12, T13, T17 and T18
      (`apps/api/src/works/works.controller.crud.spec.ts` with the setting off ⇒ `400 app_works_disabled` whatever
      client header, and `app-source.controller.spec.ts` the same for inspect) and the unit specs of T20 — and the
      e2e case above runs in the setting-off shard named in ACCEPTANCE §0.1. Nothing is dropped and no spec
      toggles the setting.
      **Create** `apps/web/e2e/flow-app-work-create-form.spec.ts` — chip → form → mocked inspect route →
      preview copy, disabled Link with reason, deploy picker defaults to **None — don't deploy yet**, Ever Works Apps
      disabled (ACC-01-12). Prefer `getByTestId`.
      **Test**: `cd apps/web && npx playwright test e2e/flow-app-work-create-refusals.spec.ts e2e/flow-app-work-create-form.spec.ts`
      — ACC-01-06, ACC-01-07, ACC-01-12 in the PR lane, plus ACC-01-13's client half there and its server half in
      the setting-off shard and in the API Jest specs of T18.
      **Done when**: both pass and `apps/web/e2e/flow-work-kind-template-activation-deep.spec.ts`,
      `apps/web/e2e/flow-work-kind-variants.spec.ts` pass unchanged.

- [ ] **T29. Docs.**
      **Create** `docs/features/app-works.md` — what an App Work is, the three modes and their trade-offs,
      what gets written to your repository (one commit on a fork or copy Ever Works created, a setup pull request
      otherwise), deploy targets (**None**, Your cluster, Ever Works Apps), deleting safely (workloads removed,
      stored data kept unless chosen, fork kept unless chosen).
      **Modify** `docs/features/creating-a-work.md` — App row in the creation-methods table.
      **Modify** `apps/docs/sidebarsPlatform.ts` — list the new page.
      **Test**: `pnpm --filter ever-works-docs build`.
      **Done when**: the docs build has no broken-link warnings.

## P1.8 — Program audit additions (2026-09-17)

- [ ] **T39. Deleting an App Work removes its workloads and keeps stored data by default (Resolution R-15).**
      **Create** `packages/agent/src/app-works/app-work-deletion.port.ts` — `AppWorkDeletionRequest`,
      `AppWorkDeletionOutcome` (`status: 'pending' | 'done'`, `target`, `reason?`),
      `AppWorkDeletionPort.requestDeletion({ workId, userId, deleteStoredData })` and
      `APP_WORK_DELETION_PORT = Symbol('APP_WORK_DELETION_PORT')` exactly as [plan §7](./plan.md).
      **Modify** `packages/agent/src/app-works/index.ts` — export the port.
      **Modify** `packages/agent/src/items-generator/dto/delete-items-generator.dto.ts` — `DeleteWorkDto` gains
      `delete_stored_data?: boolean = false` (`@IsOptional`, `@IsBoolean`, `@ApiPropertyOptional` stating it applies
      to kind `app` only) **and** `confirm_slug?: string` (`@IsOptional`, `@IsString`, `@MaxLength(200)`), the
      server-side half of the typed confirmation (FR-40b).
      **Modify** `packages/agent/src/services/work-lifecycle.service.ts` — inject `APP_WORK_DELETION_PORT`
      `@Optional()` (appended last); in `deleteWork` for kind `app`, refuse the linked-repository request first,
      then — when `delete_stored_data === true` — require `confirm_slug === work.slug`, else
      `422 { code: 'confirmation_mismatch' }` **before the port is called or any repository step runs** (FR-40b);
      then
      call `requestDeletion` before any repository step with `deleteStoredData: delete_stored_data === true`; unbound or
      a throw ⇒ taken as `done` (a throw appends the target and reason code to `message`); `done` ⇒ the row is deleted
      in the request; `pending` ⇒ `200 { deleting: true, message }` and the row stays. **Add**
      `completeAppWorkDeletion(workId)` (public, called by APW-06's `AppRuntimeDeletionService`) — deletes the row and
      the local checkout, idempotent, never touches a repository. **Modify**
      `packages/agent/src/items-generator/dto/delete-items-generator.dto.ts` response — `DeleteWorkResponseDto` gains
      `deleting?: boolean`.
      **Modify** `apps/mcp/src/openapi-tools/whitelist.ts` — the `delete_work` entry gains
      `omitArgs: ['delete_stored_data', 'confirm_slug']`, so neither the stored-data flag nor its confirmation is
      advertised as a tool argument and no agent can destroy stored data through MCP (FR-40b).
      **Modify** `apps/web/src/lib/api/work.ts` — `DeleteWorkDto` gains `delete_stored_data?: boolean` and
      `confirm_slug?: string`.
      **Modify** `apps/web/src/components/works/detail/settings/DeleteComponent.tsx` — for `app`: the workloads note;
      **Also delete stored data** checkbox + typed App Work slug, shown when the deploy target is not `none`, sending
      `delete_stored_data: true` **and** `confirm_slug: <typed slug>` only when both are satisfied; kept independent
      of the fork checkbox. The target it reads is **APW-06's `GET /api/works/:id/app-target`**, and a `404`
      (APW-06 not merged, or no runtime row yet) is treated as `none`, which hides the checkbox (FR-34).
      **Test**: extend `packages/agent/src/services/__tests__/work-lifecycle.app-kind.spec.ts` — a linked-repository
      delete request is refused before the port is called; `delete_stored_data: true` without `confirm_slug`, and
      with a non-matching one, is refused with `422 confirmation_mismatch` **and the port is never called**; the
      matching pair proceeds; port called once, before any repository deletion call, with
      `deleteStoredData: false` when the flag is omitted and `true` only when it is `true`; the fork decision is identical
      with either value; `done` ⇒ row deleted; `pending` ⇒ row kept, response `deleting: true`, and a later
      `completeAppWorkDeletion(workId)` deletes it (a second call is a no-op); port unbound ⇒ deletion proceeds; port
      throws ⇒ row deleted and the message names the target; non-`app` kinds never call the port. Extend
      `apps/mcp/test/whitelist-app-works.spec.ts` — `delete_work` lists both names in `omitArgs` and the generated
      tool schema carries neither. Extend
      `apps/web/src/components/works/detail/settings/DeleteComponent.unit.spec.tsx` — stored-data checkbox hidden for
      target `none` **and when `GET app-target` answers 404**; payload carries `delete_stored_data: true` and the
      typed `confirm_slug` only after the typed App Work slug matches; ticking it never
      sets `delete_data_repository` (ACC-01-20, ACC-01-24).
      **Done when**: both specs are green and `packages/agent/src/services/__tests__/work-lifecycle.delete.spec.ts`
      passes unchanged.

- [ ] **T40. Preparing-card acceptance: timeout and lost access (ACC-01-15, ACC-01-16).**
      **Modify** `apps/web/src/components/works/app/AppSourceStatusCard.unit.spec.tsx` (created by T24) — `timed_out`
      renders "Your fork is taking longer than 15 minutes." with **Try again** and **Open on GitHub**; `failed` with
      `access_revoked` renders the lost-access copy with **Reconnect GitHub** and **Try again**; **Try again** calls
      `retryUpstreamReadinessAction` exactly once and never `createWork`; `retry_limit_reached` renders its copy.
      **Create** `apps/web/e2e/flow-app-work-preparing-card.spec.ts` — in the fake-GitHub shard (APW-13's
      `EVER_WORKS_E2E_FAKES=1` harness, with APW-02 T44's shortened non-production readiness deadline): a fork that never
      finishes shows the timed-out card; **Try again** sends one `POST /api/works/:id/upstream/readiness/retry` and the
      fake records exactly one fork request in total; the fake answering 401 for the member's token while preparing
      shows the lost-access card; after the token is restored, **Try again** reaches ready with still one fork request.
      **Test**: `cd apps/web && npx vitest run src/components/works/app/AppSourceStatusCard.unit.spec.tsx` and
      `cd apps/web && EVER_WORKS_E2E_FAKES=1 npx playwright test e2e/flow-app-work-preparing-card.spec.ts` — together they
      assert ACC-01-15 (lost access ⇒ Failed with Reconnect; Try again resumes on the existing fork with no second fork
      request) and ACC-01-16 (the 15-minute copy; Try again never requests a second fork).
      **Done when**: both pass in the fake-GitHub e2e shard; a run with `EVER_WORKS_E2E_FAKES` unset (where the spec
      self-skips, as every `flow-app-work-*` spec does) is not accepted as evidence.

- [ ] **T41. Account import and restore never create or convert an App Work (FR-54).**
      **Modify** `packages/agent/src/account-transfer/account-import.service.ts` — `normalizeImportedWorkKind`
      (lines 62-69) must return `undefined` for `'app'` instead of accepting it, and the overwrite branch
      (`updateData.kind = importedKind`, lines 732-738) must skip the assignment when either the imported kind or
      the existing Work's kind is `app`, so an import can neither create an App Work nor turn a Repository Work into
      one (nor an App Work back). The entry is reported as skipped with the kind it kept; no error is raised and no
      other entry's import changes.
      **Modify** `packages/agent/src/account-transfer/account-import.service.ts` — the import report gains the
      skip reason code `app_kind_not_importable` beside the existing per-entry outcomes.
      **Test**: extend `packages/agent/src/account-transfer/account-import.service.spec.ts` — an export whose entry
      claims kind `app` creates nothing and is listed as skipped; an overwrite whose exported kind is `app` leaves
      the existing Work's kind untouched; an overwrite of an existing App Work by a `repo` entry leaves it `app`;
      every other kind imports exactly as before (ACC-01-23).
      **Done when**: the spec is green, `WORK_KINDS` is unchanged, and a grep over the import path shows `'app'` is
      never assigned to `kind`.

- [ ] **T42. Blueprint parity across every client (FR-56).**
      **Modify** `apps/web/src/lib/ai/tools/work.tools.ts` — for `kind === 'app'` the confirmation calls the
      read-only `inspectAppSource` first and appends "with the {name} App Blueprint" when a Blueprint matched, so a
      Blueprint is never applied unseen; the tool passes neither a guessed nor a stale `blueprintId`.
      **Modify** `apps/mcp/src/openapi-tools/whitelist.ts` — the count comment beside the Works block, so the new
      read-only inspect tool and the `appEnv` field are accounted for.
      **Modify** `docs/features/app-works.md` (created by T29) — one paragraph: the Blueprint is chosen by the
      server from the resolution order, whichever client creates the App Work, and a client that names a different
      one is refused.
      **Test**: extend `apps/web/src/lib/ai/tools/work.tools.app.unit.spec.ts` — a matched Blueprint is named in
      the confirmation; the created call carries no `blueprintId` of its own; extend
      `apps/mcp/test/whitelist-app-works.spec.ts` — `create_work` exposes `appEnv` and no blueprint override; run
      the APW-01 T13 create spec against a fake catalog to assert the same Blueprint id is persisted for a web
      payload and a chat payload with no id (ACC-01-21).
      **Done when**: the three specs are green and the same resolution order is asserted for the web, chat and MCP
      paths.

- [ ] **T43. Prompted values, end to end (FR-55).**
      **Modify** `packages/agent/src/dto/create-work.dto.ts` — `appEnv?: Record<string, string>` (`@IsOptional`,
      `@IsObject`, each value `@IsString`, `@MaxLength(8192)`, `@ApiPropertyOptional` stating **write-only**), and
      mark it so the generated OpenAPI never lists it as a response property.
      **Modify** `packages/agent/src/app-works/app-work-create.service.ts` — after the transaction of T13 step 10
      commits, hand the values to `APP_PROMPTED_VALUES_PORT.storePrompted(workId, values)` `@Optional()`, once, and
      never log them; unbound ⇒ log the count only and continue.
      **Modify** `apps/api/src/works/dto/create-work.dto.ts` (or the Swagger decorators on the agent DTO) — no
      response DTO ever echoes `appEnv`.
      **Test**: extend `packages/agent/src/app-works/__tests__/app-work-create.service.spec.ts` — the port receives
      exactly the typed names once per create; unbound ⇒ the create still succeeds; a value is never written to the
      Activity row, the telemetry payload or the response; the schema rejects a non-string value and a value over
      8 192 characters (ACC-01-22).
      **Done when**: the spec is green and `git grep -n "appEnv" apps/api/src` shows no read path.

## P1.9 — Ship gate

- [ ] **T30. P1 ship gate.**
      **Modify** `docs/specs/features/app-works/APW-01-app-work-kind/tasks.md` — tick every P1 task; **Modify**
      `docs/specs/features/app-works/ACCEPTANCE.md` — record the ACC-01 ids covered by automated tests and those
      deferred to APW-13's live suite.
      **Test**: `pnpm format && pnpm lint && pnpm type-check && pnpm test && pnpm build` from the root, once with
      `EVER_WORKS_APP_WORKS_ENABLED=false` and once with `true`.
      **Done when**: `develop` is green with `EVER_WORKS_APP_WORKS_ENABLED=false` (production default) and
      with `true` (staging), and every ACC-01-01…ACC-01-20 id names a green test.

---

# Phase P2 — Polish

_Refines spec FR-9 (all organizations) and adds the P2 items in [plan §11](./plan.md)._

- [ ] **T31. Existing-fork scan across all organizations.**
      **Modify** `packages/agent/src/app-works/app-source-inspector.service.ts` — paginate owners up to 200,
      stop at the 15-call cap and mark unscanned owners `existingFork: undefined` with a
      `scanIncomplete: true` flag on the response.
      **Modify** `packages/contracts/src/apps/app-source.ts` — add optional `scanIncomplete?: boolean`.
      **Test**: extend `packages/agent/src/app-works/__tests__/app-source-inspector.service.spec.ts` — 150
      organizations, cap honoured, flag set; extend `packages/contracts/src/apps/__tests__/app-source.spec.ts` — the
      field is optional.
      **Done when**: an inspect over a 150-organization fixture makes at most 15 provider calls and returns
      `scanIncomplete: true`.

- [ ] **T32 (parallel with T31). `inspectAppSource` chat tool.**
      **Modify** `apps/web/src/lib/ai/tools/work.tools.ts` — read-only tool returning modes, reasons,
      default mode and owners (no URL echo beyond `fullName`).
      **Test**: extend `apps/web/src/lib/ai/tools/tool-selection.unit.spec.ts` (picks it for "can I fork
      github.com/…?") and `apps/web/src/lib/ai/tools/work.tools.app.unit.spec.ts` (no confirmation, no write call).
      **Done when**: both specs are green and `apps/web/src/lib/ai/tools/generated/registry-parity.unit.spec.ts` passes.

- [ ] **T33. Composer suggestion.**
      **Modify** `apps/web/src/components/new/NewPageClient.tsx` and
      `apps/web/src/components/works/WorksCreateComposer.tsx` — when the prompt reduces to a canonical GitHub
      URL and the **App** chip is enabled, show a one-line suggestion "Looks like a repository. Create an App
      Work from it?" with **Use App**.
      **Modify** `apps/web/messages/en.json` and the 20 sibling locale files — `dashboard.newPage.appSuggestion`,
      `dashboard.newPage.appSuggestionAction`.
      **Test**: extend `apps/web/src/components/new/NewPageClient.unit.spec.tsx` and
      `apps/web/src/components/works/WorksCreateComposer.unit.spec.tsx` — suggestion only for canonical URLs; never
      for URLs with credentials; extend `apps/web/src/components/works/app/app-works-messages.unit.spec.ts` with the
      two keys.
      **Done when**: the three specs are green.

- [ ] **T34. Remix deep link and Blueprint display name.**
      **Modify** `apps/web/src/components/works/app/AppWorkForm.tsx` — accept `prompt` as the URL seed and
      auto-run inspect once; **Modify** `apps/web/src/components/works/app/AppSourcePreviewCard.tsx` — show the
      Blueprint display name and notice from APW-03 when present.
      **Test**: extend `apps/web/src/components/works/app/AppWorkForm.unit.spec.tsx` — seeded URL inspects exactly
      once; **create** `apps/web/src/components/works/app/AppSourcePreviewCard.unit.spec.tsx` — display name and
      notice rendered when present, absent otherwise.
      **Done when**: both specs are green.

- [ ] **T35. P2 ship gate.**
      **Modify** `docs/specs/features/app-works/APW-01-app-work-kind/tasks.md` — tick P2.
      **Test**: `pnpm format && pnpm lint && pnpm type-check && pnpm test && pnpm build` from the root.
      **Done when**: `develop` is green with T31–T34 merged.

---

# Cross-phase closing tasks

- [x] **T36. Telemetry.**
      **Status (2026-09-25): done** (`781f9a2e5`). Landed: `packages/agent/src/app-works/app-works-telemetry.service.ts`
      (`APP_WORKS_TELEMETRY_SINK`, `APP_WORKS_TELEMETRY_EVENTS`, `AppWorksTelemetryService`, `appWorkCreateOutcomeOf`),
      provided and exported by `AppWorksModule`; emitters in the inspector, the create service, the ready handler and
      `WorkLifecycleService.deleteWork`; API binding `AppWorksTelemetryBindingModule` (`@Global`, `useExisting`
      `AnalyticsService`) imported by `ApiModule`. Specs: `__tests__/app-works.telemetry.spec.ts` (30 cases) and
      `apps/api/src/telemetry/app-works-telemetry-binding.module.spec.ts`. The Done-when grep is empty. The outcome
      union gained `failed` (plan §9.1).
      **Create** `packages/agent/src/app-works/app-works-telemetry.service.ts` — `AppWorksTelemetryService` with
      `track(event, props)` over an injected, `@Optional()`, env-configured sink
      (`APP_WORKS_TELEMETRY_SINK`, bound by the API to the existing PostHog client exactly as
      `ZeroFrictionFunnelService` binds `FunnelAnalyticsSink` — `packages/agent/src/services/zero-friction-funnel.service.ts:56`);
      unbound ⇒ the events are counted and dropped, never a refusal or a throw. **No epic emits through a package
      dependency**: `packages/agent`, `packages/plugin` and `packages/tasks` do not depend on a monitoring package,
      so the sink is a token this epic declares, not an import.
      **Modify** `packages/agent/src/app-works/app-source-inspector.service.ts`,
      `packages/agent/src/app-works/app-work-create.service.ts`,
      `packages/agent/src/app-works/app-source-initializer.service.ts` and
      `packages/agent/src/services/work-lifecycle.service.ts` (delete path) — emit the five events of
      [plan §9.1](./plan.md) through that service. **FR-53 is delivered by P1** (`tasks.md:64`), so this task lands
      **with P1.7's T27 i18n pass**, ahead of the P2 tasks, even though its number sits in this closing block.
      **Test**: **create** `packages/agent/src/app-works/__tests__/app-works.telemetry.spec.ts` — each event emitted
      once per outcome with a bound sink; nothing thrown and nothing logged but a count with the sink unbound; no
      payload contains a repository name, URL, owner, token or file content (FR-53).
      **Done when**: the spec is green and `git grep -n "@ever-works/monitoring" packages/agent/src/app-works` returns nothing.

- [ ] **T37. Tracker and contracts.**
      **Modify** `docs/specs/features/app-works/TRACKER.md` — APW-01 status and PR links.
      **Modify** `docs/specs/features/app-works/CONTRACTS.md` only if a name this epic created is missing — every
      name in the plan header must appear with APW-01 as owner.
      **Test**: `git grep -n "APW-01" docs/specs/features/app-works/CONTRACTS.md` lists `createdByThisWork`,
      `APP_WORK_DELETION_PORT`, `delete_stored_data`, `builds`/`appEnvironment` and every other name in the plan header.
      **Done when**: that listing is complete and TRACKER.md links every merged APW-01 PR.

- [ ] **T38. Update statuses.**
      **Modify** `docs/specs/features/app-works/APW-01-app-work-kind/spec.md`,
      `docs/specs/features/app-works/APW-01-app-work-kind/plan.md` and this file — `Implemented` / `Done`.
      **Test**: `npx prettier --check docs/specs/features/app-works/APW-01-app-work-kind/*.md`, and each gate in
      [plan §12](./plan.md) re-checked against the merged code.
      **Done when**: the three files carry the new status and prettier reports no changes needed.

---

## Definition of Done

- Every checkbox above is ticked.
- `pnpm format:check`, `pnpm lint`, `pnpm type-check`, `pnpm test` and `pnpm build` are green from the root.
- `packages/agent/src/works/repository-work-guard.ts` and the `repo` branch of `WorkLifecycleService.createWork`
  have no diff; every pre-existing `repo` test passes unchanged.
- With `EVER_WORKS_APP_WORKS_ENABLED=false`, no chip, chat call, MCP call or command-line call can inspect or create
  an App Work.
- Inspect produces no GitHub write in any test (asserted by facade spies); no code path in this epic clones a data
  repository to record its source, or pushes to a default branch it did not create.
- ACC-01-01 … ACC-01-27 are each covered by an automated test here or listed as a live scenario in
  [ACCEPTANCE.md](../ACCEPTANCE.md) for APW-13.
- Every task named in the Prerequisites is merged before this epic's P1, in the program merge order; no task here
  adds, renames or removes a symbol another epic owns.
- Every gate in [plan §12](./plan.md) is confirmed, and its carried-forward gaps are still recorded there.
