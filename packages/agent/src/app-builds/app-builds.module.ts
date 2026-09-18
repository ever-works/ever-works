import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ActivityLogModule } from '../activity-log/activity-log.module';
import { AppBuildPreparationRepository } from '../database/repositories/app-build-preparation.repository';
import { AppBuildRepository } from '../database/repositories/app-build.repository';
import { WorkBuild } from '../entities/work-build.entity';
import { WorkBuildPreparation } from '../entities/work-build-preparation.entity';
import { UsageModule } from '../usage/usage.module';
import { AppBuildPullTokenService } from './app-build-pull-token.service';
import { AppBuildsService } from './app-builds.service';

/**
 * APW-05 T17 — the Builds module.
 *
 * It provides and exports the two services and the two repositories this epic
 * owns; everything else this service needs is injected `@Optional()` behind a
 * token this epic does not yet have a binder for, so the module compiles and boots
 * on its own (see `AppBuildsService`'s docstring).
 *
 * ## `TypeOrmModule.forFeature` is the fifth registration point
 *
 * `work_builds` and `work_build_preparations` are registered by
 * `entities/index.ts` (`export *`), `AGENT_ENTITY_NAMES`,
 * `_entities-inventory.ts` and the migration (§3.4:572-580). This is the fifth:
 * without `forFeature` the two repositories' `@InjectRepository` has no provider
 * to inject and the API fails at boot — the same reason `AppWorksModule` carries
 * its own `forFeature`.
 *
 * ## `WorkBuild` is injected into the service, not only into the repository
 *
 * `AppBuildsService` performs two conditional claims (`startedAt`, and the
 * terminal transition) whose whole point is the WHERE predicate, plus the field
 * patches that turn a snapshot into a row. `AppBuildRepository` owns the number
 * arithmetic and the run-identity upsert; it exposes no generic patch. Including
 * the entity in `forFeature` is what makes `@InjectRepository(WorkBuild)` resolvable
 * in the service.
 *
 * ## What is deliberately NOT bound here
 *
 * `APP_BUILD_PLUGIN_RESOLVER` (T16), `APP_BUILD_PREPARE_DISPATCHER` /
 * `APP_BUILD_WATCH_DISPATCHER` and the two runners (T18-T20),
 * `APP_BUILD_WORK_SOURCE`, `APP_BUILD_SPEC_SOURCE` (APW-03),
 * `APP_BUILD_RUNNER_RECIPE_SOURCE` (APW-07), `APP_BUILD_PLATFORM_SETTINGS_WRITER`
 * (§4.12), `APP_BUILD_EDIT_ACCESS` and `APP_PROVISION_EVENTS_PORT` (APW-04) all
 * stay **unbound**: binding a placeholder would make an unconfigured installation
 * look configured, which is the failure mode `AppWorksModule`'s docstring names
 * for exactly this reason. Each absence has a documented, fail-closed behaviour —
 * `null` plugin ⇒ `pullTokenUnavailable` / no provider call; unbound dispatcher ⇒
 * §7.1's in-process fallback; unbound fingerprints ⇒ `staleInputs`; unbound edit
 * port ⇒ `canEdit: false`.
 */
@Module({
    imports: [
        // This epic's two tables. `forFeature` is what registers the entities with
        // the DataSource the application opened; without it the repositories'
        // `@InjectRepository` has no provider and the API fails at boot.
        TypeOrmModule.forFeature([WorkBuild, WorkBuildPreparation]),
        // The single Activity + event writer of §7.8 needs `ActivityLogService`; the
        // receipt of §7.3 needs `PluginUsageService`. Both modules are leaf imports
        // with respect to this one — neither imports it — so nothing here can become
        // a cycle.
        ActivityLogModule,
        UsageModule,
    ],
    providers: [
        AppBuildRepository,
        AppBuildPreparationRepository,
        AppBuildsService,
        AppBuildPullTokenService,
    ],
    exports: [
        AppBuildRepository,
        AppBuildPreparationRepository,
        AppBuildsService,
        AppBuildPullTokenService,
    ],
})
export class AppBuildsModule {}
