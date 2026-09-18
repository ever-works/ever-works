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
 */

export * from './ports';
export * from './default-ports';
export * from './app-runtime-deletion.service';
