import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WorkUpstreamStateRepository } from '../database/repositories/work-upstream-state.repository';
import { WorkUpstreamState } from '../entities/work-upstream-state.entity';

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
 */
@Module({
    imports: [
        // The epic's own table. `forFeature` is what registers the entity with
        // the DataSource the application opened; without it the repository's
        // `@InjectRepository(WorkUpstreamState)` has no provider to inject and
        // the API fails at boot.
        TypeOrmModule.forFeature([WorkUpstreamState]),
    ],
    providers: [WorkUpstreamStateRepository],
    exports: [WorkUpstreamStateRepository],
})
export class AppWorksModule {}
