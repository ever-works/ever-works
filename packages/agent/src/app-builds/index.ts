/**
 * Public API of the Builds epic (APW-05 plan §5:1218-1223) — imported as
 * `@ever-works/agent/app-builds`.
 *
 * The barrel starts with what T17 lands and grows additively as the epic's
 * remaining services arrive: T18's dispatchers, T19/T19a's prepare runner and
 * `releaseRepository`, T20's watch runner and T21's `AppBuildSweepService`. Each
 * adds its own `export *` line here, so an importer never reaches into a deep path
 * (`@ever-works/agent/app-builds/app-builds.service`). Nothing is re-exported
 * speculatively — a name that does not exist yet must not appear, or `apps/api` and
 * `packages/tasks` would compile against a module that does not resolve.
 *
 * - `./app-builds.service` — `AppBuildsService` (T17), one service that owns a
 *   Build's whole life: `requestPrepare` with the `prepareSeq` marker of §7.2,
 *   `recordProviderRun` (the shared accept rules of §7.5), `requestRebuild` with
 *   its 10-second dedupe and 10-per-hour limit, `cancel`, `startVerification`,
 *   `getDetail`, `applySnapshot`, `finalize` and `publish` — the single Activity +
 *   event writer of §7.8. It also exports the two job payload types and the
 *   provisional tokens/dispatchers its collaborators will bind, the verification
 *   plan builder of §4.10 (`buildVerificationPlan`, `verificationPlanMemoryMiB`,
 *   `assertVerificationBudget`) and `AppVerificationPlanRefusedError`.
 * - `./deployable-verdict` — the §5.1 verdict reader (`evaluateBuildVerdict`),
 *   `computeCurrentInputsHash` and `DEPLOYABLE_VERDICT_CLAUSE_ORDER`. The clauses
 *   themselves are contracts' `evaluateBuildDeployability`, so the two can never
 *   drift from `secret-sync.ts`.
 * - `./app-build-failure-copy` — `AppBuildFailureCopy` (class → i18n key + params)
 *   and its `forAgent` hand-off, the payload APW-08's delivery follow-up consumes
 *   in T44.
 * - `./app-build-pull-token.service` — `AppBuildPullTokenService.save`
 *   (plan §4.12, `APW05-G07`), its refusal codes and
 *   `APP_BUILD_PLATFORM_SETTINGS_WRITER`.
 * - `./app-build-prepare.runner` — `AppBuildPrepareRunner` (T19), §7.2's
 *   repository work: the strategy gate, APW-07's build values, the runner fit
 *   (`APW05-G14`), `prepareRepository` with the checks (ACC-05-30), the §3.1b
 *   preparation-row upsert (`APW05-G03`), §4.6 step 0's verification bootstrap
 *   (`APW05-G02`), the blocked-Build retry (`APW05-G15`), the `prepareSeq`
 *   coalescing loop (`APW05-G17`), and the ports it consumes — T17's
 *   `APP_BUILD_PLUGIN_RESOLVER` (T16 binds it) and APW-07's `AppEnvResolver`. It
 *   also carries the skip reasons of an unconfigured installation and the pure
 *   helpers (`selectBuildRunner`, `appBuildWorkflowStateFor`,
 *   `unionMinusRemoved`, `mapPluginBlockedReason`, `appBuildBlock`,
 *   `appBuildChecks`, `declaredBuildMemoryGiB`) its spec pins.
 * - `./app-build-watch.runner` — `AppBuildWatchRunner` (T20), §7.3's observation
 *   of one Build: §7.3:1386-1388's two-minute `watchLeaseUntil` claim, the
 *   `IBuildPlugin.getBuild` read with APW-07's redactor (FR-38), the §3.1b
 *   re-stamp the first `startedAt` triggers (`APW05-G03`), the lease release, and
 *   §4.10's per-run verification-secret deletion (`APW05-G11`). Every transition
 *   it observes is written by T17's `applySnapshot`/`finalize`/`publish` — this
 *   runner writes no status and emits no event of its own. It also carries
 *   §7.1's ten-run in-process cap (`APP_BUILD_WATCH_MAX_CONCURRENT_RUNS`), the
 *   lease length, the skip reasons of an unconfigured installation and
 *   `repositoryCoordinates`.
 * - `./app-build-sweep.service` — `AppBuildSweepService` (T21, first slice), the
 *   pass behind the `app-build-sweep` schedule: `runSweep()` under the
 *   `app-builds:sweep` lock, the re-drive of requested Builds nothing
 *   dispatched (§9.2) and the never-adopted half of §7.4's `lost` rule, with the
 *   window constants its spec pins. `apps/api`'s cron fallback and the
 *   trigger-internal controller import the class from here.
 * - `./app-builds.module` — `AppBuildsModule`, what `apps/api`'s App Builds module
 *   will import.
 */

export * from './app-builds.module';
export * from './app-builds.service';
export * from './deployable-verdict';
export * from './app-build-failure-copy';
export * from './app-build-pull-token.service';
export * from './app-build-sweep.service';

// 🛑 An EXPLICIT list, not `export *`, for exactly one name.
//
// T17's provisional PORT `AppBuildPrepareRunner`
// (`app-builds.service.ts:143-149`, the `run(payload)` the null-dispatch
// fallback calls) and this file's CLASS of the same name are two different
// things, and `export *` from both modules is an ambiguity TypeScript refuses
// outright (TS2308). Naming the class after the role it implements is what the
// task asks for and what T20's `app-build-watch.runner.ts` will do too, so the
// resolution belongs here: the CLASS is what `@ever-works/agent/app-builds`
// publishes under that name, and the port stays reachable from
// `./app-builds.service` (which the module and the class both import directly).
export {
    APP_BUILD_CHECK_DEFAULT_TIMEOUT_SECONDS,
    APP_BUILD_PREPARE_JOB_ID,
    APP_BUILD_PREPARE_LOCK_KEY_PREFIX,
    APP_BUILD_PREPARE_LOCK_TTL_MS,
    APP_BUILD_PREPARE_MAX_PASSES,
    APP_BUILD_PREPARE_SKIP_REASONS,
    AppBuildPrepareRunner,
    appBuildBlock,
    appBuildChecks,
    appBuildPrepareLockKey,
    appBuildWorkflowPullRequestNumber,
    appBuildWorkflowStateFor,
    declaredBuildMemoryGiB,
    mapPluginBlockedReason,
    selectBuildRunner,
    unionMinusRemoved,
    type AppBuildCheckInput,
    type AppBuildPrepareInput,
    type AppBuildPreparePluginBinding,
    type AppBuildPreparePluginResolver,
    type AppBuildPrepareRunResult,
    type AppBuildPrepareSkipReason,
    type AppBuildRunnerChoice,
    type AppBuildRunnerDecision,
} from './app-build-prepare.runner';

// 🛑 The same collision as above, for T20's runner, resolved the same way. T17's
// provisional PORT `AppBuildWatchRunner` (`app-builds.service.ts:168-174`, the
// `run(payload)` §7.1's null-dispatch fallback calls) and this file's CLASS of
// the same name are two different things, and `export *` from both modules is
// the ambiguity TypeScript refuses outright (TS2308) — so the CLASS is named
// explicitly here, exactly as `AppBuildPrepareRunner` is above, and the port
// stays reachable from `./app-builds.service` (which the module and the class
// both import directly).
//
// The names the runner file publishes beside the class are listed in full rather
// than exported wholesale for the same reason T19's list is exhaustive: an
// `export *` here would collide again the moment either port grows a member, and
// an explicit list makes the next collision a compile error in THIS file rather
// than a surprising ambiguity somewhere downstream.
export {
    APP_BUILD_WATCH_JOB_ID,
    APP_BUILD_WATCH_LEASE_MS,
    APP_BUILD_WATCH_MAX_CONCURRENT_RUNS,
    APP_BUILD_WATCH_SKIP_REASONS,
    AppBuildWatchRunner,
    repositoryCoordinates,
    type AppBuildWatchPluginBinding,
    type AppBuildWatchPluginResolver,
    type AppBuildWatchRunResult,
    type AppBuildWatchSkipReason,
} from './app-build-watch.runner';
