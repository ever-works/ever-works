# Task Breakdown: Builds

> Ordered tasks derived from [`plan.md`](./plan.md). Each is small enough to land in one PR and ships with tests per
> **Constitution VI**. The schema tasks ship their migrations in the same PR per **Constitution V**.

**Epic ID**: `APW-05-builds`
**Spec**: [`./spec.md`](./spec.md) · **Plan**: [`./plan.md`](./plan.md)
**Status**: `Draft`
**Last updated**: 2026-09-17

---

## How to use

- Tasks are **sequential by default**. `(parallel)` means it may run alongside its predecessor.
- Every task names the exact files to create or modify. An implementer should never have to guess a path. Paths not
  marked "(create if absent)" under **Modify** exist on `develop` @ `ee45946e5`.
- Every task has a **Test** line (a file and what it asserts, or the command that is the test) and a **Done when**
  line that is checkable without reading the diff. `(ACC-05-nn)` tags name the spec §8 criteria a Test line proves.
- Add new tasks at the bottom rather than renumbering.
- Phase boundaries are ship boundaries: `develop` must be green and deployable at the end of each phase.
- Repo commands run from the monorepo root unless a task says otherwise. Migrations are authored from `apps/api/`.
  Package filters: `@ever-works/contracts`, `@ever-works/plugin`, `@ever-works/agent`, `ever-works-api`,
  `ever-works-web`, `@ever-works/trigger-tasks`, `@ever-works/github-actions-build-plugin` (new, T7).
- API behaviour is tested by controller/service specs under `apps/api/src/**` or Playwright specs under `apps/web/e2e/`
  — never `apps/api/test/` (Resolution R-22).
- **Cross-epic prerequisites** (do not implement here): APW-03's effective App spec + `WorkAppSpecState` and
  `app.spec.applied`; APW-07's `AppEnvResolver.resolveForBuild`, `AppEnvService.buildRedactor` and the ephemeral recipe
  of `AppRuntimeEnvSource` (R-10); APW-02's `setActionsPermissions?`; APW-01's `WorkCapabilities.builds` (R-7);
  APW-13's fixture branches (R-23). **Added 2026-09-17 (`APW05-G06`):** APW-03 T22's `IGitProviderPlugin.commitFiles?`
  and its `GitFacadeService` wrapper (the only clone-free write — T9, T16, T19), and APW-06 T3's
  `packages/agent/src/app-runtime/ports.ts` (`AppImagePullCredentialSource` /
  `APP_IMAGE_PULL_CREDENTIAL_SOURCE` for T16; `AppRuntimeEnvSource` / `APP_RUNTIME_ENV_SOURCE` for T43). Both merge in
  the Wave 1 foundations (TRACKER), ahead of this epic's T9/T16/T19. Unit tests use a fake `RepositoryWriter` and fake
  port objects; production bindings in T16, T19 and T43 are not merged, and the port files are neither re-declared nor
  copied, until APW-03 T22 and APW-06 T3 are on `develop`. This epic never modifies `git.facade.ts` or `ports.ts`.
  Until they land, T16–T22 and T43 run against the typed fakes named in each task.
- **Cross-epic prerequisite claimed by this epic** (added 2026-09-17, `APW05-G01`/`GAP-07`): APW-05 is the only caller of
  APW-02's `createWebhook?` / `deleteWebhook?`. T19a installs the `workflow_run` hook and T19a's release path removes it;
  no other epic calls either method.

---

# Phase P1 — Builds on GitHub-hosted runners

_Delivers spec FR-1…FR-54 and FR-60…FR-70: the workflow file, build values as secrets, build services, runner
selection, digests, deployability, diagnosis, receipts, pull tokens, runner verification, App checks, the Builds tab._

## P1.1 — Contracts

- [ ] **T1. App build contracts.**
      **Create** `packages/contracts/src/apps/builds.ts` with the unions `APP_BUILD_STATUSES`,
      `APP_BUILD_TRIGGERS`, `APP_BUILD_FAILURE_CLASSES` (14), `APP_BUILD_BLOCKED_REASONS` (15),
      `APP_BUILD_NOT_DEPLOYABLE_REASONS` (9), `APP_BUILD_STRATEGIES` (`dockerfile`, `image`, `auto`, `none` —
      Resolution R-13), their types, `AppBuildSummary`, `AppBuildDetail` (receipt incl. `checksBillableMinutes`),
      `AppBuildVerificationResult`, and every constant in [plan §3.2](./plan.md) with exactly those values, including
      `APP_BUILD_CHECK_NAME_PREFIX`, `APP_BUILD_CHECKS_MAX`, `APP_BUILD_CHECKS_MAX_PARALLEL` and
      `APP_BUILD_VERIFY_PROMPTED_SECRET`.
      **Modify** APW-03's barrel `packages/contracts/src/apps/index.ts` to `export * from './builds.js';` (create it,
      and its export from `packages/contracts/src/index.ts`, only if APW-03 has not landed — Resolution R-1).
      **Test**: `packages/contracts/src/apps/__tests__/builds.spec.ts` — pins each union (a member cannot be added
      without editing the test); `APP_BUILD_STRATEGIES` contains no builder product name; asserts every numeric constant
      (`50`, `48_000`, `8`, `10_000`, `10`, `60_000`, `90_000`, `200`, `300_000`, `30`, `20`, `300`, `2_097_152`, `8_192`,
      `2`, `16`, `7`, `30`, `12`, `60_000`, `14`, `20`, `100`, checks `20` and `5`), the workflow path string and the check
      name prefix `Ever Works check: `.
      **Done when**: `pnpm --filter @ever-works/contracts test` is green, `pnpm --filter @ever-works/contracts build`
      emits declarations and `apps/api` imports `AppBuildSummary` from `@ever-works/contracts`.

- [ ] **T2 (parallel with T1). `build` capability and category.**
      **Create** `packages/plugin/src/contracts/capabilities/build.interface.ts` exactly as [plan §4.1](./plan.md),
      including `BuildStrategy` with `auto`, `PrepareRepositoryInput.checks`, `VerificationPlan.promptedNames`,
      `BuildSnapshot.checksBillableMinutes`, `isBuildPlugin` and the optional `checkImageAccess?`.
      **Modify** `packages/plugin/src/contracts/capabilities/index.ts` — `export * from './build.interface.js';`.
      **Modify** `packages/plugin/src/contracts/facade-capabilities.ts` — add `BUILD: 'build'` with a comment citing APW-05.
      **Modify** `packages/plugin/src/contracts/plugin-manifest.types.ts` — append `'build'` to `PLUGIN_CATEGORIES`.
      **Test**: `packages/plugin/src/contracts/__tests__/build-capability.spec.ts` — `isValidPluginCapability('build')`,
      `isPluginCategory('build')`, `isBuildPlugin` true/false, and that no existing capability or category was removed
      (snapshot of the previous members).
      **Done when**: `pnpm --filter @ever-works/plugin test` is green.

- [ ] **T3 (parallel with T1). `builds` Work capability — consume only.**
      **No change** to `packages/contracts/src/domain/work-capabilities.ts`: APW-01 T3 adds `readonly builds: boolean`
      (`true` for `app`, `false` for every other kind) and its spec pins (Resolution R-7). This epic only reads
      `getWorkCapabilities(work.kind).builds` (T25's Builds tab) and never declares or defaults the field.
      **Test**: `git grep -n "builds" packages/contracts/src/domain/work-capabilities.ts` shows APW-01's field, and no
      APW-05 change touches that file or its spec.
      **Done when**: APW-01 T3 is merged and `pnpm type-check` passes for web and API against it.

## P1.2 — Entity, table, migration

- [ ] **T4. `WorkBuild` entity.**
      **Create** `packages/agent/src/entities/work-build.entity.ts` with every column of [plan §3.1](./plan.md) (incl.
      `checksBillableMinutes`, `verifySecretNames` and the `syncOrigin`/`syncFromSha`/`syncToSha` trio APW-04 and APW-06
      read — `APW04-G06`), `TimestampColumn` from `packages/agent/src/entities/_types.ts`
      for timestamps, `ManyToOne(() => Work, { onDelete: 'CASCADE' })`, Tier A `tenantId`/`organizationId` without
      relations, and the five indexes.
      **Create also** `packages/agent/src/entities/work-build-preparation.entity.ts` — every column of
      [plan §3.1b](./plan.md), the unique `(workId)` index `uq_work_build_preparations_work`, the same
      `TimestampColumn`/`ManyToOne(Work, CASCADE)`/Tier A treatment and **no** API route that writes it
      (`APW05-G03`).
      **Modify** `packages/agent/src/entities/index.ts`, `packages/agent/src/database/_entity-names.ts` (`'WorkBuild'`,
      `'WorkBuildPreparation'`),
      `packages/agent/src/database/_entities-inventory.ts` (import + `ENTITIES`).
      **Test**: `packages/agent/src/entities/__tests__/work-build.entity.spec.ts` — index names, uniqueness flags, the
      plain `UNIQUE` on `(buildPluginId, providerRunId, runAttempt)` with **no** partial `WHERE` (so the same DDL works on
      Postgres, SQLite, MySQL and MariaDB — `APW05-G10`), both scope columns present; and
      `packages/agent/src/entities/__tests__/work-build-preparation.entity.spec.ts` — the unique `workId` index, the
      `webhookState`/`workflowState` defaults, both scope columns.
      **Done when**: `pnpm --filter @ever-works/agent test -- work-build.entity work-build-preparation.entity` is green
      and the drift specs `packages/agent/src/database/database.module.spec.ts` and
      `packages/agent/src/database/database.config.spec.ts` pass without editing a magic number.

- [ ] **T5. Migration.**
      **Create** `apps/api/src/migrations/1792050000000-CreateWorkBuilds.ts` (generate the skeleton with
      `cd apps/api && pnpm typeorm migration:generate -d typeorm.config.ts src/migrations/CreateWorkBuilds`, then re-stamp
      the class name/timestamp to the APW-05 block). It creates **both** `work_builds` and `work_build_preparations`
      ([plan §3.1b](./plan.md)) with their FKs and all six indexes, declared through TypeORM `TableIndex` — no raw
      double-quoted SQL and no partial index anywhere (`APW05-G10`). `down()` drops only those two tables.
      **Test**: `apps/api/src/migrations/__tests__/CreateWorkBuilds.spec.ts` — `up()` creates both tables, their FKs and
      the six indexes; `down()` removes only them; the file contains no `ALTER TABLE` on a pre-existing table and no
      driver branch.
      **Done when**: `pnpm --filter ever-works-api test -- CreateWorkBuilds` is green, a fresh Postgres, a fresh SQLite
      **and** a fresh MySQL/MariaDB database all migrate up and down cleanly, and the timestamp is above the newest
      migration on `develop`.

- [ ] **T6. `AppBuildRepository`.**
      **Create** `packages/agent/src/database/repositories/app-build.repository.ts` with `insertWithNextNumber(workId, data,
      { stampFromPreparation })` (transaction; the Work-row pessimistic lock on postgres/mysql/mariadb with
      `loadEagerRelations: false`, skipped on the SQLite family; `MAX(number)+1` through the query builder with no
      `FOR UPDATE`; 3 retries on a unique violation, detected across drivers as `CreditLedgerRepository.isUniqueViolation`
      does — plan §3.1, `APW05-G10`), `upsertByProviderRun`, `findPage(workId, filters,
page, pageSize)`, `findByIdForWork`, `findRecentForCommit(workId, sha, sinceMs)`, `claimWatchLease(id, ms)` through the
      query builder with a parameterised `:now`/`:until`, `findSilentNonTerminal(now, silenceMs, limit)`,
      `findWithOrphanedVerifySecrets(now, limit)`, `markLost(ids)`.
      **Create also** `packages/agent/src/database/repositories/app-build-preparation.repository.ts` with `findByWork` and
      `upsertAfterPrepare` (`APW05-G03`).
      **Modify** `packages/agent/src/database/index.ts` to export both.
      **Test**: `packages/agent/src/database/repositories/__tests__/app-build.repository.spec.ts` — 20 concurrent
      `insertWithNextNumber` calls yield numbers 1…20 with no gap or duplicate; `stampFromPreparation` copies
      `buildInputsHash`, `buildSecretNames` and `secretsSyncedAt` from the preparation row, and an absent row leaves all
      three NULL; lease claim returns 0 rows for a live lease;
      silent-build query honours the 90 s silence and the 200 limit, oldest first; orphaned-verify-secret query selects only
      verification Builds older than 40 minutes with a non-empty `verifySecretNames`.
      `apps/api/src/migrations/__tests__/query-shape.spec.ts` (or the existing query-shape precedent) asserts no
      double-quoted raw SQL and no `interval '` literal in either repository, so the MySQL/MariaDB rule of `b5a7d6857` is
      enforced by a test rather than by review (`APW05-G10`).
      **Done when**: `pnpm --filter @ever-works/agent test -- app-build.repository app-build-preparation.repository` is
      green on SQLite and on the Postgres test container.

## P1.3 — The `github-actions-build` plugin

- [ ] **T7. Package scaffold and settings.**
      **Create** `packages/plugins/github-actions-build/` — `package.json` (name `@ever-works/github-actions-build-plugin`,
      `everworks.plugin` block from [plan §4.3](./plan.md), deps `octokit`, `libsodium-wrappers`, `fflate`; `tsup`,
      `vitest` scripts copied from `packages/plugins/k8s/package.json`), `tsconfig.json`, `tsup.config.ts`,
      `vitest.config.ts`, `src/index.ts`, `src/settings.schema.ts` ([plan §4.4](./plan.md), `pullToken` with
      `x-secret: true` and `x-platformManaged: true`, `pullTokenExpiresAt` `x-platformManaged: true`, and the two new
      Work-scope booleans `allowBuildValuesOnPullRequests` (default `false`) and
      `verificationPromptedValuesRequireApproval` (default `true`) — `XC-01`), `src/github-actions-build.plugin.ts`
      (id, category `build`, capability `build`,
      `buildKind: 'github-actions'`, `supportedStrategies: ['dockerfile']` — `auto` is not supported, R-13 — method stubs
      throwing `not implemented`; **no `validateSettings` for `pullToken`** — the check is
      `AppBuildPullTokenService`, plan §4.12, `APW05-G07`).
      **Test**: `packages/plugins/github-actions-build/src/__tests__/plugin.manifest.spec.ts` — manifest
      id/category/capabilities; `pullToken` is `x-secret` and `x-platformManaged`; `attestations` defaults `false`;
      `reclaimDisk` defaults `true`; `supportedStrategies` excludes `auto`; **the schema declares no preparation key**
      (`workflowSha256`, `workflowPullRequestNumber`, `webhookId`, `runsEtag`, `repositoryBlock` are absent —
      `APW05-G03`), and `validateSettingsScope` refuses `pullToken` and `pullTokenExpiresAt` at every scope
      (`APW05-G07`).
      **Done when**: `pnpm --filter @ever-works/github-actions-build-plugin test` is green and plugin discovery lists
      `github-actions-build` at API boot in development.

- [ ] **T8. Workflow generator and action pins.**
      **Create** `packages/plugins/github-actions-build/src/workflow/generator.ts`, `src/workflow/inputs-hash.ts`,
      `src/workflow/action-pins.ts` (`checkout`, `setupBuildx`, `login`, `buildPush`, `uploadArtifact` — 40-hex commit
      hashes resolved at implementation time, release tag in a trailing comment) implementing [plan §2.4 and
      §4.5](./plan.md): header lines, triggers, `permissions: {}`, concurrency expression, pull-request guard, services with
      health options, check-values step, checkout, disk reclaim, buildx (network host only with services), login, build
      (`load: true`, `push: false`, `provenance: false`), secret check, push + digest capture, verify step, result write,
      upload. (The `checks` job is T41.)
      **Test**: `packages/plugins/github-actions-build/src/__tests__/generator.spec.ts` — golden files under
      `src/__tests__/golden/` for 6 fixtures (minimal; args with `value` + `fromEnv`; services postgres + redis; private
      repo with larger runner; attestations on; branch `feature/x` slug); byte equality on two runs (ACC-05-03); LF
      endings; for each fixture every build value string supplied to the test is **absent** from the output and the build
      job reads `EW_` secrets only as `${{ secrets.EW_* }}` references (ACC-05-05); the build job's `if:` refuses pull
      requests whose head repository differs **and** excludes `inputs.ew_mode == 'verify'` (`APW05-G02`), and no job that
      references `secrets.` or pushes runs for them (ACC-05-06); tags `sha-${{ env.EW_SHA }}` + `branch-<slug>` for push
      and `pr-<n>` for pull requests, never `latest` (ACC-05-07); `cache-to` only on push; the concurrency block sets
      `cancel-in-progress` only for `pull_request`, groups the tracked branch by ref, and gives a verification its own
      `verify-<buildId>` group (`APW05-G02`); the services golden declares the `postgres` service **with the
      `BUILD_SERVICE_DEFAULTS` env (`POSTGRES_USER`/`POSTGRES_PASSWORD`/`POSTGRES_DB`), the published `5432` port and
      `pg_isready` health**, and a build-arg resolving to `127.0.0.1` (ACC-05-12, `APW05-G08`); the `build` job's
      `timeout-minutes` equals `build.resources.timeoutMinutes` with no verification bonus, and only the `verify` job adds
      30 (`APW05-G22`).
      **Also add four goldens (`APW05-G02`, `G08`, `XC-01`):** `verify-bootstrap` (dispatch-only: no `build` job, no
      `checks` job, no `secrets.EW_` except `EW_VERIFY__PROMPTED`, no `push` or `pull_request` trigger);
      `verify-job` (`permissions` exactly `contents: read, packages: read`, no `docker push`, `--push` or `cache-to`, the
      `ew_reuse_digest` input, the `verify-<buildId>` concurrency group); `services-postgres-defaults` (an undeclared
      `env` still yields the three defaults and the published container port); and `restricted-values` (a same-repository
      pull request's `fromEnv` argument is the throwaway marker with **no** `secrets.EW_` reference, while the same file's
      push path keeps `${{ secrets.EW_<NAME> }}` — ACC-05-31).
      `packages/plugins/github-actions-build/src/__tests__/action-pins.spec.ts` — every pin matches `^[0-9a-f]{40}$`
      (ACC-05-05).
      **Done when**: `pnpm --filter @ever-works/github-actions-build-plugin test -- generator action-pins` is green and the
      golden workflow for the minimal fixture passes `actionlint` locally.

- [ ] **T9. Branch protection and workflow writer.**
      **Create** `packages/plugins/github-actions-build/src/repo/branch-protection.ts` (the classic endpoint: 404 →
      unprotected; 200 with reviews or status checks → protected; 403 → protected; **plus** `GET
/repos/{o}/{r}/rules/branches/{branch}`, where an active `pull_request` or `required_status_checks` rule also means
      protected, so a ruleset-only branch is not mistaken for an open one — `APW05-G16`) and
      `src/repo/workflow-writer.ts` (through the
      `RepositoryWriter` parameter only — APW-03's `commitFiles?` via the facade; pull-request path on
      `ever-works/build-workflow` with one reused pull request; read-back sha256 compare with one retry; hand-edit detection
      against `lastWrittenWorkflowSha256`; `nonFastForward` retries ≤ 3; **`refRejectedByRule` switches once to the pull
      request path and never loops** — plan §4.6 step 2, `APW05-G16`; `createdByAppWork: false` (Link) always takes the
      pull request path — Resolution R-4; **the bootstrap file of plan §4.6 step 0**, which is delivered by these same
      rules and sets `workflowState` without ever looking like a hand edit — `APW05-G02`).
      **Test**: `packages/plugins/github-actions-build/src/__tests__/workflow-writer.spec.ts` with a fake
      `RepositoryWriter` — no clone call exists; direct commit on an unprotected fork changes exactly the one workflow path
      (ACC-05-01); pull request on a protected branch and on `createdByAppWork: false`; **a ruleset-protected branch whose
      legacy endpoint answers 404 takes the pull request path**, and a direct write refused with `refRejectedByRule`
      falls back to the pull request path exactly once (`APW05-G16`); a second and third preparation
      update the same pull request so one stays open (ACC-05-02); read-back mismatch → retry → `workflowWriteFailed`;
      hand-edited file → `editedByHand` + pull request, never an overwrite on the tracked branch (ACC-05-04); unchanged
      content → `unchanged` and zero write calls; **a branch with no workflow at all gets exactly one bootstrap commit
      whose content carries only the `verify` job, and a Link-relation App Work gets `workflowPending` plus the pull
      request URL and zero commits** (`APW05-G02`, ACC-05-02).
      **Done when**: `pnpm --filter @ever-works/github-actions-build-plugin test -- workflow-writer` is green and no code
      path calls a force update on the tracked branch.

- [ ] **T10. Secret sync.**
      **Create** `packages/plugins/github-actions-build/src/repo/secret-sync.ts` — refuse > 50 values
      (`tooManyBuildValues`) or a value > 48,000 bytes (`buildValueTooLarge`, name only) or an env name mapping onto
      `APP_BUILD_VERIFY_PROMPTED_SECRET` (`buildValueNameReserved`); one public-key fetch; libsodium sealed box per value
      (same sequence and name validation as `packages/plugins/github/src/github-actions.service.ts`); delete only
      `previouslyWrittenSecretNames` no longer referenced; map the repository secret-limit error to `secretLimitReached`;
      compute `buildInputsHash`; `writeVerifyPromptedSecret(values)` / `deleteVerifyPromptedSecret()` for §4.10.
      **Test**: `packages/plugins/github-actions-build/src/__tests__/secret-sync.spec.ts` — the three limits and the
      reserved name; removal set arithmetic (never deletes a name not previously written, even if it starts with `EW_`);
      every `fromEnv` name is `PUT` before `startBuild` would be called (ACC-05-13); hash stable under value order; the
      verify secret is one JSON secret ≤ 48 KB and is deleted by name; no value appears in any thrown error message or
      logger call (spy on the logger).
      **Done when**: `pnpm --filter @ever-works/github-actions-build-plugin test -- secret-sync` is green.

- [ ] **T11 (parallel with T10). Runner selector.**
      **Create** `packages/plugins/github-actions-build/src/runner/runner-selector.ts` — public → `githubPublic`; private →
      `largerRunnerLabel` when set (memory from `largerRunnerMemoryGiB`) else `githubPrivate`; block `runnerTooSmall` with
      `{ needed, max }` when `memoryGiB > memory − 2`; CPU above vCPU → warning flag only.
      **Test**: `packages/plugins/github-actions-build/src/__tests__/runner-selector.spec.ts` — 14 GiB public allowed,
      15 GiB public blocked, 5 GiB private allowed, 6 GiB private blocked, 12 GiB private with no larger runner blocked with
      `{ needed: 12, max: 5 }` (ACC-05-22), 12 GiB private with a 32 GiB larger runner allowed, label without memory
      rejected by settings validation.
      **Done when**: `pnpm --filter @ever-works/github-actions-build-plugin test -- runner-selector` is green.

- [ ] **T12. Run correlation, observation and the result artifact.**
      **Create** `packages/plugins/github-actions-build/src/runs/run-correlator.ts` (dispatch-time window −5 s,
      `display_title` contains the Build id, adoption window 5 minutes), `src/runs/run-observer.ts` (run + jobs →
      `BuildSnapshot`; minutes = Σ ceil per job; `checksBillableMinutes` = the subset whose job name starts with the check
      prefix; only the `build` job decides status; pull-request head sha; failing step name/number),
      `src/runs/result-artifact.ts` (artifact lookup by name, zip ≤ 64 KB refused above, `fflate.unzipSync`, JSON ≤ 8 KB,
      strict schema, digest regex), **and `src/runs/run-lister.ts`** implementing
      `IBuildPlugin.listRecentRuns?` (`APW05-G01`): `GET /repos/{o}/{r}/actions/workflows/{file}/runs?per_page=20` with
      `If-None-Match` from the stored ETag, newest first, mapping each run to `BuildRunRef`; 304 → `notModified: true`.
      **Modify** `packages/plugins/github-actions-build/src/github-actions-build.plugin.ts` — implement `startBuild`
      (workflow dispatch **on the tracked branch** with `ew_build_id`, `ew_sha`, `ew_mode`, `ew_verify_plan` ≤ 60,000
      chars and `ew_reuse_digest`, retrying a 404/422 for up to 60 s after a bootstrap commit so a just-added workflow
      file is dispatchable — `APW05-G02`), `getBuild`,
      `cancelBuild`, `getLogsUrl`, `listRecentRuns`.
      **Test**: `packages/plugins/github-actions-build/src/__tests__/run-correlator.spec.ts` (adoption by `display_title`
      inside the window, none outside it); `run-observer.spec.ts` (two jobs 61 s + 30 s → 3 minutes and a receipt payload
      carrying them — ACC-05-20; a failed `Ever Works check: lint` job with a succeeded `build` job → snapshot
      `succeeded`, `checksBillableMinutes` 1 — ACC-05-29; pull request run reports head sha not merge sha; a run that
      stays `in_progress` across two polls and then `completed` maps each status — ACC-05-11; `cancelBuild` calls the
      cancel endpoint and a `cancelled` conclusion maps to `cancelled` — ACC-05-09; tags reported without `latest` —
      ACC-05-07); `result-artifact.spec.ts` (oversize zip, malformed digest, extra keys rejected);
      `run-lister.spec.ts` (`per_page` ≤ 20, a 304 maps to `notModified`, fields map to `BuildRunRef`, a fork pull
      request's head repository is reported — `APW05-G01`).
      **Done when**: `pnpm --filter @ever-works/github-actions-build-plugin test -- run-correlator run-observer result-artifact`
      is green.

- [ ] **T13. Failure classifier and excerpt.**
      **Create** `packages/plugins/github-actions-build/src/runs/failure-classifier.ts` (the 11-row ordered table in
      [plan §4.9](./plan.md)) and `src/runs/log-tail.ts` (last 2 MiB via `Range`, split, apply the facade's `redact`, then
      mask secret-shaped strings, cut to 20 lines × 300 chars ending at the matched line).
      **Test**: `packages/plugins/github-actions-build/src/__tests__/failure-classifier.spec.ts` — one fixture log per class
      under `src/__tests__/fixtures/logs/`; `outOfMemory` (exit 137), `dockerfileError` (step, total, 120-char command),
      `missingBuildValue` (from `EW_MISSING:<NAME>` in the first step, ACC-05-14), `secretInImage` (from
      `EW_SECRET_IN_IMAGE:<NAME>`, ACC-05-15), `timeout` and `diskFull` each classify with their `failureDetail`
      (ACC-05-17); precedence (a log with both `exit code: 137` and a Dockerfile step classifies `outOfMemory`); excerpt ≤ 20
      lines × 300 chars and a known value inside the log becomes `***` (ACC-05-18).
      **Done when**: `pnpm --filter @ever-works/github-actions-build-plugin test -- failure-classifier` is green.

- [ ] **T14. Registry access and the pull token.**
      **Status (2026-09-25, wave 2):** the GHCR token exchange is in `ghcr-access.ts` (anonymous `/token` then `HEAD`
      with the registry bearer; for a pull token, `/token` with Basic `x-access-token:<PAT>`), and the confirming half
      is implemented and review-hardened: `AppBuildsService.finalize` confirms the digest through the facade binding's
      `checkImageAccess` (bounded by `APP_BUILD_DIGEST_READ_TIMEOUT_MS`, 15 s), confirmation survives repeated
      observations, a later confirmation clears a `digestMismatch`, a `manual`/`verification` Build keeps its dispatched
      commit, and plan §4.8's no-token fallback reads `BuildSnapshot.image.pushLogDigest`. Still open: a caller for
      `reconfirmDigest` (the §7.4 sweep recheck and the pull-token-save recheck), and the private path verified with a
      real classic `read:packages` token (operator).
      **Create** `packages/plugins/github-actions-build/src/registry/ghcr-access.ts` — anonymous and token-authenticated
      manifest `HEAD` for `sha-<sha>`; token check via `GET /user` requiring `x-oauth-scopes` exactly `read:packages`;
      absent header → refused (fine-grained); expiry header parsed.
      **Modify** `packages/plugins/github-actions-build/src/github-actions-build.plugin.ts` — implement `checkImageAccess`
      and async `validateSettings` for `pullToken` (refusal codes `pullTokenTooBroad`, `pullTokenFineGrained`,
      `pullTokenCannotRead`), writing `pullTokenExpiresAt`.
      **Test**: `packages/plugins/github-actions-build/src/__tests__/ghcr-access.spec.ts` — scopes `read:packages` ok;
      `read:packages, repo` refused; header absent refused; 401 on manifest → `cannotRead`; public manifest anonymous 200 →
      `visibility: 'public'`; private manifest without token → `readable: false` (ACC-05-21); no request ever sends the token
      to a host other than `api.github.com` or `ghcr.io`.
      **Done when**: `pnpm --filter @ever-works/github-actions-build-plugin test -- ghcr-access` is green.

- [ ] **T15. Secret-in-image check and runner verification scripts.**
      **Create** `packages/plugins/github-actions-build/src/workflow/secret-check.sh.ts` (the [plan §4.11](./plan.md) script
      as a template literal) and `src/workflow/verify-runner.sh.ts` ([plan §4.10](./plan.md): plan schema check **with
      `version == 1` refused otherwise** (`APW05-G11`), 12 GiB summed memory refusal, throwaway `postgres`/`redis`/`minio`
      containers pinned by digest with no volumes, recipe
      materialisation with `openssl rand` / `openssl genpkey` into a `0600` env file, prompted values from the per-run
      secret, jobs, readiness waits, smoke via `curl --max-time 30 --max-redirs 0`, per-job and per-smoke result rows, env
      file shredded, `set +x`; **and the image it verifies**: `--load` from the plan's `build` section with
      `--cache-from` the `buildcache` tag only, or `docker pull` of `ew_reuse_digest`, never a push and never `cache-to`
      — `APW05-G02`).
      **Test**: `packages/plugins/github-actions-build/src/__tests__/secret-check.script.spec.ts` — runs the script under
      `bash` with a stub `docker` on `PATH`: match → exit 79 and `EW_SECRET_IN_IMAGE:<NAME>` on stdout without the value,
      and the push step is never reached (ACC-05-15); no match → 0; 7-char value skipped.
      `packages/plugins/github-actions-build/src/__tests__/verify-runner.script.spec.ts` — plan over 60,000 chars refused;
      summed memory 13 GiB refused; a stub smoke server returning 200/500 produces one passing and one failing smoke row,
      a stub job exiting 3 produces `exitCode: 3`, and `componentsReady` reflects the stub probe (ACC-05-23); generated
      `base64` 24 bytes → 32 characters; the env file does not exist after the script ends; no generated value appears in
      captured stdout/stderr.
      **Done when**: both specs pass on Linux CI (skipped with a reason on Windows developer machines).

## P1.4 — Facade, services, jobs

- [ ] **T16. `BuildFacadeService`.**
      **Create** `packages/agent/src/facades/build.facade.ts` extending `BaseFacadeService` with `CAPABILITY =
PLUGIN_CAPABILITIES.BUILD`: `resolve(workId, userId)` → `{ plugin, auth, settings, repository }` (token through
      `GitFacadeService.getAccessToken`), `getPullCredential(workId)` (public → `null`; private → `{ server: 'ghcr.io',
username: 'x-access-token', password }` from the Work-scoped `pullToken`; never any fallback),
      `redactorFor(workId)` (APW-07 `AppEnvService.buildRedactor`; typed fake until APW-07 lands),
      `repositoryWriter(workId)` (binds `getFileContent`, APW-03's `commitFiles?`, `createBranch`, `createPullRequest`).
      **Create** `packages/agent/src/app-builds/app-build-pull-credential.source.ts` implementing APW-06's
      `AppImagePullCredentialSource.resolve(workId, buildId)` over `getPullCredential`, bound to
      `APP_IMAGE_PULL_CREDENTIAL_SOURCE` from `packages/agent/src/app-runtime/ports.ts`.
      **Modify** `packages/agent/src/facades/facades.module.ts` and `packages/agent/src/facades/index.ts` to provide/export it.
      **Test**: `packages/agent/src/facades/__tests__/build.facade.spec.ts` — resolution through a mock `build` plugin; no
      string `github-actions-build` in the facade source (grep assertion); `getPullCredential` returns `null` for public and
      never returns the git token when `pullToken` is unset (ACC-05-21); the port returns the same object as the facade.
      **Done when**: `pnpm --filter @ever-works/agent test -- build.facade` is green.

- [ ] **T17. `AppBuildsService` and the deployable verdict.**
      **Status (2026-09-25, wave 2):** `finalize`'s digest confirmation (T14's confirming half) and
      `reconfirmDigest(buildId, { pushLogDigest? })`, which re-settles a `digestUnconfirmed` Build without publishing an
      event, are implemented; nothing calls `reconfirmDigest` yet (the §7.4 sweep recheck and the pull-token-save
      recheck). `requestRebuild` now goes through `requestPrepare`, so the `prepareSeq` bump lands before the dispatch,
      and the in-process fallback re-runs a prepare requested while one is in flight once, as `coalesced` (plan §7.1).
      **Create** `packages/agent/src/app-builds/app-builds.service.ts` (`requestPrepare` with the `prepareSeq` marker of
      plan §7.2, `recordProviderRun(workId, run, source)` — the shared accept rules of plan §7.5, `requestRebuild` with
      10 s dedupe and 10/hour limit,
      `cancel`, `startVerification(workId, { ref, sha, reuseImageDigest? }) → { buildId }`, `getDetail(workId, buildId)`,
      `applySnapshot(buildId, snapshot)`,
      `finalize(buildId)` — digest confirmation, verdict, receipt, Activity, events — and `publish(build, event)`, the
      single Activity + event writer of plan §7.8), `deployable-verdict.ts` ([plan
      §5.1](./plan.md), first failing clause wins, `computeBuildInputsHash` from `@ever-works/contracts`), `app-build-failure-copy.ts` (class → i18n key + params, reused for the
      agent hand-off in T44), `app-build-pull-token.service.ts` (`save(workId, userId, token)` — plan §4.12,
      `APW05-G07`), `packages/agent/src/app-builds/app-builds.module.ts`, `index.ts`.
      **Create also** `packages/agent/src/events/app-build.events.ts` (the five classes, `AppBuildEventPayload` and the
      explicit status → event map of plan §7.8 — `APW05-G05`) and
      **Modify** `packages/agent/src/events/index.ts` to export them.
      **Modify** `packages/agent/src/entities/plugin-usage-event.entity.ts` — add `BUILD = 'build'` to
      `PluginUsageCapability` (varchar; no migration).
      **Modify** `packages/agent/src/entities/activity-log.types.ts` — add `APP_BUILD = 'app_build'` to
      `ActivityActionType`; `action` strings `app.build.queued|started|succeeded|failed|cancelled` (Resolution R-2).
      **Modify** `packages/contracts/src/apps/builds.ts` — export `APP_BUILD_SWEEP_CRON`, `AppVerificationPlan` and the
      pure `computeBuildInputsHash` (`APW05-G03`, `G11`, `G20`).
      **Test**: `packages/agent/src/app-builds/__tests__/deployable-verdict.spec.ts` — one case per clause in order: a
      pull-request Build → `pullRequest`, a verification Build → `verification` (ACC-05-23), `specValidAtCommit: false` →
      `specInvalid`, a Build whose `buildInputsHash` differs from the current hash after a rotation → `staleInputs`
      (ACC-05-16), **a NULL `buildInputsHash` or `secretsSyncedAt` → `staleInputs`**, **a preparation that synced zero
      values (the hash of the empty list) → passes that clause**, secret check failed → `secretCheckFailed`, unconfirmed
      digest → `digestUnconfirmed` (`APW05-G03`).
      `packages/agent/src/app-builds/__tests__/app-builds.service.spec.ts` — a Rebuild returns within 2 s with a slow
      dispatcher mocked (dispatch not awaited past the insert) **and, with a null-returning prepare dispatcher, the
      prepare runner is still invoked in-process exactly once and the 2 s budget holds** (`APW05-G20`); dedupe
      inside/outside 10 s returns the same/new Build;
      11th rebuild → `rebuildRateLimited` with minutes (ACC-05-08); `cancel` on a running Build calls `cancelBuild` and the
      next snapshot finalises `cancelled` (ACC-05-09); receipt recorded once with `units`, payer `workspace`, operation
      `build.run`, `costCents: 0` and no credit ledger call (ACC-05-20); Activity rows carry `actionType: 'app_build'`
      and metadata with no value and no excerpt line; **`requestRebuild` and `startVerification` publish exactly one
      `app.build.queued` with the plan §7.8 payload, `applySnapshot` publishes `app.build.started` exactly once across
      repeated `running` snapshots, a snapshot first seen as `completed` still publishes `started` before `succeeded`, and
      a `blocked` Build publishes nothing** (`APW05-G05`); **the plan JSON is built from the fixture spec at `sha`,
      validates against `verify-plan.schema.json`, is refused above 60,000 characters or 12 GiB before dispatch, contains
      no value from the env-source fake, and a verification Build's every transition calls
      `APP_PROVISION_EVENTS_PORT.buildUpdated` — 3 times for queued → running → succeeded, once for a pre-dispatch
      `missingBuildValues` block, zero times for a push Build, and a throwing port never fails the job** (`APW05-G11`);
      **`AppBuildPullTokenService.save` maps the three refusal codes, returns `pullTokenNoImageYet` with no Build, and
      writes `pullTokenExpiresAt` through `writePlatformManagedWorkSettings`** (`APW05-G07`);
      `packages/agent/src/events/__tests__/events.spec.ts` — the five names are unique and dotted (`APW05-G05`).
      **Done when**: `pnpm --filter @ever-works/agent test -- deployable-verdict app-builds.service app-build-pull-token.service`
      is green.

- [ ] **T18. Dispatchers.**
      **Create** `packages/agent/src/tasks/app-build-prepare-dispatcher.ts`, `app-build-prepare.types.ts`,
      `app-build-watch-dispatcher.ts`, `app-build-watch.types.ts` ([plan §7.1](./plan.md)); both interfaces return
      `Promise<string | null>` and are modelled on `work-import-dispatcher.ts`, **not** on the throwing
      `kb-reembed-work-dispatcher.ts` (`APW05-G20`).
      **Modify** `packages/agent/src/tasks/index.ts` (exports) and `packages/agent/src/tasks/_tasks-symbols.ts`
      (`APP_BUILD_PREPARE_DISPATCHER`, `APP_BUILD_WATCH_DISPATCHER`, alphabetical).
      **Modify** `packages/agent/src/tasks/job-runtime.providers.ts` — add both symbols to `DISPATCHER_SYMBOLS` and update
      its arity JSDoc, counted off the merged array. **Modify**
      `packages/agent/src/tasks/__tests__/job-runtime.providers.spec.ts` — raise the `toHaveLength` pin by two (14 on
      `develop` @ 873274c9f; recount at merge after APW-02/03/04) and add both symbols to the expected `Set`.
      **Modify** `packages/tasks/src/trigger/trigger.service.ts` — `dispatchAppBuildPrepare(payload)` and
      `dispatchAppBuildWatch(payload)`, both `Promise<string | null>`: return `null` when `ensureConfigured()` is false or
      `trigger()` throws, the same shape as `dispatchWorkspaceBackup`; tags `work:<workId>` / `build:<buildId>`,
      `concurrencyKey` `app-build-prepare:<workId>` / `app-build-watch:<buildId>`.
      **`trigger.module.ts` needs no edit** — `buildJobRuntimeProviders()` binds every `DISPATCHER_SYMBOLS` entry.
      **Test**: `packages/agent/src/tasks/tasks.spec.ts` passes with the two new symbols counted automatically;
      `job-runtime.providers.spec.ts` (arity and `Set`);
      `packages/tasks/src/__tests__/trigger.service.spec.ts` (unconfigured → `null`; a thrown `trigger` → `null`; a
      configured call passes tags and `concurrencyKey`).
      **Done when**: `pnpm --filter @ever-works/agent test -- tasks.spec job-runtime.providers` and
      `pnpm --filter @ever-works/tasks test -- trigger.service` are green.

- [ ] **T19. `app-build-prepare` job.**
      **Create** `packages/agent/src/app-builds/app-build-prepare.runner.ts` ([plan §7.2](./plan.md): strategy gate,
      build values through APW-07, runner selection (an **absent** `build.resources.memory` means the runner's maximum and
      never blocks — `APW05-G14`), `prepareRepository` (incl. checks), the single-transaction preparation-row upsert of
      plan §3.1b (`APW05-G03`), the **verification bootstrap** of plan §4.6 step 0 (`APW05-G02`), the **blocked-Build
      retry** of plan §7.2 step 7 with `actionsEnabled` handled after `setActionsPermissions?` (`APW05-G15`), and
      `startBuild` for requested Builds), the **`prepareSeq` coalescing loop** of plan §7.2 (`APW05-G17`) and
      `packages/tasks/src/tasks/trigger/app-build-prepare.task.ts`; **Modify**
      `packages/tasks/src/tasks/trigger/index.ts`. When the prepare dispatcher returns `null`, run the runner in-process,
      unawaited, under the same lock ([plan §7.1](./plan.md), `APW05-G20`).
      **Test**: `packages/agent/src/app-builds/__tests__/app-build-prepare.runner.spec.ts` — `image`/`none` without checks:
      no Build and no plugin call; `auto` blocks a requested Build with `strategyNotSupported` (R-13); a missing required
      build value blocks the requested Build naming it and nothing is dispatched (ACC-05-14); runner too small blocks with
      both numbers (ACC-05-22) **and an absent memory does not block** (`APW05-G14`); concurrent dispatch runs the passes
      the coalescing loop allows and re-runs while `prepareSeq` keeps moving, and a dispatch that cannot take the lock
      exits as `skipped` without losing the request (`APW05-G17`); **a `specApplied` prepare with no Build upserts the
      preparation row with the hash, `secretsSyncedAt`, the names and `workflowState: 'committed'`; a second prepare after
      an env entry was removed passes that name in `previouslyWrittenSecretNames` and drops it from the row; a checks-only
      prepare leaves the three secret fields untouched** (`APW05-G03`); **a verification request on an App Work with no
      workflow and no applied spec delivers exactly one bootstrap commit and then dispatches on the tracked branch, and on
      a Link App Work it blocks with `workflowPending` and dispatches nothing** (`APW05-G02`); **a `manual` Build blocked
      for `missingBuildValues` becomes `queued` with a cleared `blockedReason` and publishes `app.build.queued` once the
      value exists, while an older blocked manual Build is cancelled as `superseded`** (`APW05-G15`).
      **Done when**: `pnpm --filter @ever-works/agent test -- app-build-prepare.runner` is green.

- [ ] **T19a. Webhook installation — the optional latency path (`APW05-G01`, `GAP-07`).**
      **Modify** `packages/agent/src/app-builds/app-build-prepare.runner.ts` — after `prepareRepository` succeeds and the
      workflow exists on the tracked branch, install or update the `workflow_run` hook through APW-02's
      `GitFacadeService.createWebhook?` with `{ url: <config.webAppUrl() + '/api/ingest/github/events'>, secret: <the
owner's github-plugin webhookSecret>, events: ['workflow_run'] }`, and persist `webhookId` + `webhookState`
      (`installed` | `skipped` | `permissionMissing`) on the preparation row (plan §7.7).
      **Create also** `AppBuildsService.releaseRepository(workId)` — best-effort `deleteWebhook?`, warning-logged, never
      fatal (`GAP-07`'s removal half).
      **Test**: `packages/agent/src/app-builds/__tests__/app-build-webhook.spec.ts` — the call uses the owner's
      `webhookSecret` and exactly `['workflow_run']`; it is **skipped** when the secret is unset, when the receiver URL
      fails `isSafeWebhookUrl`, when the token is an App installation token, and for an upstream relation; a
      `permission_missing` result never blocks a Build and never changes a status; the secret appears in no log, error,
      Activity row or telemetry payload; `releaseRepository` swallows a `deleteWebhook?` failure.
      **Done when**: `pnpm --filter @ever-works/agent test -- app-build-webhook` is green.

- [ ] **T20. `app-build-watch` job.**
      **Create** `packages/agent/src/app-builds/app-build-watch.runner.ts` ([plan §7.3](./plan.md), including the
      preparation-row re-stamp when `startedAt` is first set — `APW05-G03`) and
      `packages/tasks/src/tasks/trigger/app-build-watch.task.ts`. When the watch dispatcher returns `null`, run the runner
      in-process, unawaited, capped at 10 concurrent runs per API process ([plan §7.1](./plan.md), `APW05-G20`).
      **Test**: `packages/agent/src/app-builds/__tests__/app-build-watch.runner.spec.ts` — lease prevents a second
      concurrent observation; terminal transition finalises exactly once across 3 deliveries; the ordered sequence
      `app.build.queued → app.build.started → app.build.succeeded` publishes exactly once each, a snapshot first seen as
      `completed` still yields `started` before `succeeded`, and `app.build.succeeded` carries branch, trigger, `deployable`
      and `imageDigest` (`APW05-G05`); `app.build.succeeded` is
      emitted only when deployable is computed (with the flag in the payload); **a succeeded push Build with a confirmed
      digest and the `sha-<40>` and `branch-<slug>` tags — and no `latest` — is `deployable: true` (ACC-05-07)**; **a push
      Build created by the consumer after
      a `specApplied` prepare, whose run started after `secretsSyncedAt`, is likewise `deployable: true`, and that same
      Build is
      `staleInputs` when a sync finished after `startedAt`** (`APW05-G03`); a verification Build's per-run secret
      is deleted on its terminal transition; **a verification Build going queued → running → succeeded calls
      `APP_PROVISION_EVENTS_PORT.buildUpdated` three times**, and a throwing port does not fail the watch (`APW05-G11`).
      **Done when**: `pnpm --filter @ever-works/agent test -- app-build-watch.runner` is green.

- [ ] **T21. `app-build-sweep` job.**
      **Create** `packages/agent/src/app-builds/app-build-sweep.service.ts` and
      `packages/tasks/src/tasks/trigger/app-build-sweep.task.ts` (`schedules.task({ id: 'app-build-sweep', cron:
APP_BUILD_SWEEP_CRON })` from `@ever-works/contracts`, same shape as
      `packages/tasks/src/tasks/trigger/deploy-ready-poller.task.ts`), and **run discovery before the silent pass** by
      calling T21a's `AppBuildRunDiscoveryService` ([plan §7.4a](./plan.md), `APW05-G01`).
      **Create also** `apps/api/src/app-builds/app-build-sweep-cron.service.ts` — the same pass from the API process when
      Trigger.dev is not the configured runtime, gated on `config.trigger.shouldUseTrigger()`, like
      `SkillReadinessSweepCronService`: the cron calls `AppBuildSweepService.runSweep()`, which takes `app-builds:sweep`
      itself (ttl 90 s); the cron does not wrap it in a second `runExclusive`, because the Trigger task reaches the
      service over RPC, where a lock callback cannot cross (corrected 2026-09-25). Register it in
      `apps/api/src/app-builds/app-builds.module.ts` (**new**, created by T21; T23 and T24 extend it) and import
      `AppBuildsModule` in `apps/api/src/api.module.ts` ([plan §7.4](./plan.md), `APW05-G20`).
      **Status (2026-09-25, first slice):** `AppBuildSweepService` runs two passes under `app-builds:sweep` (90 s
      lease, 5 min hard lifetime): the §9.2 re-drive (a queued manual or verification Build with `dispatchedAt IS NULL`
      and a queue age in [90 s, 450 s) gets `requestPrepare(workId, 'sweep')` once per Work) and the never-adopted
      half of §7.4's lost rule (`providerRunId IS NULL`, open, past `max(queuedAt, dispatchedAt) + 5 min +
      timeoutMinutes + 30` → `markLost`, then `finalize` only for rows the pass moved). The Trigger task and the API
      cron fallback both call `runSweep()`. Still open in T21: the silent-Build watch dispatch, the adopted half of the
      lost rule (`startedAt + timeoutMinutes + 30`), the `digestUnconfirmed` recheck, deleting orphaned verification
      secrets and T21a's discovery — all in the same service. Dormant in production until a Work can be prepared (the
      facade answers `pluginUnavailable`).
      **Test**: `packages/agent/src/app-builds/__tests__/app-build-sweep.service.spec.ts` — 250 silent Builds → 200
      dispatched, oldest first; a Build silent for 91 s is dispatched so a terminal status lands within the next 2-minute
      tick (≤ 3 min, ACC-05-11); lost thresholds for adopted and never-adopted Builds; `digestUnconfirmed` rechecked after
      a pull token is saved; an orphaned verification secret is deleted.
      `apps/api/src/app-builds/app-build-sweep-cron.service.spec.ts` — skipped when `shouldUseTrigger()` is true; runs
      `runSweep()` once when false (the service takes the lock); a held lock means skip; a sweep error is logged, not thrown; a watch
      dispatch returning `null` runs the watch runner in-process with at most 10 concurrent (`APW05-G20`).
      **Done when**: `pnpm --filter @ever-works/agent test -- app-build-sweep.service` and
      `pnpm --filter ever-works-api test -- app-build-sweep-cron.service` are green.

- [ ] **T21a. Run discovery — Builds without a delivery (`APW05-G01`, `GAP-07`).**
      **Create** `packages/agent/src/app-builds/app-build-run-discovery.service.ts` ([plan §7.4a](./plan.md)): up to 100
      App Works whose applied strategy is `dockerfile` and whose `workflowSha256` is set, stalest `runsCheckedAt` first;
      `BuildFacadeService` → `IBuildPlugin.listRecentRuns?` with the stored `runsEtag`; `notModified` only stamps
      `runsCheckedAt`; every run with `createdAt ≥ workflowWrittenAt` goes to
      `AppBuildsService.recordProviderRun(workId, run, 'poll')`; the cursor (`runsEtag`, `runsCheckedAt`) is stored on the
      preparation row (plan §3.1b), not in a plugin setting.
      **Test**: `packages/agent/src/app-builds/__tests__/app-build-run-discovery.service.spec.ts` — with delivery
      disabled, a push run is recorded as Build #n on the next tick and its later `completed` is visible within 3 minutes
      (ACC-05-11); a delivery **plus** a poll of the same run yields one Build and one `app.build.queued`; a fork
      pull-request run → no Build; `image`/`none`/`auto` → none; a run created before `workflowWrittenAt` → none; a 304 →
      no row writes; 150 eligible App Works → 100 checked, stalest first; a plugin without the method → skipped; a
      discovery failure does not stop the silent pass.
      **Done when**: `pnpm --filter @ever-works/agent test -- app-build-run-discovery.service` is green.

- [ ] **T22. Event listeners.**
      **Create** `packages/agent/src/app-builds/app-builds.listener.ts` — `app.spec.applied` with `changedBlocks` including
      `build` or `checks` → prepare; `app.env.changed` with a build-phase name → prepare, debounced 10 s per Work; pull
      token saved → prepare (reason `pullTokenSaved`); **a save of the Work-scoped settings of the resolved build plugin →
      prepare (reason `settingsChanged`), which is what clears `runnerTooSmall`** (`APW05-G15`).
      **Test**: `packages/agent/src/app-builds/__tests__/app-builds.listener.spec.ts` — runtime-only names do not dispatch;
      5 changes within 10 s dispatch once; dispatch happens within 60 s of the first change, so `EW_` secrets re-sync
      inside the SLA (ACC-05-13); a `checks`-only change dispatches prepare; **a settings change dispatches prepare and the
      newest blocked manual Build becomes `queued`** (`APW05-G15`).
      **Done when**: `pnpm --filter @ever-works/agent test -- app-builds.listener` is green.

## P1.5 — API and webhook intake

- [ ] **T23. Builds controller.**
      **Create** `apps/api/src/app-builds/app-builds.controller.ts`, `apps/api/src/app-builds/dto/app-builds.dto.ts`
      (`ListAppBuildsQueryDto` with `page`, `pageSize` 1–100, `status`, `trigger`, `branch`, `pullRequest`;
      `CreateAppBuildDto` with optional 40-hex `commitSha`; **`SaveAppBuildPullTokenDto` with a `token` string, for the
      new `PUT /api/works/:id/builds/pull-token` route of plan §5 — `APW05-G07`**).
      **Modify** `apps/api/src/app-builds/app-builds.module.ts` — it already exists (created by T21 for the sweep cron,
      corrected 2026-09-25); add the controller to it.
      Routes and codes exactly as [plan §5](./plan.md); `ensureCanView` / `ensureCanEdit` from
      `packages/agent/src/services/work-ownership.service.ts`; non-`app` kind → 404. **The list response's
      `workflow` field reads the preparation row** (`{ state: 'none', pullRequestUrl: null }` when there is none —
      `APW05-G03`), and the pull-token route delegates to `AppBuildPullTokenService`, returning its stable codes and never
      the token (`APW05-G07`).
      `apps/api/src/api.module.ts` already imports `AppBuildsModule` (T21), so nothing is added there.
      **Test**: `apps/api/src/app-builds/app-builds.controller.spec.ts` — foreign id 404 on read, Rebuild and Cancel
      (ACC-05-24); viewer 403 on POST routes with code; 202 shape with `deduped` and a second POST inside 10 s returning the
      same Build (ACC-05-08); 429 `rebuildRateLimited` with `retryAfterMinutes`; 202 on cancel of a running Build and 409
      `notCancellable` on a terminal one (ACC-05-09); `nothingToBuild` for `image` strategy; no response contains
      `pullToken` or its value (ACC-05-21).
      **Done when**: `pnpm --filter ever-works-api test -- app-builds.controller` is green and Swagger lists the four
      routes under a `Builds` tag.

- [ ] **T24. `workflow_run` consumer.**
      **Create** `apps/api/src/app-builds/app-build-workflow-run.consumer.ts` ([plan §7.5](./plan.md)), registered on
      `GitHubWebhookDispatcherService` in `onModuleInit`. **The consumer maps the delivery to a `BuildRunRef` and calls
      `AppBuildsService.recordProviderRun(workId, run, 'event')`** — the same entry point run discovery uses — so the
      accept rules live in one place (`APW05-G01`). **Modify** `apps/api/src/app-builds/app-builds.module.ts` to
      import the ingest module's dispatcher, **and** either
      `apps/api/src/ingest/ingest.module.ts` to add `GitHubWebhookDispatcherService` to `exports` (with its spec extended)
      **or** register this consumer as a provider inside `IngestModule` — the module exports only `[EventIngestModule]`
      today (`apps/api/src/ingest/ingest.module.ts:131-149`), so the "import the exported dispatcher" instruction cannot
      work as written (`APW05-G21`).
      **Test**: `apps/api/src/app-builds/app-build-workflow-run.consumer.spec.ts` — other workflow paths ignored; repository
      not an App Work ignored; runs of an App Work whose applied strategy is `image`, `none` or `auto` ignored (ACC-05-30);
      a `pull_request` run whose head repository differs creates no Build (ACC-05-06); `requested` creates Build #n
      `queued` **and publishes `app.build.queued` once, while a duplicate delivery publishes nothing** (`APW05-G05`);
      manual run adopted by `display_title`; **a push or pull-request insert stamps `buildInputsHash`,
      `buildSecretNames` and `secretsSyncedAt` from the preparation row in the same transaction, and a push run while
      `workflowState = 'pullRequestOpen'` dispatches `app-build-prepare { reason: 'workflowMerged' }`** (`APW05-G03`);
      **a commit inside a completed upstream-sync range stamps `syncOrigin: 'upstreamSync'` with `syncFromSha`/
      `syncToSha`, and any other commit stamps `none` with both NULL** (`APW04-G06`);
      **a null watch dispatch runs the watch runner in-process without being awaited** (`APW05-G20`);
      `apps/api/src/ingest/github/github-check-intake.service.spec.ts` still passes unchanged.
      **Done when**: `pnpm --filter ever-works-api test -- app-build-workflow-run.consumer github-check-intake` is green
      and the consumer performs zero outbound HTTP calls (asserted).
      **Done when**: `pnpm --filter ever-works-api test -- app-build-workflow-run.consumer github-check-intake` is green
      and the consumer performs zero outbound HTTP calls (asserted).

## P1.6 — Web

- [ ] **T25. Client, actions and route.**
      **Create** `apps/web/src/lib/api/app-builds.ts`, `apps/web/src/app/actions/dashboard/app-builds.ts` (six actions in
      [plan §6.2](./plan.md)), `apps/web/src/app/[locale]/(dashboard)/works/[id]/builds/page.tsx`.
      **Modify** `apps/web/src/lib/constants.ts` — `DASHBOARD_WORK_BUILDS`.
      **Modify** `apps/web/src/components/works/detail/WorkTabs.tsx` — Builds tab after Pull requests, visible when
      `getWorkCapabilities(work.kind).builds`.
      **Test**: `apps/web/src/components/works/detail/WorkTabs.unit.spec.tsx` — Builds tab hidden for `directory`, shown
      for a kind with `builds: true`.
      **Done when**: `pnpm --filter ever-works-web test -- WorkTabs` is green and a non-app Work shows no new tab.

- [ ] **T26. Builds list.**
      **Create** `apps/web/src/components/works/detail/builds/BuildsPageClient.tsx`, `BuildRow.tsx`,
      `BuildStatusChip.tsx`, `BuildBlockedNotice.tsx` — URL-backed filters and page, 10 s polling while any row is
      queued/running (paused when hidden, stops after 60 minutes), empty/loading/error states, viewer-disabled actions.
      **Test**: `apps/web/src/components/works/detail/builds/BuildsPageClient.unit.spec.tsx` — poll starts/stops; filters
      round-trip through the URL; each blocked reason renders its action; a `missingBuildValues` notice names the value and
      links **Set it** (ACC-05-14); a viewer sees Rebuild and Cancel disabled with the edit-access copy (ACC-05-24).
      **Done when**: `pnpm --filter ever-works-web test -- BuildsPageClient` is green.

- [ ] **T27. Detail drawer and failure panel.**
      **Create** `apps/web/src/components/works/detail/builds/BuildDetailDrawer.tsx` (`?build=<number>`, copy digest,
      receipt with the checks-minutes line, verification results, and the verification approval notice of plan §4.7b when
      prompted values were withheld) and `BuildFailurePanel.tsx` (title + suggestion per class
      with params; excerpt in `<pre>`; **Ask an agent to fix this** opening APW-08's `RequestChangeDialog` with `buildId`
      preset through `requestAppChangeAction({ workId, buildId, request? })` → `POST /api/works/:id/evolve`, hidden when
      APW-08 is absent or the viewer lacks edit access — `APW05-G12`).
      **Test**: `apps/web/src/components/works/detail/builds/BuildFailurePanel.unit.spec.tsx` — all 14 classes render
      translated title and suggestion with params (ACC-05-17); `BuildDetailDrawer.unit.spec.tsx` — `Esc` returns focus to
      the row; `C` copies the image reference; the receipt reads payer "your GitHub account" and no credits (ACC-05-20);
      verification rows render one line per job and smoke result (ACC-05-23).
      **Done when**: `pnpm --filter ever-works-web test -- BuildFailurePanel BuildDetailDrawer` is green.

- [ ] **T28 (parallel with T27). Overview card, pull token and settings dialogs.**
      **Create** `apps/web/src/components/works/detail/overview/LatestBuildCard.tsx`,
      `apps/web/src/components/works/detail/builds/PullTokenDialog.tsx`, `BuildSettingsDialog.tsx` (plugin id taken from
      the list response's `provider.pluginId`).
      **Modify** `apps/web/src/components/works/detail/overview/WorkInfo.tsx` to render the card when `builds` is true.
      **Test**: `apps/web/src/components/works/detail/builds/PullTokenDialog.unit.spec.tsx` — the three refusal codes map to
      copy; the input is cleared after save and never re-populated (ACC-05-21);
      `apps/web/src/components/works/detail/overview/LatestBuildCard.unit.spec.tsx` — deployable same vs other commit.
      **Done when**: `pnpm --filter ever-works-web test -- PullTokenDialog LatestBuildCard` is green and no web source file
      contains the literal `github-actions-build`.

## P1.7 — i18n, tests, docs

- [ ] **T29. i18n.**
      **Modify** `apps/web/messages/en.json` — the `dashboard.workDetail.tabs.builds` keys and the
      `dashboard.workDetail.builds` tree from [plan §8](./plan.md); mirror into the 20 sibling locale files in
      `apps/web/messages/`.
      **Test**: run `node apps/web/scripts/sync-locale-parity.mjs` then `git diff --exit-code apps/web/messages` — the script
      adds zero keys because all 21 files already carry every new key (ACC-05-25); a grep over the new leaves finds no `.`.
      **Done when**: both commands exit 0 in the PR.

- [ ] **T30. E2E.**
      **Seeding recipe (rewritten 2026-09-17, `APW05-G18`).** The PR lane runs with `EVER_WORKS_E2E_FAKES=1`, and no
      route or environment variable is added to seed Builds — every Build in these specs is produced by the real
      `app-build-prepare` path against APW-13's fake GitHub and stops **before** any build-provider call: 1. register the owner with `registerUserViaAPI` (APW-13 T6); 2. seed the fake GitHub through `/_control/seed` (APW-13 T2) with a repository whose `.works/works.yml` is either
      APW-13's `missing-value.works.yml` profile (→ `missingBuildValues`) or a `dockerfile` spec with
      `build.resources.memoryGiB: 12` on a private repository and no larger runner set (→ `runnerTooSmall`); 3. create the App Work with APW-13's `createAppWork` helper (T6); 4. `POST /api/works/:id/builds` without `commitSha`; 5. `expect.poll` on `GET /api/works/:id/builds/:buildId` until `status` is `blocked` and `blockedReason` is the
      expected one.
      These Builds stop in `app-build-prepare` steps 3–4 ([plan §7.2](./plan.md)), before `prepareRepository` or
      `startBuild`, so the detail shows `providerRunId: null`. No `work_builds` row is inserted directly, and no seeding
      route exists.
      **Create** `apps/web/e2e/app-builds-tab.spec.ts` (list, URL-backed filters, drawer on a blocked Build, viewer sees
      Rebuild and Cancel disabled, another account's Build id answers 404 on read, Rebuild and Cancel — ACC-05-24),
      `apps/web/e2e/app-builds-failure.spec.ts` (the blocked `missingBuildValues` notice names the value — ACC-05-14;
      `runnerTooSmall` shows both numbers — ACC-05-22), `apps/web/e2e/app-builds-a11y.spec.ts` (axe on the tab, on a
      blocked Build's drawer, and on `BuildSettingsDialog` and `PullTokenDialog` opened without submitting; the keys `↑↓`,
      `Enter`, `Esc` and `R` — ACC-05-25).
      **Recorded move (APW-13 plan §8.3 — a path the fake switch cannot see leaves the PR lane).** The build plugin has its
      own Octokit and GHCR clients, and T14 keeps them on `api.github.com` and `ghcr.io`, so provider-set failure classes
      (ACC-05-17), copying the digest with `C`, pull-token validation and "Deploy blocked for a private image without a
      token" (ACC-05-21) are **not** PR-lane e2e and no `app-builds-pull-token.spec.ts` is created. They are covered by
      T13 and T27 (all 14 classes' copy; `C`), by T14, T16, T23 and T28 (pull token), and by APW-13 T59 live on dev
      (failure classes against real Builds).
      **Test**: `pnpm --filter ever-works-web test:e2e app-builds-` (the three specs above are the test).
      **Done when**: all three pass locally and in the `e2e.yml` lane, every Build they create is `blocked` with
      `providerRunId: null`, and rows use `getByTestId`.

- [ ] **T31. Live acceptance wiring.**
      **Modify** `docs/specs/features/app-works/ACCEPTANCE.md` (the APW-05 table in §3 — coordinate with the file's owner) —
      map `ACC-05-01…23`, `29`, `30`, **31** and **32** to the APW-13 harness scenario names and to **APW-13's** fixture
      branches of `ever-works/app-fixture-hello` — the branches `variant/<name>`: `variant/build-oom`,
      `variant/services-postgres`, `variant/missing-value`, `variant/secret-in-image`, `variant/dockerfile-error`,
      **`variant/build-timeout` and `variant/disk-full`, which APW-13 T58 also creates for ACC-05-17's `timeout` and
      `diskFull` cases** (short names used elsewhere in this epic map to `variant/<name>`; Resolution R-23: this epic
      references them and creates none — `APW05-G23`). The failure class name in that mapping is `outOfMemory`, matching
      spec §6.3 and ACC-05-17, never `out_of_memory`.
      **Test**: `rg -n "ACC-05-(0[1-9]|1[0-9]|2[0-3]|29|30|31|32)" docs/specs/features/app-works/ACCEPTANCE.md` lists every
      id with
      a scenario name, and `git ls-remote https://github.com/ever-works/app-fixture-hello` shows each referenced branch
      once APW-13 T58 has landed.
      **Done when**: every P1 ACC-05 id names a scenario and no APW-05 task creates a fixture branch.

- [ ] **T32. Docs.**
      **Create** `docs/features/app-builds.md` — what the workflow file is, build values, runners and sizes, App checks on
      pull requests, failure classes, pull tokens, receipts.
      **Modify** `apps/docs/sidebarsPlatform.ts` (manual sidebar), `docs/plugin-system/built-in-plugins.md` (add
      `github-actions-build`), `docs/plugin-system/plugin-categories.md` (add `build`).
      **Test**: `pnpm --filter ever-works-docs build`.
      **Done when**: the build reports no broken-link warnings.

- [ ] **T33. P1 ship gate.**
      **Modify** `docs/specs/features/app-works/TRACKER.md` — tick APW-05 P1.
      **Test**: root `pnpm format:check`, `pnpm lint`, `pnpm type-check`, `pnpm test`, `pnpm build`; ACC-05-01…25, 29 and 30
      walked on the fixture repository.
      **Done when**: every command exits 0 and each walked criterion is recorded against its scenario.

---

# Phase P3 — Ever Works Apps builder

_Delivers spec FR-55…FR-59 and ACC-05-26…28. Starts only after APW-10 publishes the isolated build controller
contract and its launch gate passes (Resolution R-24: sandboxed in-zone builds are Wave 3, gate item LG-24).
Infrastructure specifics stay in the private operations repository._

- [ ] **T34. Supply-chain columns.**
      **Create** `apps/api/src/migrations/1792050100000-AddWorkBuildSupplyChain.ts` (`scanSummary`, `signatureState`,
      `blockedEgressHosts`); **Modify** `packages/agent/src/entities/work-build.entity.ts`; **Modify**
      `packages/contracts/src/apps/builds.ts` (`AppBuildDetail.supplyChain`).
      **Test**: `apps/api/src/migrations/__tests__/AddWorkBuildSupplyChain.spec.ts` — additive only (three `ADD COLUMN`, no
      other statement); `down()` drops only those columns.
      **Done when**: `pnpm --filter ever-works-api test -- AddWorkBuildSupplyChain` is green and the migration runs up/down
      on both databases.

- [ ] **T35. `apps-builder` plugin.**
      **Create** `packages/plugins/apps-builder/` (package `@ever-works/apps-builder-plugin`; manifest `category: build`,
      `buildKind: 'apps-builder'`; `prepareRepository` = no repository writes; `startBuild` →
      `IAppsTierProvider.submitBuild?` with an `AppBuild` request (APW-10 plan §3.2: sealed build values,
      `sealedSourceToken`, caps); `getBuild` → `getBuild?`; caps from `APP_BUILD_MANAGED_*`; concurrency 1 per App Work and
      3 per account → `managedConcurrencyLimit`). No builder endpoint or credential setting exists in this plugin.
      **Modify** `packages/agent/src/facades/build.facade.ts` — resolve `apps-builder` only when
      `AppsTierPolicy.isOpen()` and `managedScope() === 'any'` and the target is Ever Works Apps; otherwise never
      (Resolution R-5 — no read of `EVER_WORKS_APPS_MANAGED_ENABLED`).
      **Test**: `packages/plugins/apps-builder/src/__tests__/apps-builder.plugin.spec.ts` against an `IAppsTierProvider`
      fake — caps clamped to maxima; token lifetimes requested (≤ 1 h source, ≤ timeout + 60 min push); a snapshot whose
      `blockedEgressHosts` lists hosts maps to failure class `egressBlocked` with at most 10 hosts (ACC-05-27); the request
      never asks for a privileged workload. Extend `packages/agent/src/facades/__tests__/build.facade.spec.ts` — refused for
      Your cluster, for scope `verified-blueprints`, and when the policy is closed; a spy proves the env var is never read.
      **Done when**: `pnpm --filter @ever-works/apps-builder-plugin test` and `pnpm --filter @ever-works/agent test --
build.facade` are green.

- [ ] **T36. Verdict, receipts and UI for the managed tier.**
      **Modify** `packages/agent/src/app-builds/deployable-verdict.ts` (signature and fixable-critical clauses),
      `packages/agent/src/app-builds/app-builds.service.ts` (receipt payer `platform`),
      `apps/web/src/components/works/detail/builds/BuildDetailDrawer.tsx` (scan counts, **Signed**), i18n
      (`dashboard.workDetail.builds.supplyChain.*`, `failure.egressBlocked.*`) in all 21 files under `apps/web/messages/`.
      **Test**: extend `packages/agent/src/app-builds/__tests__/deployable-verdict.spec.ts` with `unsigned` (unsigned and
      foreign-signed) and `criticalVulnerability` (ACC-05-28); extend
      `apps/web/src/components/works/detail/builds/BuildDetailDrawer.unit.spec.tsx` — scan counts and **Signed** render, and
      a Build row with `completedAt` shows no running workload (ACC-05-26).
      **Done when**: `pnpm --filter @ever-works/agent test -- deployable-verdict` and `pnpm --filter ever-works-web test --
BuildDetailDrawer` are green.

- [ ] **T37. P3 acceptance and ship gate.**
      **Modify** `docs/specs/features/app-works/ACCEPTANCE.md` (APW-05 rows ACC-05-26…28, with the owner's agreement) and
      `docs/specs/features/app-works/TRACKER.md` (tick P3).
      **Test**: ACC-05-26…28 walked in APW-10's gated environment (manual, evidence in the private operations repository);
      root `pnpm format:check`, `pnpm lint`, `pnpm type-check`, `pnpm test`, `pnpm build`.
      **Done when**: the three criteria are recorded green and every root command exits 0.

---

# Cross-phase closing tasks

- [ ] **T38. Telemetry.**
      **Create** `packages/agent/src/app-builds/app-builds.telemetry.ts` emitting the events in [plan §9.1](./plan.md)
      through APW-01 T36's pattern: an `@Optional()` sink token bound by the API — reuse `APP_WORKS_TELEMETRY_SINK` /
      `AppWorksTelemetryService` (`packages/agent/src/app-works/app-works-telemetry.service.ts`) rather than importing
      the monitoring package, on which `packages/agent` takes no dependency (corrected 2026-09-25); **Modify**
      `packages/agent/src/app-builds/app-builds.service.ts`,
      `app-build-sweep.service.ts` and `packages/plugins/github-actions-build/src/repo/workflow-writer.ts` (via a callback)
      to call it.
      **Test**: `packages/agent/src/app-builds/__tests__/app-builds.telemetry.spec.ts` — no event payload contains an env
      name, a check name or command, a repository name, a commit message, a log line or a token.
      **Done when**: `pnpm --filter @ever-works/agent test -- app-builds.telemetry` is green.

- [ ] **T39. Contracts confirmation.**
      **Modify** `docs/specs/features/app-works/TRACKER.md` (APW-05 row) and, through its owner, `CONTRACTS.md` if the merged
      code differs from the rows this epic added (jobs `app-build-prepare`, `app-build-sweep`; route
      `POST /api/works/:id/builds/:buildId/cancel`; `checkImageAccess?` and verification inputs on `IBuildPlugin`; the §3
      checks-job row as a matrix job (R-9); the §9 repository conventions incl. `EW_VERIFY__PROMPTED`).
      **Test**: `rg -n "app-build-prepare|app-build-sweep|builds/:buildId/cancel|checkImageAccess|Ever Works check|EW_VERIFY__PROMPTED" apps packages`
      finds each name in merged code.
      **Done when**: every CONTRACTS row this epic owns matches a hit, or the row was corrected.

- [ ] **T40. Update statuses.**
      **Modify** `docs/specs/features/app-works/APW-05-builds/spec.md`, `plan.md` and this file — `Implemented` / `Done`.
      **Test**: re-check every gate in [plan §12](./plan.md) against the merged code with a reviewer.
      **Done when**: each gate is ticked with a link to the code or test that proves it, and known gaps remain listed.

---

# Program audit follow-ups (added 2026-09-17)

- [ ] **T41. The `checks` matrix job (Resolution R-9).**
      **Create** `packages/plugins/github-actions-build/src/workflow/checks-job.ts` ([plan §2.4, §4.14](./plan.md)): one
      matrix row per `spec.checks[]` entry in declared order (`name`, `required`, `timeoutMinutes = ceil(timeoutSeconds /
60)`, `commandB64`), job-level `name: "Ever Works check: ${{ matrix.check.name }}"`, `if:` pull request from the same
      repository, `permissions: { contents: read }`, `continue-on-error: ${{ !matrix.check.required }}`, `fail-fast:
false`, `max-parallel: 5`, checkout of the pull request head with `persist-credentials: false`, and the base64 run
      step.
      **Modify** `packages/plugins/github-actions-build/src/workflow/generator.ts` and `src/workflow/inputs-hash.ts` — emit
      the job after `build` when `checks` is non-empty; add `checks` (with `commandSha256`) to the canonical inputs.
      **Ownership (`APW05-G04`).** T41 and T42 are the **only** implementers of the `checks` job, and the single golden is
      `src/__tests__/golden/checks.yml`; APW-08 T15 consumes the check runs and does not edit this generator, and no other
      epic uses the name `app-checks-two.yml`. The trigger is same-repository pull requests into the tracked branch only —
      no `push`, no `workflow_dispatch` (CONTRACTS §3's row is corrected to match FR-65 by this fix pass).
      **Test**: `packages/plugins/github-actions-build/src/__tests__/checks-job.spec.ts` — two checks (one advisory) → two
      matrix rows and the exact job name expression; the job's YAML contains `contents: read` and nothing else under
      `permissions`, no `secrets.` and no `EW_` token other than `EW_CHECK_COMMAND_B64`, no `cache-` key, no `needs:`; the
      advisory row sets `required: false` so `continue-on-error` is true; the same-repository guard is present (ACC-05-29);
      a command containing `${{ secrets.X }}`, a backtick and both quote kinds appears nowhere in clear text and decodes
      back byte-identical; `timeoutSeconds` 61 → 2 minutes; a golden file `src/__tests__/golden/checks.yml` stays byte-stable.
      **Done when**: `pnpm --filter @ever-works/github-actions-build-plugin test -- checks-job generator` is green and the
      golden passes `actionlint` locally.

- [ ] **T42. Checks-only workflow, observation and receipts for checks (R-9).**
      **Modify** `packages/plugins/github-actions-build/src/workflow/generator.ts` (checks-only file for `image`/`none`
      strategies: `on: pull_request` only, `permissions: {}`, concurrency, `checks` job), `src/repo/workflow-writer.ts`
      (write checks-only files through the same delivery rules; propose removal by pull request when neither a build nor a
      check remains), `packages/agent/src/app-builds/app-build-prepare.runner.ts` (run `prepareRepository` without secret
      sync for `image`/`none`/`auto` when checks exist), `packages/agent/src/app-builds/app-builds.service.ts` (receipt
      metadata `checksBillableMinutes`).
      **Test**: extend `packages/plugins/github-actions-build/src/__tests__/generator.spec.ts` — `image` + one check → a file
      with no `build` job, no `push` or `workflow_dispatch` trigger and no `secrets.` reference; removing the check yields
      no workflow content (ACC-05-30). Extend `packages/agent/src/app-builds/__tests__/app-build-prepare.runner.spec.ts` —
      `image` + checks calls `prepareRepository` with zero values and creates no Build (ACC-05-30). Extend
      `packages/agent/src/app-builds/__tests__/app-builds.service.spec.ts` — a pull request Build with 3 check minutes records
      `checksBillableMinutes: 3` inside `units` and the Build's status and `deployable` are identical with checks green or
      red (ACC-05-29).
      **Done when**: the three specs are green through their package commands.

- [ ] **T43. Verification inputs from APW-07's ephemeral mode (Resolution R-10).**
      **Modify** `packages/agent/src/app-builds/app-builds.service.ts` — `startVerification(workId, { ref, sha,
reuseImageDigest? }) → { buildId }` asks
      `APP_RUNTIME_ENV_SOURCE`'s ephemeral mode for the value-free runner recipe (APW-07 plan §4.6.1; typed fake until APW-07
      lands), builds `components`, `dependencies`, `jobs` and `smoke` from `AppSpecService.getEffectiveSpec(workId, sha)`,
      **validates the plan against [`verify-plan.schema.json`](./verify-plan.schema.json) with ajv before dispatch**
      (`APW05-G11`), refuses with `missingBuildValues` when a required prompted name is unset, writes the per-run
      `EW_VERIFY__PROMPTED` secret through the plugin **only when T46's approval gate passes** (`XC-01`), records
      `verifySecretNames`, passes `reuseImageDigest` when a
      succeeded Build of the same commit has a confirmed digest, **dispatches on the tracked branch after the bootstrap
      file of plan §4.6 step 0 when the App Work has no workflow (`APW05-G02`)**, and
      dispatches `startBuild({ mode: 'verify', verification, reuseImageDigest })`. **Modify**
      `packages/agent/src/app-builds/app-build-watch.runner.ts` and `app-build-sweep.service.ts` — delete the
      per-run secret. **Modify** `packages/plugins/github-actions-build/src/github-actions-build.plugin.ts` — `getBuild`
      fills `BuildSnapshot.verification` `{ jobs[], componentsReady, smoke[] }` from the result artifact.
      **Test**: extend `packages/agent/src/app-builds/__tests__/app-builds.service.spec.ts` — the plan JSON contains the recipe
      and no value from the env source fake (sentinel search); **every generated plan validates against
      `verify-plan.schema.json` and a plan over 60,000 characters or 12 GiB is refused before dispatch**; an unset required
      prompted name blocks before dispatch; a reused digest sets `ew_reuse_digest` and leaves the plan with no `build`
      section; **an App Work with no workflow and no applied spec delivers exactly one bootstrap commit and then dispatches
      on the tracked branch with the proposal head sha, while a Link App Work blocks with `workflowPending` and the pull
      request URL and dispatches nothing** (`APW05-G02`); **a verification Build's queued, running and terminal
      transitions each call `APP_PROVISION_EVENTS_PORT.buildUpdated`, including a pre-dispatch `blocked` transition**
      (`APW05-G11`); the verification Build is created with trigger `verification` and is never
      deployable (ACC-05-23). Extend `packages/plugins/github-actions-build/src/__tests__/run-observer.spec.ts` — the
      artifact's job and smoke rows become `verification` in the CONTRACTS §3 shape (ACC-05-23). Extend
      `app-build-watch.runner.spec.ts` and `app-build-sweep.service.spec.ts` — the per-run secret is deleted exactly once.
      **Done when**: `pnpm --filter @ever-works/agent test -- app-builds.service app-build-watch.runner app-build-sweep.service`
      and `pnpm --filter @ever-works/github-actions-build-plugin test -- run-observer` are green, and APW-04's verification
      loop fake receives `{ jobs, componentsReady, smoke }`.

- [ ] **T44. Failure hand-off to agents in the user's words (FR-39, ACC-05-19).**
      **Create** `packages/contracts/src/apps/build-failure-copy.ts` — `APP_BUILD_FAILURE_COPY_EN` (14 classes, `{ title,
suggestion }` templates with `{param}` placeholders equal to plan §8's `failure.<class>` leaves) **and the type
      `AppBuildFailureHandoff { class; title; suggestion; excerpt: string[]; logsUrl: string | null; untrusted: true }`**
      (`APW05-G12`). **Modify** `packages/contracts/src/apps/index.ts` (export) and
      `packages/agent/src/app-builds/app-build-failure-copy.ts` —
      `forAgent(build): AppBuildFailureHandoff` → `{ class, title, suggestion, excerpt, logsUrl, untrusted: true }`,
      exported from
      `packages/agent/src/app-builds/index.ts` for APW-08, with the rule that **no consumer re-fetches or re-redacts build
      logs** (FR-38).
      **Named consumer action (`APW05-G12`).** T27's "APW-08's action when present" is
      `requestAppChangeAction({ workId, buildId, request? })` → `POST /api/works/:id/evolve` with the failed Build's
      `buildId` preset in APW-08's `RequestChangeDialog`; hidden when APW-08 is absent or the viewer lacks edit access.
      **Test**: `packages/agent/src/app-builds/__tests__/app-build-failure-copy.spec.ts` — for a seeded `outOfMemory` Build
      with `{ memory: '7Gi', max: '14 GiB' }` the agent payload's title and suggestion equal the English UI copy of spec §6.3
      with the same parameters, the excerpt equals the stored redacted excerpt, `untrusted` is `true` and the returned
      object satisfies `AppBuildFailureHandoff` (ACC-05-19).
      `apps/web/src/lib/api/app-build-failure-copy.parity.unit.spec.ts` — for every class, the `en.json` leaves
      `dashboard.workDetail.builds.failure.<class>.title|suggestion` equal `APP_BUILD_FAILURE_COPY_EN` (ACC-05-19).
      **Done when**: `pnpm --filter @ever-works/agent test -- app-build-failure-copy` and `pnpm --filter ever-works-web test --
      app-build-failure-copy.parity` are green.

- [ ] **T45 (P1, lands with T4–T5; recheck with T34). Classify new tables for workspace backup (R-25).**
      **Modify** `packages/agent/src/account-transfer/backup/collectors/domain-specs.ts` — append to the `works` domain:
      `{ file: 'builds.jsonl', entity: 'WorkBuild', scope: { by: 'parent', column: 'workId', from: 'workIds' } }` **and**
      `{ file: 'build-preparations.jsonl', entity: 'WorkBuildPreparation', scope: { by: 'parent', column: 'workId', from:
'workIds' } }` (`APW05-G03`).
      **Modify** `packages/agent/src/account-transfer/backup/redaction.ts` — `BACKUP_BENIGN_COLUMNS` gains `appSpecHash`
      (a digest of an App spec, which holds no secret values), `buildSecretNames` and `verifySecretNames` (secret names,
      never values), `secretsSyncedAt` (a timestamp) and `secretCheck` (a verdict); `ENTITY_DROPPED_COLUMNS` gains
      `WorkBuild: ['buildInputsHash']` (derived from the fingerprints of build values, meaningless outside this
      workspace) and `WorkBuildPreparation: ['buildInputsHash']`. `WorkBuildPreparation.webhookId`, `runsEtag` and
      `repositoryBlock` carry no secret value; nothing joins `BACKUP_DROPPED_ENTITIES`; T34's `scanSummary`,
      `signatureState` and
      `blockedEgressHosts` need no entry.
      **Test**: extend `packages/agent/src/account-transfer/backup/collectors/collectors.spec.ts` — `WorkBuild` and
      `WorkBuildPreparation` are each referenced exactly once, in `works`, scoped `parent` on `workId` from `workIds`, not
      dropped; an `EntityBackupCollector` over the `works` spec yields a fixture `WorkBuild` row with
      `buildSecretNames: ['EW_DATABASE_URL']` intact and no `buildInputsHash` key, and a fixture `WorkBuildPreparation`
      row with `webhookId`/`runsEtag` intact and no `buildInputsHash` key.
      **Done when**: `pnpm --filter @ever-works/agent test -- collectors redaction` is green — including the
      secret-shaped-column guard in `redaction.spec.ts` — and `data/works/builds.jsonl` in a backup with one Build has
      no `buildInputsHash` key.

- [ ] **T46 (P1, lands with T8 and T10). Restricted build values on pull requests and verifications (`XC-01`, FR-71, FR-72).**
      **Modify** `packages/plugins/github-actions-build/src/workflow/generator.ts` — with
      `allowBuildValuesOnPullRequests` false (the default) a `fromEnv` build argument is emitted as
      `<NAME>=${{ github.event_name == 'pull_request' && '<restricted literal>' || secrets.EW_<NAME> }}`, one fixed marker
      per value name; the "Check build values" step's `EW_MISSING` check is emitted only for the non-pull-request path;
      with the setting true, the previous unrestricted form is emitted unchanged (plan §4.7b).
      **Modify** `packages/plugins/github-actions-build/src/settings.schema.ts` — the two new Work-scope booleans
      `allowBuildValuesOnPullRequests` (default `false`) and `verificationPromptedValuesRequireApproval` (default `true`)
      (T7 creates the file; this task adds the keys and their copy).
      **Modify** `packages/agent/src/app-builds/app-builds.service.ts` — `startVerification` writes
      `EW_VERIFY__PROMPTED` only when the verification-prompted-values gate of plan §4.7b passes (no build-affecting file
      in the base→head diff, or the owner approved it), and records why it withheld the values on the Build so the detail
      drawer can say **"Owner approval is needed before prompted values are used for this verification."** with **Review
      the change**. The `verify` job references no stored `EW_<NAME>` at all — the value-free recipe is the only source.
      **Modify** `apps/web/src/components/works/detail/builds/BuildSettingsDialog.tsx` and the new
      `dashboard.workDetail.builds.settings.allowBuildValuesOnPullRequests`,
      `…allowBuildValuesOnPullRequestsWarning` and `…verificationPromptedValuesRequireApproval` leaves in all 21
      `apps/web/messages/*.json` files, plus a notice on the Build detail drawer.
      **Test**: `packages/plugins/github-actions-build/src/__tests__/secret-mode.spec.ts` — the pull-request path renders
      the restricted literal and contains **no** `secrets.EW_` reference while the push path keeps
      `${{ secrets.EW_<NAME> }}` (ACC-05-31); `EW_MISSING` is absent from the pull-request path; the golden
      `restricted-values` is byte-stable; `allowBuildValuesOnPullRequests: true` reproduces the unrestricted golden byte
      for byte. Extend `packages/agent/src/app-builds/__tests__/app-builds.service.spec.ts` — a prompted name is withheld
      when the diff touches a `Dockerfile`, and delivered when the owner approved the diff or the flag is false
      (ACC-05-32); a sentinel search proves the stored value is absent from the plan, the dispatch inputs and every log
      line.
      **Done when**: `pnpm --filter @ever-works/github-actions-build-plugin test -- secret-mode generator` and
      `pnpm --filter @ever-works/agent test -- app-builds.service` are green, and ACC-05-31's honeypot leaves the canary
      sink empty on the injection fixture.

---

## Definition of Done

- Every checkbox above is ticked for the phases being shipped.
- `pnpm format:check`, `pnpm lint`, `pnpm type-check`, `pnpm test` and `pnpm build` are green from the repo root.
- `apps/api/src/ingest/github/github-check-intake.service.spec.ts`,
  `apps/api/src/plugins-capabilities/deploy/deploy.service.server-side.spec.ts` and every existing deploy e2e spec pass
  **unchanged** — the additive-only guarantee.
- Every acceptance box in [spec §8](./spec.md) for the shipped phase has been walked against real GitHub-hosted runners,
  and each ACC-05 id appears in at least one **Test** line above.
- No file in the repository outside `packages/plugins/github-actions-build/` and `packages/plugins/apps-builder/` contains
  either plugin id as a string literal (grep in CI).
- Every gate in [plan §12](./plan.md) is confirmed, and its known gaps are still recorded there rather than silently closed.
