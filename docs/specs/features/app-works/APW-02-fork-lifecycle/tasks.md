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
  T15, T27, T43 and T44. T43–T44 were added by the program audit.
- Phase boundaries are ship boundaries: `develop` must be green and deployable at the end of each phase.
- **P0 is independently shippable** on branch `feat/apw-02-fork-lifecycle-p0` and touches no table, route, job or UI;
  P1 ships on `feat/apw-02-fork-lifecycle`.
- **Program audit resolutions** ([CONTRACTS §0](../CONTRACTS.md#0-program-audit-resolutions-binding--2026-09-17-against-develop--ee45946e5))
  applied here: R-1 (T11), R-2 (T15), R-4 (T43), R-8 (T30, T36), R-14 (T2 — generic fixtures only), R-21 (T23), R-22
  (no suite under `apps/api/test/`).
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
      `expectExisting?`; the `cloneOrPull` coalescing key appends `cloneOptions.checkoutKey ?? ''`; `getLocalDir` /
      `removeLocalDir` accept and forward the key.
      **Test**: extend `packages/plugins/github/src/__tests__/github.plugin.spec.ts` (forwarding) and **create**
      `packages/agent/src/facades/__tests__/git.facade.checkout-key.spec.ts` — two calls with different keys for one repo
      do not coalesce; two identical calls do (ACC-02-01).
      **Done when**: `pnpm --filter @ever-works/agent test` is green.

- [ ] **T5. Fork requests find the real existing fork and can return immediately.**
      **Modify** `packages/plugins/github/src/github-api.service.ts` — `forkRepository` always resolves the target owner
      and checks `<target>/<name ?? repo>`; returns it only when `fork === true` and `source.full_name` (else
      `parent.full_name`) equals `owner/repo` case-insensitively, with `forkReadiness` from its default-branch head;
      `waitForReady === false` returns the mapped `POST /forks` response with `forkReadiness: 'pending'`; the default
      keeps the 24 × 5 s poll.
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
      by owner, REST forks fallback ≤ 3 pages).
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
      notification; an open labelled Task is commented, not duplicated (ACC-02-11); `timeout` once per attempt and
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
      **Modify** `packages/tasks/src/tasks/trigger/index.ts` and
      `packages/tasks/src/trigger/worker/modules/trigger-worker.module.ts` — export / provide `AppUpstreamSyncService`.
      **Test**: **create** (new directory) `packages/tasks/src/tasks/trigger/__tests__/app-upstream-sync.task.spec.ts` —
      payload forwarded to `AppUpstreamSyncService.run`; drained credentials skip.
      **Done when**: `cd packages/tasks && npx vitest run src/tasks/trigger/__tests__/app-upstream-sync.task.spec.ts` is green.

- [ ] **T34. `app-upstream-sync-dispatcher` cron.**
      **Create** `packages/tasks/src/tasks/trigger/app-upstream-sync-dispatcher.task.ts` — `schedules.task` on
      `'*/10 * * * *'` with the five-field validation and fallback copied from `data-repo-sync-dispatcher.task.ts`, calling
      `APP_UPSTREAM_SYNC_DISPATCHER_SERVICE.dispatchDue()` and returning the counters.
      **Modify** `packages/tasks/src/tasks/trigger/index.ts` — export.
      **Test**: **create** (new directory) `packages/tasks/src/tasks/trigger/__tests__/app-upstream-sync-dispatcher.task.spec.ts` —
      invalid override falls back to the default cron.
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
      **Modify** `packages/agent/src/app-works/app-fork-readiness.service.ts`,
      `packages/agent/src/app-works/app-actions-hygiene.service.ts`, `packages/agent/src/app-works/app-upstream-sync.service.ts`,
      `packages/agent/src/app-works/app-upstream-sync-dispatcher.service.ts` and `packages/plugin/src/git/git-operations.ts`
      (the `RepositoryNotReadyError` path) — wire the six events of [plan §9.1](./plan.md) through the monitoring package.
      **Test**: **create** `packages/agent/src/app-works/__tests__/app-upstream.telemetry.spec.ts` — each event emitted once
      per outcome; no payload contains a repository name, owner, file path, commit message or token.
      **Done when**: the spec is green.

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
      **Test**: with both variables exported in the shell,
      `cd packages/plugins/github && npx vitest run --config vitest.contract.config.ts`; the unit specs of T16–T21 then
      assert against the committed fixtures (ACC-02-03, ACC-02-08, ACC-02-20).
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
- ACC-02-01 … ACC-02-23 are each covered by an automated test here or listed as a live scenario in
  [ACCEPTANCE.md](../ACCEPTANCE.md) for APW-13.
- Every gate in [plan §12](./plan.md) is confirmed, and its carried-forward gaps are still recorded there.
