import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { WorkAppRuntimeState } from '../entities/work-app-runtime-state.entity';
import { Work } from '../entities/work.entity';
import { WorkAppRuntimeStateRepository } from '../database/repositories/work-app-runtime-state.repository';
import { WORK_APP_RUNTIME_STATES } from '../app-launcher/app-launcher.service';

/**
 * APW-06 T17 — the module that finally **binds** `WORK_APP_RUNTIME_STATES`.
 *
 * ## What this fixes
 *
 * Twelve services inject that token and, until 2026-09-21, nothing provided it
 * anywhere in the tree (`grep 'provide: WORK_APP_RUNTIME_STATES'` → zero hits;
 * the only two modules that mentioned it did so in prose explaining that they
 * deliberately do not bind it). Every injection site is `@Optional()`, so the
 * API booted perfectly and the feature was simply inert:
 * `AppDeployRequestService.requestDeploy` short-circuited with
 * `503 app_deploy_state_unavailable` before the lock claim, so no App Work could
 * be deployed at all.
 *
 * ## Why a module of its own, and a small one
 *
 * The consumers are spread across APW-06, APW-10 and APW-11 and live in
 * different graphs; several of their own modules are not written yet. A single
 * focused module that owns the table, the repository and the token can be
 * imported by each consumer's module as that module lands, without any of them
 * having to know about the others — and without `DatabaseModule` growing a
 * feature-owned repository, which `_repository-inventory.ts` explains it must
 * not (the same posture `AppWorksModule` takes for
 * `WorkUpstreamStateRepository`).
 *
 * ## `forFeature` is declared HERE, not in a parent
 *
 * Nest resolves a provider in the context of the module that **declares** it, so
 * a parent importing `TypeOrmModule.forFeature([...])` alongside this module is
 * not enough. That exact mistake broke the API boot twice on this branch
 * (`AppLauncherService` / `AppSpecModule` missing `DatabaseModule`, then T26's
 * CORS middleware) and both are recorded as paid-for traps. `Work` is registered
 * too, because FR-63's target derivation reads the Work's `deployProvider`.
 *
 * ## The token is bound with `useExisting`, not `useClass`
 *
 * One instance, two names. `useClass` would construct a **second**
 * `WorkAppRuntimeStateRepository`, and the two would hold separate TypeORM
 * repository handles — harmless today, and exactly the kind of thing that stops
 * being harmless the moment anything here caches.
 */
@Module({
    imports: [TypeOrmModule.forFeature([WorkAppRuntimeState, Work])],
    providers: [
        WorkAppRuntimeStateRepository,
        { provide: WORK_APP_RUNTIME_STATES, useExisting: WorkAppRuntimeStateRepository },
    ],
    exports: [WorkAppRuntimeStateRepository, WORK_APP_RUNTIME_STATES, TypeOrmModule],
})
export class AppRuntimeStateModule {}
