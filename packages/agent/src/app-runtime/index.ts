/**
 * Public API of the App runtime ports (APW-06 `plan.md` §9.6, §9.8:1510–1538).
 *
 * Imported as `@ever-works/agent/app-runtime`:
 *
 * - `./ports` — the port interfaces, their DI tokens and the typed refusal error.
 * - `./default-ports` — the fail-closed defaults the platform binds until APW-05, APW-07 and APW-10
 *   replace them.
 * - `./app-runtime-deletion.service` — `AppRuntimeDeletionService` (T58, plan §9.7), which is what
 *   APW-01's `APP_WORK_DELETION_PORT` is bound to, plus the `delete-app-work` op handler T70's
 *   router routes to. It carries its own clearly-marked provisional seam block for the three
 *   collaborators whose owner tasks have not landed yet (APW-01 T39's port and its
 *   `completeAppWorkDeletion`, APW-07 T16's `AppDependenciesService`), so the swap is an import.
 * - `./app-verification-target.service` — `AppVerificationTargetService` (T60, plan §4.12,
 *   Resolution R-10) and its `verification-deploy` / `verification-status` / `verification-destroy`
 *   op handlers for T70's router, plus the §4.12 namespace derivation both `verification-deploy`
 *   and `verification-destroy` agree on. Its provisional block declares APW-06 T20's facade, APW-06
 *   T22's render-input builder and APW-07 T16's `provisionEphemeral`, and **reuses**
 *   `APP_DEPENDENCIES_SERVICE`, `APP_RUNTIME_ENV_SOURCE` and `APP_VERIFICATION_SINK` rather than
 *   declaring parallel tokens (R-26; a second `Symbol` of the same name is a different token).
 * - `./worker-context` — `markAppClusterWorkerContext()` / `isAppClusterWorkerContext()` and the
 *   `APP_CLUSTER_IO_IN_API` refusal (T20, plan §6.2). A **process-level flag, not an env var**.
 *   Exported here because the one caller that arms it is T71's bootstrap provider in
 *   `packages/tasks/src/trigger/worker/modules/trigger-app-runtime.module.ts`: a cross-package
 *   import can only reach the built `@ever-works/agent/app-runtime` subpath, so the marker has to
 *   be on this barrel.
 */

export * from './ports';
export * from './default-ports';
export * from './worker-context';
export * from './app-runtime-deletion.service';
export * from './app-verification-target.service';
