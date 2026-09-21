import { DataSource } from 'typeorm';
import { WorkAppRuntimeState } from '../../../entities/work-app-runtime-state.entity';
import { Work } from '../../../entities/work.entity';
import { ENTITIES } from '../../_entities-inventory';
import {
    APP_CAPABLE_DEPLOY_PROVIDER_IDS,
    APP_DEPLOY_LOCK_STALE_S,
    WorkAppRuntimeStateRepository,
    deriveAppDeployTarget,
} from '../work-app-runtime-state.repository';

/**
 * APW-06 T17 — the runtime-state repository, executed against a real
 * (in-memory better-sqlite3) database rather than a mocked repository.
 *
 * The things this file is really about are the CONDITIONAL UPDATEs: the deploy
 * lock, the deletion claim, the pause and the dequeue are each a
 * compare-and-set whose predicate is what keeps two API replicas from acting on
 * the same App Work at once. A mocked repository would assert that the code
 * calls `.where(...)`; only a real database asserts that the second caller
 * loses.
 *
 * better-sqlite3 is the default `DATABASE_TYPE` (every local and self-hosted
 * install) and the driver CI and the e2e lane use, so a claim that only holds
 * under a pooled driver is not a claim that holds. It is also the driver the
 * `bigint` timestamp columns exist for — `plan.md:1020`.
 *
 * Plan §7.2 (the column list), §2.2 step 3 (the claim), §5.6 steps 6–7 (the
 * patch and the dequeue), §9.3 (the poll), §9.7 (the deletion claim),
 * §9.10 (pause / cancel / remove); `tasks.md` T17 for the method list and FR-63.
 * Every uuid below is obviously synthetic.
 */

const WORK_A = '11111111-1111-4111-8111-111111111111';
const WORK_B = '22222222-2222-4222-8222-222222222222';
const WORK_C = '33333333-3333-4333-8333-333333333333';

const DEPLOY_ONE = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const DEPLOY_TWO = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const BUILD_ONE = 'cccccccc-3333-4333-8333-cccccccccccc';
const BUILD_TWO = 'dddddddd-4444-4444-8444-dddddddddddd';
const MEMBER = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee';
/** `works.userId` is NOT NULL; the cases that care about the owner override it. */
const OWNER = 'ffffffff-6666-4666-8666-ffffffffffff';

describe('WorkAppRuntimeStateRepository (APW-06 T17)', () => {
    let dataSource: DataSource;
    let repository: WorkAppRuntimeStateRepository;

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
            logging: false,
        });
        await dataSource.initialize();
        // The owning Work row is not what is under test here; the FK itself
        // belongs to the migration's own spec.
        await dataSource.query('PRAGMA foreign_keys = OFF');
        repository = new WorkAppRuntimeStateRepository(
            dataSource.getRepository(WorkAppRuntimeState),
            dataSource.getRepository(Work),
        );
    });

    afterAll(async () => {
        await dataSource.destroy();
    });

    beforeEach(async () => {
        await dataSource.getRepository(WorkAppRuntimeState).clear();
        await dataSource.getRepository(Work).clear();
    });

    /** Insert a state row directly, so a case can start from any stored state. */
    function seed(
        workId: string,
        overrides: Partial<WorkAppRuntimeState> = {},
    ): Promise<WorkAppRuntimeState> {
        const rows = dataSource.getRepository(WorkAppRuntimeState);
        return rows.save(rows.create({ workId, target: 'none', ...overrides }));
    }

    /**
     * A minimal owning Work.
     *
     * `name`, `slug`, `userId` and `description` are the NOT NULL columns on
     * `works` (`work.entity.ts:167-173, 275`). The derivation under test reads
     * `deployProvider` and the health poll reads `userId` — nothing else about
     * the Work matters here, so nothing else is invented.
     */
    function seedWork(
        works: ReturnType<DataSource['getRepository']>,
        id: string,
        overrides: Partial<Work> = {},
    ) {
        return (works as unknown as { create: (value: Partial<Work>) => Work }).create({
            id,
            name: `app-${id.slice(0, 8)}`,
            slug: `app-${id.slice(0, 8)}`,
            userId: OWNER,
            description: 'An App Work fixture.',
            ...overrides,
        });
    }

    /** One `AppJobResult`, with only the members these cases read. */
    function jobResult(name: string, status: 'succeeded' | 'failed' | 'running') {
        return {
            name,
            when: 'post-deploy',
            runName: `${name}-run`,
            status,
            startedAt: new Date().toISOString(),
        } as never;
    }

    /** Re-read from the database, never from the object a method returned. */
    async function stored(workId: string): Promise<WorkAppRuntimeState> {
        return dataSource.getRepository(WorkAppRuntimeState).findOneOrFail({ where: { workId } });
    }

    /* ------------------------------------------------------------------ *
     * getOrCreate + FR-63
     * ------------------------------------------------------------------ */

    describe('getOrCreate', () => {
        it('creates the row on first read and returns the same row on the second', async () => {
            const first = await repository.getOrCreate(WORK_A);
            const second = await repository.getOrCreate(WORK_A);

            expect(first.workId).toBe(WORK_A);
            expect(second.id).toBe(first.id);
            expect(await dataSource.getRepository(WorkAppRuntimeState).count()).toBe(1);
        });

        it('defaults `target` to `none` — a real state, not a missing value', async () => {
            const row = await repository.getOrCreate(WORK_A);

            expect(row.target).toBe('none');
            expect(row.paused).toBe(false);
            expect(row.health).toBe('unknown');
            expect(row.deletionAttempts).toBe(0);
        });

        it('FR-63: derives `your-cluster` from a Work whose deployProvider supports apps', async () => {
            const works = dataSource.getRepository(Work);
            await works.save(seedWork(works, WORK_A, { deployProvider: 'k8s' }));

            const row = await repository.getOrCreate(WORK_A);

            expect(row.target).toBe('your-cluster');
            // Persisted, not just returned — the next reader must see it too.
            expect((await stored(WORK_A)).target).toBe('your-cluster');
        });

        it('FR-63: derives the managed target from `ever-works-apps`', async () => {
            const works = dataSource.getRepository(Work);
            await works.save(seedWork(works, WORK_B, { deployProvider: 'ever-works-apps' }));

            expect((await repository.getOrCreate(WORK_B)).target).toBe('ever-works-apps');
        });

        it('FR-63: leaves `none` for a Work with no deploy provider', async () => {
            const works = dataSource.getRepository(Work);
            await works.save(seedWork(works, WORK_C, { deployProvider: null }));

            expect((await repository.getOrCreate(WORK_C)).target).toBe('none');
        });

        it('FR-63: never clobbers a target the owner has already changed', async () => {
            const works = dataSource.getRepository(Work);
            // The Work was created for `k8s`, but the owner has since chosen the
            // managed tier. The derivation must not drag it back.
            await works.save(seedWork(works, WORK_A, { deployProvider: 'k8s' }));
            await seed(WORK_A, { target: 'ever-works-apps' });

            expect((await repository.getOrCreate(WORK_A)).target).toBe('ever-works-apps');
        });

        it('survives two concurrent first reads without a duplicate row', async () => {
            const [one, two] = await Promise.all([
                repository.getOrCreate(WORK_A),
                repository.getOrCreate(WORK_A),
            ]);

            expect(one.workId).toBe(WORK_A);
            expect(two.workId).toBe(WORK_A);
            expect(await dataSource.getRepository(WorkAppRuntimeState).count()).toBe(1);
        });
    });

    /* ------------------------------------------------------------------ *
     * The deploy lock — §2.2 step 3
     * ------------------------------------------------------------------ */

    describe('claimDeployLock', () => {
        it('is atomic: of two concurrent claims exactly one wins', async () => {
            await seed(WORK_A, { target: 'your-cluster' });

            const results = await Promise.all([
                repository.claimDeployLock(WORK_A, DEPLOY_ONE),
                repository.claimDeployLock(WORK_A, DEPLOY_TWO),
            ]);

            expect(results.filter(Boolean)).toHaveLength(1);
            const row = await stored(WORK_A);
            expect([DEPLOY_ONE, DEPLOY_TWO]).toContain(row.deployLockId);
            expect(row.deployLockedAt).toBeInstanceOf(Date);
        });

        it('refuses a second claim while the lock is held and fresh', async () => {
            await seed(WORK_A);

            expect(await repository.claimDeployLock(WORK_A, DEPLOY_ONE)).toBe(true);
            expect(await repository.claimDeployLock(WORK_A, DEPLOY_TWO)).toBe(false);
            expect((await stored(WORK_A)).deployLockId).toBe(DEPLOY_ONE);
        });

        it(`reclaims a lock that has been held for more than ${APP_DEPLOY_LOCK_STALE_S} s`, async () => {
            // The bound is the max deploy duration (7 200 s) plus a minute, so a
            // dispatcher that died mid-deploy wedges its Work for at most that.
            const stale = new Date(Date.now() - (APP_DEPLOY_LOCK_STALE_S + 60) * 1000);
            await seed(WORK_A, { deployLockId: DEPLOY_ONE, deployLockedAt: stale });

            expect(await repository.claimDeployLock(WORK_A, DEPLOY_TWO)).toBe(true);
            expect((await stored(WORK_A)).deployLockId).toBe(DEPLOY_TWO);
        });

        it('does NOT reclaim a lock that is still inside the stale window', async () => {
            const recent = new Date(Date.now() - (APP_DEPLOY_LOCK_STALE_S - 120) * 1000);
            await seed(WORK_A, { deployLockId: DEPLOY_ONE, deployLockedAt: recent });

            expect(await repository.claimDeployLock(WORK_A, DEPLOY_TWO)).toBe(false);
        });

        it('refuses a paused App Work (APW06-G03)', async () => {
            await seed(WORK_A, { paused: true, pausedAt: new Date() });

            expect(await repository.claimDeployLock(WORK_A, DEPLOY_ONE)).toBe(false);
            expect((await stored(WORK_A)).deployLockId ?? null).toBeNull();
        });

        it('refuses an App Work whose deletion has been claimed (APW06-G03)', async () => {
            await seed(WORK_A, { deletionRequestedAt: new Date() });

            expect(await repository.claimDeployLock(WORK_A, DEPLOY_ONE)).toBe(false);
        });
    });

    describe('releaseDeployLock', () => {
        it('only the holder may release', async () => {
            await seed(WORK_A);
            await repository.claimDeployLock(WORK_A, DEPLOY_ONE);

            expect(await repository.releaseDeployLock(WORK_A, DEPLOY_TWO)).toBe(false);
            expect((await stored(WORK_A)).deployLockId).toBe(DEPLOY_ONE);

            expect(await repository.releaseDeployLock(WORK_A, DEPLOY_ONE)).toBe(true);
            expect((await stored(WORK_A)).deployLockId ?? null).toBeNull();
        });

        it('clears the cancel flag in the same UPDATE, so it cannot cancel the NEXT deploy', async () => {
            await seed(WORK_A);
            await repository.claimDeployLock(WORK_A, DEPLOY_ONE);
            await repository.requestCancel(WORK_A, DEPLOY_ONE, MEMBER);
            expect((await stored(WORK_A)).cancelRequestedAt).toBeInstanceOf(Date);

            await repository.releaseDeployLock(WORK_A, DEPLOY_ONE);

            const row = await stored(WORK_A);
            expect(row.cancelRequestedAt ?? null).toBeNull();
            expect(row.cancelRequestedByUserId ?? null).toBeNull();
        });
    });

    describe('requestCancel', () => {
        it('records the cancel only against the Deployment that holds the lock', async () => {
            await seed(WORK_A);
            await repository.claimDeployLock(WORK_A, DEPLOY_ONE);

            expect(await repository.requestCancel(WORK_A, DEPLOY_TWO, MEMBER)).toBe(false);
            expect(await repository.requestCancel(WORK_A, DEPLOY_ONE, MEMBER)).toBe(true);
            expect((await stored(WORK_A)).cancelRequestedByUserId).toBe(MEMBER);
        });
    });

    /* ------------------------------------------------------------------ *
     * The queue of one — §7.2:1056, §5.6 step 7
     * ------------------------------------------------------------------ */

    describe('setQueued / takeQueued', () => {
        it('answers the Deployment it displaced, so the caller can mark it SUPERSEDED', async () => {
            await seed(WORK_A);

            const first = await repository.setQueued(WORK_A, {
                deploymentId: DEPLOY_ONE,
                buildId: BUILD_ONE,
            });
            expect(first.supersededDeploymentId).toBeNull();

            const second = await repository.setQueued(WORK_A, {
                deploymentId: DEPLOY_TWO,
                buildId: BUILD_TWO,
            });
            expect(second.supersededDeploymentId).toBe(DEPLOY_ONE);

            const row = await stored(WORK_A);
            expect(row.queuedDeploymentId).toBe(DEPLOY_TWO);
            expect(row.queuedBuildId).toBe(BUILD_TWO);
        });

        it('keeps the queue at exactly one row under two concurrent writers', async () => {
            await seed(WORK_A);

            await Promise.all([
                repository.setQueued(WORK_A, { deploymentId: DEPLOY_ONE, buildId: BUILD_ONE }),
                repository.setQueued(WORK_A, { deploymentId: DEPLOY_TWO, buildId: BUILD_TWO }),
            ]);

            const row = await stored(WORK_A);
            expect([DEPLOY_ONE, DEPLOY_TWO]).toContain(row.queuedDeploymentId);
            // Both columns come from the SAME setQueued call — never one writer's
            // Deployment beside the other's Build.
            expect(row.queuedBuildId).toBe(
                row.queuedDeploymentId === DEPLOY_ONE ? BUILD_ONE : BUILD_TWO,
            );
        });

        it('dequeues exactly once: the second concurrent finish gets nothing', async () => {
            await seed(WORK_A);
            await repository.setQueued(WORK_A, { deploymentId: DEPLOY_ONE, buildId: BUILD_ONE });

            const taken = await Promise.all([
                repository.takeQueued(WORK_A),
                repository.takeQueued(WORK_A),
            ]);

            expect(taken.filter(Boolean)).toHaveLength(1);
            expect(taken.find(Boolean)).toEqual({
                queuedDeploymentId: DEPLOY_ONE,
                queuedBuildId: BUILD_ONE,
            });
            expect((await stored(WORK_A)).queuedDeploymentId ?? null).toBeNull();
        });

        it('answers null when nothing is queued', async () => {
            await seed(WORK_A);

            expect(await repository.takeQueued(WORK_A)).toBeNull();
        });
    });

    /* ------------------------------------------------------------------ *
     * Deletion — §9.7
     * ------------------------------------------------------------------ */

    describe('claimDeletion', () => {
        it('refuses while a deploy lock is held, and succeeds once it is released', async () => {
            await seed(WORK_A);
            await repository.claimDeployLock(WORK_A, DEPLOY_ONE);

            expect(
                await repository.claimDeletion(WORK_A, {
                    deleteStoredData: true,
                    requestedByUserId: MEMBER,
                }),
            ).toBe(false);

            await repository.releaseDeployLock(WORK_A, DEPLOY_ONE);

            expect(
                await repository.claimDeletion(WORK_A, {
                    deleteStoredData: true,
                    requestedByUserId: MEMBER,
                }),
            ).toBe(true);

            const row = await stored(WORK_A);
            expect(row.deletionRequestedAt).toBeInstanceOf(Date);
            expect(row.deletionDeleteData).toBe(true);
            expect(row.deletionRequestedByUserId).toBe(MEMBER);
        });

        it('is claimed exactly once, whoever asks', async () => {
            await seed(WORK_A);

            const results = await Promise.all([
                repository.claimDeletion(WORK_A, {
                    deleteStoredData: false,
                    requestedByUserId: MEMBER,
                }),
                repository.claimDeletion(WORK_A, {
                    deleteStoredData: true,
                    requestedByUserId: MEMBER,
                }),
            ]);

            expect(results.filter(Boolean)).toHaveLength(1);
        });

        it('counts its retries', async () => {
            await seed(WORK_A);

            expect(await repository.recordDeletionAttempt(WORK_A)).toBe(1);
            expect(await repository.recordDeletionAttempt(WORK_A)).toBe(2);
            expect((await stored(WORK_A)).deletionAttempts).toBe(2);
        });
    });

    /* ------------------------------------------------------------------ *
     * Pause — §9.10:1588-1589
     * ------------------------------------------------------------------ */

    describe('setPaused', () => {
        it('refuses to pause while a Deployment holds the lock', async () => {
            await seed(WORK_A);
            await repository.claimDeployLock(WORK_A, DEPLOY_ONE);

            expect(await repository.setPaused(WORK_A, true, new Date())).toBe(false);
            expect((await stored(WORK_A)).paused).toBe(false);
        });

        it('pauses when nothing is in flight, and resuming clears the stamp', async () => {
            await seed(WORK_A);

            expect(await repository.setPaused(WORK_A, true, new Date())).toBe(true);
            expect((await stored(WORK_A)).pausedAt).toBeInstanceOf(Date);

            expect(await repository.setPaused(WORK_A, false, new Date())).toBe(true);
            const row = await stored(WORK_A);
            expect(row.paused).toBe(false);
            expect(row.pausedAt ?? null).toBeNull();
        });
    });

    /* ------------------------------------------------------------------ *
     * Health — §9.3 / §7.2
     * ------------------------------------------------------------------ */

    describe('selectForHealthPoll', () => {
        it('selects only deployed, unpaused, unremoved App Works with a target', async () => {
            await seed(WORK_A, { target: 'your-cluster', currentDeploymentId: DEPLOY_ONE });
            // target `none` — nothing to poll.
            await seed(WORK_B, { target: 'none', currentDeploymentId: DEPLOY_ONE });
            // deployed but paused.
            await seed(WORK_C, {
                target: 'your-cluster',
                currentDeploymentId: DEPLOY_ONE,
                paused: true,
            });

            const rows = await repository.selectForHealthPoll(10);

            expect(rows.map((row) => row.workId)).toEqual([WORK_A]);
        });

        it('skips a Work with a target but nothing deployed', async () => {
            await seed(WORK_A, { target: 'your-cluster', currentDeploymentId: null });

            expect(await repository.selectForHealthPoll(10)).toEqual([]);
        });

        it('skips a removed Work', async () => {
            await seed(WORK_A, {
                target: 'your-cluster',
                currentDeploymentId: DEPLOY_ONE,
                removedAt: new Date(),
            });

            expect(await repository.selectForHealthPoll(10)).toEqual([]);
        });

        it('orders never-polled rows first, then oldest poll first', async () => {
            const base = Date.now() - 3_600_000;
            await seed(WORK_A, {
                target: 'your-cluster',
                currentDeploymentId: DEPLOY_ONE,
                lastPolledAt: new Date(base + 60_000),
            });
            await seed(WORK_B, {
                target: 'your-cluster',
                currentDeploymentId: DEPLOY_ONE,
                lastPolledAt: null,
            });
            await seed(WORK_C, {
                target: 'your-cluster',
                currentDeploymentId: DEPLOY_ONE,
                lastPolledAt: new Date(base),
            });

            const rows = await repository.selectForHealthPoll(10);

            expect(rows.map((row) => row.workId)).toEqual([WORK_B, WORK_C, WORK_A]);
        });

        it('joins the owner from `works` — §7.2 carries no user id of its own', async () => {
            const works = dataSource.getRepository(Work);
            await works.save(seedWork(works, WORK_A, { userId: MEMBER, deployProvider: 'k8s' }));
            await seed(WORK_A, { target: 'your-cluster', currentDeploymentId: DEPLOY_ONE });

            const [row] = await repository.selectForHealthPoll(10);

            expect(row.userId).toBe(MEMBER);
        });

        it('still returns a row whose Work cannot be read — polled, but not notifiable', async () => {
            await seed(WORK_A, { target: 'your-cluster', currentDeploymentId: DEPLOY_ONE });

            const [row] = await repository.selectForHealthPoll(10);

            expect(row.workId).toBe(WORK_A);
            expect(row.userId ?? null).toBeNull();
        });

        it('honours the limit and answers nothing for a limit of zero', async () => {
            await seed(WORK_A, { target: 'your-cluster', currentDeploymentId: DEPLOY_ONE });
            await seed(WORK_B, { target: 'your-cluster', currentDeploymentId: DEPLOY_ONE });

            expect(await repository.selectForHealthPoll(1)).toHaveLength(1);
            expect(await repository.selectForHealthPoll(0)).toEqual([]);
        });
    });

    describe('recordHealth', () => {
        it('writes the counters and the poll time', async () => {
            await seed(WORK_A);
            const at = new Date();

            await repository.recordHealth(WORK_A, {
                health: 'degraded',
                consecutiveFailures: 2,
                consecutivePasses: 0,
                unreachableStreak: 1,
                lastPolledAt: at,
            });

            const row = await stored(WORK_A);
            expect(row.health).toBe('degraded');
            expect(row.consecutiveFailures).toBe(2);
            expect(row.unreachableStreak).toBe(1);
            expect(row.lastPolledAt?.getTime()).toBe(at.getTime());
        });

        it('leaves `lastHealthNotifiedAt` alone unless a notification was really created', async () => {
            const notified = new Date(Date.now() - 60_000);
            await seed(WORK_A, { lastHealthNotifiedAt: notified });

            await repository.recordHealth(WORK_A, {
                health: 'down',
                consecutiveFailures: 3,
                consecutivePasses: 0,
                unreachableStreak: 0,
                lastPolledAt: new Date(),
            });

            // Stamping it on every poll would suppress the next real
            // notification for the whole six-hour window.
            expect((await stored(WORK_A)).lastHealthNotifiedAt?.getTime()).toBe(notified.getTime());
        });

        it('leaves a good address alone when the poll reports no change (FR-41)', async () => {
            await seed(WORK_A, { ingressAddress: { ip: '198.51.100.7' } });

            await repository.recordHealth(WORK_A, {
                health: 'healthy',
                consecutiveFailures: 0,
                consecutivePasses: 1,
                unreachableStreak: 0,
                lastPolledAt: new Date(),
            });

            expect((await stored(WORK_A)).ingressAddress).toEqual({ ip: '198.51.100.7' });
        });

        it('clears the address when the poll says it was withdrawn', async () => {
            await seed(WORK_A, { ingressAddress: { ip: '198.51.100.7' } });

            await repository.recordHealth(WORK_A, {
                health: 'unreachable',
                consecutiveFailures: 1,
                consecutivePasses: 0,
                unreachableStreak: 1,
                lastPolledAt: new Date(),
                ingressAddress: null,
            });

            expect((await stored(WORK_A)).ingressAddress ?? null).toBeNull();
        });
    });

    /* ------------------------------------------------------------------ *
     * The remaining writes
     * ------------------------------------------------------------------ */

    describe('the §5.6 / §8.2 / §9.10 writes', () => {
        it('patchRuntimeState writes only the keys it was given', async () => {
            await seed(WORK_A, { namespace: 'ew-a', clusterFingerprint: 'fp-1' });

            await repository.patchRuntimeState(WORK_A, { currentDeploymentId: DEPLOY_ONE });

            const row = await stored(WORK_A);
            expect(row.currentDeploymentId).toBe(DEPLOY_ONE);
            expect(row.namespace).toBe('ew-a');
            expect(row.clusterFingerprint).toBe('fp-1');
        });

        it('clearPendingDomainRebuild is atomic: a stale Build cannot clear a newer claim', async () => {
            await seed(WORK_A, { pendingDomainRebuildBuildId: BUILD_TWO });

            expect(await repository.clearPendingDomainRebuild(WORK_A, BUILD_ONE)).toBe(false);
            expect((await stored(WORK_A)).pendingDomainRebuildBuildId).toBe(BUILD_TWO);

            expect(await repository.clearPendingDomainRebuild(WORK_A, BUILD_TWO)).toBe(true);
            expect((await stored(WORK_A)).pendingDomainRebuildBuildId ?? null).toBeNull();
        });

        it('saveClusterCheck never writes `clusterFingerprint` (§7.2 reserves it)', async () => {
            await seed(WORK_A, { clusterFingerprint: 'deployed-fp' });

            await repository.saveClusterCheck(
                WORK_A,
                { fingerprint: 'checked-fp' } as never,
                new Date(),
                { ip: '198.51.100.9' },
            );

            const row = await stored(WORK_A);
            // The deployed cluster is untouched; the check's own fingerprint
            // lives inside the bag. Confusing the two is how a check against the
            // wrong cluster would read as a successful deploy.
            expect(row.clusterFingerprint).toBe('deployed-fp');
            expect(row.clusterCheck).toEqual({ fingerprint: 'checked-fp' });
            expect(row.ingressAddress).toEqual({ ip: '198.51.100.9' });
        });

        it('markRemoved clears `currentDeploymentId`, so the poller drops the row', async () => {
            await seed(WORK_A, { target: 'your-cluster', currentDeploymentId: DEPLOY_ONE });

            await repository.markRemoved(WORK_A, new Date());

            const row = await stored(WORK_A);
            expect(row.removedAt).toBeInstanceOf(Date);
            expect(row.currentDeploymentId ?? null).toBeNull();
            expect(await repository.selectForHealthPoll(10)).toEqual([]);
        });

        it('saveJobResult replaces a job by name and appends an unseen one', async () => {
            // The caller passes the `AppJobResult` ITSELF
            // (`app-lifecycle-ops.service.ts:1670`); it carries its own `name`,
            // and the `{ name, last }` wrapping the snapshot stores is done by
            // the repository. Passing a wrapper here instead would write
            // `last: undefined` and lose every result.
            await seed(WORK_A, {
                statusSnapshot: {
                    observedAt: new Date().toISOString(),
                    components: [],
                    jobs: [{ name: 'migrate', last: jobResult('migrate', 'failed') }],
                    cron: [],
                    isolationEnforced: null,
                } as never,
            });

            await repository.saveJobResult(WORK_A, jobResult('migrate', 'succeeded'));
            await repository.saveJobResult(WORK_A, jobResult('seed', 'running'));

            const jobs = (await stored(WORK_A)).statusSnapshot?.jobs ?? [];
            expect(jobs).toHaveLength(2);
            expect(jobs.find((job) => job.name === 'migrate')?.last?.status).toBe('succeeded');
            expect(jobs.map((job) => job.name)).toEqual(['migrate', 'seed']);
        });

        it('findJobState answers the last run status, and null when there is none', async () => {
            // Reached through an `as unknown as` cast and a `hasMember` probe at
            // `app-lifecycle-ops.service.ts:1734-1745`, so a missing
            // implementation would read as `null` — "the job is not running" —
            // and let a second run start over a live one.
            await seed(WORK_A);
            await repository.saveJobResult(WORK_A, jobResult('migrate', 'running'));

            expect(await repository.findJobState(WORK_A, 'migrate')).toBe('running');
            expect(await repository.findJobState(WORK_A, 'never-ran')).toBeNull();
            expect(await repository.findJobState(WORK_B, 'migrate')).toBeNull();
        });

        it('findStateForWorks answers a map and creates nothing', async () => {
            await seed(WORK_A, { paused: true });

            const map = await repository.findStateForWorks([WORK_A, WORK_B]);

            expect(map.get(WORK_A)?.paused).toBe(true);
            expect(map.has(WORK_B)).toBe(false);
            // A read of the launcher's whole tile list must not write a row per
            // tile — that would turn every launcher render into a write storm.
            expect(await dataSource.getRepository(WorkAppRuntimeState).count()).toBe(1);
        });
    });

    /* ------------------------------------------------------------------ *
     * The column the table must NOT have — R-3, ACC-06-39
     * ------------------------------------------------------------------ */

    describe('ACC-06-39 — no `licenseAttestation` column', () => {
        it('the entity metadata declares no such column', () => {
            // Asserted against the METADATA, not against the file's text: a
            // column added through an embedded or an inherited entity would not
            // show up in a grep.
            const metadata = dataSource.getMetadata(WorkAppRuntimeState);
            const names = metadata.columns.map((column) => column.propertyName);

            expect(names).not.toContain('licenseAttestation');
            // And the columns the epic DOES depend on are really there, so this
            // case cannot pass by looking at the wrong entity.
            expect(names).toEqual(
                expect.arrayContaining([
                    'workId',
                    'target',
                    'deployLockId',
                    'deployLockedAt',
                    'deletionRequestedAt',
                    'lastPolledAt',
                ]),
            );
        });
    });

    /* ------------------------------------------------------------------ *
     * FR-63's rule as a pure function
     * ------------------------------------------------------------------ */

    describe('deriveAppDeployTarget', () => {
        it('maps the App-capable plugin ids to `your-cluster`', () => {
            for (const id of APP_CAPABLE_DEPLOY_PROVIDER_IDS) {
                expect(deriveAppDeployTarget(id)).toBe('your-cluster');
            }
        });

        it('includes `k8s`, the one plugin in this tree declaring `supportsApps`', () => {
            // Measured, not assumed: `packages/plugins/k8s/src/k8s.plugin.ts:388`
            // is the only `supportsApps = true` in the repository. If a second
            // App-capable deployment plugin lands and is not added to the set,
            // a correctly-created Work would silently refuse to deploy.
            expect(APP_CAPABLE_DEPLOY_PROVIDER_IDS.has('k8s')).toBe(true);
        });

        it('maps the managed provider and nothing else to `ever-works-apps`', () => {
            expect(deriveAppDeployTarget('ever-works-apps')).toBe('ever-works-apps');
            expect(deriveAppDeployTarget('vercel')).toBe('none');
        });

        it('answers `none` for absent, empty and unknown providers', () => {
            expect(deriveAppDeployTarget(null)).toBe('none');
            expect(deriveAppDeployTarget(undefined)).toBe('none');
            expect(deriveAppDeployTarget('   ')).toBe('none');
            expect(deriveAppDeployTarget('not-a-plugin')).toBe('none');
        });

        it('is case- and whitespace-insensitive', () => {
            expect(deriveAppDeployTarget('  K8s ')).toBe('your-cluster');
        });
    });
});
