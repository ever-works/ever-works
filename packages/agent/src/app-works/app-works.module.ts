import { Module, type FactoryProvider } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ActivityLogModule } from '../activity-log/activity-log.module';
import { DatabaseModule } from '../database/database.module';
import { FacadesModule } from '../facades/facades.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { TasksDomainModule } from '../tasks-domain/tasks.module';
import { DistributedTaskLockService } from '../cache/distributed-task-lock.service';
import { WorkUpstreamStateRepository } from '../database/repositories/work-upstream-state.repository';
import { WorkUpstreamState } from '../entities/work-upstream-state.entity';
import {
    APP_FORK_READINESS_DISPATCHER,
    AppUpstreamStateService,
    type AppForkReadinessDispatcher,
    type AppForkReadinessJobPayload,
} from './app-upstream-state.service';
import { AppUpstreamSyncDispatcherService } from './app-upstream-sync-dispatcher.service';
import { AppSourceInspectorService } from './app-source-inspector.service';
import { AppWorkCreateService } from './app-work-create.service';
import { AppActionsHygieneService } from './app-actions-hygiene.service';
import { AppSourceInitializerService } from './app-source-initializer.service';
import { AppWorksTelemetryService } from './app-works-telemetry.service';
import { APP_SOURCE_CATALOG_PORT } from './app-source-catalog.port';
import { AppBlueprintResolverService } from '../apps-catalog/app-blueprint-resolver.service';
import { AppSourceCatalogAdapter } from '../apps-catalog/app-source-catalog.adapter';
import {
    JOB_RUNTIME_PROVIDER_REGISTRY,
    type JobRuntimeProviderRegistry,
} from '../tasks/job-runtime.providers';

/**
 * APW-02 App Works (Fork lifecycle) — the agent-side module.
 *
 * Plan §3.1 (`plan.md:261-263`) fixes four registration points for the
 * `work_upstream_states` entity, and this is the fourth: `TypeOrmModule.forFeature`
 * here, beside `export *` in `entities/index.ts`, the name in
 * `AGENT_ENTITY_NAMES` and the entry in `_entities-inventory.ts` (all three of
 * which T14/T12 own, not this file).
 *
 * It provides and exports **`WorkUpstreamStateRepository`** — provided *here*
 * rather than by `DatabaseModule`, exactly as APW-11's
 * `AppLauncherPreferenceRepository` is: `work_upstream_states` is this epic's
 * table and its repository is deliberately absent from
 * `_repository-inventory.ts`, so `DatabaseModule` (which provides the inventory)
 * does not carry it. `database/index.ts` *exports* the class — that is what
 * makes it importable — and this module is what makes it injectable.
 *
 * ## Additive by design: the later services land in this same module
 *
 * T16–T39 add the services of this epic (readiness, Actions hygiene, upstream
 * sync, the dispatcher, the state service, the telemetry port) plus the imports
 * they need. Nothing here pre-binds a collaborator for them: a service that is
 * not written yet must not appear in `providers`, and a token this epic does not
 * own (`APP_WORK_AGENT_RESOLVER`, APW-08) must not be bound to a placeholder —
 * binding it here would make an unconfigured installation look configured, which
 * is the failure mode APW-11's module docstring calls out for the same reason.
 *
 * The three Activity families this epic's T15 adds (`app_fork`, `app_actions`,
 * `app_upstream`) are **not** module concerns: they are enum members in
 * `entities/activity-log.types.ts` with their `FEED_KIND_RULES` rows in
 * `activity-log/feed-kind.ts`.
 *
 * ## T23 — the state service joins the repository (additive)
 *
 * `AppUpstreamStateService` (T23) is provided and exported beside the repository, so
 * `apps/api`'s App Works module (T27) and the remote-proxy map (T28) can resolve it by
 * importing this one module. It is the ONLY entry T23 adds here: the tokens it injects
 * (`APP_WORK_AGENT_RESOLVER` — APW-08 T25; the two dispatchers — T31) are still
 * deliberately unbound, because binding a placeholder would make an unconfigured
 * installation look configured (see above), and every collaborator it reads through is
 * `@Optional()` so this module still compiles on its own — which is what
 * `__tests__/app-works.module.spec.ts` asserts.
 *
 * ## T28 — the dispatcher joins them (additive)
 *
 * `AppUpstreamSyncDispatcherService` (T28, plan §6.6) is provided and exported here beside
 * the state service, for the same reason and in the same shape: it is API-side (§2.4), the
 * API's `TriggerInternalModule` reaches it through the `remoteMap`/`createRemoteProxy`
 * pair, and its only two hard dependencies — this repository and the state service — are
 * already in this module. Its two job dispatchers stay **unbound** (`@Optional()`), exactly
 * as the state service's are: T31 owns the real `APP_UPSTREAM_SYNC_DISPATCHER` /
 * `APP_FORK_READINESS_DISPATCHER` declarations and bindings, and a placeholder here would
 * make a tick that queues nothing look like a tick that queued something.
 *
 * ## APW-09 T43 — why the credential of record is NOT provided here (additive)
 *
 * `UPSTREAM_CREDENTIAL_STORE` (FR-43) is bound by the epic that owns it,
 * `upstream-pull-requests/upstream-pull-requests.module.ts`, which imports this
 * module for the `WorkUpstreamStateRepository` this file already provides and
 * exports. Binding it *here* was tried and is not shippable: the store itself
 * injects only this repository, but `UpstreamCredentialService` injects
 * `WorkRepository` **non-optionally**, and this module is compiled bare by two
 * specs that shell `DatabaseModule` (`app-works.module.spec.ts`,
 * `app-upstream-state.service.spec.ts`) precisely so that a collaborator a later
 * service quietly requires fails there rather than at API boot. It failed there,
 * as designed; the fix is the epic's own module, which imports `DatabaseModule`
 * for real, not a widened shell in someone else's spec. Nothing in this file
 * changes as a result, and the epic's token crosses back in through this
 * module's `exports`.
 *
 * ## C10 — the readiness dispatcher IS bound here now (additive)
 *
 * `docs/internal/app-works-build-progress.md` §5.2 row C10 recorded the gap this
 * section closes: `APP_FORK_READINESS_DISPATCHER` had **no `provide:` anywhere**,
 * so `AppWorkCreateService.dispatchReadiness` and
 * `AppUpstreamStateService.retryReadiness` both found their `@Optional()`
 * injection `undefined`, answered `readinessReason = 'dispatch_unavailable'`, and
 * an App Work could never reach `ready` in any environment.
 *
 * 🛑 **Why the binding is in THIS module and not in
 * `apps/api/src/app-works/app-works.module.ts`, whose docstring names the
 * dispatchers as owed there.** Nest resolves a provider's dependencies from the
 * module that **declares** it plus that module's own imports.
 * `AppWorkCreateService` and `AppUpstreamStateService` are declared *here*; the
 * API's module **imports** this one, so a provider it declares reaches this
 * module's services only if this module imports *it* — which would be the cycle
 * `WorkModule`'s `imports: [AppWorksModule]` already documents. The token
 * therefore has to be bound on this side of that edge (or by a `@Global()`
 * module), and a binding anywhere else would be structurally invisible to both
 * call sites — which is exactly the failure C10 measured.
 *
 * The note T28 left above still stands for its own token: T31's planned
 * `APP_UPSTREAM_SYNC_DISPATCHER` binding is *not* this file's to add, and this
 * section binds the readiness token only because C10 is the gap that keeps an App
 * Work from ever becoming `ready`.
 *
 * What the binding resolves: the **active job runtime's** dispatchers view
 * (`JOB_RUNTIME_PROVIDER_REGISTRY`, EW-685), whose `dispatchAppForkReadiness`
 * enqueues the `app-fork-readiness` job (`TriggerService`, wired by the same
 * slice). Two properties are load-bearing and both are pinned by
 * `__tests__/app-fork-readiness-wiring.spec.ts`:
 *
 *   - the injection is **optional** (`OptionalFactoryDependency`), so this module
 *     still compiles in the bare graph its own spec builds, and a process with no
 *     job runtime registered is a supported installation rather than a boot
 *     failure;
 *   - `dispatch` answers **`null`** whenever no runtime is registered or the
 *     runtime does not implement the method — the same fail-closed answer both
 *     call sites already had, which records `dispatch_unavailable` on the row and
 *     leaves it to APW-02's sweeper. This binding makes the dispatch *possible*;
 *     it does not invent a run id for a dispatch that did not happen.
 *
 * The readiness **run** itself (`AppForkReadinessService`, T24) is provided
 * API-side, beside the facades it reads providers through, and exposed to the
 * worker as `AppForkReadinessRunner` — see that file's docstring for why its
 * `deps.sleep` function cannot cross the internal channel.
 *
 * ## APW-01 T15 — the ready handler joins them (additive)
 *
 * `AppSourceInitializerService` (T15, plan §6) is provided **and exported** here,
 * beside the services above, because T15 says so and because that is what makes the
 * class reachable from `apps/api` through this one module import. It is the
 * implementation of APW-02's `APP_FORK_READY_HANDLER` port: the readiness run calls
 * it once a Work's repository has content, and its `AppSpecService.initialize` call
 * is the one **C32** measured as missing everywhere (no `work_app_spec_states` row,
 * so `GET /api/works/:id/app-spec` answered `404` for every App Work and every role).
 *
 * 🛑 **Every collaborator of that service is `@Optional()`, and here that is
 * load-bearing rather than stylistic.** A Nest provider resolves its dependencies
 * from the module that DECLARES it plus that module's own imports — the rule the C10
 * section above records. This module deliberately imports neither `AppSpecModule`
 * (which would drag the App spec entity, the spec state repository and a
 * non-optional `GitFacadeService` into the two bare-graph compiles this module's own
 * specs perform) nor `WorkModule` (which imports *this* module — a cycle). So the
 * copy declared here compiles everywhere and is fully wired only in a graph that
 * provides those collaborators; `apps/api/src/app-works/app-works.module.ts` imports
 * `AppSpecModule`, `ActivityLogModule` and a `WorksConfigService` and declares its
 * OWN copy, which Nest resolves ahead of this one for the `APP_FORK_READY_HANDLER`
 * binding it owns. Both halves are pinned by
 * `__tests__/app-source-initializer.service.spec.ts`.
 *
 * ## APW-03 T26 — the Apps-catalog port IS bound here (additive)
 *
 * `APP_SOURCE_CATALOG_PORT` is bound to `AppSourceCatalogAdapter`, with
 * `AppBlueprintResolverService` (the explicit and probe halves of T26) beside it.
 * Until then no module anywhere provided the token, so every inspect previewed
 * Blueprint `unavailable` and licence class `unknown`, and every explicit
 * `blueprintId` (FR-81) was refused `400 blueprint_mismatch`.
 *
 * 🛑 **Why here, and why not a separate `AppsCatalogModule`.** The port is
 * injected `@Optional()` by `AppSourceInspectorService` and `AppWorkCreateService`,
 * which this module DECLARES — the same rule the C10 section records: a provider
 * declared in a module that imports this one never reaches them. A module of its
 * own would have to be imported here, and `app-works-port-dormancy.spec.ts` reads
 * the direct providers of the nine App Works modules only, so the binding would
 * be invisible to the register. The token is NOT exported: only the two services
 * declared here consume it.
 *
 * Every collaborator of the adapter and the resolver is `@Optional()`, so the
 * bare-graph compile this module's spec performs (with `FacadesModule` shelled)
 * still resolves: the resolver then has no git facade and answers "credential
 * unavailable", which both consumers read as `unavailable`. The adapter also holds
 * a Blueprint MATCH back until `APP_BLUEPRINT_APPLY_SERVICE` (T28) is bound — see
 * its docstring for that gate and T28's obligation to bind the token in this
 * graph.
 *
 * ## The Activity, notification and Task collaborators — bound by IMPORT (2026-09-26)
 *
 * `AppUpstreamStateService` files the conflict Task (`TasksService`), comments on
 * the open one (`TaskRepository` + `TaskChatService`), notifies the owner when no
 * Agent resolved (`NotificationService`) and writes the epic's dotted Activity
 * events (`ActivityLogService`); `AppActionsHygieneService` and this module's copy
 * of `AppSourceInitializerService` write Activity too. All `@Optional()`, and until
 * 2026-09-26 all `undefined` in the running API: this module imported only
 * `DatabaseModule` and `FacadesModule`, neither of which exports them, and the
 * imports `apps/api/src/app-works/app-works.module.ts` carries "for the state
 * service" cannot reach a provider declared HERE (the C10 visibility rule above).
 * So every conflict was recorded without a Task, no owner was told, and no
 * `app.upstream.*` / `app.actions.*` Activity row was ever written.
 *
 * `ActivityLogModule`, `NotificationsModule` and `TasksDomainModule` are imported
 * here now. None of them reaches this module (`tasks.module.ts` imports
 * `app-works/` SERVICE files, never this module or the barrel), so the graph stays
 * a DAG; in the API all three were already instantiated, so nothing new boots
 * there. The internal CLI (`apps/internal-cli`, which imports `WorkModule`, which
 * imports this module) DOES gain `TasksDomainModule` and, through it,
 * `AgentsModule`, `AppSpecModule` and `SkillsModule`; this module composes against
 * the CLI's kind of root (a non-global local emitter, a global cache, the plugins
 * module and the full entity list), which was checked when the import landed.
 * `__tests__/app-works.module.graph.spec.ts` composes the module for real
 * and pins all five; the bare-graph specs of this module shell the three the way
 * they shell `DatabaseModule` and `FacadesModule`.
 *
 * ## APW-01 T36 — the telemetry service joins them (additive)
 *
 * `AppWorksTelemetryService` (FR-53, plan §9.1) is provided **and exported** here:
 * the inspector, the create service and the ready handler are declared in this
 * module, the API-side module's own copy of the ready handler resolves it through
 * this module's exports, and `WorkModule` (which imports this module) injects it
 * into `WorkLifecycleService` for the delete event. One instance per graph, so its
 * counters describe the whole process.
 *
 * Its sink, `APP_WORKS_TELEMETRY_SINK`, is **not** bound here and must not be: this
 * package takes no dependency on the monitoring package. The API binds it with a
 * `@Global()` alias to its PostHog `AnalyticsService`
 * (`apps/api/src/telemetry/app-works-telemetry-binding.module.ts`), which a global
 * module makes visible to this module's providers; everywhere else (the worker, the
 * CLI, this module's bare-graph specs) the `@Optional()` sink is absent and every
 * event is counted and dropped.
 */

/**
 * The method the active job runtime exposes for this job.
 *
 * Named once so the binding and its spec cannot drift: `TriggerService`
 * implements it (`packages/tasks/src/trigger/trigger.service.ts`) and
 * `TriggerService` **is** the dispatchers view its providers hand out.
 */
const FORK_READINESS_DISPATCH_METHOD = 'dispatchAppForkReadiness' as const;

/**
 * C10's binding, built by a function so the spec can drive the factory directly
 * with a fake registry (the shape `buildJobRuntimeProviders` is tested with) as
 * well as through a real container.
 *
 * The registry is injected **optionally** (`OptionalFactoryDependency`), which is
 * what lets this module compile where no job runtime exists at all — the agent
 * package's own module spec, a CLI context, a worker that never registers the
 * Trigger provider. `dispatch` then answers `null`: C10's documented fail-closed
 * path, not a new failure mode.
 */
export function buildAppForkReadinessDispatcherProvider(): FactoryProvider {
    return {
        provide: APP_FORK_READINESS_DISPATCHER,
        useFactory: (registry?: JobRuntimeProviderRegistry | null): AppForkReadinessDispatcher => ({
            dispatch: async (payload: AppForkReadinessJobPayload): Promise<string | null> => {
                const dispatchers = registry?.getActive()?.dispatchers as
                    | Record<string, unknown>
                    | undefined;
                const dispatch = dispatchers?.[FORK_READINESS_DISPATCH_METHOD];
                if (typeof dispatch !== 'function') {
                    return null;
                }
                const runId = await (
                    dispatch as (p: AppForkReadinessJobPayload) => Promise<string | null>
                ).call(dispatchers, payload);
                return runId ?? null;
            },
        }),
        inject: [{ token: JOB_RUNTIME_PROVIDER_REGISTRY, optional: true }],
    };
}

@Module({
    imports: [
        // The epic's own table. `forFeature` is what registers the entity with
        // the DataSource the application opened; without it the repository's
        // `@InjectRepository(WorkUpstreamState)` has no provider to inject and
        // the API fails at boot.
        TypeOrmModule.forFeature([WorkUpstreamState]),
        // APW-01 T12/T13 — `AppSourceInspectorService` reads the Work tables and
        // `AppWorkCreateService` writes them through `WorkRepository`, so this
        // module needs the repository wrappers `DatabaseModule` provides and
        // exports. `FacadesModule` supplies `GitFacadeService` (the only way this
        // epic talks to a provider) and `DeployFacadeService` (the user-scoped
        // deploy provider list the create path's step 4 reads). Both are leaf
        // imports with respect to this module — nothing in either imports it —
        // which is what keeps `WorkModule`'s `imports: [AppWorksModule]` acyclic.
        DatabaseModule,
        FacadesModule,
        // APW-02 §3.5 / §6.5 — the Activity writer, the owner notice and the
        // conflict Task, for the services DECLARED here (`AppUpstreamStateService`,
        // `AppActionsHygieneService`, this module's `AppSourceInitializerService`).
        // They must be imported HERE: Nest resolves a provider's dependencies in the
        // module that declares it, and until 2026-09-26 only the API's wrapper
        // module imported them — which the services here cannot see. See the class
        // docstring's "The Activity, notification and Task collaborators" section.
        ActivityLogModule,
        NotificationsModule,
        TasksDomainModule,
    ],
    providers: [
        WorkUpstreamStateRepository,
        AppUpstreamStateService,
        AppUpstreamSyncDispatcherService,
        // APW-01 T12/T13. `DistributedTaskLockService` is provided locally, exactly
        // as `AppSpecModule` and `CommunityPrModule` provide it: the cache module
        // is not global, and the create lock (FR-22) is this epic's own use.
        DistributedTaskLockService,
        AppSourceInspectorService,
        AppWorkCreateService,
        // C10 — T24's hygiene service joined the graph with the readiness service
        // (`AppForkReadinessService` injects it NON-optionally), and it is provided
        // here because `WorkUpstreamStateRepository`, its only required
        // collaborator, is this module's own provider. Its other three
        // collaborators stay `@Optional()`, so the bare compile this module's spec
        // builds still resolves.
        AppActionsHygieneService,
        // APW-01 T15 — the ready handler. Provided here (compiling in every graph,
        // wired where its collaborators are visible) and exported so `apps/api` can
        // bind it to APW-02's `APP_FORK_READY_HANDLER`. See the docstring above.
        AppSourceInitializerService,
        // C10 — the binding that makes a readiness dispatch leave the process. See
        // the docstring above for why it lives here and what `null` means.
        buildAppForkReadinessDispatcherProvider(),
        // APW-03 T26 — the Apps-catalog port, bound where its two consumers are
        // declared. Deliberately not exported. See the docstring above.
        AppBlueprintResolverService,
        { provide: APP_SOURCE_CATALOG_PORT, useClass: AppSourceCatalogAdapter },
        // APW-01 T36 — FR-53's five events. Its sink is the API's to bind (a global
        // alias); unbound, events are counted and dropped. See the docstring above.
        AppWorksTelemetryService,
    ],
    exports: [
        WorkUpstreamStateRepository,
        AppUpstreamStateService,
        AppUpstreamSyncDispatcherService,
        AppSourceInspectorService,
        AppWorkCreateService,
        // C10 — exported so the API-side module can provide T24's readiness service
        // (and the RPC runner in front of it) without re-declaring the hygiene
        // service, and so any future consumer of this module resolves the SAME
        // dispatcher instance the two call sites use.
        AppActionsHygieneService,
        APP_FORK_READINESS_DISPATCHER,
        // APW-01 T15 — exported for the same reason: the API-side module binds
        // `APP_FORK_READY_HANDLER` to this class, and a class that is not exported
        // cannot be reached across the module edge.
        AppSourceInitializerService,
        // APW-01 T36 — exported so the API-side ready handler and `WorkModule`'s
        // `WorkLifecycleService` receive the same instance the services here do.
        AppWorksTelemetryService,
    ],
})
export class AppWorksModule {}
