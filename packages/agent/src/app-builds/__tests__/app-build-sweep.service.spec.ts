import { DataSource } from 'typeorm';
import {
    APP_BUILD_ADOPT_WINDOW_MS,
    APP_BUILD_LOST_GRACE_MINUTES,
    APP_BUILD_POLL_AFTER_SILENCE_MS,
    APP_BUILD_SWEEP_CRON,
    computeBuildInputsHash,
    type AppSpec,
} from '@ever-works/contracts';
import type { BuildRepositoryRef, PrepareRepositoryResult } from '@ever-works/plugin';
import type { AppEnvResolver } from '../../app-env/app-env.resolver';
import { DistributedTaskLockService } from '../../cache/distributed-task-lock.service';
import { ENTITIES } from '../../database/_entities-inventory';
import { AppBuildPreparationRepository } from '../../database/repositories/app-build-preparation.repository';
import { AppBuildRepository } from '../../database/repositories/app-build.repository';
import { CacheEntry } from '../../entities/cache.entity';
import { WorkBuild } from '../../entities/work-build.entity';
import { WorkBuildPreparation } from '../../entities/work-build-preparation.entity';
import {
    AppBuildPrepareRunner,
    type AppBuildPreparePluginBinding,
} from '../app-build-prepare.runner';
import {
    APP_BUILD_REDRIVE_ATTEMPTS,
    APP_BUILD_REDRIVE_MAX_AGE_MS,
    APP_BUILD_REDRIVE_MIN_AGE_MS,
    APP_BUILD_SWEEP_INTERVAL_MS,
    APP_BUILD_SWEEP_LOCK_KEY,
    APP_BUILD_SWEEP_LOCK_TTL_MS,
    AppBuildSweepService,
} from '../app-build-sweep.service';
import {
    APP_BUILD_PREPARE_REASONS,
    AppBuildsService,
    type AppBuildSpecRead,
    type AppBuildSpecSource,
    type AppBuildWorkContext,
} from '../app-builds.service';

/**
 * APW-05 T21, first slice — `AppBuildSweepService`: the re-drive of requested
 * Builds nothing dispatched (§9.2) and the never-adopted half of §7.4's `lost`
 * rule.
 *
 * The Builds live in a REAL in-memory better-sqlite3 table read through the real
 * `AppBuildRepository`, because the two properties that matter most are window
 * arithmetic — "exactly three re-drives" and "lost one millisecond after the
 * deadline, never at it" — and they are only honest when the SQL that bounds the
 * window is the SQL production runs. `AppBuildsService` is a recording double in
 * the unit cases (the sweep's contract with it is two calls: `requestPrepare` and
 * `finalize`); the last block wires the REAL service, the REAL prepare runner and
 * the REAL lock over the same table to prove the defect end to end: a Build whose
 * prepare failed stays `queued` with nothing to move it, and one sweep tick
 * starts it.
 */

const WORK_A = '11111111-1111-4111-8111-111111111111';
const WORK_B = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const SHA = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const TRACKED = 'main';
const PLUGIN_ID = 'github-actions-build';

/** A fixed "now" so every window is exact, never wall-clock flaky. */
const NOW = Date.parse('2026-03-01T06:00:00.000Z');
const SECOND = 1_000;
const MINUTE = 60_000;

/** An App spec whose `build.resources.timeoutMinutes` is `minutes`. */
function specWithTimeout(minutes: number | undefined): AppSpec {
    return {
        kind: 'app',
        appSpecVersion: 1,
        display: { name: 'Shop' },
        build: {
            strategy: 'dockerfile',
            dockerfile: 'Dockerfile',
            context: '.',
            args: [{ name: 'DATABASE_URL', fromEnv: 'DATABASE_URL' }],
            resources:
                minutes === undefined
                    ? { cpu: 2, memory: '2Gi' }
                    : { cpu: 2, memory: '2Gi', timeoutMinutes: minutes },
        },
        components: [{ name: 'web', role: 'web', port: 3000 }],
        checks: [],
    } as AppSpec;
}

function specRead(spec: AppSpec | null, commitSha: string | null = SHA): AppBuildSpecRead {
    return { spec, commitSha, specHash: 'f'.repeat(64), valid: true };
}

describe('AppBuildSweepService', () => {
    let dataSource: DataSource;
    let repository: AppBuildRepository;

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
            logging: false,
        });
        await dataSource.initialize();
        repository = new AppBuildRepository(dataSource.getRepository(WorkBuild));
    });

    afterAll(async () => {
        await dataSource.destroy();
    });

    beforeEach(async () => {
        // The owning Work row is not what is under test; the FK itself is
        // asserted by the migration spec, exactly as the repository spec says.
        await dataSource.query('PRAGMA foreign_keys = OFF');
        await dataSource.getRepository(WorkBuild).clear();
        await dataSource.getRepository(WorkBuildPreparation).clear();
        await dataSource.getRepository(CacheEntry).clear();
    });

    /** Insert a Build directly, so a case can start from any stored state. */
    let nextNumber = 1;
    function seedBuild(
        overrides: Partial<WorkBuild> & { readonly workId: string },
    ): Promise<WorkBuild> {
        const rows = dataSource.getRepository(WorkBuild);
        return rows.save(
            rows.create({
                number: nextNumber++,
                buildPluginId: PLUGIN_ID,
                status: 'queued',
                trigger: 'manual',
                branch: TRACKED,
                commitSha: SHA,
                ...overrides,
            }),
        );
    }

    /** Re-read a row from the database, never from the object a method returned. */
    function stored(id: string): Promise<WorkBuild> {
        return dataSource.getRepository(WorkBuild).findOneOrFail({ where: { id } });
    }

    /* ---------------------------------------------------------------------- *
     * The unit harness — a recording AppBuildsService and a recording lock
     * ---------------------------------------------------------------------- */

    interface UnitHarness {
        readonly sweeps: AppBuildSweepService;
        readonly service: { requestPrepare: jest.Mock; finalize: jest.Mock };
        readonly specs: { read: jest.Mock };
        readonly lock: {
            runExclusive: jest.Mock;
            held: boolean;
        };
    }

    function unit(
        options: { specs?: AppBuildSpecSource | null; locks?: 'none' } = {},
    ): UnitHarness {
        const service = {
            requestPrepare: jest.fn(async () => ({ prepareSeq: 1, dispatched: true })),
            finalize: jest.fn(async (buildId: string) => ({
                finalized: true,
                reason: 'finalized',
                build: { id: buildId },
                deployable: false,
                notDeployableReason: null,
            })),
        };
        const specs = {
            read: jest.fn(
                async (): Promise<AppBuildSpecRead | null> => specRead(specWithTimeout(60)),
            ),
        };
        const lock = {
            held: false,
            runExclusive: jest.fn(
                async (
                    _key: string,
                    fn: () => Promise<unknown>,
                    opts?: { onLocked?: () => void },
                ) => {
                    if (lock.held) {
                        opts?.onLocked?.();
                        return { acquired: false };
                    }
                    return { acquired: true, result: await fn() };
                },
            ),
        };
        const sweeps = new AppBuildSweepService(
            repository,
            service as unknown as AppBuildsService,
            options.locks === 'none' ? undefined : (lock as unknown as DistributedTaskLockService),
            options.specs === null ? undefined : ((options.specs ?? specs) as AppBuildSpecSource),
        );
        return { sweeps, service, specs, lock };
    }

    /* ---------------------------------------------------------------------- *
     * The window
     * ---------------------------------------------------------------------- */

    describe('the re-drive window (§9.2 "3 times")', () => {
        it('is three sweep intervals long, opening at the 90 s silence', () => {
            // The sweep runs on `*/2 * * * *`; the interval constant must be that
            // cron's period, or "three ticks in the window" is no longer three.
            expect(APP_BUILD_SWEEP_CRON).toBe('*/2 * * * *');
            expect(APP_BUILD_SWEEP_INTERVAL_MS).toBe(120_000);
            expect(APP_BUILD_REDRIVE_ATTEMPTS).toBe(3);
            expect(APP_BUILD_REDRIVE_MIN_AGE_MS).toBe(APP_BUILD_POLL_AFTER_SILENCE_MS);
            expect(APP_BUILD_REDRIVE_MAX_AGE_MS).toBe(90_000 + 3 * 120_000);
        });

        it('adds `sweep` to the prepare reasons', () => {
            expect(APP_BUILD_PREPARE_REASONS).toContain('sweep');
        });
    });

    /* ---------------------------------------------------------------------- *
     * Pass A — the re-drive
     * ---------------------------------------------------------------------- */

    describe('re-drive of requested Builds nothing dispatched', () => {
        it('asks for one prepare of the stuck Build’s Work, with the reason `sweep`', async () => {
            const h = unit();
            await seedBuild({ workId: WORK_A, queuedAt: new Date(NOW - 91 * SECOND) });

            const summary = await h.sweeps.sweep(NOW);

            expect(h.service.requestPrepare).toHaveBeenCalledTimes(1);
            expect(h.service.requestPrepare).toHaveBeenCalledWith(WORK_A, 'sweep');
            expect(summary).toMatchObject({
                skipped: null,
                redriveBuilds: 1,
                redriveWorks: 1,
                redriveRequested: 1,
                redriveFailed: 0,
            });
        });

        it('asks once per Work, however many of its Builds are stuck', async () => {
            const h = unit();
            await seedBuild({ workId: WORK_A, queuedAt: new Date(NOW - 100 * SECOND) });
            await seedBuild({
                workId: WORK_A,
                trigger: 'verification',
                queuedAt: new Date(NOW - 200 * SECOND),
            });

            await h.sweeps.sweep(NOW);
            expect(h.service.requestPrepare.mock.calls).toEqual([[WORK_A, 'sweep']]);

            h.service.requestPrepare.mockClear();
            await seedBuild({ workId: WORK_B, queuedAt: new Date(NOW - 150 * SECOND) });

            const summary = await h.sweeps.sweep(NOW);

            expect(h.service.requestPrepare.mock.calls).toEqual([
                [WORK_A, 'sweep'],
                [WORK_B, 'sweep'],
            ]);
            expect(summary).toMatchObject({
                redriveBuilds: 3,
                redriveWorks: 2,
                redriveRequested: 2,
            });
        });

        it('re-drives a stuck Build on exactly three two-minute ticks, then leaves it', async () => {
            // Pins §9.2's "3 times": a half-open window three intervals long holds
            // exactly three ticks, whatever their phase. Widening the window by one
            // millisecond (451 s) gives this Build a fourth request.
            const h = unit();
            const queuedAt = NOW - 10 * MINUTE;
            await seedBuild({ workId: WORK_A, queuedAt: new Date(queuedAt) });

            const counts: number[] = [];
            for (const age of [89, 90, 210, 330, 450, 570]) {
                await h.sweeps.sweep(queuedAt + age * SECOND);
                counts.push(h.service.requestPrepare.mock.calls.length);
            }

            // 89 s: not yet silent. 90, 210, 330 s: the three re-drives. 450 s
            // and later: the window is closed.
            expect(counts).toEqual([0, 1, 2, 3, 3, 3]);
        });

        it('never re-drives a Build the runner already claimed or dispatched', async () => {
            const h = unit();
            await seedBuild({
                workId: WORK_A,
                queuedAt: new Date(NOW - 120 * SECOND),
                dispatchedAt: new Date(NOW - 110 * SECOND),
            });

            await h.sweeps.sweep(NOW);

            expect(h.service.requestPrepare).not.toHaveBeenCalled();
        });

        it('still re-drives Work B when the request for Work A rejects', async () => {
            const h = unit();
            await seedBuild({ workId: WORK_A, queuedAt: new Date(NOW - 300 * SECOND) });
            await seedBuild({ workId: WORK_B, queuedAt: new Date(NOW - 100 * SECOND) });
            h.service.requestPrepare.mockRejectedValueOnce(new Error('database is locked'));

            const summary = await h.sweeps.sweep(NOW);

            expect(h.service.requestPrepare.mock.calls).toEqual([
                [WORK_A, 'sweep'],
                [WORK_B, 'sweep'],
            ]);
            expect(summary).toMatchObject({ redriveRequested: 1, redriveFailed: 1 });
        });

        it('a failed read of one pass does not stop the other', async () => {
            const h = unit();
            await seedBuild({ workId: WORK_A, queuedAt: new Date(NOW - 200 * MINUTE) });
            const read = jest
                .spyOn(repository, 'findUndispatchedRequested')
                .mockRejectedValueOnce(new Error('connection reset'));

            try {
                const summary = await h.sweeps.sweep(NOW);

                expect(summary.passesFailed).toBe(1);
                // The lost pass still ran and failed the 200-minute-old Build.
                expect(summary.lostMarked).toBe(1);
            } finally {
                read.mockRestore();
            }
        });
    });

    /* ---------------------------------------------------------------------- *
     * Pass B — never-adopted Builds failed as `lost`
     * ---------------------------------------------------------------------- */

    describe('never-adopted Builds failed as lost (§7.4: queuedAt + 5 min + timeoutMinutes + 30)', () => {
        /** `queuedAt + 5 min + T + 30 min` for a Build queued at `queuedAt`. */
        const deadline = (queuedAt: number, minutes: number) =>
            queuedAt +
            APP_BUILD_ADOPT_WINDOW_MS +
            (minutes + APP_BUILD_LOST_GRACE_MINUTES) * MINUTE;

        it('leaves a 60-minute Build alone at +95 min, and fails it once 1 ms later', async () => {
            const h = unit();
            const queuedAt = NOW - 3 * 60 * MINUTE;
            const build = await seedBuild({ workId: WORK_A, queuedAt: new Date(queuedAt) });
            expect(deadline(queuedAt, 60)).toBe(queuedAt + 95 * MINUTE);

            const atDeadline = await h.sweeps.sweep(queuedAt + 95 * MINUTE);

            expect(atDeadline.lostMarked).toBe(0);
            expect((await stored(build.id)).status).toBe('queued');
            expect(h.service.finalize).not.toHaveBeenCalled();
            expect(h.specs.read).toHaveBeenCalledWith(WORK_A, SHA);

            const after = await h.sweeps.sweep(queuedAt + 95 * MINUTE + 1);

            const row = await stored(build.id);
            expect(row.status).toBe('failed');
            expect(row.failureClass).toBe('lost');
            expect(row.completedAt?.getTime()).toBe(queuedAt + 95 * MINUTE + 1);
            expect(h.service.finalize.mock.calls).toEqual([[build.id]]);
            expect(after).toMatchObject({ lostCandidates: 1, lostMarked: 1, lostFinalized: 1 });
        });

        it('reads a 5-minute timeout: untouched at +40 min, lost 1 ms later', async () => {
            const h = unit();
            h.specs.read.mockResolvedValue(specRead(specWithTimeout(5)));
            const queuedAt = NOW - 3 * 60 * MINUTE;
            const build = await seedBuild({ workId: WORK_A, queuedAt: new Date(queuedAt) });

            await h.sweeps.sweep(queuedAt + 40 * MINUTE);
            expect((await stored(build.id)).status).toBe('queued');

            await h.sweeps.sweep(queuedAt + 40 * MINUTE + 1);
            expect((await stored(build.id)).status).toBe('failed');
            expect(h.service.finalize).toHaveBeenCalledTimes(1);
        });

        it('defaults to 60 minutes when the spec cannot be read, is absent, or has no timeout', async () => {
            for (const answer of [
                () => Promise.reject(new Error('spec source down')),
                () => Promise.resolve(null),
                () => Promise.resolve(specRead(null)),
                () => Promise.resolve(specRead(specWithTimeout(undefined))),
            ]) {
                await dataSource.getRepository(WorkBuild).clear();
                const h = unit();
                h.specs.read.mockImplementation(answer);
                const queuedAt = NOW - 5 * 60 * MINUTE;
                const build = await seedBuild({ workId: WORK_A, queuedAt: new Date(queuedAt) });

                await h.sweeps.sweep(queuedAt + 95 * MINUTE);
                expect((await stored(build.id)).status).toBe('queued');

                await h.sweeps.sweep(queuedAt + 95 * MINUTE + 1);
                expect((await stored(build.id)).status).toBe('failed');
            }
        });

        it('defaults to 60 minutes when no spec source is bound', async () => {
            const h = unit({ specs: null });
            const queuedAt = NOW - 5 * 60 * MINUTE;
            const build = await seedBuild({ workId: WORK_A, queuedAt: new Date(queuedAt) });

            await h.sweeps.sweep(queuedAt + 95 * MINUTE);
            expect((await stored(build.id)).status).toBe('queued');

            await h.sweeps.sweep(queuedAt + 95 * MINUTE + 1);
            expect((await stored(build.id)).status).toBe('failed');
        });

        it('clamps a declared timeout to the schema’s 5–180 minutes', async () => {
            const h = unit();
            h.specs.read.mockResolvedValue(specRead(specWithTimeout(500)));
            const queuedAt = NOW - 10 * 60 * MINUTE;
            const build = await seedBuild({ workId: WORK_A, queuedAt: new Date(queuedAt) });

            await h.sweeps.sweep(deadline(queuedAt, 180));
            expect((await stored(build.id)).status).toBe('queued');

            await h.sweeps.sweep(deadline(queuedAt, 180) + 1);
            expect((await stored(build.id)).status).toBe('failed');
        });

        it('reads the spec once per Work and commit in one tick', async () => {
            const h = unit();
            const queuedAt = NOW - 3 * 60 * MINUTE;
            await seedBuild({ workId: WORK_A, queuedAt: new Date(queuedAt) });
            await seedBuild({ workId: WORK_A, queuedAt: new Date(queuedAt + SECOND) });
            await seedBuild({
                workId: WORK_A,
                commitSha: SHA_B,
                queuedAt: new Date(queuedAt + 2 * SECOND),
            });

            await h.sweeps.sweep(NOW);

            expect(h.specs.read.mock.calls).toEqual([
                [WORK_A, SHA],
                [WORK_A, SHA_B],
            ]);
        });

        it('never finalizes a Build this pass did not move (a racing terminal write)', async () => {
            // `finalize` is not claim-guarded against a concurrent finalize, so the
            // pass may only finalize the rows ITS `markLost` moved: a Build that
            // finished between the read and the UPDATE is finalized by whoever
            // finished it, and a second call would publish a second terminal event.
            const h = unit();
            const queuedAt = NOW - 3 * 60 * MINUTE;
            await seedBuild({ workId: WORK_A, queuedAt: new Date(queuedAt) });
            const markLost = jest.spyOn(repository, 'markLost').mockResolvedValueOnce(0);

            try {
                const summary = await h.sweeps.sweep(NOW);

                expect(markLost).toHaveBeenCalledTimes(1);
                expect(h.service.finalize).not.toHaveBeenCalled();
                expect(summary).toMatchObject({
                    lostCandidates: 1,
                    lostMarked: 0,
                    lostFinalized: 0,
                });
            } finally {
                markLost.mockRestore();
            }
        });

        it('leaves an adopted Build to the adopted half of the rule', async () => {
            const h = unit();
            const build = await seedBuild({
                workId: WORK_A,
                queuedAt: new Date(NOW - 10 * 60 * MINUTE),
                providerRunId: 'run-9',
                dispatchedAt: new Date(NOW - 10 * 60 * MINUTE),
            });

            await h.sweeps.sweep(NOW);

            expect((await stored(build.id)).status).toBe('queued');
            expect(h.service.finalize).not.toHaveBeenCalled();
        });

        it('measures a Build dispatched after it was queued from its dispatch', async () => {
            // A Build that waited, then was started by a later prepare, gets the
            // whole adoption window and timeout from the moment it was handed to
            // the provider — not from the moment it was asked for.
            const h = unit();
            const queuedAt = NOW - 5 * 60 * MINUTE;
            const dispatchedAt = queuedAt + 60 * MINUTE;
            const build = await seedBuild({
                workId: WORK_A,
                queuedAt: new Date(queuedAt),
                dispatchedAt: new Date(dispatchedAt),
            });

            await h.sweeps.sweep(queuedAt + 95 * MINUTE + 1);
            expect((await stored(build.id)).status).toBe('queued');

            await h.sweeps.sweep(dispatchedAt + 95 * MINUTE + 1);
            expect((await stored(build.id)).status).toBe('failed');
        });

        it('counts a finalize that throws, and keeps going', async () => {
            const h = unit();
            const queuedAt = NOW - 3 * 60 * MINUTE;
            const first = await seedBuild({ workId: WORK_A, queuedAt: new Date(queuedAt) });
            const second = await seedBuild({ workId: WORK_B, queuedAt: new Date(queuedAt + 1) });
            h.service.finalize.mockRejectedValueOnce(new Error('activity log down'));

            const summary = await h.sweeps.sweep(NOW);

            expect(h.service.finalize.mock.calls).toEqual([[first.id], [second.id]]);
            expect(summary).toMatchObject({ lostMarked: 2, lostFinalized: 1, lostFailed: 1 });
        });
    });

    /* ---------------------------------------------------------------------- *
     * runSweep — the one lock
     * ---------------------------------------------------------------------- */

    describe('runSweep', () => {
        it('takes `app-builds:sweep` with the 90 s lease and runs the passes under it', async () => {
            const h = unit();
            await seedBuild({ workId: WORK_A, queuedAt: new Date(NOW - 100 * SECOND) });

            const summary = await h.sweeps.runSweep(NOW);

            expect(APP_BUILD_SWEEP_LOCK_KEY).toBe('app-builds:sweep');
            expect(APP_BUILD_SWEEP_LOCK_TTL_MS).toBe(90_000);
            expect(h.lock.runExclusive).toHaveBeenCalledWith(
                'app-builds:sweep',
                expect.any(Function),
                expect.objectContaining({ ttlMs: 90_000 }),
            );
            expect(h.service.requestPrepare).toHaveBeenCalledWith(WORK_A, 'sweep');
            expect(summary).toMatchObject({ skipped: null, redriveRequested: 1 });
        });

        it('runs no pass while another tick holds the lock', async () => {
            const h = unit();
            h.lock.held = true;
            await seedBuild({ workId: WORK_A, queuedAt: new Date(NOW - 100 * SECOND) });
            await seedBuild({ workId: WORK_B, queuedAt: new Date(NOW - 3 * 60 * MINUTE) });

            const summary = await h.sweeps.runSweep(NOW);

            expect(summary).toMatchObject({
                skipped: 'locked',
                redriveRequested: 0,
                lostMarked: 0,
            });
            expect(h.service.requestPrepare).not.toHaveBeenCalled();
            expect(h.service.finalize).not.toHaveBeenCalled();
        });

        it('runs no pass, and says so, when no lock service is bound', async () => {
            const h = unit({ locks: 'none' });
            await seedBuild({ workId: WORK_A, queuedAt: new Date(NOW - 100 * SECOND) });

            const summary = await h.sweeps.runSweep(NOW);

            expect(summary.skipped).toBe('lockUnavailable');
            expect(h.service.requestPrepare).not.toHaveBeenCalled();
        });

        it('reads the clock itself when called with no argument — the RPC call carries none', async () => {
            const h = unit();
            await seedBuild({ workId: WORK_A, queuedAt: new Date(Date.now() - 100 * SECOND) });

            const summary = await h.sweeps.runSweep();

            expect(summary.redriveRequested).toBe(1);
        });

        it('really locks against a second tick on the real lock table', async () => {
            // The real `DistributedTaskLockService` over `cache_entries`: while one
            // tick holds `app-builds:sweep`, a second tick is told `locked`.
            const locks = new DistributedTaskLockService(dataSource.getRepository(CacheEntry));
            let release: () => void = () => undefined;
            const gate = new Promise<void>((resolve) => {
                release = resolve;
            });
            const service = {
                requestPrepare: jest.fn(async () => {
                    await gate;
                    return { prepareSeq: 1, dispatched: true };
                }),
                finalize: jest.fn(),
            };
            const sweeps = new AppBuildSweepService(
                repository,
                service as unknown as AppBuildsService,
                locks,
            );
            await seedBuild({ workId: WORK_A, queuedAt: new Date(Date.now() - 100 * SECOND) });

            const first = sweeps.runSweep();
            while (service.requestPrepare.mock.calls.length === 0) {
                await new Promise((resolve) => setImmediate(resolve));
            }
            const second = await sweeps.runSweep();
            release();

            expect(second.skipped).toBe('locked');
            expect((await first).redriveRequested).toBe(1);
            expect(service.requestPrepare).toHaveBeenCalledTimes(1);
        });
    });

    /* ---------------------------------------------------------------------- *
     * End to end — the real service, the real runner, the real lock
     * ---------------------------------------------------------------------- */

    describe('end to end: a Build whose prepare failed is started by the next tick', () => {
        const INPUTS_HASH = computeBuildInputsHash([{ name: 'DATABASE_URL', fingerprint: 'v3' }]);

        function prepareResult(): PrepareRepositoryResult {
            return {
                workflow: { state: 'committed', commitSha: SHA, contentSha256: 'c'.repeat(64) },
                secretsWritten: ['EW_DATABASE_URL'],
                secretsRemoved: [],
                buildInputsHash: INPUTS_HASH,
            } as PrepareRepositoryResult;
        }

        /**
         * The whole chain the local stack runs: `AppBuildsService` with NO job
         * runtime bound, so `requestPrepare` takes §7.1's in-process fallback into
         * the real `AppBuildPrepareRunner`; the runner's lock, repositories and
         * row claims are the real ones over the in-memory table. Only the plugin,
         * the Work, the spec and the build values are doubles.
         */
        function endToEnd() {
            const context: AppBuildWorkContext = {
                workId: WORK_A,
                userId: USER_ID,
                trackedBranch: TRACKED,
                buildPluginId: PLUGIN_ID,
                repositoryFullName: 'acme/shop',
                repositoryVisibility: 'public',
            };
            const plugin = {
                prepareRepository: jest.fn(async () => prepareResult()),
                startBuild: jest.fn(async () => ({
                    providerRunId: 'run-1',
                    dispatchedAt: new Date().toISOString(),
                })),
                getFileContent: jest.fn(async () => null),
            };
            const binding = {
                pluginId: PLUGIN_ID,
                buildKind: 'github-actions',
                imageRepository: 'ghcr.io/acme/shop/ever-works-app',
                repository: {
                    owner: 'acme',
                    repo: 'shop',
                    visibility: 'public',
                    trackedBranch: TRACKED,
                    createdByAppWork: true,
                } as BuildRepositoryRef,
                settings: {},
                writer: { getFileContent: plugin.getFileContent },
                prepareRepository: plugin.prepareRepository,
                startBuild: plugin.startBuild,
            } as unknown as AppBuildPreparePluginBinding;
            const specs = { read: jest.fn(async () => specRead(specWithTimeout(60))) };
            const works = { read: jest.fn(async () => context) };
            const env = {
                resolveForBuild: jest.fn(async () => ({
                    values: [
                        {
                            name: 'DATABASE_URL',
                            value: 'postgres://build/db',
                            secret: true,
                            fingerprint: 'v3',
                        },
                    ],
                    unresolved: [],
                    fingerprints: { DATABASE_URL: 'v3' },
                    warnings: [],
                    missingRequired: [],
                    egress: [],
                })),
            };

            const builds = repository;
            const preparations = new AppBuildPreparationRepository(
                dataSource.getRepository(WorkBuildPreparation),
            );
            const locks = new DistributedTaskLockService(dataSource.getRepository(CacheEntry));
            const inFlight: Array<Promise<unknown>> = [];
            let runner: AppBuildPrepareRunner | null = null;
            const service = new AppBuildsService(
                builds,
                preparations,
                dataSource.getRepository(WorkBuild),
                undefined, // activityLog
                undefined, // emitter
                undefined, // usage
                undefined, // fingerprints
                undefined, // provisionEvents
                undefined, // plugins
                undefined, // works
                undefined, // specs
                undefined, // runnerRecipe
                undefined, // prepareDispatcher — none: §7.1's in-process fallback
                undefined, // watchDispatcher
                {
                    run: (payload) => {
                        const run = runner!.run(payload);
                        inFlight.push(run.catch(() => undefined));
                        return run;
                    },
                },
                undefined, // watchRunner
            );
            runner = new AppBuildPrepareRunner(
                builds,
                preparations,
                service,
                locks,
                { resolve: jest.fn(async () => binding) } as never,
                works as never,
                specs as never,
                env as unknown as AppEnvResolver,
                dataSource.getRepository(WorkBuild),
            );
            const dispatchWatch = jest.spyOn(service, 'dispatchWatch');
            const sweeps = new AppBuildSweepService(builds, service, locks, specs as never);

            /** Wait for every in-process prepare the tick started. */
            const settle = async () => {
                for (let round = 0; round < 50; round += 1) {
                    await new Promise((resolve) => setImmediate(resolve));
                    const pending = inFlight.splice(0);
                    if (pending.length === 0 && round > 2) return;
                    await Promise.all(pending);
                }
            };

            return { runner: runner!, sweeps, plugin, dispatchWatch, settle };
        }

        it('a prepare that threw leaves the Build queued; one tick prepares and starts it', async () => {
            const e2e = endToEnd();
            const build = await seedBuild({
                workId: WORK_A,
                queuedAt: new Date(Date.now() - 95 * SECOND),
            });
            e2e.plugin.prepareRepository.mockRejectedValueOnce(new Error('GitHub answered 502'));

            // Today's state: the prepare throws, and the Build waits with nothing
            // that will ever move it.
            await expect(e2e.runner.run({ workId: WORK_A, reason: 'rebuild' })).rejects.toThrow(
                'GitHub answered 502',
            );
            const stuck = await stored(build.id);
            expect(stuck.status).toBe('queued');
            expect(stuck.dispatchedAt ?? null).toBeNull();
            expect(e2e.plugin.startBuild).not.toHaveBeenCalled();

            const summary = await e2e.sweeps.runSweep();
            await e2e.settle();

            expect(summary).toMatchObject({ skipped: null, redriveRequested: 1 });
            expect(e2e.plugin.prepareRepository).toHaveBeenCalledTimes(2);
            expect(e2e.plugin.startBuild).toHaveBeenCalledTimes(1);
            const started = await stored(build.id);
            expect(started.dispatchedAt).toBeInstanceOf(Date);
            expect(started.providerRunId).toBe('run-1');
            expect(e2e.dispatchWatch).toHaveBeenCalledWith({
                buildId: build.id,
                reason: 'dispatched',
            });
        });

        it('a startBuild that threw leaves the Build queued; one tick starts it', async () => {
            const e2e = endToEnd();
            const build = await seedBuild({
                workId: WORK_A,
                queuedAt: new Date(Date.now() - 95 * SECOND),
            });
            e2e.plugin.startBuild.mockRejectedValueOnce(new Error('GitHub 502'));

            const first = await e2e.runner.run({ workId: WORK_A, reason: 'rebuild' });

            expect(first).toMatchObject({ status: 'prepared', buildsDispatched: 0 });
            const stuck = await stored(build.id);
            expect(stuck.status).toBe('queued');
            expect(stuck.dispatchedAt ?? null).toBeNull();

            const summary = await e2e.sweeps.runSweep();
            await e2e.settle();

            expect(summary.redriveRequested).toBe(1);
            expect(e2e.plugin.startBuild).toHaveBeenCalledTimes(2);
            const started = await stored(build.id);
            expect(started.dispatchedAt).toBeInstanceOf(Date);
            expect(started.providerRunId).toBe('run-1');
            expect(e2e.dispatchWatch).toHaveBeenCalledWith({
                buildId: build.id,
                reason: 'dispatched',
            });
        });
    });
});
