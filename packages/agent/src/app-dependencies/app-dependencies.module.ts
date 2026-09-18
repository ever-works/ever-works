/**
 * APW-07 T16 — the App dependencies module.
 *
 * What it binds, and nothing more:
 *
 * - `WorkAppDependency` through `TypeOrmModule.forFeature`, so `AppDependenciesService` can create
 *   the `pending`/`awaiting_config` row it is about to dispatch (T8's docstring reserves creation
 *   for `reconcile`) and write the small row patches a transition needs.
 * - `WorkAppDependencyRepository` — feature-owned (T8): it is provided here and exported, NOT by
 *   `DatabaseModule`, which is why `_repository-inventory.ts` deliberately does not list it.
 * - `AppDependenciesService`, exported for APW-06 (its six entry points), APW-07 T17's runner and
 *   APW-07 T24/T25's routes.
 * - `FacadesModule`, for `AppDependencyFacadeService`: the ONE place a provider is selected and
 *   called. It is a leaf with respect to this module (nothing it imports imports this one), so the
 *   import cannot cycle.
 *
 * ## The seams this module does NOT bind (and why that is deliberate)
 *
 * `APP_DEPENDENCY_SPEC_SOURCE`, `APP_DEPENDENCY_PROVISION_DISPATCHER`,
 * `APP_DEPENDENCY_CONFIG_CIPHER` and `APP_DEPENDENCY_CLUSTER_ACCESS` are other owners' — APW-03's
 * `AppSpecService`, APW-07 T17's dispatcher, APW-07 T9's `AppEnvCrypto` and APW-06 T20's
 * `AppRuntimeFacadeService`. None of them exists in this tree yet, so none can be bound here
 * without inventing it. `AppDependenciesService` takes every one of them `@Optional()` and answers
 * each absence explicitly (`specUnavailable`, `dispatchUnavailable`, `secureStorageUnavailable`, a
 * `mayRemain` report), so an unbound seam degrades into a named refusal rather than a silent
 * success. The bindings land with their owners — see the block at the foot of
 * `app-dependencies.service.ts` for the exact `useExisting` swap of each.
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WorkAppDependency } from '../entities/work-app-dependency.entity';
import { WorkAppDependencyRepository } from '../database/repositories/work-app-dependency.repository';
import { FacadesModule } from '../facades/facades.module';
import { AppDependenciesService } from './app-dependencies.service';

@Module({
    imports: [TypeOrmModule.forFeature([WorkAppDependency]), FacadesModule],
    providers: [WorkAppDependencyRepository, AppDependenciesService],
    exports: [AppDependenciesService, WorkAppDependencyRepository],
})
export class AppDependenciesModule {}
