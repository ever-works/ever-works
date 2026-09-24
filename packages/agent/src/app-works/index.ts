/**
 * Public API of App Works (APW-02 plan §3.1:261-263) — imported as
 * `@ever-works/agent/app-works`.
 *
 * The barrel starts with the one thing this package exports today and grows
 * additively as the epic's P1.3 services land (T16–T39): each of them adds its
 * own `export *` line here, so an importer never has to reach into a deep path
 * (`@ever-works/agent/app-works/app-upstream-sync.service`). Nothing is
 * re-exported speculatively — a name that does not exist yet must not appear,
 * or `apps/api` and `packages/tasks` would compile against a module that does
 * not resolve.
 *
 * - `./app-works.module` — `AppWorksModule`, what `apps/api`'s App Works module
 *   imports: `TypeOrmModule.forFeature([WorkUpstreamState])` plus
 *   `WorkUpstreamStateRepository` (the fourth registration point of the entity,
 *   plan §3.1).
 * - `./app-upstream-state.service` — `AppUpstreamStateService` (T23), the one writer of
 *   the state row, its refusal error and the result shapes the two jobs read, plus the
 *   three **provisional** tokens its collaborators own elsewhere
 *   (`APP_WORK_AGENT_RESOLVER` — APW-08 T25; `APP_FORK_READINESS_DISPATCHER` and
 *   `APP_UPSTREAM_SYNC_DISPATCHER` — T31). Each carries the swap note on its declaration.
 * - `./app-fork-ready-handler.port` — `APP_FORK_READY_HANDLER` and the outcome APW-01's
 *   handler answers with (plan §6.2, Resolution R-4).
 * - `./app-actions-hygiene.service` — `AppActionsHygieneService` (T25), the Actions
 *   permission hygiene of plan §6.7: it disables only what §6.7 names, and answers
 *   `not_applicable` without touching the provider when the repository is a link (FR-31).
 * - `./app-fork-readiness.service` — `AppForkReadinessService` (T24), the readiness poll
 *   of plan §6.2 and its recorded sleep ladder. Its `APP_PROVISION_EVENTS_PORT` consumer
 *   half is **provisional** until APW-04 lands, and carries the mandatory-swap note on
 *   its declaration.
 * - `./app-fork-readiness.runner` — `AppForkReadinessRunner` and
 *   `APP_FORK_READINESS_JOB_ID` (C10): the serialisable, `remoteMap`-facing seam in
 *   front of T24's service, because its `deps.sleep` function cannot cross the
 *   SuperJSON remote proxy. The API-side module provides it and the
 *   `app-fork-readiness` Trigger task proxies it by name.
 * - `./upstream-schedule` — `computeNextUpstreamSync` and the four-field reader of
 *   `upstreamSync` (T26, plan §6.4): the schedule, `enabled`, `branch` and `mode`, with
 *   the documented defaults, the hourly clamp and the stable per-Work jitter.
 * - `./app-upstream-conflict.copy` — the spec §6.3 copy templates (T26): the conflict
 *   Task's title, description and comment, and the one path list that caps them at 50.
 * - `./app-upstream-sync.service` — `AppUpstreamSyncService.run` (T26, plan §6.3), its
 *   `ProviderCallBudget` (FR-49) and the three **provisional** seams it declares for the
 *   collaborators that have not landed (`APP_UPSTREAM_SYNC_SPEC_SOURCE` — APW-03 T12;
 *   `APP_UPSTREAM_LICENSE_SERVICE` — APW-03 T42; `APP_UPSTREAM_PRIVATE_COPY_PORT` —
 *   APW-02 P1's private-copy capability). Each carries its mandatory-swap note.
 * - `./app-upstream-sync-dispatcher.service` — `AppUpstreamSyncDispatcherService` (T28,
 *   plan §6.6): the four-legged cron tick (`dispatchDue`) and the on-view divergence
 *   compare of §4.1 (`requestDivergenceCompare`). Its two job dispatchers are the
 *   **provisional** T23 tokens (T31 owns the real ones), and the setup pull request leg is
 *   T43's.
 * - `./app-source-catalog.port` — `AppSourceCatalogPort` and `APP_SOURCE_CATALOG_PORT`
 *   (T11, plan §7): the Apps-catalog seam APW-03 binds and this epic injects
 *   `@Optional()`. Unbound means "catalog unavailable", never "no match".
 * - `./app-prompted-values.port` — `AppPromptedValuesPort`,
 *   `APP_PROMPTED_VALUES_PORT` and its no-op default (T11, plan §7): the write-only
 *   App env answers of FR-55. Unbound ⇒ the values are logged as dropped, never a
 *   refusal.
 * - `./app-source-inspector.service` — `AppSourceInspectorService` (T12, plan §2.2):
 *   everything the preview and the create path learn about a pasted URL, including the
 *   15-call provider budget, the refusal reason codes and the deploy-target map. It
 *   also exports the pure helpers the create path shares with it
 *   (`resolveAppUpstreamRef`, `resolveAppDeployTargets`,
 *   `collectAppDeployProviderFacts`, `ProviderCallBudget`).
 * - `./app-work-create.service` — `AppWorkCreateService` (T13, plan §4.2): the twelve
 *   steps of an `app`-kind create, the `WorkUpstreamState` row written in the same
 *   transaction, and the readiness dispatch.
 * - `./app-work-deletion.port` — `AppWorkDeletionPort` and `APP_WORK_DELETION_PORT`
 *   (T39, plan §7): the App runtime's deletion seam. APW-06's
 *   `AppRuntimeDeletionService` binds it; `WorkLifecycleService` injects it
 *   `@Optional()`, and unbound means "no App runtime exists yet", so an App Work's
 *   delete keeps today's behaviour (the row goes now) until APW-06 merges.
 * - `./app-source-initializer.service` — `AppSourceInitializerService` (T15, plan §6),
 *   the implementation of `APP_FORK_READY_HANDLER`: it creates the App spec state row
 *   (**the call C32 measured as missing everywhere**), applies or requests a Blueprint,
 *   records the source in `.works/works.yml` with no clone, and runs the licence and
 *   provisioning follow-ups. It also carries the three **provisional** tokens its
 *   not-yet-landed collaborators own (`APP_BLUEPRINT_APPLY_SERVICE` — APW-03 T28;
 *   `APP_PROVISIONING_SERVICE` — APW-04; and the `AppSourceCommitCapability` view of
 *   APW-03 T22's `commitFiles`), each with its mandatory-swap note. The licence request
 *   **reuses** APW-03's own `APP_LICENSE_SERVICE` rather than declaring a second Symbol
 *   for the same owner (R-26).
 */

export * from './app-works.module';
export * from './app-upstream-state.service';
export * from './app-fork-ready-handler.port';
export * from './app-actions-hygiene.service';
export * from './app-fork-readiness.service';
export * from './app-fork-readiness.runner';
export * from './upstream-schedule';
export * from './app-upstream-conflict.copy';
export * from './app-upstream-sync.service';
export * from './app-upstream-sync-dispatcher.service';
export * from './app-source-catalog.port';
export * from './app-prompted-values.port';
export * from './app-source-inspector.service';
export * from './app-work-create.service';
export * from './app-work-deletion.port';
export * from './app-source-initializer.service';

// APW-08 T10 — the rules one evolve run is governed by, read at the Task's BASE
// commit and frozen. Exported here because the dispatch brief, the Fleet
// admission and the change guard all ask this one service rather than reading
// the spec three times.
export {
    AppSpecUnreadableError,
    AppWorkRulesService,
    DEFAULT_SIZE_GUIDANCE,
    MAX_CHECKS,
    MAX_INSTRUCTION_FILES,
    MAX_SIZE_GUIDANCE,
    MIN_SIZE_GUIDANCE,
    type AppWorkRules,
    type AppWorkRulesWork,
} from './app-work-rules.service';

// APW-08 T17 — what an evolve run's branch is refused for. Exported beside the
// rules it reads, because a caller needs both or neither.
export {
    ALWAYS_PROTECTED,
    APP_SPEC_PATH,
    AppChangeGuard,
    AppChangeRefusedError,
    MAX_FILES,
    PROVISION_LABEL,
    REFUSAL_MULTIPLE,
    type AppChangeGuardInput,
    type AppChangeRefusalCode,
    type AppChangeVerdict,
} from './app-change-guard';

// APW-08 T17 — the change gate `TasksDomainModule` binds to `APP_WORK_CHANGE_GATE`.
export { AppWorkChangeGateService } from './app-work-change-gate.service';
