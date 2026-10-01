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
 * - `AppEnvModule`, added 2026-09-22, for the one seam below. The import is
 *   one-way: `AppEnvModule` does not import this module, so the graph stays a DAG.
 *
 * ## The two seams this module DOES bind
 *
 * `APP_DEPENDENCY_CONFIG_CIPHER` → `{ useExisting: AppEnvCrypto }`, the swap
 * `app-dependencies.service.ts:297` documents. An earlier revision of this
 * docstring said `AppEnvCrypto` did not exist in this tree — it does, in
 * `app-env/app-env-crypto.ts`, and it is exported by `AppEnvModule`. Until this
 * binding landed, every `configure` call and every stored dependency output was
 * refused `secureStorageUnavailable` on an installation that had a key.
 *
 * `APP_DEPENDENCIES_SERVICE` → `{ useExisting: AppDependenciesService }` — the
 * token APW-06 declares (`app-runtime-deletion.service.ts:388`) and three of its
 * services inject: the Deploy preconditions' `ensureReadyForDeploy`, the
 * lifecycle removal ordering and the deletion task's kept-rows report. One
 * token, three structural views, one implementation.
 *
 * ## The seams this module still does NOT bind (and why that is deliberate)
 *
 * `APP_DEPENDENCY_SPEC_SOURCE`, `APP_DEPENDENCY_PROVISION_DISPATCHER` and
 * `APP_DEPENDENCY_CLUSTER_ACCESS` are other owners' — APW-03's `AppSpecService`,
 * APW-07 T17's dispatcher and APW-06 T20's `AppRuntimeFacadeService`. None of
 * those exists in this tree, so none can be bound here without inventing it.
 * `AppDependenciesService` takes every one of them `@Optional()` and answers each
 * absence explicitly (`specUnavailable`, `dispatchUnavailable`, a `mayRemain`
 * report), so an unbound seam degrades into a named refusal rather than a silent
 * success. The bindings land with their owners — see the block at the foot of
 * `app-dependencies.service.ts` for the exact `useExisting` swap of each.
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WorkAppDependency } from '../entities/work-app-dependency.entity';
import { WorkAppDependencyRepository } from '../database/repositories/work-app-dependency.repository';
import { FacadesModule } from '../facades/facades.module';
import { AppEnvCrypto } from '../app-env/app-env-crypto';
import { AppEnvModule } from '../app-env/app-env.module';
import { APP_DEPENDENCIES_SERVICE } from '../app-runtime/app-runtime-deletion.service';
import { APP_DEPENDENCY_CONFIG_CIPHER, AppDependenciesService } from './app-dependencies.service';

@Module({
    imports: [TypeOrmModule.forFeature([WorkAppDependency]), FacadesModule, AppEnvModule],
    providers: [
        WorkAppDependencyRepository,
        AppDependenciesService,
        // The epic's ONE envelope, shared with env values: a second format
        // would be a second thing to rotate.
        { provide: APP_DEPENDENCY_CONFIG_CIPHER, useExisting: AppEnvCrypto },
        { provide: APP_DEPENDENCIES_SERVICE, useExisting: AppDependenciesService },
    ],
    exports: [
        AppDependenciesService,
        WorkAppDependencyRepository,
        APP_DEPENDENCY_CONFIG_CIPHER,
        APP_DEPENDENCIES_SERVICE,
    ],
})
export class AppDependenciesModule {}
