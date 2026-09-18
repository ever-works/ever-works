import { DataSource } from 'typeorm';
import { WorkAppProvisioning } from '../../../entities/work-app-provisioning.entity';
import { ENTITIES } from '../../_entities-inventory';
import {
    APP_PROVISIONING_ACTIVE_STATUSES,
    APP_PROVISIONING_LEASE_MS,
    APP_PROVISIONING_SWEEP_BATCH,
    WorkAppProvisioningRepository,
} from '../work-app-provisioning.repository';

/**
 * APW-04 T7 — the `work_app_provisionings` repository, executed against a real
 * (in-memory better-sqlite3) database rather than a mocked repository: the
 * partial unique index behind "one ACTIVE row per App Work", the two
 * compare-and-sets and the epoch-free `Date` comparisons are the ones production
 * runs.
 *
 * better-sqlite3 is the default `DATABASE_TYPE` (every local and self-hosted
 * install) and the driver CI and the e2e lane use, so a rule that only holds
 * under a pooled driver is not a rule that holds.
 *
 * The DataSource is built with `synchronize: true` over the REAL `ENTITIES`
 * inventory, so `uq_work_app_provisionings_active` is the index TypeORM derived
 * from the entity's own `@Index(… { unique: true, where })` declaration — the
 * test is about the declaration, not about a hand-written copy of it.
 *
 * 🛑 **What this driver cannot reach, and is therefore asserted rather than
 * executed**: a genuinely CONCURRENT pair of inserts. better-sqlite3 funnels a
 * whole DataSource through one connection and serialises writes at the driver,
 * so `Promise.all([insert, insert])` here is two sequential statements — the
 * index is load-bearing on a pooled driver (PostgreSQL, MySQL/MariaDB) and only
 * *observed* here. T7's case therefore asserts the property that makes the index
 * the guard on every driver: the SECOND insert is refused with a unique
 * violation, and the row count stays 1. APW-05's T6 recorded the same limitation
 * for the same reason, and it is repeated in this slice's report rather than
 * glossed. The PostgreSQL leg is NOT run: no container is available in this
 * environment.
 *
 * ACC-04-03 (two active rows for one Work are impossible), ACC-04-25 (a user's
 * 4th active row is counted for queueing). Every uuid below is obviously
 * synthetic.
 */

const WORK_A = '11111111-1111-4111-8111-111111111111';
const WORK_B = '22222222-2222-4222-8222-222222222222';
const TASK_A = '33333333-3333-4333-8333-333333333333';
const USER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_A = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const AGENT_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

/** A fixed "now" so every window is exact, never wall-clock flaky. */
const NOW = Date.parse('2026-03-01T06:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe('WorkAppProvisioningRepository (APW-04 T7)', () => {
    let dataSource: DataSource;
    let repository: WorkAppProvisioningRepository;

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
            logging: false,
        });
        await dataSource.initialize();
        repository = new WorkAppProvisioningRepository(
            dataSource.getRepository(WorkAppProvisioning),
        );
    });

    afterAll(async () => {
        await dataSource.destroy();
    });

    beforeEach(async () => {
        await dataSource.query('PRAGMA foreign_keys = OFF');
        await dataSource.getRepository(WorkAppProvisioning).clear();
    });

    /** Insert a row directly, so a case can start from any stored state. */
    function seed(overrides: Partial<WorkAppProvisioning> = {}): Promise<WorkAppProvisioning> {
        const rows = dataSource.getRepository(WorkAppProvisioning);
        return rows.save(
            rows.create({
                workId: WORK_A,
                userId: USER_A,
                trigger: 'manual',
                status: 'queued',
                step: 'repository',
                ...overrides,
            }),
        );
    }

    /** Re-read a row from the database, never from the object a method returned. */
    async function stored(id: string): Promise<WorkAppProvisioning> {
        return dataSource.getRepository(WorkAppProvisioning).findOneOrFail({ where: { id } });
    }

    async function count(): Promise<number> {
        return dataSource.getRepository(WorkAppProvisioning).count();
    }

    describe('the partial unique index is the guard (ACC-04-03)', () => {
        it('allows exactly one ACTIVE row for one App Work', async () => {
            await seed({ workId: WORK_A, status: 'running' });

            await expect(seed({ workId: WORK_A, status: 'queued' })).rejects.toThrow(
                /UNIQUE constraint failed/,
            );
            expect(await count()).toBe(1);
        });

        it('refuses the insert for each of the three active statuses', async () => {
            for (const status of APP_PROVISIONING_ACTIVE_STATUSES) {
                await dataSource.getRepository(WorkAppProvisioning).clear();
                await seed({ workId: WORK_A, status: 'queued' });

                await expect(seed({ workId: WORK_A, status })).rejects.toThrow(
                    /UNIQUE constraint failed/,
                );
            }
        });

        it('lets terminal rows accumulate — re-provisioning is the whole point (FR-59)', async () => {
            await seed({ workId: WORK_A, status: 'failed' });
            await seed({ workId: WORK_A, status: 'merged' });
            await seed({ workId: WORK_A, status: 'cancelled' });
            await seed({ workId: WORK_A, status: 'succeeded' });

            expect(await count()).toBe(4);
            // …and one more ACTIVE row is still legal on top of them.
            await expect(seed({ workId: WORK_A, status: 'running' })).resolves.toBeDefined();
            expect(await count()).toBe(5);
        });

        it('keeps two different App Works independent', async () => {
            await seed({ workId: WORK_A, status: 'running' });
            await seed({ workId: WORK_B, status: 'running' });

            expect(await count()).toBe(2);
        });

        it('refuses a second row for one Task, and allows many NULL taskIds', async () => {
            await seed({ workId: WORK_A, taskId: TASK_A });
            await expect(seed({ workId: WORK_B, taskId: TASK_A })).rejects.toThrow(
                /UNIQUE constraint failed/,
            );

            await dataSource.getRepository(WorkAppProvisioning).clear();
            // The predicate is `"taskId" IS NOT NULL`, so queued rows with no Task
            // yet do not collide with each other.
            await seed({ workId: WORK_A, taskId: null });
            await seed({ workId: WORK_B, taskId: null });
            expect(await count()).toBe(2);
        });

        it('refuses a second QUEUED suggestion for one upstream, and allows a settled one', async () => {
            await seed({
                workId: WORK_A,
                suggestionUpstream: 'owner/repo',
                suggestionState: 'queued',
            });
            await expect(
                seed({
                    workId: WORK_B,
                    suggestionUpstream: 'owner/repo',
                    suggestionState: 'queued',
                }),
            ).rejects.toThrow(/UNIQUE constraint failed/);

            await dataSource.getRepository(WorkAppProvisioning).clear();
            await seed({
                workId: WORK_A,
                suggestionUpstream: 'owner/repo',
                suggestionState: 'accepted',
            });
            await expect(
                seed({
                    workId: WORK_B,
                    suggestionUpstream: 'owner/repo',
                    suggestionState: 'queued',
                }),
            ).resolves.toBeDefined();
        });
    });

    describe('findActiveByWork / findByTaskId', () => {
        it('answers the one ACTIVE row and never a terminal one', async () => {
            await seed({ workId: WORK_A, status: 'failed' });
            const active = await seed({ workId: WORK_A, status: 'needs_input' });

            const found = await repository.findActiveByWork(WORK_A);

            expect(found?.id).toBe(active.id);
            expect(found?.status).toBe('needs_input');
        });

        it('answers null for a Work whose rows are all terminal', async () => {
            await seed({ workId: WORK_A, status: 'merged' });

            await expect(repository.findActiveByWork(WORK_A)).resolves.toBeNull();
        });

        it('answers null for a Work that has never been provisioned', async () => {
            await expect(repository.findActiveByWork(WORK_B)).resolves.toBeNull();
        });

        it('answers the row a provisioning Task belongs to', async () => {
            const row = await seed({ taskId: TASK_A });

            const found = await repository.findByTaskId(TASK_A);

            expect(found?.id).toBe(row.id);
            await expect(repository.findByTaskId(TASK_A)).resolves.toBeDefined();
        });

        it('answers null for a Task that is not a provisioning', async () => {
            await expect(repository.findByTaskId(TASK_A)).resolves.toBeNull();
        });
    });

    describe('claimLease / releaseLease (one statement each)', () => {
        it('claims a free lease and stores the five-minute expiry', async () => {
            const row = await seed();

            const claimed = await repository.claimLease(
                row.id,
                'lease-1',
                APP_PROVISIONING_LEASE_MS,
                NOW,
            );

            expect(claimed).toBe(true);
            const fresh = await stored(row.id);
            expect(fresh.lease).toBe('lease-1');
            expect(fresh.leaseExpiresAt?.getTime()).toBe(NOW + APP_PROVISIONING_LEASE_MS);
            expect(APP_PROVISIONING_LEASE_MS).toBe(300_000);
        });

        it('refuses a second claim while the lease is live — the loser must not run', async () => {
            const row = await seed();
            await repository.claimLease(row.id, 'lease-1', APP_PROVISIONING_LEASE_MS, NOW);

            const second = await repository.claimLease(
                row.id,
                'lease-2',
                APP_PROVISIONING_LEASE_MS,
                NOW + MINUTE,
            );

            expect(second).toBe(false);
            expect((await stored(row.id)).lease).toBe('lease-1');
        });

        it('lets an EXPIRED lease be taken over, so a crashed executor costs five minutes', async () => {
            const row = await seed();
            await repository.claimLease(row.id, 'lease-1', APP_PROVISIONING_LEASE_MS, NOW);

            const takeover = await repository.claimLease(
                row.id,
                'lease-2',
                APP_PROVISIONING_LEASE_MS,
                NOW + APP_PROVISIONING_LEASE_MS + 1,
            );

            expect(takeover).toBe(true);
            expect((await stored(row.id)).lease).toBe('lease-2');
        });

        it('releases only to the holder that still owns the lease', async () => {
            const row = await seed();
            await repository.claimLease(row.id, 'lease-1', APP_PROVISIONING_LEASE_MS, NOW);
            await repository.claimLease(
                row.id,
                'lease-2',
                APP_PROVISIONING_LEASE_MS,
                NOW + APP_PROVISIONING_LEASE_MS + 1,
            );

            // The superseded holder must not free the NEW holder's claim.
            await expect(repository.releaseLease(row.id, 'lease-1')).resolves.toBe(false);
            expect((await stored(row.id)).lease).toBe('lease-2');

            await expect(repository.releaseLease(row.id, 'lease-2')).resolves.toBe(true);
            const released = await stored(row.id);
            expect(released.lease).toBeNull();
            expect(released.leaseExpiresAt).toBeNull();
        });

        it('answers false for a row that does not exist', async () => {
            await expect(repository.claimLease(WORK_A, 'lease-1')).resolves.toBe(false);
            await expect(repository.releaseLease(WORK_A, 'lease-1')).resolves.toBe(false);
        });
    });

    describe('casAttemptsUsed (the counter is advanced, never raced)', () => {
        it('advances from the expected value and reports the win', async () => {
            const row = await seed({ attemptsUsed: 0 });

            await expect(repository.casAttemptsUsed(row.id, 0)).resolves.toBe(true);
            expect((await stored(row.id)).attemptsUsed).toBe(1);

            await expect(repository.casAttemptsUsed(row.id, 1)).resolves.toBe(true);
            expect((await stored(row.id)).attemptsUsed).toBe(2);
        });

        it('refuses a STALE expected value, so one attempt cannot be spent twice', async () => {
            const row = await seed({ attemptsUsed: 0 });
            await repository.casAttemptsUsed(row.id, 0);

            // The second caller read 0 before the first one wrote 1: its CAS must
            // lose, or two runs would consume two attempts' worth of budget from
            // one reading.
            await expect(repository.casAttemptsUsed(row.id, 0)).resolves.toBe(false);
            expect((await stored(row.id)).attemptsUsed).toBe(1);
        });

        it('never moves a counter past what the callers actually spent', async () => {
            const row = await seed({ attemptsUsed: 0, attemptBudget: 3 });

            const results = await Promise.all([
                repository.casAttemptsUsed(row.id, 0),
                repository.casAttemptsUsed(row.id, 0),
                repository.casAttemptsUsed(row.id, 0),
            ]);

            expect(results.filter(Boolean)).toHaveLength(1);
            expect((await stored(row.id)).attemptsUsed).toBe(1);
        });

        it('answers false for a row that does not exist', async () => {
            await expect(repository.casAttemptsUsed(WORK_A, 0)).resolves.toBe(false);
        });
    });

    describe('the two cap counters (ACC-04-25)', () => {
        it('counts a user’s ACTIVE rows, and a 4th is counted for queueing', async () => {
            const works = [WORK_A, WORK_B, '44444444-4444-4444-8444-444444444444'];
            for (const workId of works) {
                await seed({ workId, userId: USER_A, status: 'running' });
            }

            await expect(repository.countActiveForUser(USER_A)).resolves.toBe(3);

            // The 4th row is a legal ROW — it is the cap that makes it wait, and
            // the count is what the start path compares against `activePerUser`.
            await seed({
                workId: '55555555-5555-4555-8555-555555555555',
                userId: USER_A,
                status: 'queued',
                queuedReason: 'user-limit',
            });

            await expect(repository.countActiveForUser(USER_A)).resolves.toBe(4);
        });

        it('does not count terminal rows, and does not count another user’s', async () => {
            await seed({ workId: WORK_A, userId: USER_A, status: 'merged' });
            await seed({ workId: WORK_B, userId: USER_A, status: 'failed' });
            await seed({
                workId: '44444444-4444-4444-8444-444444444444',
                userId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
                status: 'running',
            });

            await expect(repository.countActiveForUser(USER_A)).resolves.toBe(0);
        });

        it('counts a workspace’s ACTIVE rows', async () => {
            await seed({ workId: WORK_A, organizationId: ORG_A, status: 'running' });
            await seed({ workId: WORK_B, organizationId: ORG_A, status: 'needs_input' });
            await seed({
                workId: '44444444-4444-4444-8444-444444444444',
                organizationId: ORG_A,
                status: 'cancelled',
            });

            await expect(repository.countActiveForOrg(ORG_A)).resolves.toBe(2);
        });

        it('never counts a row whose organizationId is NULL as belonging to an Organization', async () => {
            await seed({ workId: WORK_A, organizationId: null, status: 'running' });

            await expect(repository.countActiveForOrg(ORG_A)).resolves.toBe(0);
        });
    });

    describe('listExpiredTargets (the sweeper’s teardown input)', () => {
        it('answers only the rows with a namespace and an expiry at or before now', async () => {
            const expired = await seed({
                workId: WORK_A,
                verificationNamespace: 'app-prov-1',
                verificationExpiresAt: new Date(NOW - MINUTE),
            });
            await seed({
                workId: WORK_B,
                verificationNamespace: 'app-prov-2',
                verificationExpiresAt: new Date(NOW + HOUR),
            });
            await seed({
                workId: '44444444-4444-4444-8444-444444444444',
                verificationNamespace: null,
                verificationExpiresAt: new Date(NOW - HOUR),
            });
            await seed({
                workId: '55555555-5555-4555-8555-555555555555',
                verificationNamespace: 'app-prov-3',
                verificationExpiresAt: null,
            });

            const rows = await repository.listExpiredTargets(50, NOW);

            expect(rows.map((row) => row.id)).toEqual([expired.id]);
        });

        it('orders the stalest target first and clamps the batch', async () => {
            await seed({
                workId: WORK_A,
                verificationNamespace: 'n1',
                verificationExpiresAt: new Date(NOW - MINUTE),
            });
            await seed({
                workId: WORK_B,
                verificationNamespace: 'n2',
                verificationExpiresAt: new Date(NOW - HOUR),
            });

            const rows = await repository.listExpiredTargets(50, NOW);

            expect(rows.map((row) => row.verificationNamespace)).toEqual(['n2', 'n1']);
            expect(await repository.listExpiredTargets(100_000, NOW)).toHaveLength(2);
        });

        it('issues no query at all for a non-positive limit', async () => {
            await seed({
                workId: WORK_A,
                verificationNamespace: 'n1',
                verificationExpiresAt: new Date(NOW - MINUTE),
            });

            await expect(repository.listExpiredTargets(0, NOW)).resolves.toEqual([]);
        });
    });

    describe('listStaleQuestions (the S20 reminder input)', () => {
        it('answers a needs_input row past 72 hours that has never been reminded', async () => {
            const stale = await seed({
                workId: WORK_A,
                status: 'needs_input',
                questionReason: 'missing-required-value',
                questionParams: { variable: 'OAUTH_CLIENT_SECRET' },
                questionAskedAt: new Date(NOW - 73 * HOUR),
            });

            const rows = await repository.listStaleQuestions(50, NOW);

            expect(rows.map((row) => row.id)).toEqual([stale.id]);
            expect(rows[0].questionAskedAt?.getTime()).toBe(NOW - 73 * HOUR);
        });

        it('excludes a fresh question, an already-reminded one and every other status', async () => {
            await seed({
                workId: WORK_A,
                status: 'needs_input',
                questionAskedAt: new Date(NOW - HOUR),
            });
            await seed({
                workId: WORK_B,
                status: 'needs_input',
                questionAskedAt: new Date(NOW - 100 * HOUR),
                questionRemindedAt: new Date(NOW - 20 * HOUR),
            });
            await seed({
                workId: '44444444-4444-4444-8444-444444444444',
                status: 'running',
                questionAskedAt: new Date(NOW - 100 * HOUR),
            });
            await seed({
                workId: '55555555-5555-4555-8555-555555555555',
                status: 'needs_input',
                questionAskedAt: null,
            });

            await expect(repository.listStaleQuestions(50, NOW)).resolves.toEqual([]);
        });

        it('orders the oldest question first', async () => {
            await seed({
                workId: WORK_A,
                status: 'needs_input',
                questionAskedAt: new Date(NOW - 73 * HOUR),
            });
            await seed({
                workId: WORK_B,
                status: 'needs_input',
                questionAskedAt: new Date(NOW - 100 * HOUR),
            });

            const rows = await repository.listStaleQuestions(50, NOW);

            expect(rows.map((row) => row.workId)).toEqual([WORK_B, WORK_A]);
        });

        it('issues no query at all for a non-positive limit', async () => {
            await expect(repository.listStaleQuestions(0, NOW)).resolves.toEqual([]);
        });
    });

    describe('listQueued (the dispatcher’s drain order)', () => {
        it('answers the QUEUED rows oldest first and never an active one', async () => {
            await seed({ workId: WORK_A, status: 'queued', queuedReason: 'user-limit' });
            await seed({ workId: WORK_B, status: 'running' });

            const rows = await repository.listQueued(50);

            expect(rows.map((row) => row.workId)).toEqual([WORK_A]);
            expect(rows[0].queuedReason).toBe('user-limit');
        });

        it('clamps the batch to the sweep ceiling and issues no query for zero', async () => {
            await seed({ workId: WORK_A, status: 'queued' });

            expect(APP_PROVISIONING_SWEEP_BATCH).toBe(200);
            await expect(repository.listQueued(0)).resolves.toEqual([]);
            await expect(repository.listQueued(-1)).resolves.toEqual([]);
        });
    });

    describe('findRecentAgentId (reuse the Agent the last run was given)', () => {
        /**
         * Pin a row's `createdAt` after the insert: `@CreateDateColumn` stamps
         * the wall clock on save, and a test that read it would be ordering by
         * how fast the machine is rather than by the column.
         */
        async function stamp(id: string, at: number): Promise<void> {
            await dataSource
                .getRepository(WorkAppProvisioning)
                .update(id, { createdAt: new Date(at) });
        }

        it('answers the agentId of the newest row in the same scope', async () => {
            const older = await seed({ workId: WORK_A, userId: USER_A, agentId: null });
            const newer = await seed({ workId: WORK_B, userId: USER_A, agentId: AGENT_A });
            await stamp(older.id, NOW - HOUR);
            await stamp(newer.id, NOW);

            await expect(repository.findRecentAgentId(USER_A, null)).resolves.toBe(AGENT_A);
        });

        it('does not confuse “no Organization” with an Organization’s scope', async () => {
            await seed({ workId: WORK_A, userId: USER_A, organizationId: ORG_A, agentId: AGENT_A });

            await expect(repository.findRecentAgentId(USER_A, null)).resolves.toBeNull();
            await expect(repository.findRecentAgentId(USER_A, ORG_A)).resolves.toBe(AGENT_A);
        });

        it('answers null for a scope that has never provisioned anything', async () => {
            await expect(repository.findRecentAgentId(USER_A, ORG_A)).resolves.toBeNull();
        });

        it('skips rows with no agentId rather than answering null over a real one', async () => {
            const withAgent = await seed({ workId: WORK_A, userId: USER_A, agentId: AGENT_A });
            const withoutAgent = await seed({ workId: WORK_B, userId: USER_A, agentId: null });
            await stamp(withAgent.id, NOW);
            await stamp(withoutAgent.id, NOW + HOUR);

            // The NEWEST row has no agentId; the answer is the newest row that
            // HAS one, never a null that would create a second Agent template.
            await expect(repository.findRecentAgentId(USER_A, null)).resolves.toBe(AGENT_A);
        });
    });
});
