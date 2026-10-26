import { Global, Module } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
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
    ],
    exports: [APP_WORK_DELETION_PORT, AppRuntimeDeletionService],
})
export class AppRuntimePortsModule {}
