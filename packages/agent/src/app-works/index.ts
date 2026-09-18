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
 */

export * from './app-works.module';
export * from './app-upstream-state.service';
export * from './app-fork-ready-handler.port';
export * from './app-actions-hygiene.service';
export * from './app-fork-readiness.service';
export * from './upstream-schedule';
export * from './app-upstream-conflict.copy';
export * from './app-upstream-sync.service';
export * from './app-upstream-sync-dispatcher.service';
