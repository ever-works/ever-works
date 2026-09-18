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
 * - `./app-builds.module` — `AppBuildsModule`, what `apps/api`'s App Builds module
 *   will import.
 */

export * from './app-builds.module';
export * from './app-builds.service';
export * from './deployable-verdict';
export * from './app-build-failure-copy';
export * from './app-build-pull-token.service';
