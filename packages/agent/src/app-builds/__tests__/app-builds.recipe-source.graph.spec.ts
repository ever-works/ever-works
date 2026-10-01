import { CacheModule } from '@nestjs/cache-manager';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ENTITIES } from '../../database/_entities-inventory';
import { PluginsModule } from '../../plugins/plugins.module';
import { AppEnvRuntimeSource } from '../../app-env/app-env-runtime.source';
import { AppDeployRequestModule } from '../../app-runtime/app-deploy-request.module';
import { AppBuildsModule } from '../app-builds.module';
import {
    APP_BUILD_RUNNER_RECIPE_SOURCE,
    type AppBuildRunnerRecipeSource,
} from '../app-builds.service';

/**
 * APW-05 §4.12 × APW-07 — the Builds module's value-free runner recipe finds
 * APW-07's `AppEnvRuntimeSource` in the graph the API composes.
 *
 * ## The defect this pins
 *
 * `APP_BUILD_RUNNER_RECIPE_SOURCE` is a `ModuleRef` factory that looks
 * `AppEnvRuntimeSource` up NON-strictly at call time (`app-builds.module.ts`), so it
 * finds the class in whichever module provides it — and only `AppRuntimeEnvModule`
 * does. No API module imported `AppRuntimeEnvModule`, so the lookup found nothing and
 * the factory answered "no recipe and nothing missing" for every verification Build:
 * a verification job would run with no env and never be blocked for an unset
 * required value.
 *
 * The API reaches `AppRuntimeEnvModule` through `AppDeployRequestModule` (imported by
 * the deploy, works and trigger-internal modules), which is why this graph is the two
 * agent modules the API imports side by side — the lookup is non-strict, so which
 * importer brings the class in does not matter, only that one does.
 *
 * Stood in: only the API root's infrastructure — the DataSource (in-memory sqlite
 * over `ENTITIES`), the global event emitter, the global cache and the global
 * `PluginsModule.forRoot()` (registered, never bootstrapped).
 */

/** A uuid that exists in no database: a Work with no App spec and no env rows. */
const WORK_ID = '00000000-0000-4000-8000-0000000000fc';

describe('AppBuildsModule — the runner recipe source in the graph the API composes', () => {
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
                AppBuildsModule,
                AppDeployRequestModule,
            ],
        }).compile();
    });

    afterAll(async () => {
        await moduleRef?.close();
    });

    it("finds APW-07's runtime source — the class the lazy lookup asks for is in the graph", () => {
        expect(moduleRef.get(AppEnvRuntimeSource, { strict: false })).toBeInstanceOf(
            AppEnvRuntimeSource,
        );
    });

    it('delegates the runner recipe to it, with the value-free runner context', async () => {
        const runtime = moduleRef.get(AppEnvRuntimeSource, { strict: false });
        const resolveEphemeral = jest.spyOn(runtime, 'resolveEphemeral');
        const recipes = moduleRef.get<AppBuildRunnerRecipeSource>(APP_BUILD_RUNNER_RECIPE_SOURCE, {
            strict: false,
        });

        try {
            const answer = await recipes.resolveEphemeral(WORK_ID, 'a'.repeat(40), {
                target: 'runner',
            });

            expect(resolveEphemeral).toHaveBeenCalledTimes(1);
            expect(resolveEphemeral).toHaveBeenCalledWith(WORK_ID, 'a'.repeat(40), {
                target: 'runner',
                primaryUrl: null,
                primaryHost: null,
                buildCommitSha: null,
                internalUrls: {},
            });
            // A recipe, never a value (§4.6.1:447): the runner branch has no
            // `values` key at all.
            expect(answer).not.toHaveProperty('values');
        } finally {
            resolveEphemeral.mockRestore();
        }
    });
});
