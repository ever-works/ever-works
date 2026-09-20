import { Module, type FactoryProvider } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DatabaseModule } from '../database/database.module';
import { FacadesModule } from '../facades/facades.module';
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
    ],
})
export class AppWorksModule {}
