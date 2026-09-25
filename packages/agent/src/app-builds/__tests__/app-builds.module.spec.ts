import { Test } from '@nestjs/testing';
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { DistributedTaskLockService } from '../../cache/distributed-task-lock.service';
import { ENTITIES } from '../../database/_entities-inventory';
import { AppBuildPreparationRepository } from '../../database/repositories/app-build-preparation.repository';
import { AppBuildRepository } from '../../database/repositories/app-build.repository';
import { WorkBuild } from '../../entities/work-build.entity';
import { WorkBuildPreparation } from '../../entities/work-build-preparation.entity';
import { AppBuildPrepareRunner, APP_BUILD_PREPARE_JOB_ID } from '../app-build-prepare.runner';
import { AppBuildsModule } from '../app-builds.module';
import {
    APP_BUILD_WATCH_RUNNER,
    APP_BUILD_PREPARE_RUNNER,
    AppBuildsService,
} from '../app-builds.service';
import { AppBuildWatchRunner } from '../app-build-watch.runner';
import { AppBuildSweepService } from '../app-build-sweep.service';

/**
 * APW-05 T19 — the Builds module, pinned against a REAL Nest container.
 *
 * ## Why this spec exists at all
 *
 * Rule: a DI failure is invisible to unit specs (they construct classes by hand)
 * and to `type-check`, and it has taken this API down before. T19's own spec
 * constructs `AppBuildPrepareRunner` by hand, so nothing else in the tree proves
 * the module can MINT it — and the binding T19 adds is the load-bearing half of
 * §7.1's null-dispatch fallback: with `APP_BUILD_PREPARE_RUNNER` unresolvable,
 * `AppBuildsService.dispatchPrepare` returns `false`, runs nothing, and leaves
 * every requested Build `queued` forever behind one log line.
 *
 * Three things are asserted against a live in-memory DataSource:
 *
 *  1. `TypeOrmModule.forFeature([WorkBuild, WorkBuildPreparation])` really
 *     registers both tables (`no such table` is what a missing `forFeature`
 *     answers, exactly as `AppWorksModule`'s spec records for its own entity);
 *  2. `AppBuildPrepareRunner` and `DistributedTaskLockService` are both
 *     CONSTRUCTED in the container — the runner eagerly, so a broken optional
 *     graph fails here rather than at the first dispatch;
 *  3. the token's `ModuleRef` factory answers an object with a working `run`,
 *     and calling it end-to-end (through the same path the fallback takes)
 *     reaches the runner and comes back with the named
 *     `workUnavailable` skip — which is this graph's honest answer, because
 *     `APP_BUILD_WORK_SOURCE` is unbound here by design.
 *
 * The lock is NOT stubbed, unlike `AppWorksModule`'s spec: this module provides
 * `DistributedTaskLockService` locally, so a real `cache_entries` round-trip is
 * part of what is being proven.
 */

/** A uuid that exists in no database. */
const WORK_ID = '00000000-0000-4000-8000-0000000000fe';

describe('AppBuildsModule', () => {
    /** A provider entry is either a class or `{ provide, useFactory, inject }`. */
    const tokenOf = (provider: unknown): unknown =>
        typeof provider === 'function'
            ? provider
            : (provider as { provide?: unknown } | null)?.provide;

    const metadata = (key: string): unknown[] =>
        (Reflect.getMetadata(key, AppBuildsModule) as unknown[]) ?? [];

    it('provides and exports the prepare runner, and binds its token to a factory', () => {
        expect(metadata('providers')).toContain(AppBuildPrepareRunner);
        expect(metadata('exports')).toContain(AppBuildPrepareRunner);
        // The token is bound by a `ModuleRef` factory, never by
        // `useExisting: AppBuildPrepareRunner`: the runner injects
        // `AppBuildsService`, which injects this very token, so an alias would be
        // a provider cycle Nest refuses to bootstrap.
        const binding = metadata('providers').find(
            (provider) => tokenOf(provider) === APP_BUILD_PREPARE_RUNNER,
        ) as { useExisting?: unknown; useFactory?: unknown } | undefined;
        expect(binding).toBeDefined();
        expect(typeof binding?.useFactory).toBe('function');
        expect(binding?.useExisting).toBeUndefined();
    });

    it('provides and exports the watch runner, and binds its token the same way', () => {
        // APW-05 T20 + C17 — the watch half of the same pair. Without this binding
        // `dispatchWatch`'s `this.watchRunner?.run(...)` is `undefined?.run(...)`: the
        // fallback is skipped, the Build is never observed by this process, and the
        // sweep re-offers it later — which is why the defect is invisible rather than
        // loud. The binding is asserted here as well as in the controller spec because
        // the two halves fail independently.
        expect(metadata('providers')).toContain(AppBuildWatchRunner);
        expect(metadata('exports')).toContain(AppBuildWatchRunner);
        const binding = metadata('providers').find(
            (provider) => tokenOf(provider) === APP_BUILD_WATCH_RUNNER,
        ) as { useExisting?: unknown; useFactory?: unknown } | undefined;
        expect(binding).toBeDefined();
        expect(typeof binding?.useFactory).toBe('function');
        expect(binding?.useExisting).toBeUndefined();
    });

    it('provides and exports the sweep service, so the API cron and the RPC channel can reach it', () => {
        // APW-05 T21 (first slice). `apps/api`'s `AppBuildSweepCronService` and the
        // trigger-internal controller's `remoteMap` both inject it from this module;
        // provided but not exported, both would resolve nothing.
        expect(metadata('providers')).toContain(AppBuildSweepService);
        expect(metadata('exports')).toContain(AppBuildSweepService);
    });

    it('registers both of the epic’s tables through TypeOrmModule.forFeature', () => {
        for (const entity of [WorkBuild, WorkBuildPreparation]) {
            const feature = metadata('imports').find((entry) =>
                ((entry as { providers?: unknown[] } | null)?.providers ?? []).some(
                    (provider) => tokenOf(provider) === getRepositoryToken(entity),
                ),
            );
            expect(feature).toBeDefined();
        }
    });

    it('constructs the runner and answers through the bound token against a real DataSource', async () => {
        const moduleRef = await Test.createTestingModule({
            imports: [
                TypeOrmModule.forRoot({
                    type: 'better-sqlite3',
                    database: ':memory:',
                    entities: ENTITIES,
                    synchronize: true,
                    logging: false,
                }),
                AppBuildsModule,
            ],
        }).compile();

        // (2) the container constructs the runner and the lock it holds.
        expect(moduleRef.get(AppBuildPrepareRunner)).toBeInstanceOf(AppBuildPrepareRunner);
        expect(moduleRef.get(DistributedTaskLockService)).toBeInstanceOf(
            DistributedTaskLockService,
        );

        // (1) both repositories resolve, and their tables exist — a `forFeature`
        // the DataSource never heard of throws "no such table" on this read.
        const preparations = moduleRef.get(AppBuildPreparationRepository);
        await expect(preparations.findByWork(WORK_ID)).resolves.toBeNull();
        const builds = moduleRef.get(AppBuildRepository);
        await expect(
            builds.findPage(WORK_ID, { status: ['queued'] }, 1, 20),
        ).resolves.toMatchObject({ rows: [], total: 0 });
        expect(moduleRef.get(AppBuildsService)).toBeInstanceOf(AppBuildsService);

        // T21 — the sweep composes from this module alone (its four collaborators
        // are all provided here), and a tick over the empty table runs both passes
        // under the real `app-builds:sweep` lock and finds nothing to do.
        const sweeps = moduleRef.get(AppBuildSweepService);
        expect(sweeps).toBeInstanceOf(AppBuildSweepService);
        await expect(sweeps.runSweep()).resolves.toMatchObject({
            skipped: null,
            passesFailed: 0,
            redriveRequested: 0,
            lostMarked: 0,
        });

        // (3) the fallback's own entry point: the token, then `run` on whatever
        // it answered — the ModuleRef lookup happens at call time, which is what
        // proves the de-cycling works in a real container.
        const runner = moduleRef.get(APP_BUILD_PREPARE_RUNNER) as {
            run(payload: { workId: string; reason: string }): Promise<unknown>;
        };
        expect(typeof runner.run).toBe('function');

        await expect(runner.run({ workId: WORK_ID, reason: 'specApplied' })).resolves.toEqual({
            status: 'skipped',
            jobId: APP_BUILD_PREPARE_JOB_ID,
            workId: WORK_ID,
            // The lock resolved (otherwise this would be `lockUnavailable`), and
            // `APP_BUILD_WORK_SOURCE` is unbound in this graph: the runner names
            // that rather than writing a row it cannot justify.
            reason: 'workUnavailable',
            passes: 1,
            coalesced: false,
            prepared: false,
            workflowState: null,
            secretsSynced: false,
            buildsDispatched: 0,
            buildsBlocked: 0,
            error: null,
        });

        await moduleRef.close();
    });

    it('resolves the watch runner through its bound token against a real DataSource', async () => {
        const moduleRef = await Test.createTestingModule({
            imports: [
                TypeOrmModule.forRoot({
                    type: 'better-sqlite3',
                    database: ':memory:',
                    entities: ENTITIES,
                    synchronize: true,
                    logging: false,
                }),
                AppBuildsModule,
            ],
        }).compile();

        expect(moduleRef.get(AppBuildWatchRunner)).toBeInstanceOf(AppBuildWatchRunner);

        const watch = moduleRef.get(APP_BUILD_WATCH_RUNNER) as {
            run(payload: { buildId: string; reason: string }): Promise<Record<string, unknown>>;
        };
        expect(typeof watch.run).toBe('function');

        // The same shape of proof the prepare runner gets: the ModuleRef lookup happens at
        // CALL time, so this line is what shows the de-cycling works in a real container —
        // and the answer is the runner's own fail-closed one rather than a thrown cycle.
        const watched = await watch.run({
            buildId: '00000000-0000-4000-8000-000000000001',
            reason: 'event',
        });
        expect(watched.status).toBe('skipped');
        expect(watched.reason).toBe('buildUnavailable');

        await moduleRef.close();
    });
});

describe('app-builds barrel', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const barrel = require('../index');

    it('re-exports the module, the class and the ports an importer needs', () => {
        expect(barrel.AppBuildsModule).toBe(AppBuildsModule);
        // The CLASS wins the one collision with T17's provisional PORT of the
        // same name (`app-builds.service.ts:143-149`), which stays reachable from
        // that module — `export *` from both is a TS2308 ambiguity.
        expect(barrel.AppBuildPrepareRunner).toBe(AppBuildPrepareRunner);
        expect(barrel.APP_BUILD_PREPARE_RUNNER).toBe(APP_BUILD_PREPARE_RUNNER);
        expect(typeof barrel.selectBuildRunner).toBe('function');
        expect(typeof barrel.unionMinusRemoved).toBe('function');
        // T21's first slice — what `apps/api` imports by name.
        expect(barrel.AppBuildSweepService).toBe(AppBuildSweepService);
        expect(barrel.APP_BUILD_SWEEP_LOCK_KEY).toBe('app-builds:sweep');
    });
});
