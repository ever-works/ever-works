import { Injectable, Module, OnModuleInit } from '@nestjs/common';
import { config } from '@ever-works/agent/config';
import {
    APP_DEPLOY_BUILD_SOURCE,
    APP_DEPLOY_SPEC_SOURCE,
    APP_DEPLOY_TARGET_RESOLVER,
    APP_IMAGE_PULL_CREDENTIAL_SOURCE,
    APP_RUNTIME_DELETION_FACADE,
    APP_RUNTIME_ENV_SOURCE,
    APP_RUNTIME_HEALTH_FACADE,
    APP_RUNTIME_TARGET,
    APP_RUNTIME_VERIFICATION_FACADE,
    APP_TARGET_UPDATED_PORT,
    APP_VERIFICATION_SINK,
    APP_VERIFICATION_SPEC_SOURCE,
    APPS_TIER_POLICY,
    AppClusterOpRouter,
    AppDeployOrchestrator,
    AppDeployPreconditionsService,
    AppDomainsService,
    AppHealthService,
    AppHostsService,
    AppLicenseGate,
    AppLifecycleOpsService,
    AppPublicSmokeService,
    AppRenderInputBuilder,
    AppRuntimeDeletionService,
    AppSmokeService,
    AppVerificationTargetService,
    UnavailableVerificationSink,
    markAppClusterWorkerContext,
    // A0.7 (2026-10-17) — the real port implementations and the seams they fill.
    APP_COMMIT_ANCESTRY,
    APP_CUSTOM_DOMAIN_STORE,
    APP_DEPLOY_DEPLOYMENT_STORE,
    APP_DEPLOY_DISPATCHER,
    APP_CLUSTER_OP_DISPATCHER,
    APPS_DOMAIN_DNS_SERVICE,
    APP_HOSTS_APPS_DOMAIN,
    APP_HOSTS_DEPLOY_REQUESTER,
    APP_HOSTS_DEPLOYMENT_STORE,
    APP_HOSTS_WORK_STORE,
    APP_IMAGE_REFERENCE_RESOLVER,
    APP_RUNTIME_EVENT_SINK,
    APP_RUNTIME_NOTIFICATIONS,
    APP_UPSTREAM_STATE_READER,
    AppBuildPullCredentialSource,
    AppDeployDeploymentStoreAdapter,
    AppRuntimeNotificationProducersAdapter,
    AppRuntimeTargetAdapter,
    ConfigAppsTierPolicy,
    PublicGitHubCommitAncestry,
    RegistryAppImageReferenceResolver,
    workerAppDeployDispatcher,
} from '@ever-works/agent/app-runtime';
import { APP_DEPLOY_HOST_SOURCE } from '@ever-works/agent/app-runtime';
import { APP_DEPENDENCIES_SERVICE } from '@ever-works/agent/app-runtime';
// Lane aw-deploy-3 (2026-10-17) — APW-07's service, composed HERE so the worker's preconditions
// enforce dependency readiness and the orchestrator's `remove` can order the dependency deletion.
import {
    APP_DEPENDENCY_CLUSTER_ACCESS,
    APP_DEPENDENCY_CONFIG_CIPHER,
    APP_DEPENDENCY_PROVISION_DISPATCHER,
    APP_DEPENDENCY_SPEC_SOURCE,
    AppDependenciesService,
} from '@ever-works/agent/app-dependencies';
import { WORK_APP_RUNTIME_STATES } from '@ever-works/agent/app-launcher';
import {
    AppDependencyFacadeService,
    AppRuntimeFacadeService,
    DeployFacadeService,
    GitFacadeService,
} from '@ever-works/agent/facades';
import { APP_PROVISION_EVENTS_PORT } from '@ever-works/agent/app-works';
import {
    WorkAppDependencyRepository,
    WorkCustomDomainRepository,
    WorkDeploymentRepository,
    WorkRepository,
} from '@ever-works/agent/database';
import { Work } from '@ever-works/agent/entities';
import { DistributedTaskLockService } from '@ever-works/agent/cache';
import { NotificationService } from '@ever-works/agent/notifications';
import { TriggerPluginsModule } from './trigger-plugins.module';
import { TriggerRemoteCacheModule } from './trigger-remote-cache.module';
import { TriggerFacadesModule } from './trigger-facades.module';
import { TriggerInternalModule } from './trigger-internal.module';
import { TriggerInternalApiClient } from '../services/trigger-internal-api.client';
import { createRemoteProxy } from '../remote-proxy';

/**
 * APW-06 T71 (`tasks.md:1220-1238`, plan §6.4 `plan.md:966-991`) — **the isolated App runtime
 * worker's module**.
 *
 * ## ⭐ Status 2026-10-17 (A0.7, lane aw-deploy) — read this before the historical notes below
 *
 * A dequeued Deployment now runs end to end in this context. What changed, and what the older
 * sections below (kept for history, no-removal rule) therefore no longer describe:
 *
 * - **Decision B1** — `AppDeployPreconditionsService.evaluate` skips §5.1 step 1's dispatcher gate
 *   when it runs inside this worker (`isAppClusterWorkerContext()`) for the Deployment that holds
 *   the deploy lock. `APP_DEPLOY_DISPATCHER_AVAILABILITY` therefore stays **deliberately** unbound
 *   here; `APP_DEPLOY_DISPATCHER` is bound for §5.6 step 7's dequeue only (→ the API's gate).
 * - `WORK_APP_RUNTIME_STATES` → `remoteMap.WorkAppRuntimeStateRepository` (T71 item (b)).
 * - The four §6.4 ports are real: `APP_RUNTIME_ENV_SOURCE` → `remoteMap.AppEnvRuntimeSource`;
 *   `APP_IMAGE_PULL_CREDENTIAL_SOURCE`, `APP_RUNTIME_TARGET`, `APPS_TIER_POLICY` → the classes in
 *   `packages/agent/src/app-runtime/app-runtime-worker.adapters.ts`.
 * - The unwritten seams are written and bound: `APP_IMAGE_REFERENCE_RESOLVER` (T72),
 *   `APP_RUNTIME_EVENT_SINK` (T28 relay), `APP_RUNTIME_NOTIFICATIONS` (T29),
 *   `APP_UPSTREAM_STATE_READER`, `APP_COMMIT_ANCESTRY`, `APP_DEPLOY_DEPLOYMENT_STORE` (with the
 *   orchestrator's `update`), and T26's host stores (`APP_CUSTOM_DOMAIN_STORE`,
 *   `APP_HOSTS_WORK_STORE`, `APP_HOSTS_DEPLOYMENT_STORE`, `APP_HOSTS_APPS_DOMAIN`,
 *   `APP_HOSTS_DEPLOY_REQUESTER`).
 * - `WorkRepository` answers real `Work` instances (`hydratingWorkRepositoryProxy`).
 *
 * Still unbound (each in `EXPECTED_WORKER_UNBOUND` with its reason): the verification sink,
 * the dependency service, the cluster-op dispatcher, the managed DNS service, the rebuild
 * requester, the licence service, the provisioner ports and the health egress source.
 *
 * ## Why it is not `TriggerInternalModule`
 *
 * `TriggerInternalModule` is built entirely from `createRemoteProxy` entries
 * (`trigger-internal.module.ts:102-528`, served by `apps/api/src/trigger/trigger-internal.controller.ts`),
 * so a task that boots it makes **every** call inside the API. For App runtime work that is the
 * wrong shape and not merely a slow one: the whole point of §6.2 is that the *cluster* connection
 * happens in the worker (FR-5, ACC-06-04), so the work itself — the orchestrator, the render-input
 * builder, the smoke service, the ops — has to be instantiated **here**, locally, and only the
 * *repository reads and writes* it cannot perform without a `DataSource` are proxied.
 *
 * ## The rule this file exists to keep
 *
 * **No `DatabaseModule`, no TypeORM `DataSource`, no Redis client.** `TriggerWorkflowRunModule`
 * imports `DatabaseModule` deliberately (it owns the `workflows` row); this module must not, which
 * is why `packages/tasks/src/trigger/worker/modules/__tests__/trigger-app-runtime.module.spec.ts`
 * asserts that no `DataSource` is resolvable from the context this module boots. The worker's only
 * platform endpoint is the internal Trigger API over HTTPS, which is what makes §6.2's
 * `EVER_WORKS_APPS_CLUSTER_WORKER_ISOLATED` attestation achievable at all.
 *
 * ## The one bootstrap provider
 *
 * {@link AppClusterWorkerContextBootstrap} calls `markAppClusterWorkerContext()` in
 * `onModuleInit`. It is the **only** caller of that marker in the tree (T20's rule,
 * `packages/agent/src/app-runtime/worker-context.ts:96-113`), and the module spec asserts that by
 * scanning for a second caller rather than by trusting this docstring. Until it runs,
 * `AppRuntimeFacadeService`'s every method throws `APP_CLUSTER_IO_IN_API` — which is exactly what
 * keeps a cluster dial out of the API process.
 *
 * ## What is local, and what is proxied
 *
 * | Local (this module) | Proxied over the internal API |
 * | --- | --- |
 * | `AppRuntimeFacadeService` (T20) | `WorkRepository`, `WorkDeploymentRepository`, `WorkCustomDomainRepository` |
 * | `AppDeployPreconditionsService`, `AppLicenseGate` (T21) | `DistributedTaskLockService` — it injects `@InjectRepository(CacheEntry)` NON-optionally, so it can only be a proxy here |
 * | `AppRenderInputBuilder` (T22), `AppPublicSmokeService` (T23) | `NotificationService` — Activity and notifications are written in the API process |
 * | `AppHostsService`, `AppDomainsService` (T26), `AppDeployOrchestrator` (T25) | `APP_DEPLOY_SPEC_SOURCE` → the API's `AppSpecService` (§5.1's spec at a commit) |
 * | `AppRuntimeDeletionService` (T58), `AppVerificationTargetService` (T60) | `APP_DEPLOY_BUILD_SOURCE` → the API's `AppDeployBuildSourceAdapter` (APW-05's `WorkBuild` reads) |
 * | `DeployFacadeService` (§6.4:979 — the plugin settings that hold the kubeconfig) | |
 *
 * The last two are the API's OWN bindings of the same tokens (`AppDeployRequestModule`), reached by
 * name, so the worker's §5.1 re-check and render input read the spec and the Build exactly as the
 * API's deploy route does. Unbound (before 2026-09-25), the render-input builder answered
 * `no_green_build` for every Build-backed Deployment and `spec_unavailable` for every other one,
 * and `AppHealthService` had no component list to judge.
 *
 * ⚠ Binding them does NOT yet let the worker's §5.1 re-check pass: `APP_DEPLOY_DISPATCHER_AVAILABILITY`
 * is unbound in this module, so `AppDeployPreconditionsService.evaluate` still stops at its step 1
 * with `worker_not_isolated` — before it reads the spec or the Build — for every dequeued
 * Deployment. What "an isolated dispatcher is available" means inside the isolated worker itself is
 * a §5.1/§5.6 decision this module does not make on its own.
 *
 * ## 🛑 The two §6.4 rows that CANNOT be wired yet, and what is bound instead
 *
 * §6.4's table lists `APP_RUNTIME_ENV_SOURCE`, `APP_IMAGE_PULL_CREDENTIAL_SOURCE`,
 * `APP_RUNTIME_TARGET` and `APPS_TIER_POLICY` as **"proxied by name"**, because "their
 * implementations live in the API's module graph (§9.8)". §9.8's module does not exist yet
 * (`apps/api/src/app-runtime/app-runtime-ports.module.ts`, APW-06 **T73**), and neither does any
 * implementation class it would publish, so there is no API-side `remoteMap` name for a proxy to
 * dial: a `createRemoteProxy(client, 'AppRuntimeEnvSource')` here would answer
 * `Unknown remote target: AppRuntimeEnvSource` at call time instead of the platform's own typed
 * refusal.
 *
 * The platform already declares the answer for exactly this state — `default-ports.ts`'s
 * fail-closed classes, which are what §9.8 binds until the owning epics replace them — so they are
 * bound here **explicitly** rather than left unbound: the same named refusal
 * (`AppPortUnavailableError('env_source_unavailable')`, `tier_unavailable`, `verification_unavailable`,
 * `target_not_checked`) that an unbound `@Optional()` collaborator already produces, but
 * *observable* in the container. **T73 (or T44 for the tier policy) must replace these five
 * bindings with the proxied ones when §9.8 lands**; that swap is what §6.4 asks for and this note
 * is the reason it is not here today.
 *
 * ## What §6.4 also lists and cannot be provided at all
 *
 * These owners have not landed, so their classes do not exist to provide:
 *
 * - `AppImageReferenceResolver` — APW-06 **T72** (`packages/agent/src/app-runtime/app-image-reference.resolver.ts`).
 * - `AppRuntimeEventRelayService` (the `APP_RUNTIME_EVENT_SINK` proxy) — APW-06 **T28**
 *   (`apps/api/src/app-runtime/app-runtime-event-relay.service.ts`).
 * - APW-03's `AppLicenseService` (T29/T30's `APP_LICENSE_SERVICE`). (APW-05's `WorkBuild` reads were
 *   on this list until 2026-09-25; they are proxied above.)
 *
 * (`WORK_APP_RUNTIME_STATES` was on this list, blamed on APW-06 T17. That was stale: T17's
 * `WorkAppRuntimeStateRepository` has landed and the API binds the token to it. It moved to the
 * section below.)
 *
 * ## Still open under T71 — the classes exist, the worker bindings do not (measured 2026-09-26)
 *
 * `apps/api/src/app-works-di-reachability.spec.ts` walks this module's graph and lists every
 * `@Optional()` token nothing here provides. These have an implementation in the tree and are
 * T71's own open composition work (`APW-06/tasks.md:1220-1234` lists the first two), each blocked
 * on something that is not a one-line binding:
 *
 * - `APP_DEPLOY_DISPATCHER_AVAILABILITY` / `APP_DEPLOY_DISPATCHER` — the §5.1/§5.6 decision above
 *   (T71 status item (a)); the dequeue dispatch is T31's.
 * - `WORK_APP_RUNTIME_STATES` — §6.4 proxies `WorkAppRuntimeStateRepository`, which needs a new
 *   `remoteMap` name on the API side and `TriggerInternalModule` importing `AppRuntimeStateModule`
 *   (T71 status item (b)). Binding it turns on every runtime path here that is not behind the
 *   dispatcher gate — the health sweep, the cluster ops, the smoke and the deletion path — so it
 *   lands with a spec that drives them across the hop, not as a line on its own.
 * - `APP_CUSTOM_DOMAIN_STORE`, `APP_HOSTS_WORK_STORE`, `APP_HOSTS_DEPLOYMENT_STORE`,
 *   `APP_HOSTS_APPS_DOMAIN` — `app-hosts.service.ts` documents each swap, to providers this module
 *   already proxies (`WorkCustomDomainRepository`, `WorkRepository`, `WorkDeploymentRepository`) or
 *   to `config.everWorks.apps`. `AppHostsService.resolveHost` also reads the runtime-state row —
 *   the owner's primary-domain choice, TLS mode and the pending-rebuild hosts — so bound WITHOUT
 *   it they would render a managed-only host set that ignores the owner's settings. They land
 *   with `WORK_APP_RUNTIME_STATES`, not before it.
 * - `APP_DEPLOY_DEPLOYMENT_STORE` — the API binds it to `AppDeployDeploymentStoreAdapter`, which has
 *   no `update`; the orchestrator's view of the same token needs one (§5.6 steps 4–7). Which class
 *   carries it is a decision, not a binding.
 * - `APP_HOSTS_DEPLOY_REQUESTER` — bound to the API's `AppDeployRequestService`; §6.4 lists no proxy
 *   for it, so whether this worker may request a Deployment over the internal channel is open.
 * - `APP_WORK_DELETION_COMPLETION` — deletes the Work row; its binding is owed in the API
 *   (`app-runtime-deletion.service.ts`, APW-06 T33/T58) and, here, would be a proxy to a destructive
 *   method. Unbound, a finished removal keeps the row (fail-closed).
 * - `APP_DEPENDENCIES_SERVICE` — APW-07's service must run HERE (its provider calls dial the
 *   cluster), and its row writes go through `@InjectRepository(WorkAppDependency)`, which cannot cross
 *   the internal channel; with `app-dependency-provision.task.ts`'s module, it waits on that design.
 * - `APP_HEALTH_EGRESS_SOURCE` — the narrow adapter `app-health.service.ts` names is unwritten, and
 *   `APP_RUNTIME_ENV_SOURCE` here is still the fail-closed default above.
 *
 * **APW-06 T70's three classes and T27's service are provided below** (added 2026-09-18):
 * `AppClusterOpRouter` plus the `AppLifecycleOpsService` and `AppSmokeService` it and the
 * `app-smoke` task resolve, so the two refusals this module used to answer by name —
 * `op_router_unavailable` and `smoke_service_unavailable` — are now real results; and
 * `AppHealthService`, whose own facade token is bound to the same class as T58's and T60's, so
 * `health_service_unavailable` is likewise a fallback rather than the norm. The router reaches
 * T58's and T60's already provided op handlers by method presence, so no op is implemented twice.
 *
 * None of them is stubbed. Every consumer declares the collaborator `@Optional()` and answers a
 * named refusal, so the module boots, the four `app-*` tasks run, and what a run *cannot* do is
 * reported by name rather than faked.
 */

/**
 * The one writer of T20's worker-context flag, and the reason this module is safe to boot.
 *
 * `onModuleInit` rather than a module-level side effect on purpose: the flag must be armed by a
 * Nest context that this module's own graph built, never by importing a file. A second caller
 * anywhere in the tree would silently widen "who may dial a cluster", which the module spec
 * asserts against by scanning for one.
 */
@Injectable()
export class AppClusterWorkerContextBootstrap implements OnModuleInit {
    onModuleInit(): void {
        markAppClusterWorkerContext();
    }
}

/** The remote name each proxied provider dials on `TriggerInternalController.remoteMap`. */
export const APP_RUNTIME_REMOTE_PROXIES = [
    'WorkRepository',
    'WorkDeploymentRepository',
    'WorkCustomDomainRepository',
    'DistributedTaskLockService',
    'NotificationService',
    // §5.1's two reads, bound below to `APP_DEPLOY_SPEC_SOURCE` / `APP_DEPLOY_BUILD_SOURCE`.
    'AppSpecService',
    'AppDeployBuildSourceAdapter',
    // A0.7 (2026-10-17) — T71 status item (b), §6.4's env source, T28's relay, the dequeue
    // dispatcher, the hosts' deploy requester and APW-02's upstream-state read.
    'WorkAppRuntimeStateRepository',
    'AppEnvRuntimeSource',
    'AppRuntimeEventRelayService',
    'AppDeployDispatchRelay',
    'AppClusterOpDispatchRelay',
    'AppsDomainDnsServiceImpl',
    'AppBuildPullTokenReader',
    // Lane aw-deploy-3 — APW-07's rows, cipher, spec and re-dispatch (as `app-dependency-provision`).
    'WorkAppDependencyRepository',
    'AppDependencyRowsRelay',
    'AppDependencyConfigCipherRelay',
    'AppDependencySpecSourceAdapter',
    'AppDependencyProvisionDispatchRelay',
    'AppDeployRequestService',
    'WorkUpstreamStateRepository',
] as const;

/**
 * The worker's `WorkRepository`: the API's, over the internal channel, with `findById` answering a
 * real `Work` instance. SuperJSON carries the row's fields but not its prototype, and
 * `AppRuntimeFacadeService.resolveYourCluster` calls `work.getRepoOwner('data')` for the
 * cluster-source matrix — on a plain object that threw, so every Your-cluster access was refused
 * before any kubeconfig was read (found 2026-10-17, A0.7).
 */
export function hydratingWorkRepositoryProxy(apiClient: TriggerInternalApiClient): WorkRepository {
    const remote = createRemoteProxy(apiClient, 'WorkRepository');
    return createRemoteProxy(apiClient, 'WorkRepository', {
        async findById(id: string, ...rest: unknown[]) {
            return hydrateWork(await remote.findById(id, ...rest));
        },
    });
}

function hydrateWork<T>(row: T): T {
    if (!row || typeof row !== 'object' || row instanceof Work) return row;
    return Object.assign(Object.create(Work.prototype), row) as T;
}

/**
 * The one queue every App cluster task declares (plan §6.2:942 "All App cluster I/O runs in
 * Trigger.dev tasks on queue `app-cluster-io` (`concurrencyLimit: 20`)"; §9.2:1251 "All run on
 * queue `app-cluster-io`").
 *
 * It lives in **this** file rather than in a seventh shared module because all four tasks already
 * import the module they boot, so the constant adds no import edge (and no cycle) — and because the
 * queue and the module are the same decision: this module is what makes a run on it isolated.
 *
 * The specs assert the queue against a **literal**, not against this constant, so a change here
 * cannot silently move all four tasks at once.
 */
export const APP_RUNTIME_TASK_QUEUE = { name: 'app-cluster-io', concurrencyLimit: 20 } as const;

/**
 * The production attestation of §6.2 (`plan.md:950-952`): in production an `app-*` cluster job runs
 * only when the operator has stated that this queue's worker has no route to internal networks.
 *
 * Both halves are enforced in two places on purpose — the dispatcher refuses to enqueue
 * (`worker_not_isolated`) and the task refuses to RUN — so a message enqueued before the flag was
 * flipped, or by an older deployment, still cannot dial a cluster. Failing closed here means no
 * lease is claimed and no plugin is ever called.
 */
export function appClusterWorkerRefusal(): { code: string; message: string } | null {
    if (process.env.NODE_ENV !== 'production') return null;
    if (config.everWorks.apps.isClusterWorkerIsolated()) return null;

    return {
        code: 'worker_not_isolated',
        message:
            'refusing to run in production — EVER_WORKS_APPS_CLUSTER_WORKER_ISOLATED is not true, ' +
            'so this worker is not attested as having no route to internal networks.',
    };
}

@Module({
    imports: [
        // @Global() — PluginRegistryService + PluginSettingsService, which `AppRuntimeFacadeService`
        // takes NON-optionally: without the first this module does not merely lose a credential, it
        // fails to instantiate. `EventEmitterModule.forRoot()` (also global) comes with it.
        TriggerPluginsModule.forRoot(),
        // @Global() — `CACHE_MANAGER`, which `PluginContextFactoryService` requires (its 6th
        // constructor argument is non-optional) and which every `app-op:` / `app-logs:` entry in
        // §9.10 is keyed on.
        TriggerRemoteCacheModule.forRoot(),
        // `GitFacadeService` — the spec at the Build commit — and `DeployFacadeService`, provided
        // locally below because §6.4:979 wants it in THIS module (its App branch is T26's
        // `AppDomainsService`, which lives here).
        TriggerFacadesModule,
        // `TriggerInternalApiClient` for the factories below, plus `WorkRepository` (already a
        // `remoteMap` entry). Nothing else from it is used.
        TriggerInternalModule,
    ],
    providers: [
        // ---- the flag, armed by this module's own bootstrap and by nothing else --------
        AppClusterWorkerContextBootstrap,

        // ---- proxied: the worker owns no `DataSource` -----------------------------------
        {
            provide: WorkRepository,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                hydratingWorkRepositoryProxy(apiClient),
            inject: [TriggerInternalApiClient],
        },
        {
            provide: WorkDeploymentRepository,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'WorkDeploymentRepository'),
            inject: [TriggerInternalApiClient],
        },
        {
            provide: WorkCustomDomainRepository,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'WorkCustomDomainRepository'),
            inject: [TriggerInternalApiClient],
        },
        // `@InjectRepository(CacheEntry)` NON-optionally — the one provider that cannot be local.
        {
            provide: DistributedTaskLockService,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'DistributedTaskLockService'),
            inject: [TriggerInternalApiClient],
        },
        {
            provide: NotificationService,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'NotificationService'),
            inject: [TriggerInternalApiClient],
        },
        // §5.1's two reads (plan §6.4: APW-05's `WorkBuild` reads are "Proxied"), dialled by name
        // to the API's OWN bindings of the same tokens (`AppDeployRequestModule`): the effective
        // App spec at a commit (`AppSpecService.getEffectiveSpec`, the proxy
        // `app-spec-evaluate.task.ts` already uses) and the Build a Deployment names plus the
        // Work's deployable green Builds (`AppDeployBuildSourceAdapter`). Both read rows, so
        // neither can be local here. The preconditions pass, the render-input builder,
        // `AppHostsService` and `AppHealthService` inject them.
        {
            provide: APP_DEPLOY_SPEC_SOURCE,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'AppSpecService'),
            inject: [TriggerInternalApiClient],
        },
        {
            provide: APP_DEPLOY_BUILD_SOURCE,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'AppDeployBuildSourceAdapter'),
            inject: [TriggerInternalApiClient],
        },
        // ---- A0.7 (2026-10-17): the rows and relays a Deployment needs to reach READY ----------
        // T71 status item (b): the runtime-state row — the deploy lock the orchestrator releases,
        // the target and namespace the facade reads, the snapshot health and the ops write.
        {
            provide: WORK_APP_RUNTIME_STATES,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'WorkAppRuntimeStateRepository'),
            inject: [TriggerInternalApiClient],
        },
        // §6.4 "proxied by name" (T73): APW-07's env source reads the stored env and decrypts it in
        // the API, where its key lives; the values cross the authenticated internal channel once.
        {
            provide: APP_RUNTIME_ENV_SOURCE,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'AppEnvRuntimeSource'),
            inject: [TriggerInternalApiClient],
        },
        // T28: the relay re-emits a catalogued `app.*` event in the API (names and ids only).
        {
            provide: APP_RUNTIME_EVENT_SINK,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'AppRuntimeEventRelayService'),
            inject: [TriggerInternalApiClient],
        },
        // §5.6 step 7: the adopted queued Deployment is dispatched through the API's own gate.
        // Decision B1: this is the DEQUEUE dispatcher only — `APP_DEPLOY_DISPATCHER_AVAILABILITY`
        // stays unbound here on purpose, because inside this worker §5.1 step 1 is answered by the
        // run itself (the lock-holding `deploymentId`, `AppDeployPreconditionsService.evaluate`).
        {
            provide: APP_DEPLOY_DISPATCHER,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                workerAppDeployDispatcher(createRemoteProxy(apiClient, 'AppDeployDispatchRelay')),
            inject: [TriggerInternalApiClient],
        },
        // T31 (lane aw-deploy-2): the worker's own re-dispatches — T58's deletion retries, T26's
        // `ingress-reconcile`, `resume`'s wait — go through the API's `app-cluster-op` gate.
        {
            provide: APP_CLUSTER_OP_DISPATCHER,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'AppClusterOpDispatchRelay'),
            inject: [TriggerInternalApiClient],
        },
        // T47/T48 (lane aw-deploy-2): the deletion path removes the managed subdomain's record
        // through the API's apps-DNS service, where the apps-DNS token lives.
        {
            provide: APPS_DOMAIN_DNS_SERVICE,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'AppsDomainDnsServiceImpl'),
            inject: [TriggerInternalApiClient],
        },
        // ---- APW-07 in the isolated worker (lane aw-deploy-3, 2026-10-17) --------------------
        // `APP_DEPENDENCIES_SERVICE` was unbound here, so the worker's §5.1 re-check only WARNED
        // `dependencies_unavailable` and `remove` answered `dependencies_unavailable`. The service
        // is composed locally (its provider calls dial the cluster) over the same proxies
        // `app-dependency-provision` uses: rows, raw id-scoped row writes, cipher, spec, dispatch.
        AppDependenciesService,
        AppDependencyFacadeService,
        { provide: APP_DEPENDENCIES_SERVICE, useExisting: AppDependenciesService },
        { provide: APP_DEPENDENCY_CLUSTER_ACCESS, useExisting: AppRuntimeFacadeService },
        {
            provide: WorkAppDependencyRepository,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'WorkAppDependencyRepository'),
            inject: [TriggerInternalApiClient],
        },
        {
            // `@InjectRepository(WorkAppDependency)`'s token (`getRepositoryToken` → the string).
            provide: 'WorkAppDependencyRepository',
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'AppDependencyRowsRelay'),
            inject: [TriggerInternalApiClient],
        },
        {
            provide: APP_DEPENDENCY_CONFIG_CIPHER,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'AppDependencyConfigCipherRelay'),
            inject: [TriggerInternalApiClient],
        },
        {
            provide: APP_DEPENDENCY_SPEC_SOURCE,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'AppDependencySpecSourceAdapter'),
            inject: [TriggerInternalApiClient],
        },
        {
            provide: APP_DEPENDENCY_PROVISION_DISPATCHER,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'AppDependencyProvisionDispatchRelay'),
            inject: [TriggerInternalApiClient],
        },
        // T26: a primary-domain change asks for a Deployment; the request (and every §5.1 check
        // it re-runs) happens in the API, so the worker may ask over the internal channel.
        {
            provide: APP_HOSTS_DEPLOY_REQUESTER,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'AppDeployRequestService'),
            inject: [TriggerInternalApiClient],
        },
        // APW-02's row read for §5.6 step 9's upstream-sync verdict (`findByWorkId`).
        {
            provide: APP_UPSTREAM_STATE_READER,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'WorkUpstreamStateRepository'),
            inject: [TriggerInternalApiClient],
        },
        // APW-04 (lane aw-ai, 2026-10-17) — the provisioner's events port, dialled by name to
        // the API's ONE `AppProvisionEventsService` (`AgentAppWorksModule`): the orchestrator's
        // `smokeFailedAfterUpstreamSync` (§5.6:844-847, which files a re-provision Task) and
        // `cluster-check`'s `targetUpdated` (§9.10:1593). Both land where the Task tables are;
        // the worker owns no `DataSource`.
        {
            provide: APP_PROVISION_EVENTS_PORT,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'AppProvisionEventsService'),
            inject: [TriggerInternalApiClient],
        },
        {
            provide: APP_TARGET_UPDATED_PORT,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'AppProvisionEventsService'),
            inject: [TriggerInternalApiClient],
        },

        // ---- local: the work itself ------------------------------------------------------
        DeployFacadeService,
        AppRuntimeFacadeService,
        AppLicenseGate,
        AppDeployPreconditionsService,
        AppRenderInputBuilder,
        AppPublicSmokeService,
        AppHostsService,
        AppDomainsService,
        AppDeployOrchestrator,
        AppRuntimeDeletionService,
        AppVerificationTargetService,
        // T70 — the `app-cluster-op` router and its two services, and the body of `app-smoke`.
        // §9.10 gives the router the nine lifecycle handlers and the smoke service; T58's and T60's
        // op handlers above are what its classifier reaches for `delete-app-work` and the three
        // `verification-*` ops, so no op is re-implemented in this module.
        AppClusterOpRouter,
        AppLifecycleOpsService,
        AppSmokeService,
        // T27 — the every-minute health sweep behind `app-health-poll`. Its own facade token is
        // bound below, exactly as T58's and T60's are, so the poll reaches the cluster through the
        // one place that assembles a plugin and a credential (R-5).
        AppHealthService,

        // ---- the seams the landed services declare, bound to their own classes -----------
        // T25's orchestrator resolves its credential through T20's facade
        // (`app-deploy.orchestrator.ts:602-607` says so in as many words).
        { provide: APP_DEPLOY_TARGET_RESOLVER, useExisting: AppRuntimeFacadeService },
        // T58/T60 declared their facades; T20 implements both (`app-runtime.facade.ts:433-436`).
        { provide: APP_RUNTIME_DELETION_FACADE, useExisting: AppRuntimeFacadeService },
        { provide: APP_RUNTIME_VERIFICATION_FACADE, useExisting: AppRuntimeFacadeService },
        // T60's prescribed binding: the render-input builder IS the verification spec source
        // (`app-verification-target.service.ts:571-577`, `app-render-input.builder.ts`).
        { provide: APP_VERIFICATION_SPEC_SOURCE, useExisting: AppRenderInputBuilder },
        // T26's binding, which is what retires T22's `hosts_incomplete` warning: one class answers
        // every host question (`packages/agent/src/app-runtime/index.ts:58-63`).
        { provide: APP_DEPLOY_HOST_SOURCE, useExisting: AppHostsService },
        // T27's own narrow reading of the same facade, at T27's token — the third of the three
        // (`APP_RUNTIME_DELETION_FACADE`, `APP_RUNTIME_VERIFICATION_FACADE`, this one), all bound
        // to the one class so no consumer can be handed a different plugin.
        { provide: APP_RUNTIME_HEALTH_FACADE, useExisting: AppRuntimeFacadeService },

        // ---- the ports (A0.7, 2026-10-17): real implementations ---------------------------
        // Until 2026-10-17 these were `default-ports.ts`'s fail-closed classes. Each is now the
        // narrow real answer (`packages/agent/src/app-runtime/app-runtime-worker.adapters.ts`);
        // the verification sink stays fail-closed (T60's sink is APW-04's, not in this slice).
        // T44 / APW-10 minimal: the managed target opens only with EVER_WORKS_APPS_MANAGED_ENABLED.
        { provide: APPS_TIER_POLICY, useFactory: () => new ConfigAppsTierPolicy() },
        // T73: a Build's image — public => no credential; private GHCR => the owner's GitHub token.
        {
            provide: APP_IMAGE_PULL_CREDENTIAL_SOURCE,
            useFactory: (
                builds: ConstructorParameters<typeof AppBuildPullCredentialSource>[0],
                works: WorkRepository,
                apiClient: TriggerInternalApiClient,
                git?: GitFacadeService,
            ) =>
                new AppBuildPullCredentialSource(
                    builds,
                    works as unknown as ConstructorParameters<
                        typeof AppBuildPullCredentialSource
                    >[1],
                    git,
                    undefined,
                    // Lane aw-deploy-3 — APW-05's stored pull token first (read in the API).
                    createRemoteProxy(apiClient, 'AppBuildPullTokenReader'),
                ),
            inject: [
                APP_DEPLOY_BUILD_SOURCE,
                WorkRepository,
                TriggerInternalApiClient,
                { token: GitFacadeService, optional: true },
            ],
        },
        // T73 / §9.9: APW-07's dependency target, through T20's facade (the one credential path).
        {
            provide: APP_RUNTIME_TARGET,
            useFactory: (
                facade: AppRuntimeFacadeService,
                states?: ConstructorParameters<typeof AppRuntimeTargetAdapter>[1],
            ) =>
                new AppRuntimeTargetAdapter(
                    facade as unknown as ConstructorParameters<typeof AppRuntimeTargetAdapter>[0],
                    states,
                ),
            inject: [AppRuntimeFacadeService, { token: WORK_APP_RUNTIME_STATES, optional: true }],
        },
        { provide: APP_VERIFICATION_SINK, useClass: UnavailableVerificationSink },
        // T72: §5.8's published-image identity (anonymous registry HEAD, tag -> digest once).
        {
            provide: APP_IMAGE_REFERENCE_RESOLVER,
            useFactory: () => new RegistryAppImageReferenceResolver(),
        },
        // T29: the two producers, written through the proxied `NotificationService`.
        {
            provide: APP_RUNTIME_NOTIFICATIONS,
            useFactory: (notifications: NotificationService) =>
                new AppRuntimeNotificationProducersAdapter(notifications),
            inject: [NotificationService],
        },
        // §5.6:841-843 — the upstream-sync verdict's range check (public GitHub compare).
        { provide: APP_COMMIT_ANCESTRY, useFactory: () => new PublicGitHubCommitAncestry() },
        // §5.6 steps 4-7: the Deployment row, with the `update` the orchestrator patches each phase
        // through (the API adapter's class, over the proxied `WorkDeploymentRepository`).
        { provide: APP_DEPLOY_DEPLOYMENT_STORE, useClass: AppDeployDeploymentStoreAdapter },
        // T26's host stores — the swaps `app-hosts.service.ts` documents, now that the
        // runtime-state row (the owner's primary-domain/TLS settings) is bound beside them.
        { provide: APP_CUSTOM_DOMAIN_STORE, useExisting: WorkCustomDomainRepository },
        { provide: APP_HOSTS_WORK_STORE, useExisting: WorkRepository },
        { provide: APP_HOSTS_DEPLOYMENT_STORE, useExisting: WorkDeploymentRepository },
        {
            provide: APP_HOSTS_APPS_DOMAIN,
            useValue: {
                getDomain: (): string | null => config.everWorks.apps.getDomain(),
                // APW-10 lite — managed-target hosts may live under their own apex.
                getManagedDomain: (): string | null => config.everWorks.apps.managedTargetDomain(),
            },
        },
    ],
    exports: [
        // A0.10 (lane aw-deploy-2) — what `app-dependency-provision`'s module reads from here.
        APP_RUNTIME_TARGET,
        APP_RUNTIME_EVENT_SINK,
        WORK_APP_RUNTIME_STATES,
        AppClusterWorkerContextBootstrap,
        AppRuntimeFacadeService,
        DeployFacadeService,
        AppLicenseGate,
        AppDeployPreconditionsService,
        AppRenderInputBuilder,
        AppPublicSmokeService,
        AppHostsService,
        AppDomainsService,
        AppDeployOrchestrator,
        AppRuntimeDeletionService,
        AppVerificationTargetService,
        // T70 — what the three tasks resolve from this context: the router (`app-cluster-op`), the
        // smoke service (`app-smoke`) and T27's health service (`app-health-poll`).
        AppClusterOpRouter,
        AppLifecycleOpsService,
        AppSmokeService,
        AppHealthService,
        WorkRepository,
        WorkDeploymentRepository,
        WorkCustomDomainRepository,
        DistributedTaskLockService,
        NotificationService,
    ],
})
export class TriggerAppRuntimeModule {}
