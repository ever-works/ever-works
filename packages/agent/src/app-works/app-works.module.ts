import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DatabaseModule } from '../database/database.module';
import { FacadesModule } from '../facades/facades.module';
import { DistributedTaskLockService } from '../cache/distributed-task-lock.service';
import { WorkUpstreamStateRepository } from '../database/repositories/work-upstream-state.repository';
import { WorkUpstreamState } from '../entities/work-upstream-state.entity';
import { AppUpstreamStateService } from './app-upstream-state.service';
import { AppUpstreamSyncDispatcherService } from './app-upstream-sync-dispatcher.service';
import { AppSourceInspectorService } from './app-source-inspector.service';
import { AppWorkCreateService } from './app-work-create.service';

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
 */
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
    ],
    exports: [
        WorkUpstreamStateRepository,
        AppUpstreamStateService,
        AppUpstreamSyncDispatcherService,
        AppSourceInspectorService,
        AppWorkCreateService,
    ],
})
export class AppWorksModule {}
