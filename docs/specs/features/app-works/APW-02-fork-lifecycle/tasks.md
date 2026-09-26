# Task Breakdown: Fork lifecycle — readiness, Actions hygiene, upstream sync, divergence, checkout keys

> Ordered tasks derived from [`plan.md`](./plan.md). Each is small enough to land in one PR and ships with
> tests per **Constitution VI**. The schema task ships its migration in the same PR per **Constitution V**.

**Epic ID**: `APW-02-fork-lifecycle`
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
- Add new tasks at the bottom of their phase rather than renumbering — APW-01 references T1–T8 (P0), T9–T34 (P1),
  T15, T27, T43 and T44. T43–T44 were added by the program audit; T46–T51 by the 2026-09-17 audit pass.
- Phase boundaries are ship boundaries: `develop` must be green and deployable at the end of each phase.
- **P0 is independently shippable** on branch `feat/apw-02-fork-lifecycle-p0` and touches no table, route, job or UI;
  P1 ships on `feat/apw-02-fork-lifecycle`.
- **Program audit resolutions** ([CONTRACTS §0](../CONTRACTS.md#0-program-audit-resolutions-binding-2026-09-17-against-develop-ee45946e5))
  applied here: R-1 (T11), R-2 (T15), R-4 (T43), R-8 (T30, T36), R-14 (T2 — generic fixtures only), R-21 (T23), R-22
  (no suite under `apps/api/test/`).
- **Prerequisites.** **P0: none — it is Wave 0 and ships alone.** **P1: APW-03 P1** (T1's contracts barrel and
  T12's `AppSpecService.getEffectiveSpec` / `AppSpecAppliedEvent`) **and APW-03 P2's seam** (T24 `AppsCatalogService`,
  T26's adapter) for T26/T28's spec reads, **APW-06 T1–T3** (`packages/agent/src/app-runtime/ports.ts` and the
  `IDeploymentPlugin` App additions) for T28's proxies, and **APW-03 P3's `AppLicenseService`** (its T42) for the
  license leg. The license and tier services are injected `@Optional()`; where a `ports.ts` file does not exist yet,
  the task that needs it **creates it from CONTRACTS §3 verbatim** and APW-06 T3 modifies it — nothing here removes
  what APW-06 declared. This epic creates `packages/agent/src/app-works/`, which APW-01 T11 and every later epic
  build on, so **T15 lands before APW-01 T11** in the program merge order.
- Unit and controller tests never call GitHub. Live behaviour is pinned once by the contract probe (T42) against a
  throwaway repository in a test organization, and by APW-13's suite.
- Test commands run from the monorepo root unless a task says otherwise: plugin
  `cd packages/plugin && npx vitest run <path>`; GitHub plugin `cd packages/plugins/github && npx vitest run <path>`;
  contracts `cd packages/contracts && npx vitest run <path>`; agent `cd packages/agent && npx jest <path>`; API
  `cd apps/api && npx jest <path>`; tasks `cd packages/tasks && npx vitest run <path>`; web unit
  `cd apps/web && npx vitest run <path>`; web e2e `cd apps/web && npx playwright test <path>`.

---

# Phase P0 — Safe working copies and non-blocking fork requests (Wave 0)

_Delivers spec FR-1…FR-13 and ACC-02-01…ACC-02-03._

## P0.1 — Contracts

- [ ] **T1. Optional fields for keys, expectations and waiting.**
      **Modify** `packages/plugin/src/contracts/capabilities/git-provider.interface.ts` — `GitCloneOptions` gains
      `checkoutKey?: string` and `expectExisting?: boolean`; `ForkRepositoryOptions` gains `waitForReady?: boolean`;
      `GitRepository` gains `forkReadiness?: 'ready' | 'pending'`; `IGitOperations.getLocalDir(owner, repo,
checkoutKey?)` and `removeLocalDir(owner, repo, checkoutKey?)`. JSDoc on each states the default keeps today's
      behaviour.
      **Modify** `packages/plugin/src/facades/git-facade.interface.ts` — `getLocalDir(providerId, owner, repo,
checkoutKey?)`.
      **Test**: type-level only in this task — `pnpm --filter @ever-works/plugin type-check` and
      `pnpm --filter @ever-works/github-plugin type-check` pass with no edit to any implementer; behaviour is asserted by
      the T2–T5 specs.
      **Done when**: `pnpm --filter @ever-works/plugin build` emits declarations and every existing implementer compiles
      unchanged.

## P0.2 — Entity, table, migration

_None in P0._

## P0.3 — Services

- [ ] **T2. Exact checkout directories.**
      **Modify** `packages/plugin/src/git/git-operations.ts` — export pure
      `checkoutDirectoryName(cloneUrl, owner, repo, checkoutKey?)` per [plan §2.1](./plan.md): with a key,
      `v2/k/<sha256(key)[0,16]>-<slug(key)>` after validating `^[a-z0-9][a-z0-9:_-]{0,127}$` (else throw); without,
      `v2/r/<sha256(cloneUrl)[0,16]>-<slug(owner)>--<slug(repo)>`; `slug` reuses `slugifyText` and is capped at 40
      characters per part. `getLocalDir`, `removeLocalDir` and `cloneOrPull` use it; `cloneBranch` is unchanged.
      **Modify** `packages/plugin/src/git/index.ts` — export `checkoutDirectoryName`.
      **Test**: **create** `packages/plugin/src/git/__tests__/git-operations.checkout-key.spec.ts` — two distinct
      owner/repository pairs whose normalized names collide (the arrange step asserts the legacy slug of both is equal,
      so the fixture cannot silently stop colliding) give two different directories; key dirs never equal repo dirs;
      owner `..`, repo `../x` and key `work:../x` cannot leave the base (resolved path starts with base);
      `removeLocalDir` of one leaves a sibling and a pre-created legacy-slug directory intact (ACC-02-01); run
      `cd packages/plugin && npx vitest run src/git/__tests__/git-operations.checkout-key.spec.ts`.
      **Done when**: the spec passes and `packages/plugin/src/git/__tests__/git-http-agent.spec.ts` still passes.

- [ ] **T3. Refuse the empty-copy fallback when a repository must exist.**
      **Modify** `packages/plugin/src/git/git-operations.ts` — export `RepositoryNotReadyError` (`code =
'repository_not_ready'`); in `cloneOrPull`'s catch, when `expectExisting === true`, remove the directory and throw
      it instead of `git.init` + `addRemote`. Without the flag the fallback is unchanged.
      **Test**: **create** `packages/plugin/src/git/__tests__/git-operations.expect-existing.spec.ts` — using a local
      HTTP-less fixture (a stubbed `git.clone` rejecting with `NotFoundError` and with an "empty" message): flag set ⇒
      error and no directory; flag unset ⇒ directory initialised with `origin` as today (ACC-02-02); run
      `cd packages/plugin && npx vitest run src/git/__tests__/git-operations.expect-existing.spec.ts`.
      **Done when**: both paths are covered and `git grep -n "expectExisting: true" packages/agent/src` returns no
      existing caller.

- [ ] **T4. Plugin and facade pass-through.**
      **Modify** `packages/plugins/github/src/github.plugin.ts` — `getLocalDir` / `removeLocalDir` forward the optional
      key.
      **Modify** `packages/agent/src/facades/git.facade.ts` — `FacadeCloneOptions` gains `checkoutKey?`,
      `expectExisting?`; the `cloneOrPull` coalescing key appends **both** `cloneOptions.checkoutKey ?? ''` and
      `cloneOptions.expectExisting === true` (FR-8: a plain clone and an `expectExisting` clone of the same
      coordinates must never share one in-flight clone, because the plain one may legally leave an empty
      `git init` directory behind and the `expectExisting` caller would then be handed it); `getLocalDir` /
      `removeLocalDir` accept and forward the key.
      **Test**: extend `packages/plugins/github/src/__tests__/github.plugin.spec.ts` (forwarding) and **create**
      `packages/agent/src/facades/__tests__/git.facade.checkout-key.spec.ts` — two calls with different keys for one repo
      do not coalesce; two identical calls do; **two calls with the same key whose `expectExisting` differs do not
      coalesce**, and the `expectExisting` one still throws `RepositoryNotReadyError` when the repository is empty
      (ACC-02-01, ACC-02-02).
      **Done when**: `pnpm --filter @ever-works/agent test` is green.

- [ ] **T5. Fork requests find the real existing fork and can return immediately.**
      **Modify** `packages/plugins/github/src/github-api.service.ts` — `forkRepository` always resolves the target owner
      and checks `<target>/<name ?? repo>`; returns it only when `fork === true` and `source.full_name` (else
      `parent.full_name`) equals `owner/repo` case-insensitively, with `forkReadiness` from its default-branch head;
      `waitForReady === false` returns the mapped `POST /forks` response with `forkReadiness: 'pending'`; the default
      keeps the 24 × 5 s poll. **This is step (1) of the full lookup, not the whole of FR-10**: a fork the member
      renamed is found only once **T52** routes `forkRepository` through T17's three-step `findExistingFork`, so
      ACC-02-03 is not signed off on P0 alone.
      **Modify** `packages/plugins/github/src/github.plugin.ts` and `packages/agent/src/facades/git.facade.ts` — no
      signature change; forward the options object untouched.
      **Test**: **create** `packages/plugins/github/src/__tests__/github-api.service.fork.spec.ts` (Octokit mocked) —
      existing fork found without `name`; a same-named non-fork is not returned and a fork request is made; fork of a
      fork matched by `source`; `waitForReady: false` makes exactly one POST and zero `repos.get` polls and answers well
      inside 10 s on a fake clock; default path still polls (ACC-02-03).
      **Done when**: `packages/agent/src/template-catalog/template-catalog.service.spec.ts` (the `forkTemplateForUser`
      caller) passes unchanged.

- [ ] **T6 (parallel with T5). Remote-rewrite audit.**
      **Modify** only where the audit finds a shared working copy — the current `replaceRemote` callers are
      `packages/agent/src/generators/website-generator/branch-sync.service.ts`,
      `packages/agent/src/generators/website-generator/website-generator.service.ts`,
      `packages/agent/src/generators/website-generator/website-update.service.ts` and
      `packages/agent/src/template-catalog/template-customization.service.ts` (re-run
      `git grep -n "replaceRemote" packages/agent/src` first); each one that works in a shared working copy moves onto a
      per-call `checkoutKey` or `cloneBranch`.
      **Test**: for each changed caller, extend its spec
      (`packages/agent/src/generators/website-generator/branch-sync.service.spec.ts`,
      `packages/agent/src/generators/website-generator/website-generator.service.spec.ts`,
      `packages/agent/src/generators/website-generator/website-update.service.spec.ts`,
      `packages/agent/src/template-catalog/__tests__/template-customization.service.spec.ts`) — the directory it rewrites
      is unique per call; unchanged callers keep their specs green.
      **Done when**: the PR description lists every `replaceRemote` caller with its verdict and the four specs pass.

## P0.7 — Tests and docs

- [ ] **T7. Regression sweep.**
      **Modify**: none expected — a failing caller is fixed in the file T2–T5 changed
      (`packages/plugin/src/git/git-operations.ts` or `packages/agent/src/facades/git.facade.ts`), never by editing the
      caller's spec. No documentation page changes in P0 (the behaviour is internal); T37 documents working copies.
      **Test**: `cd packages/agent && npx jest src/generators/data-generator/data-generator.service.spec.ts
src/comparison-generator/comparison-generator.module.spec.ts src/community-pr/community-pr-processor.service.spec.ts
src/account-transfer src/works-config/__tests__/works-config-repository-sync.service.spec.ts
src/works-config/services/works-config-repository-sync.workid.spec.ts
src/services/__tests__/knowledge-base-git-mirror.service.spec.ts src/template-catalog/template-catalog.service.spec.ts`
      — every `cloneOrPull` caller's existing specs.
      **Done when**: all listed specs pass with no edits.

- [ ] **T8. P0 ship gate.**
      **Modify** `docs/specs/features/app-works/APW-02-fork-lifecycle/tasks.md` — tick P0.
      **Test**: `pnpm format && pnpm lint && pnpm type-check && pnpm test && pnpm build` from the root.
      **Done when**: `develop` is green; no migration, route, job or UI string was added.

---

# Phase P1 — The fork lifecycle (Wave 1)

_Delivers spec FR-14…FR-59 (incl. FR-18a, FR-24a) and ACC-02-04…ACC-02-23._

## P1.1 — Contracts

- [ ] **T9. Repository facts and typed provider errors.**
      **Modify** `packages/plugin/src/contracts/capabilities/git-provider.interface.ts` — `GitRepository` gains `source?`,
      `allowForking?`, `archived?`, `visibility?`, `stars?`, `sizeKb?`, `licenseSpdx?`, `empty?`, `movedFrom?`.
      **Create** `packages/plugin/src/contracts/capabilities/git-provider.app-forks.ts` — `GitProviderErrorReason`,
      `GitProviderRequestError`, `GitForkSyncResult`, `GitForkDivergence`, `GitRepositoryCopyInput`,
      `GitRepositoryCopyResult`, `GitWorkflowRef`, `GitActionsPermissionsInput`, `GitActionsPermissionsResult`,
      `GitWebhookInput` exactly as [plan §3.3](./plan.md).
      **Modify** `packages/plugin/src/contracts/capabilities/index.ts` — `export * from './git-provider.app-forks.js';`.
      **Modify** `packages/plugin/src/git/index.ts` — re-export the new types for plugin authors.
      **Test**: **create** `packages/plugin/src/contracts/__tests__/git-provider-app-forks.spec.ts` — the
      error class keeps `reason`, `status`, `details`; `instanceof Error`.
      **Done when**: the spec passes and `pnpm --filter @ever-works/plugin build` succeeds.

- [ ] **T10 (parallel with T9). Optional capability methods.**
      **Modify** `packages/plugin/src/contracts/capabilities/git-provider.interface.ts` — add to `IGitProviderPlugin`
      the optional `findExistingFork?`, `syncForkBranch?`, `getForkDivergence?`, `createRepositoryCopy?`,
      `setActionsPermissions?`, `createWebhook?`, `deleteWebhook?` with the signatures of plan §3.3 — and APW-09's
      `createBranchFromSha?` / `updateBranchRef?` with the exact signatures in CONTRACTS §3 unless APW-09 has already
      added them — and JSDoc stating callers must materialise the method before calling (lazy-plugin proxy rule).
      **Test**: type-level — `pnpm --filter @ever-works/plugin type-check`, `pnpm --filter @ever-works/github-plugin
type-check` and `pnpm --filter @ever-works/agent type-check` pass with no edit to any existing git-provider
      implementation (runtime behaviour is asserted by T17–T22).
      **Done when**: every existing git-provider implementation compiles unchanged.

- [ ] **T11. Upstream state contracts in the shared App Works folder (Resolution R-1).**
      **Create** `packages/contracts/src/apps/app-upstream.ts` — the four state unions, `AppUpstreamStateResponse` (incl.
      `readiness.setupPullRequestNumber`), `APP_FORK_READINESS_REASONS` and every constant of [plan §3.4](./plan.md);
      import `APP_PRIVATE_COPY_MAX_SIZE_KB` from `./app-source.js` when APW-01 T2 has landed, otherwise define it here with
      a comment naming APW-01 as owner.
      **Modify** `packages/contracts/src/apps/index.ts` — `export * from './app-upstream.js';` (**Create** it, and add
      `export * from './apps/index.js';` to `packages/contracts/src/index.ts`, if APW-03 T1 has not landed).
      **Test**: **create** `packages/contracts/src/apps/__tests__/app-upstream.spec.ts` — pins the unions and each
      numeric constant (`[2_000, 4_000, 8_000, 15_000]`, `15_000`, `900_000`, `30_000`, `3`, `3`, `600_000`, `5_000`,
      `60_000`, `50`, `'0 6 * * 1'`, `3_600_000`, `300_000`, `6`, `2_000`, `1_800_000`, `'*/10 * * * *'`, `50`, `20`, `50`,
      `100`, `300`, `60_000`, `60_000`, `3_600_000`, `3`, `600_000`, `86_400_000`, `25`, `86_400_000`), the env name
      `EVER_WORKS_APP_FORK_READINESS_TIMEOUT_MS` and the four readiness reasons.
      **Done when**: `import { AppUpstreamStateResponse } from '@ever-works/contracts'` type-checks in `apps/web`
      (`pnpm --filter ever-works-web type-check`) and `git grep -n "app-upstream.dto" packages/contracts` returns nothing.

## P1.2 — Entity, table, migration

- [ ] **T12. `WorkUpstreamState` entity.**
      **Create** `packages/agent/src/entities/work-upstream-state.entity.ts` — every column, default and index of
      [plan §3.1](./plan.md) (incl. `setupPullRequestNumber`, `setupCheckedAt`); `TimestampColumn` for every time;
      `@ManyToOne(() => Work, { onDelete: 'CASCADE' })`; scope columns without relations.
      **Modify** `packages/agent/src/entities/index.ts`, `packages/agent/src/database/_entity-names.ts`,
      `packages/agent/src/database/_entities-inventory.ts` — the three registration steps.
      **Test**: **create** `packages/agent/src/entities/__tests__/work-upstream-state.entity.spec.ts` — index names,
      defaults (`preparing`, `unknown`, `available`, `pending`, counters `0`), scope columns present.
      **Done when**: `packages/agent/src/database/database.module.spec.ts` passes without a magic-number edit.

- [ ] **T13. Migration.**
      **Create** `apps/api/src/migrations/1792020000000-CreateWorkUpstreamStates.ts` — Table API, every column of T12, FK
      to `works(id)` ON DELETE CASCADE, three indexes; `down()` drops indexes then table.
      **Test**: **create** `apps/api/src/migrations/__tests__/CreateWorkUpstreamStates.spec.ts` — `up()` creates exactly the
      table + indexes; `down()` removes only them; `apps/api/src/migrations/__tests__/migrations-directory-contract.spec.ts`
      passes.
      **Done when**: a fresh database migrates and rolls back cleanly on Postgres and SQLite.

- [ ] **T14. Repository.**
      **Create** `packages/agent/src/database/repositories/work-upstream-state.repository.ts` — `findByWorkId`,
      `create`, `update`, `claimDue(nowMs, limit)` (transactional select + stamp), `findStalePreparing(nowMs, idleMs,
limit)`, `findUnavailableDueForRecheck(nowMs, limit)`, `claimSetupPullRequestChecks(nowMs, minIntervalMs, limit)`,
      `incrementManualSync(workId, nowMs, windowMs, max)`, `incrementManualRetry(workId, nowMs, windowMs, max)` (atomic
      conditional updates returning allowed/denied).
      **Modify** `packages/agent/src/database/index.ts` — export.
      **Test**: **create** `packages/agent/src/database/repositories/__tests__/work-upstream-state.repository.spec.ts` —
      `claimDue` and `claimSetupPullRequestChecks` never return a row twice across two concurrent calls; limit honoured;
      manual counters roll after the window; the 7th sync and the 4th retry are denied.
      **Done when**: the spec passes on the SQLite test database.

- [ ] **T15. Agent module, barrel, Activity types (Resolution R-2).**
      **Create** `packages/agent/src/app-works/app-works.module.ts` (`TypeOrmModule.forFeature([WorkUpstreamState])`,
      repository provider, services added by later tasks) and `packages/agent/src/app-works/index.ts`.
      **Modify** `packages/agent/package.json` — add the `./app-works` subpath export mirroring `./pr-review`.
      **Modify** `packages/agent/src/entities/activity-log.types.ts` — append `APP_FORK = 'app_fork'`,
      `APP_ACTIONS = 'app_actions'`, `APP_UPSTREAM = 'app_upstream'` (dotted events stored in `action`) per
      [plan §3.5](./plan.md).
      **Test**: extend `packages/agent/src/entities/__tests__/activity-log.types.spec.ts` — the three new pairs pinned,
      every existing pair unchanged; **create** `packages/agent/src/app-works/__tests__/app-works.module.spec.ts` — the
      module compiles with only its own providers.
      **Done when**: `@ever-works/agent/app-works` resolves from `apps/api` and `packages/tasks`.

## P1.3 — Services

- [ ] **T16. GitHub error classification and repository facts.**
      **Create** `packages/plugins/github/src/github-errors.ts` — `toGitProviderError(err, permissionHint?)` per the table in
      [plan §4.2](./plan.md).
      **Modify** `packages/plugins/github/src/github-api.service.ts` — `getRepository` maps the new facts, computes
      `empty` only when `size === 0`, sets `movedFrom`, keeps `null` on 404 and rethrows other failures through
      `toGitProviderError`.
      **Test**: **create** `packages/plugins/github/src/__tests__/github-errors.spec.ts` (every row, incl. rate-limit
      reset and secondary retry times — ACC-02-16) and
      `packages/plugins/github/src/__tests__/github-api.service.repository-facts.spec.ts` (every fact, `movedFrom`,
      `empty` only when `size === 0`, typed errors from every 403 variant).
      **Done when**: the existing `packages/plugins/github/src/__tests__/github-api.service.*.spec.ts` files pass unchanged.

- [ ] **T17. `findExistingFork`.**
      **Modify** `packages/plugins/github/src/github-api.service.ts` and `packages/plugins/github/src/github.plugin.ts` —
      the three-step lookup of [plan §4.3](./plan.md) (same-name identity check, GraphQL forks with affiliations filtered
      by owner, REST forks fallback ≤ 3 pages). The method is consumed in two directions: APW-01's inspect calls it
      per candidate owner, and **`forkRepository` itself calls it before every create request (T52)** — so it is a
      capability, never a private helper of the create path.
      **Test**: extend `packages/plugins/github/src/__tests__/github-api.service.fork.spec.ts` — renamed fork found via
      GraphQL; GraphQL error ⇒ REST fallback; nothing found ⇒ `null`; a match owned by another owner ignored (ACC-02-03).
      **Done when**: at most 1 REST + 1 GraphQL + 1 REST call on the happy path (asserted).

- [ ] **T18. Sync, divergence and branch update.**
      **Modify** `packages/plugins/github/src/github-api.service.ts` and `packages/plugins/github/src/github.plugin.ts` —
      `syncForkBranch`, `getForkDivergence`, and (unless already present) APW-09's `createBranchFromSha` /
      `updateBranchRef` per plan §4.3.
      **Test**: **create** `packages/plugins/github/src/__tests__/github-api.service.fork-sync.spec.ts` — merge-upstream
      200 (`fast-forward`, `merge`, `none`), 409, 422; compare basehead string is
      `<upstreamOwner>:<upstreamBranch>...<forkBranch>` and maps `ahead_by`/`behind_by`; `updateBranchRef` always sends
      `force: false`; 422 non-fast-forward ⇒ `unprocessable` (ACC-02-09, ACC-02-10, ACC-02-19).
      **Done when**: the spec is green and no request in it carries `force: true`.

- [ ] **T19. `createRepositoryCopy`.**
      **Modify** `packages/plugins/github/src/github-api.service.ts` and `packages/plugins/github/src/github.plugin.ts` —
      refuse `sizeKb > maxSizeKb` and root `.gitattributes` with `filter=lfs` before any git work; isolated `cloneBranch`;
      up-to-date short-circuit; `replaceRemote` + `push` with `remoteRef`, never `force`; directory removed in `finally`.
      **Test**: extend `packages/plugins/github/src/__tests__/github-api.service.fork-sync.spec.ts` with a `GitOperations`
      double — refusals make no clone; push called once without `force`; second run with equal heads makes no push;
      directory removed on error (ACC-02-15).
      **Done when**: the spec is green and the double records zero `force` pushes.

- [ ] **T20. `setActionsPermissions`.**
      **Modify** `packages/plugins/github/src/github-actions.service.ts` — paginate `listWorkflows` (up to `maxWorkflows`),
      add `setActionsPermissions(owner, repo, input, token, baseUrl)` per plan §4.3; leave `enableDeploymentWorkflows`
      unchanged.
      **Modify** `packages/plugins/github/src/github.plugin.ts` — expose it as the capability method.
      **Test**: **create** `packages/plugins/github/src/__tests__/github-actions.service.permissions.spec.ts` — 150
      workflows with `maxWorkflows: 100` ⇒ `truncated`; allowlist kept; skip ids untouched; `enableWorkflows` enables
      only listed paths; repo switch called only when `enabled` is set; 403 ⇒ `permission_missing` and stop (ACC-02-08,
      ACC-02-20).
      **Done when**: the spec is green and `enableDeploymentWorkflows`' existing specs pass unchanged.

- [ ] **T21 (parallel with T20). Webhooks.**
      **Modify** `packages/plugins/github/src/github-api.service.ts` and `packages/plugins/github/src/github.plugin.ts` —
      `createWebhook` (update by URL, else create) and `deleteWebhook` (404 success).
      **Test**: **create** `packages/plugins/github/src/__tests__/github-api.service.webhooks.spec.ts` — create vs update
      by URL; delete 404 is success; the secret is never included in a thrown error message.
      **Done when**: the spec is green.

- [ ] **T22. Facade methods.**
      **Modify** `packages/agent/src/facades/git.facade.ts` — the eight methods of plan §4.2 with the
      materialise-then-call guard.
      **Test**: **create** `packages/agent/src/facades/__tests__/git.facade.app-forks.spec.ts` — each method's absent
      path throws `GitOperationNotSupportedError`; present path forwards arguments and token.
      **Done when**: `apps/api/src/common/filters/facade-exception.filter.spec.ts` still maps the unsupported error to 409
      with no edit.

- [ ] **T23. Ready-handler port and `AppUpstreamStateService` (Resolution R-21).**
      **Create** `packages/agent/src/app-works/app-fork-ready-handler.port.ts` (`AppForkReadyOutcome` incl.
      `setupPullRequestNumber`, `AppForkReadyHandler`, `APP_FORK_READY_HANDLER`).
      **Create** `packages/agent/src/app-works/app-upstream-state.service.ts` — `get(workId, userId)` (view check,
      404 for other accounts and non-`app` Works, response mapping incl. warnings and remaining limits),
      `beginAttempt`, `probeReadiness`, `recordCopyPushed`, `markReady` (emits `app.fork.ready` once), `timeout`
      (emits `app.fork.timeout` once per attempt), `fail`, `retryReadiness(workId, userId)`, `requestSync(workId, userId)`,
      `beginSync`, `finishSync` (events per plan §6.3 step 8), `recordConflict` (plan §6.5 — the Agent from
      APW-08's `APP_WORK_AGENT_RESOLVER` (`packages/agent/src/app-works/app-work-agent-resolver.ts`, APW-08 T25):
      `resolve({ userId: ownerUserId, workId })?.agentId`, injected `@Optional()`; never chosen here).
      **Modify** `packages/agent/src/app-works/app-works.module.ts` — provide + export.
      **Test**: **create** `packages/agent/src/app-works/__tests__/app-upstream-state.service.spec.ts` — every error code
      of plan §4.1; events emitted exactly once across repeated calls; conflict Task Agent: resolver returns an id ⇒ Task
      `agentId` is that id; resolver returns `null`, throws or is unbound ⇒ `agentId` `null` and exactly one owner
      notification; an open labelled Task is commented, not duplicated (ACC-02-11) **and the comment goes through
      `TaskChatService.post` with `authorType: 'user'`, `authorId` = the Work's owner and a body that contains no
      `@`** (asserted directly, because the chat service fans out one agent run per `@<slug>` mention and this path
      must start none), while the Task lookup uses exactly the five open statuses of plan §6.5 — a Task in `done`
      or `cancelled` is not commented and a replacement Task is created instead; `timeout` once per attempt and
      `retryReadiness` refused with `retry_limit_reached` on the 4th call in an hour (ACC-02-05); `fail('access_revoked')`
      then `retryReadiness` accepted (ACC-02-06); readiness from `probeReadiness` on an empty then non-empty repository
      (ACC-02-04); another account's Work ⇒ 404 (ACC-02-21).
      **Done when**: the spec is green and `git grep -n "findByUserIdScoped" packages/agent/src/app-works` returns nothing
      (no local Agent-picking rule survives).

- [ ] **T24. `AppForkReadinessService`.**
      **Create** `packages/agent/src/app-works/app-fork-readiness.service.ts` — `run(payload, { sleep })` per
      [plan §6.2](./plan.md), injecting the state service (remote proxy in the worker), `GitFacadeService`,
      `AppActionsHygieneService`, `APP_FORK_READY_HANDLER` (`@Optional()`), and APW-04's `APP_PROVISION_EVENTS_PORT`
      (`@Optional()`; `forkReady(workId)` after `markReady`, failures logged only).
      **Test**: **create** `packages/agent/src/app-works/__tests__/app-fork-readiness.service.spec.ts` with a fake clock and
      recorded `sleep` durations — `[2000, 4000, 8000, 15000, 15000, …]`; empty ⇒ keep polling; ready within 30 s of the
      first commit ⇒ hygiene before handler, handler once (ACC-02-04); elapsed 900 000 ms ⇒ timeout (ACC-02-05);
      `unauthorized` ⇒ `access_revoked` (ACC-02-06); rate limited ⇒ sleeps to `retryAt`; private copy refusals and full
      history pushed once (ACC-02-15); `copyPushedSha` set ⇒ no second push; handler `waiting_for_setup_pr` and `failed`
      outcomes recorded.
      **Done when**: the spec is green and no test path calls `forkRepository` or `createRepository`.

- [ ] **T25. `AppActionsHygieneService`.**
      **Create** `packages/agent/src/app-works/app-actions-hygiene.service.ts` per plan §6.7.
      **Test**: **create** `packages/agent/src/app-works/__tests__/app-actions-hygiene.service.spec.ts` — link ⇒
      `not_applicable` with no provider call; seen ids passed as `skipWorkflowIds`; `needs_admin` vs
      `permission_missing` naming the permission, never blocking the caller; `app.actions.disabled` only when something
      was disabled; the build workflow path always in the allowlist (ACC-02-08, ACC-02-20).
      **Done when**: the spec is green and no call in it sets `enabled: false`.

- [ ] **T26. `AppUpstreamSyncService` and schedule helper.**
      **Create** `packages/agent/src/app-works/upstream-schedule.ts` — `computeNextUpstreamSync(schedule, from, workId)`
      reusing `computeNextHeartbeat` from `packages/agent/src/agents/heartbeat-cron.ts` (default, hourly clamp, stable
      jitter). **The helper reads all four `upstreamSync` fields (plan §6.4, schema.md §19): `schedule`, `enabled`
      (`false` ⇒ `nextSyncAt` stays `null` and the dispatcher never fires, while manual **Sync now** still works),
      `branch` (the branch compared and merged) and `mode` (`merge` only).** All four are read from APW-03's
      effective spec, with the documented defaults when the block or the field is absent.
      **Create** `packages/agent/src/app-works/app-upstream-sync.service.ts` — `run(payload)` per [plan §6.3](./plan.md)
      with `DistributedTaskLockService`, a `ProviderCallBudget` wrapper, `AppLicenseService` (`@Optional()`, APW-03).
      **The per-App-Work claim is taken API-side, not in the worker**: `run` does **not** call
      `DistributedTaskLockService` itself — it calls `AppUpstreamStateService.beginSync(workId)`, a remote-proxied
      atomic conditional update on the new `syncLeaseUntil` column that returns allowed/denied, and
      `finishSync(workId)` releases it. `DistributedTaskLockService` needs `@InjectRepository(CacheEntry)` and a
      callback cannot cross the SuperJSON remote proxy, and the worker imports no database module — so the lock
      cannot live there. `AppLicenseService` is reached the same way: through a **remote proxy named in T28** (the
      API-side `AppUpstreamStateService` also exposes `requestLicenseEvaluation(workId, reason)`), so a missing
      binding can never silently skip FR-37. `AppLicenseService.request(workId, reason)` gains its reason union in
      CONTRACTS §2A as part of this task's PR.
      **Create** `packages/agent/src/app-works/app-upstream-conflict.copy.ts` — the spec §6.3 templates.
      **Test**: **create** `packages/agent/src/app-works/__tests__/upstream-schedule.spec.ts` and
      `packages/agent/src/app-works/__tests__/app-upstream-sync.service.spec.ts` — lock not acquired; archived/unavailable/
      missing/too-large pauses and their one-time events (ACC-02-15, ACC-02-17, ACC-02-18); rename followed (ACC-02-19);
      behind-only + license same ⇒ fast-forward with the commit count (ACC-02-09); license worse ⇒ PR with note
      (ACC-02-12); 409 race ⇒ PR; diverged ⇒ PR create then update, never merged, rewritten history never force-moved
      (ACC-02-10); closed PR not reopened at the same head; `mergeable null` re-read 3 × 5 s; conflict ⇒ `recordConflict`
      (ACC-02-11); private copy counts from merge base and `10000+` cap; budget stop at 20 calls; skip until reset + 60 s,
      secondary backoff doubling to 3 600 000 ms, persistent notice after 3 runs (ACC-02-16); hygiene and license request
      only when the tracked branch changed.
      **Done when**: both specs are green and the sync spec's provider double records no push to the upstream and no
      `force` write.

## P1.4 — API

- [ ] **T27. Upstream routes.**
      **Create** `apps/api/src/app-works/app-works.module.ts` (imports the agent `AppWorksModule`, binds nothing APW-01
      owns — APW-01 T15 adds the handler binding here) and `apps/api/src/app-works/app-upstream.controller.ts` — the three
      routes, throttles and error codes of [plan §4.1](./plan.md), `@ApiOperation` on each; `GET` fires the divergence
      dispatch per plan.
      **Modify** `apps/api/src/api.module.ts` — import `AppWorksModule`.
      **Test**: **create** `apps/api/src/app-works/app-upstream.controller.spec.ts` — throttle metadata, 200/202 shapes,
      sync `202` without awaiting the job (ACC-02-14), 404 for another account and for a non-`app` Work (ACC-02-21),
      409/422/429 codes incl. the 7th manual sync and the 4th retry (ACC-02-05, ACC-02-14), divergence dispatch at most once
      per 600 s with `stale` in the body (ACC-02-13).
      **Done when**: `cd apps/api && pnpm test` is green.

- [ ] **T28. Dispatcher service and remote proxies.**
      **Create** `packages/agent/src/app-works/app-upstream-sync-dispatcher.service.ts` — `dispatchDue()` per plan §6.6.
      **Modify** `apps/api/src/trigger/trigger-internal.controller.ts` — add `AppUpstreamStateService` and
      `AppUpstreamSyncDispatcherService` to `remoteMap`; **Modify** `apps/api/src/trigger/trigger-internal.module.ts` —
      import `AppWorksModule`.
      **Modify** `packages/tasks/src/trigger/worker/modules/trigger-internal.module.ts` — `APP_UPSTREAM_STATE_SERVICE` and
      `APP_UPSTREAM_SYNC_DISPATCHER_SERVICE` via `createRemoteProxy`, exported.
      **Test**: **create** `packages/agent/src/app-works/__tests__/app-upstream-sync-dispatcher.service.spec.ts` (cap 50,
      stamp-before-dispatch, rate-limited skip — ACC-02-16; stale readiness ≤ 3 re-dispatches within 10 minutes then
      timeout — ACC-02-07; daily re-check resumes an unavailable upstream — ACC-02-17); extend
      `apps/api/src/trigger/trigger-internal.controller.spec.ts` (both names in `remoteMap`).
      **Done when**: both specs are green.

## P1.5 — Web

- [ ] **T29. Client plumbing.**
      **Modify** `apps/web/src/lib/api/work.ts` — `workAPI.getUpstream`, `syncUpstream`, `retryUpstreamReadiness` typed with
      `AppUpstreamStateResponse`.
      **Modify** `apps/web/src/app/actions/dashboard/works.ts` — `syncUpstreamAction`, `retryUpstreamReadinessAction`
      (auth from cookie, `revalidatePath` on the Work route, error codes passed through).
      **Test**: extend `apps/web/src/app/actions/dashboard/works.unit.spec.ts` — codes surface unchanged; unauthenticated
      redirects.
      **Done when**: the spec is green and `pnpm --filter ever-works-web type-check` is clean.

- [ ] **T30. Upstream card and the Upstream tab (Resolution R-8).**
      **Create** `apps/web/src/components/works/app/AppUpstreamCard.tsx` (variants `tab` and `overview`),
      `apps/web/src/components/works/app/UpstreamDivergenceBadge.tsx` and
      `apps/web/src/components/works/app/AppUpstreamWarnings.tsx` per [plan §5.2](./plan.md) and spec §6.1–6.2,
      `data-testid`s `app-upstream-card`, `app-upstream-relation`, `app-upstream-readiness`, `app-upstream-sync-now`,
      `app-upstream-badge`, `app-upstream-warning-<code>`.
      **Modify** `apps/web/src/app/[locale]/(dashboard)/works/[id]/page.tsx` — render the `overview` card for forks and
      private copies when readiness is `ready` or `waiting_for_setup_pr`.
      **Create** `apps/web/src/app/[locale]/(dashboard)/works/[id]/upstream/page.tsx` — the one Upstream tab page: the
      `tab` card (relation, readiness with **Try again** when timed out or failed, divergence, sync, workflows) and an
      empty slot below it for APW-09's section.
      **Modify** `apps/web/src/components/works/detail/WorkTabs.tsx` (an `Upstream` tab for kind `app` with relation fork
      or private copy) and `apps/web/src/lib/constants.ts` (`ROUTES.DASHBOARD_WORK_UPSTREAM`).
      **Modify** `apps/web/src/components/activity-log/ActivityTypeBadge.tsx` — colours + `TYPE_TO_I18N` for `app_fork`,
      `app_actions`, `app_upstream`.
      **Test**: **create** `apps/web/src/components/works/app/UpstreamDivergenceBadge.unit.spec.tsx`,
      `apps/web/src/components/works/app/AppUpstreamCard.unit.spec.tsx` and
      `apps/web/src/components/works/app/AppUpstreamWarnings.unit.spec.tsx` — five badge messages with plural forms and
      "Checked {ago}" (ACC-02-13); result lines incl. the license note (ACC-02-12); PR and Task links; workflows toggle;
      409/429 copy; poll every 5 s while running, stops at 360 polls and on unmount; the `tab` variant renders relation and
      every readiness state, and **Try again** calls `retryUpstreamReadinessAction` once (ACC-02-23); the missing-fork
      and rename warnings (ACC-02-18, ACC-02-19). Extend `apps/web/src/components/works/detail/WorkTabs.unit.spec.tsx` —
      the tab present for fork and private copy, hidden for `link` and for every other kind (ACC-02-23).
      **Done when**: the card renders every warning from a fixture without a network call and exactly one Upstream tab
      entry exists in `WorkTabs.tsx`.

## P1.6 — Background

- [ ] **T31. Dispatcher symbols and runtime bindings.**
      **Create** `packages/agent/src/tasks/app-fork-readiness.types.ts`, `packages/agent/src/tasks/app-fork-readiness-dispatcher.ts`,
      `packages/agent/src/tasks/app-upstream-sync.types.ts`, `packages/agent/src/tasks/app-upstream-sync-dispatcher.ts`
      (interface + `Symbol()` each, payloads of plan §6.1 incl. the readiness `reason`).
      **Modify** `packages/agent/src/tasks/index.ts` (exports), `packages/agent/src/tasks/_tasks-symbols.ts` (two names,
      alphabetical), `packages/agent/src/tasks/job-runtime.providers.ts` (`DISPATCHER_SYMBOLS` + 2 and its arity comment),
      `packages/agent/src/tasks/__tests__/job-runtime.providers.spec.ts` (14 → 16 on `e5f43f44d`; recount at merge).
      **Modify** `packages/tasks/src/trigger/trigger.module.ts` (provide + export both) and
      `packages/tasks/src/trigger/trigger.service.ts` (`dispatchAppForkReadiness`, `dispatchAppUpstreamSync` mirroring
      `dispatchTemplateCustomization`, with the idempotency keys of plan §6.1).
      **Test**: `packages/agent/src/tasks/tasks.spec.ts` and `packages/agent/src/tasks/__tests__/job-runtime.providers.spec.ts`
      pass without a magic-number edit beyond 14 → 16; extend `packages/tasks/src/__tests__/trigger.service.spec.ts` —
      `null` when unconfigured, idempotency key shape (incl. `app-fork-readiness:<workId>:setup_merged`).
      **Done when**: the three specs are green.

- [ ] **T32. `app-fork-readiness` task.**
      **Create** `packages/tasks/src/tasks/trigger/app-fork-readiness.task.ts` — `task({ id: 'app-fork-readiness',
maxDuration: 1_200 })`, the `template-customization.task.ts` preamble, `sleep` via `wait.for`.
      **Modify** `packages/tasks/src/tasks/trigger/index.ts` — export.
      **Modify** `packages/tasks/src/trigger/worker/modules/trigger-worker.module.ts` — provide `AppForkReadinessService`,
      `AppActionsHygieneService` (state service from the remote proxy).
      **Test**: **create** (new directory) `packages/tasks/src/tasks/trigger/__tests__/app-fork-readiness.task.spec.ts` —
      drained credentials skip; payload forwarded; `sleep` wired.
      **Done when**: `cd packages/tasks && npx vitest run src/tasks/trigger/__tests__/app-fork-readiness.task.spec.ts` is green.

- [ ] **T33. `app-upstream-sync` task.**
      **Create** `packages/tasks/src/tasks/trigger/app-upstream-sync.task.ts` — `maxDuration: 1_800`.
      **Modify** `packages/tasks/src/trigger/worker/modules/trigger-worker.module.ts` — export / provide
      `AppUpstreamSyncService`. **It builds because it needs no database and no callback**: the per-Work claim is
      `AppUpstreamStateService.beginSync/finishSync` through the T28 remote proxy, and the license leg is
      `requestLicenseEvaluation` on the same proxy. Do not import a database module and do not inject
      `DistributedTaskLockService` here.
      **Test**: **create** (new directory) `packages/tasks/src/tasks/trigger/__tests__/app-upstream-sync.task.spec.ts` —
      payload forwarded to `AppUpstreamSyncService.run`; drained credentials skip; the worker module spec asserts the
      module compiles with no database module, that `beginSync` is reached through the remote proxy, and that a
      denied claim makes no provider call.
      **Done when**: `cd packages/tasks && npx vitest run src/tasks/trigger/__tests__/app-upstream-sync.task.spec.ts` is green.

- [ ] **T34. `app-upstream-sync-dispatcher` cron.**
      **Create** `packages/tasks/src/tasks/trigger/app-upstream-sync-dispatcher.task.ts` — `schedules.task` on
      `process.env.APP_UPSTREAM_SYNC_DISPATCHER_CRON ?? '*/10 * * * *'` with the five-field validation and fallback
      copied from `data-repo-sync-dispatcher.task.ts` (which reads its own override the same way,
      `data-repo-sync-dispatcher.task.ts:48-53`), calling
      `APP_UPSTREAM_SYNC_DISPATCHER_SERVICE.dispatchDue()` and returning the counters. The variable name is
      `APP_UPSTREAM_SYNC_DISPATCHER_CRON`, it is documented in `apps/api/.env.example` beside the other
      `APP_*` switches, and it is listed in CONTRACTS §7 as an operator override — a dispatcher cron is not a
      feature switch, so R-30's family switch (`EVER_WORKS_APP_SYNC_ENABLED`) stays the only on/off control.
      **Modify** `packages/tasks/src/tasks/trigger/index.ts` — export.
      **Modify** `apps/api/.env.example` — `APP_UPSTREAM_SYNC_DISPATCHER_CRON` with its default.
      **Test**: **create** (new directory) `packages/tasks/src/tasks/trigger/__tests__/app-upstream-sync-dispatcher.task.spec.ts` —
      the default is used when the variable is unset, a valid five-field override is honoured, and an invalid
      override falls back to the default cron.
      **Done when**: a local run with a fixture due row dispatches one sync and stamps `nextSyncAt`.

## P1.7 — i18n, tests, docs

- [ ] **T35. i18n keys.**
      **Modify** `apps/web/messages/en.json` — `dashboard.workDetail.appUpstream`, `dashboard.workDetail.upstream.tabName`
      and the three activity labels from [plan §8](./plan.md) with spec §6 copy verbatim.
      **Modify** the 20 sibling locale files in `apps/web/messages/` — mirror the keys. No leaf key contains `.`.
      **Test**: **create** `apps/web/src/components/works/app/app-upstream-messages.unit.spec.ts` (pattern of
      `apps/web/src/components/tasks/tasks-kanban-messages.unit.spec.ts`) — every leaf of those trees exists in all 21
      files in `apps/web/messages/`, and no leaf key contains `.`; run
      `cd apps/web && npx vitest run src/components/works/app/app-upstream-messages.unit.spec.ts`.
      **Done when**: the spec is green and `pnpm --filter ever-works-web build` logs no missing-message warning.

- [ ] **T36. e2e.**
      **Create** `apps/web/e2e/flow-app-work-upstream-card.spec.ts` — mocked upstream states render each result and warning
      (ACC-02-17, ACC-02-18, ACC-02-19); **Sync now** shows **Syncing…** within 2 s and handles `sync_in_progress` and
      `sync_limit_reached` (ACC-02-14); `/works/:id/upstream` shows relation, readiness (with **Try again** for a timed-out
      fixture) and inherited workflows (ACC-02-23). Prefer `getByTestId`.
      **Test**: `cd apps/web && npx playwright test e2e/flow-app-work-upstream-card.spec.ts` — ACC-02-14, ACC-02-17,
      ACC-02-18, ACC-02-19, ACC-02-23 in the PR lane.
      **Done when**: it passes and the existing Work detail specs pass unchanged.

- [ ] **T37. Docs.**
      **Modify** `docs/features/app-works.md` (created by APW-01 T29; **Create** it here if APW-01 has not landed) — sections
      "Preparing and readiness" (incl. the setup pull request), "Inherited workflows", "Upstream sync", "Divergence", "The
      Upstream tab", "Permissions" (the matrix of plan §4.5), "What Ever Works never does" (push to upstream, force-push your
      branch, resolve conflicts for you).
      **Modify** `apps/docs/sidebarsPlatform.ts` if the page is new.
      **Test**: `pnpm --filter ever-works-docs build`.
      **Done when**: the docs build has no broken links.

## P1.8 — Program audit additions (2026-09-17)

- [ ] **T43. Setup pull request follow-through (FR-24a, Resolution R-4).**
      **Modify** `packages/agent/src/app-works/app-upstream-state.service.ts` — `checkSetupPullRequest(workId)` per
      [plan §6.2](./plan.md): `getPullRequestStatus` for `setupPullRequestNumber`, stamp `setupCheckedAt`; merged ⇒ dispatch
      `app-fork-readiness` with `reason: 'setup_merged'`; closed unmerged ⇒ `failed` / `setup_pull_request_closed`; `markReady`
      stores `setupPullRequestNumber` from the handler outcome.
      **Modify** `packages/agent/src/app-works/app-fork-readiness.service.ts` — `reason === 'setup_merged'` skips copy,
      polling and hygiene and calls the handler once.
      **Modify** `packages/agent/src/app-works/app-upstream-sync-dispatcher.service.ts` — `claimSetupPullRequestChecks(now,
600_000, 50)` per tick.
      **Modify** `apps/api/src/app-works/app-upstream.controller.ts` — `GET` runs the check in the background when waiting and
      `setupCheckedAt` is older than 60 000 ms.
      **Test**: extend `packages/agent/src/app-works/__tests__/app-upstream-state.service.spec.ts` (open ⇒ unchanged state;
      merged ⇒ one `setup_merged` dispatch; closed ⇒ `failed/setup_pull_request_closed`; the facade double records no merge,
      comment, reopen or update call), `packages/agent/src/app-works/__tests__/app-fork-readiness.service.spec.ts`
      (`setup_merged` ⇒ zero probes, zero hygiene calls, handler exactly once, state `ready`),
      `packages/agent/src/app-works/__tests__/app-upstream-sync-dispatcher.service.spec.ts` (≤ 50 checks per tick) and
      `apps/api/src/app-works/app-upstream.controller.spec.ts` (on-view check at most once per 60 s) — ACC-02-22.
      **Done when**: the four specs are green.

- [ ] **T44. Non-production readiness deadline (FR-18a).**
      **Modify** `packages/agent/src/app-works/app-fork-readiness.service.ts` — `resolveReadinessTimeoutMs()` per
      [plan §6.2](./plan.md) step 0: `EVER_WORKS_APP_FORK_READINESS_TIMEOUT_MS` honoured only when `NODE_ENV !== 'production'`,
      clamped to 5 000–900 000; production always 900 000.
      **Modify** `apps/api/.env.example` — document the variable, commented out, with "non-production only".
      **Test**: extend `packages/agent/src/app-works/__tests__/app-fork-readiness.service.spec.ts` — override `10000` outside
      production ⇒ timeout at 10 000 ms; override `1` ⇒ clamped to 5 000; any override with `NODE_ENV=production` ⇒ 900 000;
      unset ⇒ 900 000 (ACC-02-05). This is what lets APW-01 T40 and APW-13's ACC-NEG-09 reach **timed out** in the PR lane.
      **Done when**: the spec is green and `git grep -n "EVER_WORKS_APP_FORK_READINESS_TIMEOUT_MS" packages/agent/src` shows
      exactly one read site.

## P1.9 — Ship gate

- [ ] **T38. P1 ship gate.**
      **Modify** `docs/specs/features/app-works/APW-02-fork-lifecycle/tasks.md` — tick P1; **Modify**
      `docs/specs/features/app-works/ACCEPTANCE.md` — record which ACC-02 ids are automated here and which are live
      scenarios for APW-13.
      **Test**: root `pnpm format && pnpm lint && pnpm type-check && pnpm test && pnpm build`; migrations run on a fresh
      database.
      **Done when**: `develop` is green and every ACC-02-04…ACC-02-23 id names a green test.

---

# Cross-phase closing tasks

- [ ] **T39. Telemetry.**
      **Create** `packages/agent/src/app-works/app-upstream-telemetry.port.ts` — `AppUpstreamTelemetryEvent`,
      the per-event property allow-list and `APP_UPSTREAM_TELEMETRY_SINK` per [plan §9.1](./plan.md):
      `track(event, props, distinctId)`, fire-and-forget, never throwing, unbound ⇒ counted and dropped. **No
      package import**: `packages/agent`, `packages/plugin` and `packages/tasks` do not depend on a monitoring
      package, and this epic does not add one.
      **Modify** `apps/api/src/app-works/app-works.module.ts` — bind the token to the existing PostHog-backed sink
      (the `FunnelAnalyticsSink` binding of `zero-friction-funnel.service.ts` is the pattern).
      **Modify** `packages/agent/src/app-works/app-fork-readiness.service.ts`,
      `packages/agent/src/app-works/app-actions-hygiene.service.ts`, `packages/agent/src/app-works/app-upstream-sync.service.ts`
      and `packages/agent/src/app-works/app-upstream-sync-dispatcher.service.ts` — emit the first six events of plan
      §9.1 through the injected `@Optional()` sink, with `distinctId` = the Work owner's id (the constant
      `'system:app-works'` when no owner resolves) and `workId` as a property. **`git_checkout.not_ready` is emitted
      by the facade** — `packages/agent/src/facades/git.facade.ts` where it catches `RepositoryNotReadyError` — and
      **not** from `packages/plugin/src/git/git-operations.ts`, which has no dependency injection and keeps throwing
      the same typed error unchanged.
      **Test**: **create** `packages/agent/src/app-works/__tests__/app-upstream.telemetry.spec.ts` — each event emitted once
      per outcome with a bound sink; nothing thrown with the sink unbound; a property outside the allow-list is
      dropped (assert the sink never sees it); no payload contains a repository name, owner, file path, commit
      message or token; the facade, not the plugin, emits `git_checkout.not_ready`.
      **Done when**: the spec is green and `git grep -n "monitoring" packages/agent/src/app-works packages/agent/src/facades` returns nothing.

- [ ] **T40. Contracts and tracker.**
      **Modify** `docs/specs/features/app-works/TRACKER.md` — APW-02 P0/P1 status and PR links.
      **Modify** `docs/specs/features/app-works/CONTRACTS.md` only if a name this epic created is missing — every name in the
      plan header must appear with APW-02 as owner.
      **Test**: `git grep -n "APW-02" docs/specs/features/app-works/CONTRACTS.md` lists the route `/works/:id/upstream`,
      `EVER_WORKS_APP_FORK_READINESS_TIMEOUT_MS`, `setupPullRequestNumber` and every other name in the plan header.
      **Done when**: that listing is complete and TRACKER.md links every merged APW-02 PR.

- [ ] **T41. Update statuses.**
      **Modify** `docs/specs/features/app-works/APW-02-fork-lifecycle/spec.md`,
      `docs/specs/features/app-works/APW-02-fork-lifecycle/plan.md` and this file — `Implemented` / `Done`.
      **Test**: `npx prettier --check docs/specs/features/app-works/APW-02-fork-lifecycle/*.md`, and each gate in
      [plan §12](./plan.md) re-checked against the merged code.
      **Done when**: the three files carry the new status and prettier reports no changes needed.

- [ ] **T42. Live contract probe (before the P1 merge).**
      **Create** `packages/plugins/github/src/__tests__/contract/app-forks.contract.ts` (not a `.spec.ts`, so the default
      Vitest run never picks it up) and `packages/plugins/github/vitest.contract.config.ts` (includes only
      `src/__tests__/contract/**/*.contract.ts`) — an opt-in probe, skipped unless `GITHUB_CONTRACT_PROBE_TOKEN` and
      `GITHUB_CONTRACT_PROBE_ORG` are set and never in CI by default, that, against a tiny throwaway repository created and
      deleted inside a dedicated test organization, pins: fork of an already-forked repository returns the existing fork;
      GraphQL `forks` affiliation arguments; merge-upstream outcomes; compare `ahead_by`/`behind_by` direction;
      `PATCH git/refs` force semantics; workflow disable on a fork; the 403 messages for a missing App permission; webhook
      create/update. Never point the probe at a third-party repository.
      **Create** the recorded fixtures under `packages/plugins/github/src/__tests__/fixtures/app-forks/`.
      **Provisioning (owner action, before P1 merges).** The two variables above are **test-only** and belong to the
      private operations repository, never to a deployable environment: `GITHUB_CONTRACT_PROBE_TOKEN` is a
      fine-grained PAT scoped to that one organization with `contents`, `pull requests`, `actions` and
      `administration`, and `GITHUB_CONTRACT_PROBE_ORG` names a dedicated throwaway organization — the **same**
      organization APW-13's `E2E_*` suite uses as its `<e2e-upstream-org>` placeholder, so the estate provisions
      one test organization and one scoped token, not two. CONTRACTS §7 lists both as test-only variables and
      CONTRACTS §8 records the organization as the shared placeholder; until they are provisioned the probe stays
      skipped and ACC-02-03, ACC-02-08 and ACC-02-20 keep their unit-level proof (T5, T17, T52, T20) without
      claiming the live one.
      **Test**: with both variables exported in the shell,
      `cd packages/plugins/github && npx vitest run --config vitest.contract.config.ts`; the unit specs of T16–T21 then
      assert against the committed fixtures (ACC-02-03, ACC-02-08, ACC-02-20); with either variable unset the probe
      self-skips and the run is green.
      **Done when**: the probe's recorded responses are committed as fixtures and T16–T21's specs read them.

- [ ] **T45 (P1, lands with T12–T13). Classify new tables for workspace backup (R-25).**
      **Modify** `packages/agent/src/account-transfer/backup/collectors/domain-specs.ts` — append to the `works` domain,
      after `works.jsonl`:
      `{ file: 'upstream-states.jsonl', entity: 'WorkUpstreamState', scope: { by: 'parent', column: 'workId', from: 'workIds' } }`.
      `packages/agent/src/account-transfer/backup/redaction.ts` is **not** modified: no column of [plan §3.1](./plan.md)
      carries a credential or has a secret-shaped name, so nothing joins `BACKUP_DROPPED_ENTITIES` or the redaction
      maps.
      **Test**: extend `packages/agent/src/account-transfer/backup/collectors/collectors.spec.ts` — `WorkUpstreamState`
      is referenced exactly once, in the `works` domain, scoped `parent` on `workId` from `workIds`, and is not in
      `BACKUP_DROPPED_ENTITIES`; its planned query carries `within: { column: 'workId', ids }` with the registered Work
      ids, and yields nothing when no Work id was registered.
      **Done when**: `pnpm --filter @ever-works/agent test -- collectors redaction` is green with the entity registered,
      and a backup of a workspace holding one App Work lists `data/works/upstream-states.jsonl` with one record in
      `manifest.json`.

## P1.10 — Audit-pass additions (2026-09-17): automation, completion and closed sets

- [ ] **T46. The workflow-change hold on the sync path (FR-60, FR-61 — ACC-02-24).**
      **Create** `packages/agent/src/app-works/upstream-workflow-diff.ts` — a pure
      `workflowChanges(compareFiles): { paths: string[]; truncated: boolean }` over the compare result, matching
      `.github/workflows/**` at any depth (case-insensitive) and capping the reported paths at 100.
      **Modify** `packages/agent/src/app-works/app-upstream-sync.service.ts` — in plan §6.3, **before** the
      fast-forward decision and **before** the push to `ever-works/upstream-sync`: when `workflowChanges` is
      non-empty, do not fast-forward and do not push; persist `syncState = 'held_for_workflow_review'` with the
      changed paths, emit **no** `app.upstream.synced`, and return. The manual path, the scheduled path and any retry
      all take the same branch — there is no flag that skips it. When the member confirms (T47's route), the sync
      runs with the confirmation recorded; the Activity entry carries paths and counts only, never file content.
      **Modify** `apps/api/src/app-works/app-upstream.controller.ts` and
      `apps/api/src/works/dto/app-upstream.dto.ts` (created by T27) — `POST /api/works/:id/upstream/sync` accepts an
      optional `confirmWorkflowChanges: true`, refused with `409 workflow_confirmation_required` when the hold is
      active and the flag is absent; the refusal body names the changed paths.
      **Modify** `apps/web/src/components/works/app/AppUpstreamCard.tsx` (T30) — the hold row with **Review the
      changes** and **Sync anyway**, wired to the same action with the flag set.
      **Test**: **create** `packages/agent/src/app-works/__tests__/upstream-workflow-diff.spec.ts` (nested paths,
      case, the 100-path cap) and extend
      `packages/agent/src/app-works/__tests__/app-upstream-sync.service.spec.ts` — an incoming range that touches a
      workflow file performs **zero** fast-forward calls and **zero** pushes to `ever-works/upstream-sync`, while a
      range that does not touch one behaves exactly as before; confirming then performs the push once; a
      provider double proving no workflow-creating push happened before confirmation (ACC-02-24). Extend
      `apps/api/src/app-works/app-upstream.controller.spec.ts` — the missing flag is `409` with the paths, the flag
      proceeds. Extend `apps/web/src/components/works/app/AppUpstreamCard.unit.spec.tsx` — the hold row renders and
      **Sync anyway** sends the flag (ACC-02-24).
      **Done when**: the four specs are green and no test path can push a workflow-carrying range without the
      confirmation.

- [ ] **T47. Merged sync pull request finishes the sync (FR-62 — ACC-02-26).**
      **Modify** `packages/agent/src/entities/work-upstream-state.entity.ts` (T12), the migration (T13) and
      `packages/agent/src/database/repositories/work-upstream-state.repository.ts` (T14) — one new nullable
      `syncPullRequestCheckedAt: Date` column and `claimSyncPullRequestChecks(nowMs, minIntervalMs, limit)`
      mirroring `claimSetupPullRequestChecks`.
      **Create** `packages/agent/src/app-works/app-upstream-sync-pr.service.ts` — `checkSyncPullRequest(workId)`:
      `getPullRequestStatus` for `syncPullRequestNumber`, stamp `syncPullRequestCheckedAt`; **merged** ⇒ dispatch
      `app-upstream-sync` with `{ trigger: 'merged', mergedSha }`; **closed unmerged** ⇒ clear the pull-request
      fields and record `syncState = 'pull_request_closed'` without touching the tracked branch.
      **Modify** `packages/agent/src/app-works/app-upstream-sync.service.ts` — `trigger: 'merged'` runs the finish
      path and **not** the compare-and-open path: set `lastSyncedUpstreamSha` from the pull request's head and
      `lastSyncCommitCount` from the compare, clear `syncPullRequestNumber/Url/branch`, run
      `AppActionsHygieneService.apply` for the range only when the range changed a workflow file, and
      `AppLicenseService.request(workId, 'upstream_merged')`, each exactly once — guarded by a state compare so a
      re-dispatch is a no-op.
      **Modify** `packages/agent/src/app-works/app-upstream-sync-dispatcher.service.ts` (T28) — call
      `claimSyncPullRequestChecks(now, 600_000, 50)` per tick beside the setup-pull-request checks.
      **Test**: extend `packages/agent/src/app-works/__tests__/app-upstream-sync.service.spec.ts` (merged ⇒ sha,
      count, cleared fields, hygiene and license once; a second dispatch changes nothing; closed-unmerged ⇒ fields
      cleared and no hygiene) and
      `packages/agent/src/app-works/__tests__/app-upstream-sync-dispatcher.service.spec.ts` (≤ 50 checks per tick,
      the interval honoured), and extend `apps/api/src/app-works/app-upstream.controller.spec.ts` (`GET` fires the
      check in the background when a sync pull request is open and the stamp is older than 60 000 ms) — ACC-02-26.
      **Done when**: the three specs are green and the Upstream card no longer shows "Not synced yet" after a merged
      sync pull request.

- [ ] **T48. Private-copy divergence and sync through a plugin capability (FR-63 — ACC-02-27).**
      **Modify** `packages/plugin/src/contracts/capabilities/git-provider.app-forks.ts` (T9) and
      `packages/plugin/src/contracts/capabilities/git-provider.interface.ts` (T10) — add the optional
      `getRepositoryCopyDivergence?`: it takes the source and target coordinates plus `maxCommits`, and returns
      `aheadBy`, `behindBy`, `upstreamHeadSha` and a `capped` flag, with JSDoc stating the caller must materialise
      it first.
      **Modify** `packages/plugins/github/src/github-api.service.ts` and
      `packages/plugins/github/src/github.plugin.ts` — implement it with `GitOperations` (`fetch` into an isolated
      `cloneBranch` working copy, `findMergeBase`, capped `log`); **Create** the facade wrapper in
      `packages/agent/src/facades/git.facade.ts` (T22) that throws `GitOperationNotSupportedError` when the plugin
      lacks it.
      **Modify** `packages/agent/src/app-works/app-upstream-sync.service.ts` — the private-copy branch of plan §6.3
      calls the facade method for the counts and reuses
      `createRepositoryCopy({ branchName: 'ever-works/upstream-sync' })` for the push; **no agent-package code
      invokes git directly** (Constitution I).
      A provider without the capability ends in `syncState = 'provider_unsupported'` with its copy, not a crash.
      **Test**: extend `packages/plugins/github/src/__tests__/github-api.service.fork-sync.spec.ts` with a
      `GitOperations` double (ahead/behind direction, the `10000+` cap, `capped: true`) and
      `packages/agent/src/facades/__tests__/git.facade.app-forks.spec.ts` (absent ⇒ throws); extend
      `packages/agent/src/app-works/__tests__/app-upstream-sync.service.spec.ts` — a private copy syncs through the
      capability with the counts from it, and a provider without it pauses with `provider_unsupported`
      (ACC-02-27).
      **Done when**: `git grep -n "isomorphic-git" packages/agent/src/app-works` returns nothing and the three
      specs are green.

- [ ] **T49. Sync settings come from the App spec (FR-64 — ACC-02-28).**
      **Modify** `packages/agent/src/app-works/upstream-schedule.ts` (T26) — read every field from APW-03's
      effective spec through `AppSpecService.getEffectiveSpec(workId, branch)`; `enabled: false` ⇒ `nextSyncAt`
      stays `null` and the dispatcher never selects the row (manual **Sync now** still works), with
      `lastSyncReason = 'disabled_by_spec'` recorded; `branch` names the branch compared and merged, and FR-43's
      rename rule applies **only** when the branch was defaulted; the tracked branch is `spec.source.branch`.
      **Create** `apps/api/src/app-works/app-spec-applied.listener.ts` — an `@OnEvent('app.spec.applied')` handler
      **in the API process** that recomputes `syncSchedule` and `nextSyncAt` when `changedBlocks` includes
      `upstreamSync` or `source`, and re-dispatches nothing else.
      **Modify** `apps/api/src/app-works/app-works.module.ts` (T27) — register the listener; the agent
      `AppWorksModule` exports what it needs.
      **Test**: extend `packages/agent/src/app-works/__tests__/upstream-schedule.spec.ts` — the four field cases,
      including `enabled: false` ⇒ `null` and a configured `branch`; **create**
      `apps/api/src/app-works/__tests__/app-spec-applied.listener.spec.ts` — the schedule is recomputed for an
      `upstreamSync` or `source` change and left alone for any other block; extend
      `packages/agent/src/app-works/__tests__/app-upstream-sync.service.spec.ts` — a configured sync branch is the
      branch compared and merged (ACC-02-28).
      **Done when**: the three specs are green and `git grep -n "EVER_WORKS_APP_UPSTREAM" packages/agent/src` finds
      no environment fallback for these settings.

- [ ] **T50. Closed sets for readiness failure reasons, sync results and warning codes (FR-65 — ACC-02-29).**
      **Modify** `packages/contracts/src/apps/app-upstream.ts` (T11) — add `APP_READINESS_FAILURE_REASONS`,
      `APP_SYNC_REASONS` and `APP_UPSTREAM_WARNING_CODES` as `as const` tuples with their union types, one member
      per state: readiness `access_revoked` · `dispatch_unavailable` · `copy_refused` · `too_large` ·
      `provider_unsupported` · `timed_out` · `setup_pull_request_closed` · `handler_failed` · `blueprint_apply_failed`
      · `data_repository_missing`; sync results `up_to_date` · `fast_forwarded` · `pull_request_opened` ·
      `pull_request_updated` · `pull_request_merged` · `pull_request_closed` · `conflict` · `held_for_workflow_review`
      · `skipped_rate_limited` · `skipped_budget` · `license_worse` · `disabled_by_spec` · `paused` ·
      `provider_unsupported` · `failed`; warnings the ten spec §6.2 rows, camelCased. `AppUpstreamStateResponse`
      gains `readinessHandlerReason?: { code: string; permission?: string }` and every `warnings[]` entry carries
      `code: AppUpstreamWarningCode`. A provider failure is reported through the typed provider reason, never as
      `handler_failed:<code>`.
      **Modify** `packages/agent/src/app-works/app-upstream-state.service.ts` (T23) and
      `app-upstream-sync.service.ts` (T26) — write only members of those unions, and map every `GitProviderErrorReason`
      onto the matching member.
      **Modify** `apps/web/src/lib/work-kinds/app-upstream.ts` **(new)** — one camelCase i18n leaf per member of each
      union, and `AppUpstreamCard`/`AppUpstreamWarnings` read through it, so `app-upstream-warning-<code>` test ids
      and the leaf names derive from the same value.
      **Test**: extend `packages/contracts/src/apps/__tests__/app-upstream.spec.ts` — the three tuples pinned
      (append-only snapshot) and every member maps to an i18n leaf; extend
      `apps/web/src/components/works/app/app-upstream-messages.unit.spec.ts` (T35) — one leaf per member exists in
      all 21 locales and no leaf contains `.`; extend the sync and state service specs — every failure path writes a
      member and none writes a composed string (ACC-02-29).
      **Done when**: the four specs are green and the union sizes are asserted, not described.

- [ ] **T51. A gated fork gets exactly the build workflow enabled (FR-66 — ACC-02-30).**
      **Modify** `packages/agent/src/app-works/app-actions-hygiene.service.ts` (T25) — after the disabling pass,
      read the workflow list for the platform's own path (`ever-works-build.yml`, `.github/workflows/`) and its
      `state`; when the provider reports the fork's workflows as gated and that workflow is not `active`, call
      `setActionsPermissions` with `enableWorkflows: ['<the build workflow path>']` — **exactly that one path, never
      an inherited workflow, never a second one** — and record `buildWorkflowEnabled: true` on the state row.
      `FR-25`/`FR-26` are unchanged: every inherited workflow is still disabled and nothing else is enabled.
      **Modify** `packages/agent/src/entities/work-upstream-state.entity.ts` (T12) and the migration (T13) — one
      nullable boolean `buildWorkflowEnabled`.
      **Modify** the live contract probe `packages/plugins/github/src/__tests__/contract/app-forks.contract.ts`
      (T42) — **create a small repository that ships workflows, fork it, push a new push-triggered workflow through
      the API, and record whether it runs and whether an explicit enable call was required**; the recorded
      responses land as fixtures under `packages/plugins/github/src/__tests__/fixtures/app-forks/`, and the finding
      is written into APW-05's spec (a proposed change, since APW-05 is another epic's file) as the answer to
      "does the first Build on a fresh fork start?".
      **Test**: extend `packages/agent/src/app-works/__tests__/app-actions-hygiene.service.spec.ts` — a gated fork
      enables exactly one path, an ungated fork makes no enable call, and the manifest of the `enableWorkflows`
      argument equals exactly one entry in every case (ACC-02-30); the probe spec is skipped unless its two
      environment variables are set, exactly as today.
      **Done when**: the hygiene spec is green with the one-path assertion and the probe's recorded result is
      committed as a fixture with its verdict written down.

- [ ] **T52. Every fork request finds a renamed fork (FR-10, S2 — ACC-02-03).**
      **Modify** `packages/plugins/github/src/github-api.service.ts` — `forkRepository` resolves the target owner
      and the target name as it does today, then calls the **full** `findExistingFork` of [plan §4.3](./plan.md)
      (T17: same-name identity check, GraphQL fork-network search filtered to `owner.login == target`, REST
      `/repos/{o}/{r}/forks` fallback for at most 3 pages) **before** `POST /repos/{owner}/{repo}/forks`, and
      returns what it finds with `forkReadiness: 'ready'`. Today's name-only check stays as step (1) of that
      lookup — it is the cheap common case, not a separate path — so the change is additive: a fork that answers
      to `<target>/<name ?? repo>` is found by the same first call as before, and a fork the member **renamed**
      (which 404s on that call) is now found by step (2)/(3) instead of falling through to a create request.
      `waitForReady: false` (FR-12), the 24 × 5 s poll (FR-13), the identity rule (FR-11: `source` first, then
      `parent`, case-insensitive) and `forkTemplateForUser`'s behaviour are all unchanged; when steps (2) and (3)
      find nothing, the request proceeds to `POST /forks` exactly as it does today.
      **Modify** `packages/plugins/github/src/github.plugin.ts` and `packages/agent/src/facades/git.facade.ts` only
      if T17's plugin/facade exposure of `findExistingFork` is not already in place — no signature change and no
      new option.
      **Test**: extend `packages/plugins/github/src/__tests__/github-api.service.fork.spec.ts` (Octokit mocked) —
      a fork renamed to `me/tasks-fork` is returned with **zero** `createFork` calls and zero `repos.get` for
      `<target>/<upstream name>` beyond the first 404, proved by the mock's call log; a same-named **non-fork** is
      still not returned and still forks (FR-11); a fork of another upstream is still not returned; with the
      GraphQL call failing the REST `/forks` fallback finds the renamed fork within 3 pages and makes no fourth
      page request; nothing found ⇒ exactly one `createFork` call, unchanged; `waitForReady: false` still makes one
      POST and no poll (ACC-02-03).
      **Done when**: the spec is green, a renamed fork costs zero create requests, and
      `packages/agent/src/template-catalog/template-catalog.service.spec.ts` (the `forkTemplateForUser` caller)
      passes unchanged.

- [ ] **T53. The Upstream sync appears in the Schedules view (FR-32 — ACC-E2E-05).**
      ACC-E2E-05 asserts that "the Schedules view lists the Upstream sync with the spec's cron expression", and no
      task in any epic put it there: this epic runs sync from its own dispatcher (`app-upstream-sync-dispatcher`,
      §6.6) and the existing Schedules surface aggregates **seven** sources — recurring Tasks, Agent heartbeats,
      Work schedules, Mission ticks, item source-validation, data-sync polling and inbound triggers
      (`packages/agent/src/schedules/schedules.service.ts:163`, `schedule-view.types.ts:1-13`). This adds an eighth
      source rather than a second schedules surface.
      **Modify** `packages/agent/src/schedules/schedule-view.types.ts` — append `'app_upstream_sync'` to
      `ScheduleSourceType` and `'app_work'` to `ScheduleOwnerType`. Both are **appends**: every existing member,
      every switch over them and every existing row keeps its behaviour.
      **Modify** `packages/agent/src/schedules/schedules.service.ts` — project the new source beside the seven
      existing ones, with its own try/catch like each of them: one **read-only** row per App Work whose
      `WorkUpstreamState.nextSyncAt` is set — `sourceType: 'app_upstream_sync'`, `ownerType: 'app_work'`,
      `ownerId` = the Work id, `id` = `app_upstream_sync:<workId>` (the existing synthetic-key convention), the
      schedule string = the App spec's `upstreamSync.schedule` (or `'0 6 * * 1'` when the spec sets none — the same
      value §6.4 computes `nextSyncAt` from), `nextRunAt` = `nextSyncAt`, `status` = `active`, or `paused` when the
      row is paused (`upstreamStatus` `archived`/`unavailable`, or `dataRepositoryStatus` `missing`).
      **Modify** `packages/agent/src/schedules/schedule-control.service.ts` — `SOURCE_TYPES` gains the member, and
      `runNow` for it delegates to this epic's existing `POST /api/works/:id/upstream/sync` (FR-33's 6-per-hour cap
      and its refusal apply unchanged). Pause, resume, edit, duplicate and reassign are **not offered** for the
      source, with their reason, because the schedule is spec-owned and the dispatcher is the only writer — the
      existing controls for the other seven sources are untouched.
      **Modify** `apps/web/src/lib/api/schedules.ts` — mirror both unions;
      `apps/web/src/components/schedules/SchedulesList.tsx` and `SchedulesFilters.tsx` — the row renders the cron
      and the next-run time with `dashboard.schedules.sourceTypes.appUpstreamSync` and
      `dashboard.schedules.entityKinds.appWork` (plan §8).
      **Test**: extend the schedules service spec — an App Work with `nextSyncAt` yields exactly one row carrying the
      spec's cron and next-run time; an App Work with `nextSyncAt` null (a link, or a paused row) yields none or a
      `paused` row respectively; `runNow` dispatches the upstream sync and nothing else; an unreadable
      upstream-state source degrades to an empty slice while the other seven sources still return their rows; extend
      `apps/web/src/components/schedules/SchedulesWorkspace.unit.spec.tsx` and the filters spec — the row shows its
      cron and next-run time, offers **Sync now** only, and the new chip does not change any existing count
      (ACC-E2E-05).
      **Done when**: the Schedules view lists the Upstream sync with the spec's cron expression for a ready App Work,
      and no other source's rows, counts or filters changed.

---

## Definition of Done

- Every checkbox above is ticked.
- `pnpm format:check`, `pnpm lint`, `pnpm type-check`, `pnpm test` and `pnpm build` are green from the root.
- P0 merged on its own with no migration, route, job or UI change, and every pre-existing clone and fork caller's specs
  unchanged.
- No code path in this epic pushes to an upstream, force-pushes a tracked branch, merges or edits a setup pull request, or
  resolves a merge conflict (asserted by the sync service and state service specs' provider doubles recording every write).
- `work_upstream_states` migrates forward and back cleanly; the dispatcher arity is 16 (14 on `e5f43f44d` plus two).
- Exactly one Upstream tab and route exist; APW-09 adds a section to it, never a second tab.
- ACC-02-01 … ACC-02-30 are each covered by an automated test here or listed as a live scenario in
  [ACCEPTANCE.md](../ACCEPTANCE.md) for APW-13.
- A workflow-carrying upstream range can never fast-forward and can never reach the sync branch without the
  member's confirmation (asserted by the sync spec's provider double recording every write).
- Every gate in [plan §12](./plan.md) is confirmed, and its carried-forward gaps are still recorded there.
