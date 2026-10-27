import { Global, Module } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DatabaseModule, WorkRepository } from '@ever-works/agent/database';
import { NotificationService, NotificationsModule } from '@ever-works/agent/notifications';
import { WorkLifecycleService } from '@ever-works/agent/services';
import { getOptionalProvider } from '@ever-works/agent/utils';
import { WORK_APP_RUNTIME_STATES } from '@ever-works/agent/app-launcher';
import {
    APP_CLUSTER_OP_DISPATCHER,
    APP_DEPENDENCIES_SERVICE,
    APP_WORK_DELETION_COMPLETION,
    APP_WORK_DELETION_PORT,
    APP_WORK_DELETION_PORT_PROVIDER,
    AppRuntimeDeletionService,
    AppRuntimeStateModule,
    AppWorkDeletionCompletionService,
    buildAppClusterOpDispatcherProviders,
    type AppClusterOpDispatcher,
    type AppWorkDeletionClaimReader,
    type AppWorkDeletionCompletionWorks,
    type AppWorkDeletionNotifier,
    type AppDependenciesService,
    type AppWorkDeletionCompletion,
    type WorkAppRuntimeStateDeletionStore,
} from '@ever-works/agent/app-runtime';
import { AppDependenciesModule } from '@ever-works/agent/app-dependencies';
import { APP_PUBLISHED_HOSTS, type AppPublishedHostsPort } from '@ever-works/agent/app-launcher';
import { AppHostsService } from '@ever-works/agent/app-runtime';
import {
    APP_RUNTIME_EVENT_SINK,
    APP_RUNTIME_TARGET,
    AppRuntimeEventRelayService,
    UnavailableRuntimeTarget,
    type AppRuntimeEventSink,
    type AppRuntimeTargetPort,
} from '@ever-works/agent/app-runtime';

/**
 * APW-06 T33 / T58 / T73, plan §9.8 (lane aw-safety, 2026-10-26) — **the API's App runtime ports
 * module, the deletion half**: what finally makes deleting an App Work tear down what it runs.
 *
 * ## The defect this closes (prod risk)
 *
 * APW-01's `WorkLifecycleService.deleteWork` asks `APP_WORK_DELETION_PORT` to remove an App
 * Work's workloads BEFORE it deletes the row, and takes an unbound port as "no App runtime exists,
 * so nothing can be running". No API module bound it, so every App Work delete deleted the row at
 * once — and the namespace, its Deployments and Services, the App's dependencies and volumes, and
 * the managed DNS record kept running and serving with no Work left to manage them
 * (`app-works-di-reachability.spec.ts` carried it as `WorkModule | WorkLifecycleService |
 * APP_WORK_DELETION_PORT`). The worker half (the `delete-app-work` op) was wired; nothing in the
 * API could reach it.
 *
 * ## What it provides
 *
 * - **`APP_WORK_DELETION_PORT`** — `APP_WORK_DELETION_PORT_PROVIDER`, the lazy `ModuleRef` factory
 *   §9.8 fixes (never `useExisting`: the port and `WorkLifecycleService` form a cycle). `@Global()`
 *   and exported, so `WorkModule` (non-global, in `packages/agent`) reaches it without importing
 *   anything — the rule §9.8 states ("Consumers inside `packages/agent` never import it").
 * - **`AppRuntimeDeletionService`, the API copy** — built by a factory with exactly the
 *   collaborators the API half uses (`requestDeletion`, `describeDeletion`, `finishDeletion`): the
 *   Work and runtime-state reads, APW-07's service (the in-process `done` row and the preview),
 *   the `app-cluster-op` gate and the guarded completion. The three seams only the OP uses — the
 *   cluster facade, the managed DNS service and the event sink — are deliberately NOT given to it:
 *   the API never dials a cluster (§6.2, plan.md:1470), and the op runs in the isolated worker
 *   (`trigger-app-runtime.module.ts` binds all three there). Exported, for the preview route and
 *   for `TriggerInternalController`'s `AppRuntimeDeletionService.finishDeletion` remote target.
 * - **`APP_WORK_DELETION_COMPLETION`** → `AppWorkDeletionCompletionService`, the guarded
 *   completion (the row must record a deletion; the owner is told what may remain), local to
 *   this module.
 * - **`APP_CLUSTER_OP_DISPATCHER`**, local and NOT exported: the same stateless gate
 *   `AppDeployRequestModule` builds (`buildAppClusterOpDispatcherProviders`) — exporting it from
 *   a `@Global()` module would bind the token in every module of the API as a side effect.
 *
 * ## The event sink and the runtime target (lane aw-builds-bindings, 2026-10-27)
 *
 * §9.8 lists two more tokens this module provides in the API, and until now nothing did, so
 * `AppDependenciesService` (APW-07) ran in the API with both unbound
 * (`app-works-di-reachability.spec.ts` carried `AppDependenciesModule | AppDependenciesService |
 * APP_RUNTIME_EVENT_SINK` and `… | APP_RUNTIME_TARGET`):
 *
 * - **`APP_RUNTIME_EVENT_SINK`** → "EventEmitter2 in the API" (`ports.ts`), through the SAME
 *   `AppRuntimeEventRelayService` the worker's events arrive at — so an event the API's own copy
 *   of `AppDependenciesService` emits (a data deletion, a release) is held to the same catalogue
 *   and forbidden-key check as a relayed one, and reaches `AppRuntimeActivityListener` as an
 *   `app_dependency` Activity row. Unbound, those events were dropped without a trace.
 * - **`APP_RUNTIME_TARGET`** → §9.6's `UnavailableRuntimeTarget`, answering `cluster_unreachable`.
 *   The API never dials a cluster (§6.2): §9.9's resolver is worker-only and refuses outside the
 *   worker, which `AppDependenciesService.prepareTarget` reads as exactly that discriminant. Bound,
 *   the answer is explicit and RETRYABLE, where unbound it was `target_not_checked` — a definite
 *   "check your cluster" for a cluster that may be fine. Only the isolated worker provisions a
 *   dependency (`app-dependency-provision.task.ts` binds the real adapter there).
 *
 * Both are exported from this `@Global()` module, so they are visible to `AppDependenciesModule`
 * without an import edge. No other API provider asks for either token today; the reachability
 * spec is what would show one that starts to.
 *
 * Imported once, by the API's `AppWorksModule` (`app-works.module.ts`), so the root module's
 * import list is untouched.
 */
@Global()
@Module({
    imports: [
        // `WorkRepository` (and `WorkMemberRepository`, which the deletion service resolves lazily
        // for the member-owner check) — `DatabaseModule` is already everywhere in the API graph.
        DatabaseModule,
        // `WORK_APP_RUNTIME_STATES` — the claim, the deploy lock, the snapshot.
        AppRuntimeStateModule,
        // `APP_DEPENDENCIES_SERVICE` — §9.7's first row and the preview's dependency list.
        AppDependenciesModule,
        // `NotificationService` for the completion's owner notification.
        NotificationsModule,
    ],
    providers: [
        ...buildAppClusterOpDispatcherProviders(),
        // The guarded completion. APW-01's `WorkLifecycleService` is looked up LAZILY (§9.8: the
        // port and the lifecycle service form a cycle, so never a constructor edge), and only when
        // a finished removal is completed.
        {
            provide: AppWorkDeletionCompletionService,
            useFactory: (
                moduleRef: ModuleRef,
                works?: AppWorkDeletionCompletionWorks,
                states?: AppWorkDeletionClaimReader,
                notifications?: AppWorkDeletionNotifier,
            ) =>
                new AppWorkDeletionCompletionService(works, states, notifications, () =>
                    getOptionalProvider<WorkLifecycleService>(moduleRef, WorkLifecycleService),
                ),
            inject: [
                ModuleRef,
                { token: WorkRepository, optional: true },
                { token: WORK_APP_RUNTIME_STATES, optional: true },
                { token: NotificationService, optional: true },
            ],
        },
        { provide: APP_WORK_DELETION_COMPLETION, useExisting: AppWorkDeletionCompletionService },
        {
            provide: AppRuntimeDeletionService,
            useFactory: (
                works?: WorkRepository,
                states?: WorkAppRuntimeStateDeletionStore,
                dependencies?: AppDependenciesService,
                dispatcher?: AppClusterOpDispatcher,
                completion?: AppWorkDeletionCompletion,
                moduleRef?: ModuleRef,
            ) =>
                new AppRuntimeDeletionService(
                    works,
                    states,
                    dependencies,
                    // APP_RUNTIME_DELETION_FACADE — worker-only (the op dials the cluster).
                    undefined,
                    dispatcher,
                    // APPS_DOMAIN_DNS_SERVICE — worker-only (the op removes the record).
                    undefined,
                    // APP_RUNTIME_EVENT_SINK — worker-only (the op writes `app.deploy.removed`).
                    undefined,
                    completion,
                    moduleRef,
                ),
            inject: [
                { token: WorkRepository, optional: true },
                { token: WORK_APP_RUNTIME_STATES, optional: true },
                { token: APP_DEPENDENCIES_SERVICE, optional: true },
                { token: APP_CLUSTER_OP_DISPATCHER, optional: true },
                { token: APP_WORK_DELETION_COMPLETION, optional: true },
                ModuleRef,
            ],
        },
        APP_WORK_DELETION_PORT_PROVIDER,
        // Lane aw-safety (2026-10-26) — APW-11's `APP_PUBLISHED_HOSTS` (the App Launcher tile's
        // address): APW-06's `AppHostsService.primary` — the owner's verified primary domain, else
        // `<managedSubdomain>.<apps-domain>`, else `null` (then FR-16's order applies unchanged).
        // Lazy: `AppHostsService` lives in `AppDeployRequestModule`, and a global export is what
        // reaches the launcher in `AppLauncherModule` without an import edge.
        {
            provide: APP_PUBLISHED_HOSTS,
            useFactory: (moduleRef: ModuleRef): AppPublishedHostsPort => ({
                primary: async (workId: string) => {
                    const hosts = getOptionalProvider<AppHostsService>(moduleRef, AppHostsService);
                    return hosts ? hosts.primary(workId) : null;
                },
            }),
            inject: [ModuleRef],
        },
        // Lane aw-builds-bindings (2026-10-27) — §9.8's event sink and runtime target (see above).
        {
            provide: APP_RUNTIME_EVENT_SINK,
            useFactory: (emitter?: EventEmitter2): AppRuntimeEventSink =>
                new AppRuntimeEventRelayService(emitter),
            inject: [{ token: EventEmitter2, optional: true }],
        },
        {
            provide: APP_RUNTIME_TARGET,
            useFactory: (): AppRuntimeTargetPort =>
                new UnavailableRuntimeTarget('cluster_unreachable'),
        },
    ],
    exports: [
        APP_WORK_DELETION_PORT,
        AppRuntimeDeletionService,
        APP_PUBLISHED_HOSTS,
        APP_RUNTIME_EVENT_SINK,
        APP_RUNTIME_TARGET,
    ],
})
export class AppRuntimePortsModule {}
