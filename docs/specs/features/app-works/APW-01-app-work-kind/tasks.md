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
- Add new tasks at the bottom of their phase rather than renumbering (T39–T40 were added by the program audit).
- Phase boundaries are ship boundaries: `develop` must be green and deployable at the end of each phase.
- **Prerequisites:** APW-02 P0 (its T1–T8) and APW-02 P1 (its T9–T34, T43, T44), and APW-03 P1 (resolver, App spec
  service, apply job, `commitFiles?`, `AppsCatalogBrowser`) are merged. Tasks below name the APW-02/03/04/06/10
  symbols they consume; they never re-declare them.
- **Program audit resolutions** ([CONTRACTS §0](../CONTRACTS.md#0-program-audit-resolutions-binding--2026-09-17-against-develop--ee45946e5))
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
      **Done when**: `pnpm --filter @ever-works/contracts test` is green.

- [ ] **T2 (parallel with T1). App source contracts in the shared App Works folder (Resolution R-1).**
      **Create** `packages/contracts/src/apps/app-source.ts` with `APP_SOURCE_REPOSITORY_TYPES`,
      `AppSourceRepositoryType`, `AppUpstreamRef`, `APP_DEPLOY_TARGET_CHOICES` (`none`, `your-cluster`,
      `ever-works-apps` — R-12), `AppDeployTargetChoice`, `APP_REPOSITORY_MODES`, `AppRepositoryMode`,
      `APP_SOURCE_REASON_CODES` (24 codes), `AppSourceReasonCode`, `AppModeAvailability`, `AppTargetOwner`,
      `AppSourceInspectRequest`, `AppSourceInspectResponse` (incl. `deployTargets`) and the nine numeric constants
      exactly as in [plan §3.2](./plan.md).
      **Modify** `packages/contracts/src/apps/index.ts` — `export * from './app-source.js';` (**Create** it, and add
      `export * from './apps/index.js';` to `packages/contracts/src/index.ts`, if APW-03 T1 has not landed).
      **Modify** `packages/contracts/src/api/work/import-source.dto.ts` — `import type { AppSourceRepositoryType,
AppUpstreamRef } from '../../apps/app-source.js'`; widen `SourceRepository.type` to
      `ImportSourceType | AppSourceRepositoryType`; add `upstream?: AppUpstreamRef`, `blueprintId?: string` and
      `createdByThisWork?: boolean`. **Do not touch `IMPORT_SOURCE_TYPES`.**
      **Test**: **create** `packages/contracts/src/apps/__tests__/app-source.spec.ts` — pins the mode list, the 24
      reason codes, the three deploy target choices, every constant (`15`, `60_000`, `8_000`, `30`, `512_000`, `5`,
      `120_000`, `600_000`, `10_000`), and that `IMPORT_SOURCE_TYPES` still has exactly four members.
      **Done when**: `import { AppSourceInspectResponse } from '@ever-works/contracts'` type-checks in `apps/api` and
      `apps/web` (`pnpm --filter ever-works-api type-check`, `pnpm --filter ever-works-web type-check`), and
      `git grep -n "app-source.dto" packages/contracts` returns nothing.

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
      `@Matches(/^[a-z0-9][a-z0-9-]{0,99}$/)`); extend the `kind` and `repositoryUrl`
      `@ApiPropertyOptional` descriptions to cover `app`.
      **Test**: **create** `packages/agent/src/dto/create-work.dto.app.spec.ts` — class-validator accepts
      `{ kind: 'app', repositoryMode: 'fork', targetOwner: 'my-org' }`, rejects `repositoryMode: 'mirror'` and
      `targetOwner: '../x'` (ACC-01-03); run `cd packages/agent && npx jest src/dto/create-work.dto.app.spec.ts`.
      **Done when**: the OpenAPI document generated by `apps/api` lists the three fields on `CreateWorkDto`.

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

- [ ] **T11. Catalog port and module wiring.**
      **Create** `packages/agent/src/app-works/app-source-catalog.port.ts` — `AppSourceCatalogPort`
      (`matchBlueprint({ owner, repo, blueprintId? })`, `classifyLicense(spdx)`) and
      `APP_SOURCE_CATALOG_PORT = Symbol('APP_SOURCE_CATALOG_PORT')` exactly as [plan §7](./plan.md).
      **Modify** `packages/agent/src/app-works/index.ts` (created by APW-02 T15) — export the port.
      **Modify** `packages/agent/src/app-works/app-works.module.ts` (created by APW-02 T15) — import the
      modules exporting APW-03's `AppSpecService`, `AppBlueprintApplyService`, `AppLicenseService` and APW-04's
      `AppProvisioningService` when present (each consumer injects them `@Optional()`), and provide + export this
      epic's services as T12–T15 add them.
      **Modify** `packages/agent/src/services/work.module.ts` — import `AppWorksModule` so
      `WorkLifecycleService` can receive `AppWorkCreateService`; `AppWorkCreateService` must not inject any
      provider of `WorkModule` (slug checks go through `WorkRepository`), so no module cycle is introduced.
      **Test**: extend `packages/agent/src/services/work.module.spec.ts` — the module graph compiles with and without
      APW-03/04 providers registered.
      **Done when**: `@ever-works/agent/app-works` resolves from `apps/api` and `packages/tasks`.

- [ ] **T12. `AppSourceInspectorService`.**
      **Create** `packages/agent/src/app-works/app-source-inspector.service.ts` — `inspect(url, user, opts)`
      implementing [plan §2.2](./plan.md): `config.everWorks.apps.worksEnabled()` first (refuses every client alike,
      R-6); parser; `GitFacadeService.getRepository` (APW-02 fields); 403 classification from APW-02's typed provider
      errors; owners via `getUser` + `getOrganizations` (first 30, A–Z) with the `forkTemplateForUser`
      case-insensitive match; `findExistingFork` per owner; `.gitattributes` `filter=lfs` probe through
      `getFileContent`; conflict lookups (T8) that expose another account's usage as a boolean only;
      `APP_SOURCE_CATALOG_PORT.matchBlueprint` with the optional `blueprintId` and `classifyLicense` (`@Optional()`,
      try/catch ⇒ `unavailable`/`unknown`) per the license preview rule of [plan §7](./plan.md); `deployTargets`
      (`none` always available; `your-cluster` when an installed deploy plugin reports `supportsApps`, else
      `cluster_target_unavailable`; `ever-works-apps` only when `AppsTierPolicy.isOpen()` — injected
      `@Optional()`, absent ⇒ `managed_hosting_unavailable`; R-5, R-12); default-mode rules FR-17/FR-18; a
      provider-call counter that stops at 15 and marks the rest `unavailable` without a `rate_limited` reason; a 60 s
      in-memory cache keyed by `userId + lower(owner/repo)` (bypassed when `opts.fresh`).
      **Modify** `packages/agent/src/app-works/index.ts` — export it.
      **Test**: **create** `packages/agent/src/app-works/__tests__/app-source-inspector.service.spec.ts` —
      setting off ⇒ `app_works_disabled` before any provider call; every reason code; the default-mode matrix; the
      call cap; cache hit/miss/fresh; own-fork paste (parent becomes upstream); existing renamed fork found per owner
      (ACC-01-04); organization owners listed from the member's connection only (ACC-01-03); private-copy
      availability (ACC-01-05); renamed repository (`movedFrom`); empty repository; archived; 512 000 KB boundary
      (512 000 allowed, 512 001 refused); another account's link ⇒ Link unavailable, Fork available (ACC-01-09);
      facade spies record zero write calls (ACC-01-06); `deployTargets` with the policy unbound, closed and open.
      **Done when**: no test path can produce a mode or deploy target `available: true` alongside a reason code.

- [ ] **T13. `AppWorkCreateService`.**
      **Create** `packages/agent/src/app-works/app-work-create.service.ts` — `create(dto, user)` implementing
      the twelve steps of [plan §4.2](./plan.md), injecting `AppSourceInspectorService`,
      `DistributedTaskLockService`, `GitFacadeService`, `DeployFacadeService`, `WorkRepository`,
      `WorkUpstreamStateRepository` (APW-02), `APP_FORK_READINESS_DISPATCHER` (APW-02), `EventEmitter2`,
      `APP_SOURCE_CATALOG_PORT` (`@Optional()`, for the `blueprint_mismatch` check) and `APPS_TIER_POLICY`
      (`@Optional()`, R-5). Error bodies `{ status: 'error', code, message, details? }`. Persist
      `sourceRepository.blueprintId` when sent, and `sourceRepository.createdByThisWork` = `true` only when this
      request issued the fork request or created the private-copy repository (R-4).
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
      failure after the fork leaves no row and a retry adopts the fork; `null` dispatch records
      `dispatch_unavailable`; `deployProvider: 'ever-works'` refused while `AppsTierPolicy` is unbound or closed
      (ACC-01-12); onboarding deploy default never applied.
      **Done when**: `createWork` for every non-`app` kind passes its existing specs unchanged.

- [ ] **T14. Update and delete semantics.**
      **Modify** `packages/agent/src/services/work-lifecycle.service.ts` —
      `updateWork`: freeze `owner` for `app` (same shape as `repo`), restrict `deployProvider` to `null` or an
      apps-capable plugin, refuse `'ever-works'` unless `AppsTierPolicy.isOpen()` (R-5);
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
      **Blueprint path** (`sourceRepository.blueprintId`) ⇒ `AppBlueprintApplyService.request` and no file write
      here; **minimal path** ⇒ never clones: `getLatestCommit` + `getFileContent('.works/works.yml')`, parse with the
      works-config loader, prototype-pollution strip, set `version`/`kind`/`spec.source`, content compare; when
      `createdByThisWork` (fork or private copy) ⇒ one `GitFacadeService.commitFiles` on the default branch
      (`nonFastForward` ⇒ re-read head, ≤ 3 retries); otherwise (link, pasted or adopted fork) ⇒ setup pull request
      from `ever-works/app-setup` (reusing an open one) and outcome `waiting_for_setup_pr` with URL and number;
      refusal on unparseable or other-kind files; follow-ups only when the source is on the default branch
      (`initialized` or `unchanged`): `AppLicenseService.request` and — when no valid App spec exists —
      `AppProvisioningService.start({ workId, trigger: 'auto-create' })`; one Activity row per outcome via
      `ActivityLogService.log` with `{ blueprint: boolean, setupPullRequest: boolean }`.
      **Modify** `apps/api/src/app-works/app-works.module.ts` (created by APW-02 T27) — bind
      `APP_FORK_READY_HANDLER` with `useExisting: AppSourceInitializerService`.
      **Modify** `packages/tasks/src/trigger/worker/modules/trigger-worker.module.ts` — provide the same
      binding in the worker.
      **Test**: **create** `packages/agent/src/app-works/__tests__/app-source-initializer.service.spec.ts` —
      Blueprint path requests apply and writes nothing (ACC-01-19); created fork ⇒ exactly one `commitFiles` on the
      default branch and zero `cloneOrPull` calls (ACC-01-02); link ⇒ zero default-branch writes, one setup pull
      request, source relation `link`, Activity `app.source.linked` (ACC-01-01); adopted fork ⇒ setup pull request,
      never `commitFiles` on the default branch (ACC-01-04); retry reuses the open pull request (ACC-01-17); keys
      preserved; unchanged ⇒ no commit; unparseable ⇒ untouched + failed; other kind ⇒ untouched + failed;
      provisioning started only when the source is on the default branch, without a valid spec, and at most once
      (ACC-01-19); Activity payloads contain no body text.
      **Done when**: running the handler twice on the same Work produces exactly one commit (created fork) or exactly
      one open setup pull request (link), and the spec's facade spy records zero `cloneOrPull` calls.

- [ ] **T16. Deploy refusal until the App runtime.**
      **Modify** `apps/api/src/plugins-capabilities/deploy/deploy.service.ts` — beside the `repo` refusal
      (~198), refuse `isAppWorkKind` with `409 { code: 'app_runtime_unavailable', message: 'Deploying App
Works arrives with the App runtime.' }` unless APW-06's app route is registered (an `@Optional()` token
      APW-06 declares; absent ⇒ refuse).
      **Test**: extend `apps/api/src/plugins-capabilities/deploy/deploy.service.spec.ts` — `app` refused before
      `getPluginAndTokenAndSettings` is called, with the facade mocked to throw as production does (ACC-01-12).
      **Done when**: no `app` Work can reach the website workflow dispatch (the spec's dispatch spy records zero calls).

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
      tool registers, is read-only, and `create_work` exposes `repositoryMode` and `targetOwner` (ACC-01-14).
      **Done when**: `pnpm --filter ever-works-mcp test` is green.

## P1.5 — Web

- [ ] **T20. Flag semantics for `app`.**
      **Modify** `apps/web/src/lib/feature-flags/work-kinds.ts` — `FAIL_CLOSED_WORK_KINDS = ['app']`; for those
      values, missing key, missing flag, `undefined`, error and timeout all add the value to the disabled set.
      **Test**: **create** `apps/web/src/lib/feature-flags/work-kinds.unit.spec.ts` — `app` disabled without
      PostHog, enabled only on explicit `true`; `blog` still fail-open (ACC-01-13).
      **Done when**: an instance with no PostHog key shows no **App** chip.

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
      `apps/web/src/components/works/app/AppDeployTargetPicker.tsx` per [plan §5.2–5.3](./plan.md) and spec §6.1–6.3,
      including the **Paste a URL** / **Browse the Apps catalog** tabs that mount APW-03's `AppsCatalogBrowser` (a pick
      fills the URL, carries `blueprintId` and runs inspect once), the R-3 license chip copy, and the deploy target
      picker defaulting to **None — don't deploy yet** (R-12) with availability from inspect's `deployTargets`, with
      `data-testid`s `app-work-url`, `app-work-check`, `app-work-mode-<mode>`, `app-work-owner`,
      `app-work-deploy-none`, `app-work-deploy-your-cluster`, `app-work-deploy-ever-works-apps`, `app-work-submit`.
      **Test**: **create** `apps/web/src/components/works/app/AppWorkForm.unit.spec.tsx`,
      `apps/web/src/components/works/app/AppModeCards.unit.spec.tsx` and
      `apps/web/src/components/works/app/AppTargetOwnerPicker.unit.spec.tsx` — inspect only on click/Enter; URL change
      clears the preview; disabled cards announce reasons (every ACC-01-07 code); `↑`/`↓` skip disabled; owner switch
      re-derives without a request; private-copy trade-off copy shown before submit (ACC-01-05); submit label per mode;
      single-flight submit (ACC-01-08); **None** selected by default and Ever Works Apps disabled with its reason
      (ACC-01-12); a catalog pick fills the URL, keeps `blueprintId` and inspects exactly once (ACC-01-19).
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
      [plan §5.2](./plan.md).
      **Test**: extend `apps/web/src/components/new/NewPageClient.unit.spec.tsx`,
      `apps/web/src/app/[locale]/(dashboard)/works/new/new-work-client.unit.spec.tsx` and
      `apps/web/src/components/works/WorksCreateComposer.unit.spec.tsx` — one routing case each; a pasted URL with
      credentials routes with no `prompt`.
      **Done when**: the existing `repo` routing tests pass unchanged.

- [ ] **T24. App Work page.**
      **Create** `apps/web/src/components/works/app/AppSourceRelation.tsx` and
      `apps/web/src/components/works/app/AppSourceStatusCard.tsx` (consumes APW-02's `workAPI.getUpstream` and
      `retryUpstreamReadinessAction`; states preparing, timed out, failed, waiting for the setup pull request, setup
      pull request closed).
      **Modify** `apps/web/src/components/works/detail/WorkHeader.tsx`,
      `apps/web/src/app/[locale]/(dashboard)/works/[id]/page.tsx`,
      `apps/web/src/components/works/detail/WorkTabs.tsx`,
      `apps/web/src/components/works/detail/settings/SettingsForm.tsx`,
      `apps/web/src/components/works/detail/settings/SourceSettings.tsx`,
      `apps/web/src/components/works/detail/settings/DeleteComponent.tsx`,
      `apps/web/src/components/activity-log/ActivityTypeBadge.tsx`.
      **Test**: **create** `apps/web/src/components/works/app/AppSourceStatusCard.unit.spec.tsx` (5 s poll while
      preparing, stops at 240 polls; 30 s poll while waiting for the setup pull request, stops at 120 polls; teardown
      on unmount and on terminal states; relation header and ready transition — ACC-01-02; waiting copy with **Open
      pull request** and the closed-without-merge copy with **Try again** — ACC-01-17); extend
      `apps/web/src/components/works/detail/WorkTabs.unit.spec.tsx` (generator hidden for `app`) and
      `apps/web/src/components/works/detail/settings/DeleteComponent.unit.spec.tsx` (link note; fork checkbox needs
      typed name; payload flag only then — ACC-01-10); **create**
      `apps/web/src/components/activity-log/ActivityTypeBadge.unit.spec.tsx` (the `app_source` label).
      **Done when**: an App Work page shows the relation line and no Items/Generator/Comparisons surface.

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
      `APP_FORK_READINESS_DISPATCHER` (APW-02) and call it after commit.
      **Modify** `packages/tasks/src/trigger/worker/modules/trigger-worker.module.ts` only if T15's binding is missing.
      **Test**: **create** `packages/tasks/src/trigger/worker/modules/__tests__/trigger-worker.app-works.spec.ts`
      (sibling of `trigger-workflow-run.module.spec.ts`) — `APP_FORK_READY_HANDLER` resolves to
      `AppSourceInitializerService`; extend `packages/agent/src/app-works/__tests__/app-work-create.service.spec.ts` —
      dispatch is called once, after the transaction commits; run
      `cd packages/tasks && npx vitest run src/trigger/worker/modules/__tests__/trigger-worker.app-works.spec.ts`.
      **Done when**: both specs are green and a local dispatch against a fixture Work runs the handler once.

## P1.7 — i18n, tests, docs

- [ ] **T27. i18n keys.**
      **Modify** `apps/web/messages/en.json` — every key in [plan §8](./plan.md) with spec §6 copy verbatim.
      **Modify** the 20 sibling locale files in `apps/web/messages/` (localised where a translator is available,
      English otherwise; `apps/web/scripts/sync-locale-parity.mjs` seeds missing leaves). No leaf key contains `.`.
      **Test**: **create** `apps/web/src/components/works/app/app-works-messages.unit.spec.ts` (pattern of
      `apps/web/src/components/tasks/tasks-kanban-messages.unit.spec.ts`) — loads all 21 files in
      `apps/web/messages/`, asserts every leaf under `dashboard.workCreation.app`, `dashboard.workDetail.appSource`,
      the `dashboard.workDetail.settings.deleteApp*` leaves, the four chip/kind `app` keys and
      `dashboard.activity.filters.types.appSource` exists in every file, and that no leaf key under those trees
      contains `.` (ACC-01-18); run `cd apps/web && npx vitest run src/components/works/app/app-works-messages.unit.spec.ts`.
      **Done when**: the spec is green over the 21 files.

- [ ] **T28. e2e.**
      **Create** `apps/web/e2e/flow-app-work-create-refusals.spec.ts` — `invalid_url` (400 names the field),
      `provider_not_connected`, flag-off refusal (`app_works_disabled`) for both inspect and create, quick-create
      refuses `app` (ACC-01-06, ACC-01-07, ACC-01-13).
      **Create** `apps/web/e2e/flow-app-work-create-form.spec.ts` — chip → form → mocked inspect route →
      preview copy, disabled Link with reason, deploy picker defaults to **None — don't deploy yet**, Ever Works Apps
      disabled (ACC-01-12). Prefer `getByTestId`.
      **Test**: `cd apps/web && npx playwright test e2e/flow-app-work-create-refusals.spec.ts e2e/flow-app-work-create-form.spec.ts`
      — ACC-01-06, ACC-01-07, ACC-01-12, ACC-01-13 in the PR lane.
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
      to kind `app` only).
      **Modify** `packages/agent/src/services/work-lifecycle.service.ts` — inject `APP_WORK_DELETION_PORT`
      `@Optional()` (appended last); in `deleteWork` for kind `app`, refuse the linked-repository request first, then
      call `requestDeletion` before any repository step with `deleteStoredData: delete_stored_data === true`; unbound or
      a throw ⇒ taken as `done` (a throw appends the target and reason code to `message`); `done` ⇒ the row is deleted
      in the request; `pending` ⇒ `200 { deleting: true, message }` and the row stays. **Add**
      `completeAppWorkDeletion(workId)` (public, called by APW-06's `AppRuntimeDeletionService`) — deletes the row and
      the local checkout, idempotent, never touches a repository. **Modify**
      `packages/agent/src/items-generator/dto/delete-items-generator.dto.ts` response — `DeleteWorkResponseDto` gains
      `deleting?: boolean`.
      **Modify** `apps/web/src/lib/api/work.ts` — `DeleteWorkDto` gains `delete_stored_data?: boolean`.
      **Modify** `apps/web/src/components/works/detail/settings/DeleteComponent.tsx` — for `app`: the workloads note;
      **Also delete stored data** checkbox + typed App Work slug, shown when the deploy target is not `none`, sending
      `delete_stored_data: true` only when both are satisfied; kept independent of the fork checkbox.
      **Test**: extend `packages/agent/src/services/__tests__/work-lifecycle.app-kind.spec.ts` — a linked-repository
      delete request is refused before the port is called; port called once, before any repository deletion call, with
      `deleteStoredData: false` when the flag is omitted and `true` only when it is `true`; the fork decision is identical
      with either value; `done` ⇒ row deleted; `pending` ⇒ row kept, response `deleting: true`, and a later
      `completeAppWorkDeletion(workId)` deletes it (a second call is a no-op); port unbound ⇒ deletion proceeds; port
      throws ⇒ row deleted and the message names the target; non-`app` kinds never call the port. Extend
      `apps/web/src/components/works/detail/settings/DeleteComponent.unit.spec.tsx` — stored-data checkbox hidden for
      target `none`; payload carries `delete_stored_data: true` only after the typed App Work slug matches; ticking it never
      sets `delete_data_repository` (ACC-01-20).
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

- [ ] **T36. Telemetry.**
      **Modify** `packages/agent/src/app-works/app-source-inspector.service.ts`,
      `packages/agent/src/app-works/app-work-create.service.ts`,
      `packages/agent/src/app-works/app-source-initializer.service.ts` and
      `packages/agent/src/services/work-lifecycle.service.ts` (delete path) — emit the five events of
      [plan §9.1](./plan.md) through the monitoring package.
      **Test**: **create** `packages/agent/src/app-works/__tests__/app-works.telemetry.spec.ts` — each event emitted
      once per outcome; no payload contains a repository name, URL, owner, token or file content.
      **Done when**: the spec is green.

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
- ACC-01-01 … ACC-01-20 are each covered by an automated test here or listed as a live scenario in
  [ACCEPTANCE.md](../ACCEPTANCE.md) for APW-13.
- Every gate in [plan §12](./plan.md) is confirmed, and its carried-forward gaps are still recorded there.
