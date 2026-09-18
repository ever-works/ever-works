/**
 * APW-03 T12 — the App spec module.
 *
 * What it binds, and nothing more:
 *
 * - `WorkAppSpecState` through `TypeOrmModule.forFeature`, so the feature-owned
 *   repository below can be constructed. The table itself is created by T9/T10's
 *   migration (`apps/api/src/migrations/1792030000000-CreateWorkAppSpecStates.ts`);
 *   `DatabaseModule` already `forFeature`s every entity in `ENTITIES`, and the
 *   explicit `forFeature` here is the epic's own declaration that this module
 *   owns the row (as `AppEnvModule` and `AppDependenciesModule` each do).
 * - `WorkAppSpecStateRepository` (T11) — feature-owned: provided here and
 *   exported, NOT by `DatabaseModule`, which is why `_repository-inventory.ts`
 *   deliberately does not list it.
 * - `DistributedTaskLockService` — the per-Work lock `AppSpecService.evaluate`
 *   holds (`app-spec-evaluate:<workId>`, plan §2.3:178). It needs
 *   `@InjectRepository(CacheEntry)`, which `DatabaseModule` exports, and it is
 *   provided locally exactly as `CommunityPrModule` provides it.
 * - `AppSpecService` (T12), exported for APW-01's create/initialise path, APW-04's
 *   `validateDraft`, APW-05/06's `getEffectiveSpec`, APW-07's
 *   `APP_ENV_SPEC_SOURCE` adapter and T14/T15's job and routes.
 * - `FacadesModule`, for `GitFacadeService` — the one read of the user's
 *   repository (FR-15). It is a leaf with respect to this module, so the import
 *   cannot cycle.
 * - `ActivityLogModule`, for the three `actionType: APP_SPEC` rows R-34 requires
 *   (`app.spec.validated` / `app.spec.invalid` / `app.spec.applied`, R-2).
 *
 * ## The seams this module does NOT bind (and why that is deliberate)
 *
 * `APP_SPEC_EVALUATE_DISPATCHER` is the job runtime's — `packages/tasks`'s
 * `TriggerModule` binds it through `buildJobRuntimeProviders()`
 * (`packages/agent/src/tasks/job-runtime.providers.ts`). It is unbound in a graph
 * that does not import that module, and `AppSpecService` answers that absence
 * with the documented in-process path (plan §6.1:661-662) rather than a dropped
 * job — which is also FR-90's requirement that the evaluation, its writes and its
 * in-process events happen in the API process.
 *
 * `APP_SPEC_TELEMETRY_SINK` (plan §9.1:802-804) and the licence evaluation
 * (`APP_LICENSE_EVALUATE_DISPATCHER`, §2.3:185-186) are other tasks' — see
 * `app-spec.service.ts`'s docstring for the exact reason each is absent.
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DatabaseModule } from '../database/database.module';
import { WorkAppSpecState } from '../entities/work-app-spec-state.entity';
import { WorkAppSpecStateRepository } from '../database/repositories/work-app-spec-state.repository';
import { DistributedTaskLockService } from '../cache/distributed-task-lock.service';
import { ActivityLogModule } from '../activity-log/activity-log.module';
import { FacadesModule } from '../facades/facades.module';
import { AppSpecService } from './app-spec.service';

@Module({
    imports: [
        DatabaseModule,
        TypeOrmModule.forFeature([WorkAppSpecState]),
        FacadesModule,
        ActivityLogModule,
    ],
    providers: [WorkAppSpecStateRepository, DistributedTaskLockService, AppSpecService],
    exports: [AppSpecService, WorkAppSpecStateRepository],
})
export class AppSpecModule {}
