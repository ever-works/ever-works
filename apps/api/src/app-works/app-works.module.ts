import { Module } from '@nestjs/common';
import { DatabaseModule } from '@ever-works/agent/database';
import { FacadesModule } from '@ever-works/agent/facades';
import { NotificationsModule } from '@ever-works/agent/notifications';
import { TasksDomainModule } from '@ever-works/agent/tasks-domain';
import { AppSpecModule } from '@ever-works/agent/app-spec';
import { WorksConfigService } from '@ever-works/agent/works-config';
import {
    APP_FORK_READY_HANDLER,
    AppForkReadinessRunner,
    AppForkReadinessService,
    AppSourceInitializerService,
    AppWorksModule as AgentAppWorksModule,
} from '@ever-works/agent/app-works';
import { ActivityLogModule } from '../activity-log/activity-log.module';
import { AppUpstreamController } from './app-upstream.controller';

/**
 * APW-02 T27 — the API-side App Works module: the three upstream routes of plan §4.1
 * (`plan.md:487-516`) over the agent package's services.
 *
 * ## What is imported, and why each import is load-bearing
 *
 *   - `AgentAppWorksModule` (`@ever-works/agent/app-works`) provides and exports
 *     `WorkUpstreamStateRepository`, `AppUpstreamStateService` (T23) and
 *     `AppUpstreamSyncDispatcherService` (T28) — the state service and the dispatcher
 *     are what `apps/api/src/trigger/trigger-internal.controller.ts`'s `remoteMap`
 *     needs, and the repository is what T26's worker-side sync run reads its
 *     coordinates from.
 *   - `DatabaseModule` is **not optional**, and the ledger already said so
 *     (`docs/internal/app-works-build-progress.md:1090-1092`): `AppUpstreamStateService`
 *     resolves the Work through `WorkRepository.findByIdForAccess` and the member
 *     through `WorkMemberRepository.isMember`, so without this import **every route
 *     answers `404`** — the fail-closed visibility check cannot tell "not yours" from
 *     "I cannot read Works at all", which is exactly the degradation a missing
 *     database module must not produce silently.
 *   - `NotificationsModule` and `TasksDomainModule` are the other two the same ledger
 *     entry names: `NotificationService` (the owner notice when no Agent could be
 *     resolved for a conflict Task) and `TasksService` + `TaskChatService` (the
 *     conflict Task itself, plan §6.5).
 *   - `FacadesModule` supplies `GitFacadeService`, which the state service's
 *     `probeReadiness` and `recordConflict` read the provider through.
 *   - `ActivityLogModule` supplies `ActivityLogService`, the one writer of the epic's
 *     eight dotted events (§3.5).
 *
 * Every one of those collaborators is `@Optional()` in the service, so this module
 * compiles either way and a *missing* import degrades a feature rather than failing
 * boot. The list above is therefore the difference between "the Upstream card works"
 * and "it 404s", and it is why each line carries its reason instead of an ordering.
 *
 * `DistributedTaskLockService` is deliberately **not** imported: the state service reads
 * it only for the informational half of `syncInProgress` (the claim itself is the row's
 * `syncStartedAt` window, and `beginSync` is what refuses a second run), and importing
 * `BudgetsModule` for that would couple this epic to another feature's module for an
 * optional read that already has a documented fallback.
 *
 * ## What is not bound here
 *
 * Nothing else. `APP_WORK_AGENT_RESOLVER` (APW-08 T25), `APP_FORK_READINESS_DISPATCHER` /
 * `APP_UPSTREAM_SYNC_DISPATCHER` (APW-02 T31), `APP_UPSTREAM_SYNC_SPEC_SOURCE` (APW-03
 * T12), `APP_UPSTREAM_LICENSE_SERVICE` (APW-03 T42), `APP_BLUEPRINT_APPLY_SERVICE`
 * (APW-03 T28) and `APP_PROVISIONING_SERVICE` (APW-04) all belong to other tasks, and
 * binding a placeholder would make an unconfigured installation look configured — the
 * same rule the agent module's own docstring states. **APW-01 T15 adds the
 * `APP_FORK_READY_HANDLER` binding here** (see the T15 section below); the tokens that
 * handler reads stay unbound until their owners land, and each absence is a refusal the
 * handler names rather than a silent success.
 *
 * ## `exports: [AgentAppWorksModule]`
 *
 * A re-export, so `apps/api/src/trigger/trigger-internal.module.ts` resolves the whole
 * trio by importing this one module (the established shape: `activity-log.module.ts:16`,
 * `budgets.module.ts:54`, `safety.module.ts:30`). Two modules may import
 * `AgentAppWorksModule`; Nest instantiates it once, so the API has one state service and
 * one dispatcher whichever door is used.
 *
 * Registered additively in `apps/api/src/api.module.ts`, next to `AppLauncherModule`.
 *
 * ## C10 — T24's readiness service and its RPC runner are provided here (additive)
 *
 * The paragraph above still holds for the tokens it names: this module binds no
 * `APP_FORK_READINESS_DISPATCHER` placeholder, because that token is injected by
 * services declared in the **agent** module and a provider declared here cannot be
 * seen by them (see that module's C10 section for the visibility rule and why the
 * binding therefore lives there).
 *
 * What this module now provides is the readiness **run**: `AppForkReadinessService`
 * (T24) plus `AppForkReadinessRunner` (C10), the serialisable seam the
 * `app-fork-readiness` Trigger task proxies. They are provided here — rather than
 * in the agent module beside the state service — for a reason this module's own
 * import list already fixes: `AppForkReadinessService` injects `GitFacadeService`
 * **non-optionally** (readiness probes and the private-copy push are provider
 * calls), and `FacadesModule` is imported here for real. Providing it agent-side
 * would additionally require the two specs that compile the agent module against
 * a *shelled* `FacadesModule` (`app-works.module.spec.ts`,
 * `app-upstream-state.service.spec.ts`) to invent a git facade for a service they
 * are not about.
 *
 * `AppActionsHygieneService`, the service's other required collaborator, is
 * re-exported by `AgentAppWorksModule` and resolves from there.
 *
 * `TriggerInternalModule` imports this module for the upstream trio, and that one
 * import is also what makes the runner resolvable for the controller's
 * `remoteMap` entry `AppForkReadinessRunner` — with the entry absent the worker's
 * proxy answers the loud `Unknown remote target: AppForkReadinessRunner` instead
 * of pretending a readiness run happened.
 *
 * ## APW-01 T15 — the ready handler is declared AND bound here (additive)
 *
 * This is the module that makes `AppSpecService.initialize` happen at all — the
 * single unblocker **C32** names (`docs/internal/app-works-build-progress.md` §5.2:
 * nothing in the shipped runtime called it, so `work_app_spec_states` could never
 * hold a row and `GET /api/works/:id/app-spec` answered `404` for every App Work and
 * every role).
 *
 * Three additions, and each one is required rather than tidy:
 *
 *   1. **`AppSpecModule`** supplies `AppSpecService`, whose `initialize(workId, branch)`
 *      is step 1 of the hand-off and whose `hasValidAppSpec(workId, sha)` is step 8's
 *      provisioning gate. It is a leaf with respect to this module.
 *   2. **`WorksConfigService`** is provided here because the alternative is a cycle:
 *      the service's other provider is `WorkModule`, which imports
 *      `AgentAppWorksModule` — and step 4 parses `.works/works.yml` through the
 *      existing loader rather than a second parser. It injects only
 *      `GitFacadeService`, which `FacadesModule` supplies for real here.
 *   3. **`AppSourceInitializerService` is declared here as well as exported by
 *      `AgentAppWorksModule`**, and the token is bound to THIS copy. That is the C10
 *      visibility rule (the agent module's docstring records it): a provider resolves
 *      its dependencies from the module that declares it, so the agent module's copy —
 *      which deliberately imports neither `AppSpecModule` nor `WorkModule` — cannot see
 *      `AppSpecService`. Nest resolves a module-local provider ahead of an imported one,
 *      so the instance `APP_FORK_READY_HANDLER` resolves is the wired one.
 *
 * `onDataRepositoryReady` is deliberately **not** added to
 * `RETRY_SAFE_REMOTE_METHODS` in the controller: a transport failure fails the
 * `app-fork-readiness` run, the task's retry calls the handler again, and this
 * handler's own idempotency rules make that safe (plan §6).
 */
@Module({
    imports: [
        AgentAppWorksModule,
        DatabaseModule,
        NotificationsModule,
        TasksDomainModule,
        FacadesModule,
        ActivityLogModule,
        AppSpecModule,
    ],
    controllers: [AppUpstreamController],
    providers: [
        AppForkReadinessService,
        AppForkReadinessRunner,
        WorksConfigService,
        AppSourceInitializerService,
        // APW-01 T15 — the hand-off APW-02's readiness run calls. `useExisting`, never
        // `useClass`: the bound handler must be the SAME instance the RPC channel
        // publishes, so a worker call and an in-process run cannot diverge.
        { provide: APP_FORK_READY_HANDLER, useExisting: AppSourceInitializerService },
    ],
    exports: [
        AgentAppWorksModule,
        AppForkReadinessService,
        AppForkReadinessRunner,
        AppSourceInitializerService,
    ],
})
export class AppWorksModule {}
