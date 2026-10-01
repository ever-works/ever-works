import { CacheModule } from '@nestjs/cache-manager';
import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { ENTITIES } from '../../database/_entities-inventory';
import { PluginsModule } from '../../plugins/plugins.module';
import { AppDependenciesService } from '../../app-dependencies/app-dependencies.service';
import { WorkAppDependency } from '../../entities/work-app-dependency.entity';
import { AppEnvRuntimeSource } from '../../app-env/app-env-runtime.source';
import { AppEnvListener } from '../../app-env/app-env.listener';
import { AppSpecAppliedEvent } from '../../events/app-spec-applied.event';
import { AppDeployPreconditionsService } from '../app-deploy-preconditions.service';
import { AppDeployRequestModule } from '../app-deploy-request.module';
import { AppLicenseGate } from '../app-license-gate';
import { AppSpecService } from '../../app-spec/app-spec.service';

/**
 * APW-06 §5.1 × APW-07 — the deploy preconditions' collaborators, COMPOSED.
 *
 * ## The defect this pins
 *
 * `AppDeployPreconditionsService` injects `APP_RUNTIME_ENV_SOURCE`,
 * `APP_DEPENDENCIES_SERVICE` and `AppLicenseGate`, each `@Optional()`. Nest
 * resolves a provider's dependencies in the module that DECLARES it, and that
 * module is `AppDeployRequestModule` — which imported neither APW-07 module
 * (`AppRuntimeEnvModule` binds the env source, `AppDependenciesModule` the
 * dependency service; neither is `@Global()`) and provided no license gate. No
 * other API module imported either APW-07 module at all. So in the running API
 * every one of the three was `undefined`: every Deploy that got past the
 * dispatcher gate was refused `env_source_unavailable`, no dependency was ever
 * judged or provisioned from a preflight, the licence was never read on the
 * request path, and `AppEnvListener` (provided only by `AppRuntimeEnvModule`)
 * never subscribed to `app.spec.applied`. Every unit spec passed, because each
 * constructs its subject by hand; the module's own spec checked only that the
 * services exist.
 *
 * `apps/api/src/app-works-di-reachability.spec.ts` finds the class of defect
 * across the whole API graph; this file pins these three by composing the module
 * for real.
 *
 * ## What is real and what is stood in
 *
 * Real: `AppDeployRequestModule` and every module it imports — including
 * `AppSpecModule` → `FacadesModule`, `AppRuntimeEnvModule` and
 * `AppDependenciesModule`. Stood in: only what the API ROOT registers — the
 * DataSource (in-memory sqlite over `ENTITIES` instead of Postgres), the global
 * event emitter, the global cache and the global `PluginsModule.forRoot()`
 * (registered, never bootstrapped: no plugin is loaded). Nothing is mocked.
 */

/** A uuid that exists in no database. */
const WORK_ID = '00000000-0000-4000-8000-0000000000fe';

type PreconditionCollaborators = {
    env?: unknown;
    dependencies?: unknown;
    licenseGate?: unknown;
};

describe('AppDeployRequestModule — the §5.1 collaborators as the API composes them', () => {
    let moduleRef: TestingModule;

    beforeAll(async () => {
        moduleRef = await Test.createTestingModule({
            imports: [
                TypeOrmModule.forRoot({
                    type: 'better-sqlite3',
                    database: ':memory:',
                    entities: ENTITIES,
                    synchronize: true,
                    logging: false,
                }),
                EventEmitterModule.forRoot(),
                CacheModule.register({ isGlobal: true }),
                PluginsModule.forRoot(),
                AppDeployRequestModule,
            ],
        }).compile();
        // Lifecycle hooks, so `EventEmitterModule` subscribes every `@OnEvent`
        // provider exactly as the API's bootstrap does.
        await moduleRef.init();
    });

    afterAll(async () => {
        await moduleRef?.close();
    });

    function preconditions(): PreconditionCollaborators {
        return moduleRef.get(AppDeployPreconditionsService, {
            strict: false,
        }) as unknown as PreconditionCollaborators;
    }

    it("hands the preconditions APW-07's env source — not `undefined` (env_source_unavailable)", () => {
        expect(preconditions().env).toBeDefined();
        expect(preconditions().env).toBeInstanceOf(AppEnvRuntimeSource);
    });

    it('hands the preconditions the dependency service (GAP-05 ensureReadyForDeploy)', () => {
        expect(preconditions().dependencies).toBeDefined();
        expect(preconditions().dependencies).toBeInstanceOf(AppDependenciesService);
    });

    it('hands the preconditions the license gate (§5.2 on the request path, FR-24)', () => {
        expect(preconditions().licenseGate).toBeDefined();
        expect(preconditions().licenseGate).toBeInstanceOf(AppLicenseGate);
    });

    it('is one dependency service for the whole graph — the env source reads the same one', () => {
        const env = preconditions().env as { readiness?: unknown };

        expect(env.readiness).toBe(preconditions().dependencies);
    });

    it('answers the dependency preflight fail-closed, writing and dispatching nothing, while its spec source is unbound', async () => {
        // What wiring the service turns on TODAY. `APP_DEPENDENCY_SPEC_SOURCE` is
        // APW-07 T25's to bind and is unwritten, so `reconcile` fails closed before
        // it creates a row or dispatches a provision. §5.1 step 9 refuses on that
        // answer (`dependency_not_ready`) only when the App spec DECLARES a
        // dependency; a spec declaring none is warned `dependencies_unavailable`
        // (review 2026-09-26 — it used to be refused too, as if a dependency were not
        // ready). Before this module imported the env and dependency modules, step 8
        // refused every Deploy with `env_source_unavailable`. When T25 lands this
        // answer changes on purpose: update this case in the same commit and say what
        // now passes.
        const dependencies = preconditions().dependencies as AppDependenciesService;
        const rows = moduleRef.get<Repository<WorkAppDependency>>(
            getRepositoryToken(WorkAppDependency),
            { strict: false },
        );

        await expect(dependencies.ensureReadyForDeploy(WORK_ID)).resolves.toEqual({
            ready: false,
            notReady: [],
            optional: [],
            reason: 'specUnavailable',
        });
        await expect(rows.count()).resolves.toBe(0);
    });

    it('subscribes AppEnvListener exactly once, on the emitter AppSpecService emits app.spec.applied on', () => {
        // The producer's own bus, not `get(EventEmitter2)`: the global
        // `PluginsModule` provides (without exporting) a second, private
        // `EventEmitter2`, and a non-strict lookup can answer that one.
        const producer = moduleRef.get(AppSpecService, { strict: false }) as unknown as {
            events?: EventEmitter2;
        };

        expect(moduleRef.get(AppEnvListener, { strict: false })).toBeInstanceOf(AppEnvListener);
        expect(producer.events).toBeInstanceOf(EventEmitter2);
        expect(producer.events?.listeners(AppSpecAppliedEvent.EVENT_NAME)).toHaveLength(1);
    });
});
