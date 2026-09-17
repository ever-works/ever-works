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
  APW-13's fixture branches (R-23). Until they land, T16–T22 and T43 run against the typed fakes named in each task.

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
      `checksBillableMinutes` and `verifySecretNames`), `TimestampColumn` from `packages/agent/src/entities/_types.ts`
      for timestamps, `ManyToOne(() => Work, { onDelete: 'CASCADE' })`, Tier A `tenantId`/`organizationId` without
      relations, and the five indexes.
      **Modify** `packages/agent/src/entities/index.ts`, `packages/agent/src/database/_entity-names.ts` (`'WorkBuild'`),
      `packages/agent/src/database/_entities-inventory.ts` (import + `ENTITIES`).
      **Test**: `packages/agent/src/entities/__tests__/work-build.entity.spec.ts` — index names, uniqueness flags, the partial
      `WHERE` on `uq_work_builds_provider_run`, both scope columns present.
      **Done when**: `pnpm --filter @ever-works/agent test -- work-build.entity` is green and the drift specs
      `packages/agent/src/database/database.module.spec.ts` and `packages/agent/src/database/database.config.spec.ts`
      pass without editing a magic number.

- [ ] **T5. Migration.**
      **Create** `apps/api/src/migrations/1792050000000-CreateWorkBuilds.ts` (generate the skeleton with
      `cd apps/api && pnpm typeorm migration:generate -d typeorm.config.ts src/migrations/CreateWorkBuilds`, then re-stamp
      the class name/timestamp to the APW-05 block). `down()` drops only `work_builds`.
      **Test**: `apps/api/src/migrations/__tests__/CreateWorkBuilds.spec.ts` — `up()` creates the table, FK and five
      indexes; `down()` removes only them; the file contains no `ALTER TABLE` on a pre-existing table.
      **Done when**: `pnpm --filter ever-works-api test -- CreateWorkBuilds` is green, a fresh Postgres and a fresh SQLite
      database both migrate up and down cleanly, and the timestamp is above the newest migration on `develop`.

- [ ] **T6. `AppBuildRepository`.**
      **Create** `packages/agent/src/database/repositories/app-build.repository.ts` with `insertWithNextNumber(workId, data)`
      (transaction, `MAX(number)+1`, 3 retries on unique violation), `upsertByProviderRun`, `findPage(workId, filters,
page, pageSize)`, `findByIdForWork`, `findRecentForCommit(workId, sha, sinceMs)`, `claimWatchLease(id, ms)`,
      `findSilentNonTerminal(now, silenceMs, limit)`, `findWithOrphanedVerifySecrets(now, limit)`, `markLost(ids)`.
      **Modify** `packages/agent/src/database/index.ts` to export it.
      **Test**: `packages/agent/src/database/repositories/__tests__/app-build.repository.spec.ts` — 20 concurrent
      `insertWithNextNumber` calls yield numbers 1…20 with no gap or duplicate; lease claim returns 0 rows for a live lease;
      silent-build query honours the 90 s silence and the 200 limit, oldest first; orphaned-verify-secret query selects only
      verification Builds older than 40 minutes with a non-empty `verifySecretNames`.
      **Done when**: `pnpm --filter @ever-works/agent test -- app-build.repository` is green on SQLite and on the Postgres
      test container.

## P1.3 — The `github-actions-build` plugin

- [ ] **T7. Package scaffold and settings.**
      **Create** `packages/plugins/github-actions-build/` — `package.json` (name `@ever-works/github-actions-build-plugin`,
      `everworks.plugin` block from [plan §4.3](./plan.md), deps `octokit`, `libsodium-wrappers`, `fflate`; `tsup`,
      `vitest` scripts copied from `packages/plugins/k8s/package.json`), `tsconfig.json`, `tsup.config.ts`,
      `vitest.config.ts`, `src/index.ts`, `src/settings.schema.ts` ([plan §4.4](./plan.md), `pullToken` with
      `x-secret: true`), `src/github-actions-build.plugin.ts` (id, category `build`, capability `build`,
      `buildKind: 'github-actions'`, `supportedStrategies: ['dockerfile']` — `auto` is not supported, R-13 — method stubs
      throwing `not implemented`).
      **Test**: `packages/plugins/github-actions-build/src/__tests__/plugin.manifest.spec.ts` — manifest
      id/category/capabilities; `pullToken` is `x-secret`; `attestations` defaults `false`; `reclaimDisk` defaults `true`;
      `supportedStrategies` excludes `auto`.
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
      requests whose head repository differs and no job that references `secrets.` or pushes runs for them (ACC-05-06);
      tags `sha-${{ env.EW_SHA }}` + `branch-<slug>` for push and `pr-<n>` for pull requests, never `latest` (ACC-05-07);
      `cache-to` only on push; the concurrency block sets `cancel-in-progress` only for `pull_request` and groups the
      tracked branch by ref (ACC-05-10); the services golden declares the `postgres` service and a build-arg resolving
      to `127.0.0.1` (ACC-05-12).
      `packages/plugins/github-actions-build/src/__tests__/action-pins.spec.ts` — every pin matches `^[0-9a-f]{40}$`
      (ACC-05-05).
      **Done when**: `pnpm --filter @ever-works/github-actions-build-plugin test -- generator action-pins` is green and the
      golden workflow for the minimal fixture passes `actionlint` locally.

- [ ] **T9. Branch protection and workflow writer.**
      **Create** `packages/plugins/github-actions-build/src/repo/branch-protection.ts` (404 → unprotected; 200 with
      reviews or status checks → protected; 403 → protected) and `src/repo/workflow-writer.ts` (through the
      `RepositoryWriter` parameter only — APW-03's `commitFiles?` via the facade; pull-request path on
      `ever-works/build-workflow` with one reused pull request; read-back sha256 compare with one retry; hand-edit detection
      against `lastWrittenWorkflowSha256`; `nonFastForward` retries ≤ 3; `createdByAppWork: false` (Link) always takes the
      pull request path — Resolution R-4).
      **Test**: `packages/plugins/github-actions-build/src/__tests__/workflow-writer.spec.ts` with a fake
      `RepositoryWriter` — no clone call exists; direct commit on an unprotected fork changes exactly the one workflow path
      (ACC-05-01); pull request on a protected branch and on `createdByAppWork: false`; a second and third preparation
      update the same pull request so one stays open (ACC-05-02); read-back mismatch → retry → `workflowWriteFailed`;
      hand-edited file → `editedByHand` + pull request, never an overwrite on the tracked branch (ACC-05-04); unchanged
      content → `unchanged` and zero write calls.
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
      strict schema, digest regex).
      **Modify** `packages/plugins/github-actions-build/src/github-actions-build.plugin.ts` — implement `startBuild`
      (workflow dispatch with `ew_build_id`, `ew_sha`, `ew_mode`, `ew_verify_plan` ≤ 60,000 chars), `getBuild`,
      `cancelBuild`, `getLogsUrl`.
      **Test**: `packages/plugins/github-actions-build/src/__tests__/run-correlator.spec.ts` (adoption by `display_title`
      inside the window, none outside it); `run-observer.spec.ts` (two jobs 61 s + 30 s → 3 minutes and a receipt payload
      carrying them — ACC-05-20; a failed `Ever Works check: lint` job with a succeeded `build` job → snapshot
      `succeeded`, `checksBillableMinutes` 1 — ACC-05-29; pull request run reports head sha not merge sha; a run that
      stays `in_progress` across two polls and then `completed` maps each status — ACC-05-11; `cancelBuild` calls the
      cancel endpoint and a `cancelled` conclusion maps to `cancelled` — ACC-05-09; tags reported without `latest` —
      ACC-05-07); `result-artifact.spec.ts` (oversize zip, malformed digest, extra keys rejected).
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
      as a template literal) and `src/workflow/verify-runner.sh.ts` ([plan §4.10](./plan.md): plan schema check, 12 GiB
      summed memory refusal, throwaway `postgres`/`redis`/`minio` containers pinned by digest with no volumes, recipe
      materialisation with `openssl rand` / `openssl genpkey` into a `0600` env file, prompted values from the per-run
      secret, jobs, readiness waits, smoke via `curl --max-time 30 --max-redirs 0`, per-job and per-smoke result rows, env
      file shredded, `set +x`).
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
      **Create** `packages/agent/src/app-builds/app-builds.service.ts` (`requestRebuild` with 10 s dedupe and 10/hour limit,
      `cancel`, `startVerification(workId, { ref, sha, plan, reuseImageDigest? })`, `applySnapshot(buildId, snapshot)`,
      `finalize(buildId)` — digest confirmation, verdict, receipt, Activity, events), `deployable-verdict.ts` ([plan
      §5.1](./plan.md), first failing clause wins), `app-build-failure-copy.ts` (class → i18n key + params, reused for the
      agent hand-off in T44), `packages/agent/src/app-builds/app-builds.module.ts`, `index.ts`.
      **Modify** `packages/agent/src/entities/plugin-usage-event.entity.ts` — add `BUILD = 'build'` to
      `PluginUsageCapability` (varchar; no migration).
      **Modify** `packages/agent/src/entities/activity-log.types.ts` — add `APP_BUILD = 'app_build'` to
      `ActivityActionType`; `action` strings `app.build.queued|started|succeeded|failed|cancelled` (Resolution R-2).
      **Test**: `packages/agent/src/app-builds/__tests__/deployable-verdict.spec.ts` — one case per clause in order: a
      pull-request Build → `pullRequest`, a verification Build → `verification` (ACC-05-23), `specValidAtCommit: false` →
      `specInvalid`, a Build whose `buildInputsHash` differs from the current hash after a rotation → `staleInputs`
      (ACC-05-16), secret check failed → `secretCheckFailed`, unconfirmed digest → `digestUnconfirmed`.
      `packages/agent/src/app-builds/__tests__/app-builds.service.spec.ts` — a Rebuild returns within 2 s with a slow
      dispatcher mocked (dispatch not awaited past the insert); dedupe inside/outside 10 s returns the same/new Build;
      11th rebuild → `rebuildRateLimited` with minutes (ACC-05-08); `cancel` on a running Build calls `cancelBuild` and the
      next snapshot finalises `cancelled` (ACC-05-09); receipt recorded once with `units`, payer `workspace`, operation
      `build.run`, `costCents: 0` and no credit ledger call (ACC-05-20); Activity rows carry `actionType: 'app_build'`
      and metadata with no value and no excerpt line.
      **Done when**: `pnpm --filter @ever-works/agent test -- deployable-verdict app-builds.service` is green.

- [ ] **T18. Dispatchers.**
      **Create** `packages/agent/src/tasks/app-build-prepare-dispatcher.ts`, `app-build-prepare.types.ts`,
      `app-build-watch-dispatcher.ts`, `app-build-watch.types.ts` ([plan §7.1](./plan.md)).
      **Modify** `packages/agent/src/tasks/index.ts` (exports) and `packages/agent/src/tasks/_tasks-symbols.ts`
      (`APP_BUILD_PREPARE_DISPATCHER`, `APP_BUILD_WATCH_DISPATCHER`, alphabetical).
      **Modify** `packages/agent/src/tasks/job-runtime.providers.ts` and `packages/tasks/src/trigger/trigger.module.ts` to
      bind both through the job-runtime registry like the existing `KB_REEMBED_WORK_DISPATCHER`.
      **Test**: `packages/agent/src/tasks/tasks.spec.ts` passes with the two new symbols counted automatically.
      **Done when**: `pnpm --filter @ever-works/agent test -- tasks.spec` is green.

- [ ] **T19. `app-build-prepare` job.**
      **Create** `packages/agent/src/app-builds/app-build-prepare.runner.ts` ([plan §7.2](./plan.md): strategy gate,
      build values through APW-07, runner selection, `prepareRepository` (incl. checks), persistence, `startBuild` for
      requested Builds, lock `app-build-prepare:<workId>` ≤ 5 minutes with one re-run) and
      `packages/tasks/src/tasks/trigger/app-build-prepare.task.ts`; **Modify** `packages/tasks/src/tasks/trigger/index.ts`.
      **Test**: `packages/agent/src/app-builds/__tests__/app-build-prepare.runner.spec.ts` — `image`/`none` without checks:
      no Build and no plugin call; `auto` blocks a requested Build with `strategyNotSupported` (R-13); a missing required
      build value blocks the requested Build naming it and nothing is dispatched (ACC-05-14); runner too small blocks with
      both numbers (ACC-05-22); concurrent dispatch runs once and re-runs once.
      **Done when**: `pnpm --filter @ever-works/agent test -- app-build-prepare.runner` is green.

- [ ] **T20. `app-build-watch` job.**
      **Create** `packages/agent/src/app-builds/app-build-watch.runner.ts` ([plan §7.3](./plan.md)) and
      `packages/tasks/src/tasks/trigger/app-build-watch.task.ts`.
      **Test**: `packages/agent/src/app-builds/__tests__/app-build-watch.runner.spec.ts` — lease prevents a second
      concurrent observation; terminal transition finalises exactly once across 3 deliveries; `app.build.succeeded` is
      emitted only when deployable is computed (with the flag in the payload); a succeeded push Build with a confirmed
      digest and `sha-<40>` / `branch-<slug>` tags is `deployable: true` (ACC-05-07); a verification Build's per-run secret
      is deleted on its terminal transition.
      **Done when**: `pnpm --filter @ever-works/agent test -- app-build-watch.runner` is green.

- [ ] **T21. `app-build-sweep` job.**
      **Create** `packages/agent/src/app-builds/app-build-sweep.service.ts` and
      `packages/tasks/src/tasks/trigger/app-build-sweep.task.ts` (`schedules.task({ id: 'app-build-sweep', cron:
'*/2 * * * *' })`, same shape as `packages/tasks/src/tasks/trigger/deploy-ready-poller.task.ts`).
      **Test**: `packages/agent/src/app-builds/__tests__/app-build-sweep.service.spec.ts` — 250 silent Builds → 200
      dispatched, oldest first; a Build silent for 91 s is dispatched so a terminal status lands within the next 2-minute
      tick (≤ 3 min, ACC-05-11); lost thresholds for adopted and never-adopted Builds; `digestUnconfirmed` rechecked after
      a pull token is saved; an orphaned verification secret is deleted.
      **Done when**: `pnpm --filter @ever-works/agent test -- app-build-sweep.service` is green.

- [ ] **T22. Event listeners.**
      **Create** `packages/agent/src/app-builds/app-builds.listener.ts` — `app.spec.applied` with `changedBlocks` including
      `build` or `checks` → prepare; `app.env.changed` with a build-phase name → prepare, debounced 10 s per Work; pull
      token saved → prepare (reason `pullTokenSaved`).
      **Test**: `packages/agent/src/app-builds/__tests__/app-builds.listener.spec.ts` — runtime-only names do not dispatch;
      5 changes within 10 s dispatch once; dispatch happens within 60 s of the first change, so `EW_` secrets re-sync
      inside the SLA (ACC-05-13); a `checks`-only change dispatches prepare.
      **Done when**: `pnpm --filter @ever-works/agent test -- app-builds.listener` is green.

## P1.5 — API and webhook intake

- [ ] **T23. Builds controller.**
      **Create** `apps/api/src/app-builds/app-builds.controller.ts`, `apps/api/src/app-builds/dto/app-builds.dto.ts`
      (`ListAppBuildsQueryDto` with `page`, `pageSize` 1–100, `status`, `trigger`, `branch`, `pullRequest`;
      `CreateAppBuildDto` with optional 40-hex `commitSha`), `apps/api/src/app-builds/app-builds.module.ts`.
      Routes and codes exactly as [plan §5](./plan.md); `ensureCanView` / `ensureCanEdit` from
      `packages/agent/src/services/work-ownership.service.ts`; non-`app` kind → 404.
      **Modify** `apps/api/src/api.module.ts` to import `AppBuildsModule`.
      **Test**: `apps/api/src/app-builds/app-builds.controller.spec.ts` — foreign id 404 on read, Rebuild and Cancel
      (ACC-05-24); viewer 403 on POST routes with code; 202 shape with `deduped` and a second POST inside 10 s returning the
      same Build (ACC-05-08); 429 `rebuildRateLimited` with `retryAfterMinutes`; 202 on cancel of a running Build and 409
      `notCancellable` on a terminal one (ACC-05-09); `nothingToBuild` for `image` strategy; no response contains
      `pullToken` or its value (ACC-05-21).
      **Done when**: `pnpm --filter ever-works-api test -- app-builds.controller` is green and Swagger lists the four
      routes under a `Builds` tag.

- [ ] **T24. `workflow_run` consumer.**
      **Create** `apps/api/src/app-builds/app-build-workflow-run.consumer.ts` ([plan §7.5](./plan.md)), registered on
      `GitHubWebhookDispatcherService` in `onModuleInit`; **Modify** `apps/api/src/app-builds/app-builds.module.ts` to
      import the ingest module's exported dispatcher.
      **Test**: `apps/api/src/app-builds/app-build-workflow-run.consumer.spec.ts` — other workflow paths ignored; repository
      not an App Work ignored; runs of an App Work whose applied strategy is `image`, `none` or `auto` ignored (ACC-05-30);
      a `pull_request` run whose head repository differs creates no Build (ACC-05-06); `requested` creates Build #n
      `queued`; duplicate delivery is a no-op; manual run adopted by `display_title`;
      `apps/api/src/ingest/github/github-check-intake.service.spec.ts` still passes unchanged.
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
      receipt with the checks-minutes line, verification results) and `BuildFailurePanel.tsx` (title + suggestion per class
      with params; excerpt in `<pre>`; **Ask an agent to fix this** calling APW-08's action when present, hidden otherwise).
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
      **Create** `apps/web/e2e/app-builds-tab.spec.ts` (list, URL filters, drawer, copy digest, viewer disabled —
      ACC-05-24), `apps/web/e2e/app-builds-failure.spec.ts` (each seeded failure class renders its §6.3 copy — ACC-05-17; a
      blocked `missingBuildValues` row names the value — ACC-05-14; `runnerTooSmall` shows both numbers — ACC-05-22),
      `apps/web/e2e/app-builds-pull-token.spec.ts` (too broad → error; valid → saved, never re-rendered; Deploy blocked copy
      for a private image without a token — ACC-05-21), `apps/web/e2e/app-builds-a11y.spec.ts` (axe on tab, drawer and
      dialog with no new violations; keyboard `↑↓`, `Enter`, `Esc`, `C`, `R` — ACC-05-25) ([plan §10.2](./plan.md)), seeding
      through the API with `EVER_WORKS_E2E_FAKES`.
      **Test**: `pnpm --filter ever-works-web test:e2e app-builds-` (the four specs above are the test).
      **Done when**: all four pass locally and in the `e2e.yml` lane; rows use `getByTestId`.

- [ ] **T31. Live acceptance wiring.**
      **Modify** `docs/specs/features/app-works/ACCEPTANCE.md` (the APW-05 table in §3 — coordinate with the file's owner) —
      map `ACC-05-01…23`, `29` and `30` to the APW-13 harness scenario names and to **APW-13's** fixture branches of
      `ever-works/app-fixture-hello` — the branches `variant/<name>`: `variant/build-oom`, `variant/services-postgres`,
      `variant/missing-value`, `variant/secret-in-image`, `variant/dockerfile-error`, created by APW-13 T58 (the short
      names used elsewhere in this epic map to `variant/<name>`; Resolution R-23: this epic references them and creates
      none).
      **Test**: `rg -n "ACC-05-(0[1-9]|1[0-9]|2[0-3]|29|30)" docs/specs/features/app-works/ACCEPTANCE.md` lists every id with
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
      **Create** `packages/agent/src/app-builds/app-builds.telemetry.ts` emitting the events in [plan §9.1](./plan.md) through
      the existing monitoring package; **Modify** `packages/agent/src/app-builds/app-builds.service.ts`,
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
      **Modify** `packages/agent/src/app-builds/app-builds.service.ts` — `startVerification` asks
      `APP_RUNTIME_ENV_SOURCE`'s ephemeral mode for the value-free runner recipe (APW-07 plan §4.6.1; typed fake until APW-07
      lands), refuses with `missingBuildValues` when a required prompted name is unset, writes the per-run
      `EW_VERIFY__PROMPTED` secret through the plugin, records `verifySecretNames`, passes `reuseImageDigest` when a
      succeeded Build of the same commit has a confirmed digest, and dispatches `startBuild({ mode: 'verify', verification
})`. **Modify** `packages/agent/src/app-builds/app-build-watch.runner.ts` and `app-build-sweep.service.ts` — delete the
      per-run secret. **Modify** `packages/plugins/github-actions-build/src/github-actions-build.plugin.ts` — `getBuild`
      fills `BuildSnapshot.verification` `{ jobs[], componentsReady, smoke[] }` from the result artifact.
      **Test**: extend `packages/agent/src/app-builds/__tests__/app-builds.service.spec.ts` — the plan JSON contains the recipe
      and no value from the env source fake (sentinel search); an unset required prompted name blocks before dispatch; a
      reused digest skips the image build input; the verification Build is created with trigger `verification` and is never
      deployable (ACC-05-23). Extend `packages/plugins/github-actions-build/src/__tests__/run-observer.spec.ts` — the
      artifact's job and smoke rows become `verification` in the CONTRACTS §3 shape (ACC-05-23). Extend
      `app-build-watch.runner.spec.ts` and `app-build-sweep.service.spec.ts` — the per-run secret is deleted exactly once.
      **Done when**: `pnpm --filter @ever-works/agent test -- app-builds.service app-build-watch.runner app-build-sweep.service`
      and `pnpm --filter @ever-works/github-actions-build-plugin test -- run-observer` are green, and APW-04's verification
      loop fake receives `{ jobs, componentsReady, smoke }`.

- [ ] **T44. Failure hand-off to agents in the user's words (FR-39, ACC-05-19).**
      **Create** `packages/contracts/src/apps/build-failure-copy.ts` — `APP_BUILD_FAILURE_COPY_EN` (14 classes, `{ title,
suggestion }` templates with `{param}` placeholders equal to plan §8's `failure.<class>` leaves). **Modify**
      `packages/contracts/src/apps/index.ts` (export) and `packages/agent/src/app-builds/app-build-failure-copy.ts` —
      `forAgent(build)` → `{ class, title, suggestion, excerpt, logsUrl, untrusted: true }`, exported from
      `packages/agent/src/app-builds/index.ts` for APW-08.
      **Test**: `packages/agent/src/app-builds/__tests__/app-build-failure-copy.spec.ts` — for a seeded `outOfMemory` Build
      with `{ memory: '7Gi', max: '14 GiB' }` the agent payload's title and suggestion equal the English UI copy of spec §6.3
      with the same parameters, the excerpt equals the stored redacted excerpt, and `untrusted` is `true` (ACC-05-19).
      `apps/web/src/lib/api/app-build-failure-copy.parity.unit.spec.ts` — for every class, the `en.json` leaves
      `dashboard.workDetail.builds.failure.<class>.title|suggestion` equal `APP_BUILD_FAILURE_COPY_EN` (ACC-05-19).
      **Done when**: `pnpm --filter @ever-works/agent test -- app-build-failure-copy` and `pnpm --filter ever-works-web test --
      app-build-failure-copy.parity` are green.

- [ ] **T45 (P1, lands with T4–T5; recheck with T34). Classify new tables for workspace backup (R-25).**
      **Modify** `packages/agent/src/account-transfer/backup/collectors/domain-specs.ts` — append to the `works` domain:
      `{ file: 'builds.jsonl', entity: 'WorkBuild', scope: { by: 'parent', column: 'workId', from: 'workIds' } }`.
      **Modify** `packages/agent/src/account-transfer/backup/redaction.ts` — `BACKUP_BENIGN_COLUMNS` gains `appSpecHash`
      (a digest of an App spec, which holds no secret values), `buildSecretNames` and `verifySecretNames` (secret names,
      never values), `secretsSyncedAt` (a timestamp) and `secretCheck` (a verdict); `ENTITY_DROPPED_COLUMNS` gains
      `WorkBuild: ['buildInputsHash']` (derived from the fingerprints of build values, meaningless outside this
      workspace). Nothing joins `BACKUP_DROPPED_ENTITIES`; T34's `scanSummary`, `signatureState` and
      `blockedEgressHosts` need no entry.
      **Test**: extend `packages/agent/src/account-transfer/backup/collectors/collectors.spec.ts` — `WorkBuild` is
      referenced exactly once, in `works`, scoped `parent` on `workId` from `workIds`, not dropped; an
      `EntityBackupCollector` over the `works` spec yields a fixture `WorkBuild` row with
      `buildSecretNames: ['EW_DATABASE_URL']` intact and no `buildInputsHash` key.
      **Done when**: `pnpm --filter @ever-works/agent test -- collectors redaction` is green — including the
      secret-shaped-column guard in `redaction.spec.ts` — and `data/works/builds.jsonl` in a backup with one Build has
      no `buildInputsHash` key.

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
