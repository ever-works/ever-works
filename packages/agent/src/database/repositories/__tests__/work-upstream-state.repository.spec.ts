import { DataSource } from 'typeorm';
import { WorkUpstreamState } from '../../../entities/work-upstream-state.entity';
import { ENTITIES } from '../../_entities-inventory';
import {
    UPSTREAM_RECHECK_INTERVAL_MS,
    UPSTREAM_SYNC_CLAIM_LEASE_MS,
    WorkUpstreamStateRepository,
} from '../work-upstream-state.repository';

/**
 * APW-02 T14 — the Upstream state repository, executed against a real
 * (in-memory better-sqlite3) database rather than a mocked repository: the
 * conditional UPDATEs, the `bigint` epoch comparisons and the unique index are
 * the ones production runs, and the dispatcher that calls `claimDue` and
 * `claimSetupPullRequestChecks` runs on every API replica at once.
 *
 * better-sqlite3 is the default `DATABASE_TYPE` (every local and self-hosted
 * install) and the driver CI and the e2e lane use, so a claim that only holds
 * under a pooled driver is not a claim that holds.
 *
 * Spec FR-19, FR-23, FR-24a, FR-33, FR-41, FR-44, FR-52; plan §3.1
 * (`plan.md:265-270`) and §6.6 (`plan.md:809-814`) for how each method is
 * called. Every uuid below is obviously synthetic.
 */

const WORK_A = '11111111-1111-4111-8111-111111111111';
const WORK_B = '22222222-2222-4222-8222-222222222222';
const WORK_C = '33333333-3333-4333-8333-333333333333';

/** A fixed "now" so every window and lease is exact, never wall-clock flaky. */
const NOW = Date.parse('2026-03-01T06:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 3_600_000;

describe('WorkUpstreamStateRepository', () => {
    let dataSource: DataSource;
    let repository: WorkUpstreamStateRepository;

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
            logging: false,
        });
        await dataSource.initialize();
        // The owning Work row is not what is under test; the FK itself is
        // asserted in `apps/api/.../CreateWorkUpstreamStates.spec.ts`.
        await dataSource.query('PRAGMA foreign_keys = OFF');
        repository = new WorkUpstreamStateRepository(dataSource.getRepository(WorkUpstreamState));
    });

    afterAll(async () => {
        await dataSource.destroy();
    });

    beforeEach(async () => {
        await dataSource.getRepository(WorkUpstreamState).clear();
    });

    /** Insert a row directly, so a test can start from any stored state. */
    function seed(
        workId: string,
        overrides: Partial<WorkUpstreamState> = {},
    ): Promise<WorkUpstreamState> {
        const rows = dataSource.getRepository(WorkUpstreamState);
        return rows.save(
            rows.create({
                workId,
                relation: 'fork',
                dataOwner: 'ever-works',
                dataRepo: 'demo',
                dataDefaultBranch: 'main',
                upstreamOwner: 'upstream',
                upstreamRepo: 'demo',
                upstreamDefaultBranch: 'main',
                readinessStartedAt: new Date(NOW),
                ...overrides,
            }),
        );
    }

    /** Re-read a row from the database, never from the object a method returned. */
    async function stored(workId: string): Promise<WorkUpstreamState> {
        return dataSource.getRepository(WorkUpstreamState).findOneOrFail({ where: { workId } });
    }

    const ids = (rows: WorkUpstreamState[]) => rows.map((row) => row.workId).sort();

    /** The order a call returned its rows in — `ids` sorts, this one does not. */
    const order = (rows: WorkUpstreamState[]) => rows.map((row) => row.workId);

    /** A distinct synthetic Work id, for the tests that walk a list of states. */
    const workIdAt = (index: number) =>
        `${String(index).padStart(8, '0')}-0000-4000-8000-000000000000`;

    describe('findByWorkId / create / update', () => {
        it('starts a created row on the documented defaults', async () => {
            await repository.create({
                workId: WORK_A,
                relation: 'private-copy',
                dataOwner: 'ever-works',
                dataRepo: 'demo',
                dataDefaultBranch: 'trunk',
            });

            const row = await stored(WORK_A);
            expect(row.relation).toBe('private-copy');
            expect(row.dataOwner).toBe('ever-works');
            expect(row.dataDefaultBranch).toBe('trunk');
            // plan §3.1:220-251 — the values the Upstream card renders before
            // anything has happened.
            expect(row.readinessState).toBe('preparing');
            expect(row.upstreamStatus).toBe('unknown');
            expect(row.dataRepositoryStatus).toBe('available');
            expect(row.actionsState).toBe('pending');
            expect(Number(row.readinessDispatches)).toBe(0);
            expect(Number(row.readinessManualRetries)).toBe(0);
            expect(Number(row.manualSyncCount)).toBe(0);
            expect(Number(row.consecutiveRateLimited)).toBe(0);
            expect(row.nextSyncAt ?? null).toBeNull();
            expect(row.readinessHeartbeatAt ?? null).toBeNull();
            expect(row.readyAt ?? null).toBeNull();
            expect(row.tenantId ?? null).toBeNull();
            // FR-44: a linked Work has no upstream coordinates at all.
            expect(row.upstreamOwner ?? null).toBeNull();
            expect(row.upstreamRepo ?? null).toBeNull();
        });

        it('always writes the readiness clock the stale sweep measures against', async () => {
            await repository.create({
                workId: WORK_A,
                relation: 'link',
                dataOwner: 'ever-works',
                dataRepo: 'demo',
                dataDefaultBranch: 'main',
            });

            const row = await stored(WORK_A);
            expect(row.readinessStartedAt).toBeInstanceOf(Date);
            expect(row.readinessStartedAt.getTime()).toBeGreaterThan(NOW);
        });

        it('honours an explicit readiness clock and schedule', async () => {
            await repository.create({
                workId: WORK_A,
                relation: 'fork',
                dataOwner: 'ever-works',
                dataRepo: 'demo',
                dataDefaultBranch: 'main',
                readinessStartedAt: new Date(NOW),
                syncSchedule: '0 6 * * 1',
                nextSyncAt: new Date(NOW + HOUR),
            });

            const row = await stored(WORK_A);
            expect(row.readinessStartedAt.getTime()).toBe(NOW);
            expect(row.syncSchedule).toBe('0 6 * * 1');
            expect(row.nextSyncAt?.getTime()).toBe(NOW + HOUR);
        });

        it('refuses a second row for the same App Work (one row per Work)', async () => {
            await repository.create({
                workId: WORK_A,
                relation: 'fork',
                dataOwner: 'ever-works',
                dataRepo: 'demo',
                dataDefaultBranch: 'main',
            });

            await expect(
                repository.create({
                    workId: WORK_A,
                    relation: 'fork',
                    dataOwner: 'ever-works',
                    dataRepo: 'demo',
                    dataDefaultBranch: 'main',
                }),
            ).rejects.toThrow();
        });

        it('reads back nothing for a Work that has no state row', async () => {
            expect(await repository.findByWorkId(WORK_A)).toBeNull();
        });

        it('patches one Work’s row, and reports a missing row instead of succeeding silently', async () => {
            await seed(WORK_A);
            await seed(WORK_B);

            await expect(repository.update(WORK_A, { readinessState: 'ready' })).resolves.toBe(
                true,
            );
            await expect(repository.update(WORK_C, { readinessState: 'ready' })).resolves.toBe(
                false,
            );

            expect((await stored(WORK_A)).readinessState).toBe('ready');
            expect((await stored(WORK_B)).readinessState).toBe('preparing');
        });

        it('round-trips a Date patch into the bigint column', async () => {
            await seed(WORK_A);

            await repository.update(WORK_A, {
                nextSyncAt: new Date(NOW + HOUR),
                setupCheckedAt: new Date(NOW - MINUTE),
            });

            const row = await stored(WORK_A);
            expect(row.nextSyncAt).toBeInstanceOf(Date);
            expect(row.nextSyncAt?.getTime()).toBe(NOW + HOUR);
            expect(row.setupCheckedAt?.getTime()).toBe(NOW - MINUTE);
        });
    });

    describe('the credential of record (APW-09 T43, FR-43)', () => {
        // Two Organizations, so "one Work's row" and "another Organization's
        // Work" are two different rows in every assertion below.
        const ORG_A = '44444444-4444-4444-8444-444444444444';
        const ORG_B = '55555555-5555-4555-8555-555555555555';
        const MEMBER_ONE = '66666666-6666-4666-8666-666666666666';
        const MEMBER_TWO = '77777777-7777-4777-8777-777777777777';

        it('reads nothing for a Work that has no state row at all', async () => {
            await expect(repository.findCredentialMemberUserId(WORK_A)).resolves.toBeNull();
        });

        it('leaves a freshly created row with no credential — a handover is the only writer', async () => {
            await repository.create({
                workId: WORK_A,
                relation: 'fork',
                dataOwner: 'ever-works',
                dataRepo: 'demo',
                dataDefaultBranch: 'main',
                organizationId: ORG_A,
            });

            await expect(repository.findCredentialMemberUserId(WORK_A)).resolves.toBeNull();
            expect((await stored(WORK_A)).credentialMemberUserId ?? null).toBeNull();
        });

        it('round-trips a handover through the row, not through the object it returned', async () => {
            await seed(WORK_A);

            await expect(repository.setCredentialMemberUserId(WORK_A, MEMBER_ONE)).resolves.toBe(
                true,
            );

            await expect(repository.findCredentialMemberUserId(WORK_A)).resolves.toBe(MEMBER_ONE);
            expect((await stored(WORK_A)).credentialMemberUserId).toBe(MEMBER_ONE);
        });

        it('answers the member of the Work asked about, never another Work’s', async () => {
            // The read is scoped by `workId` and by nothing else: swapping two
            // stored records must swap the two answers.
            await seed(WORK_A, { credentialMemberUserId: MEMBER_ONE });
            await seed(WORK_B, { credentialMemberUserId: MEMBER_TWO });

            await expect(repository.findCredentialMemberUserId(WORK_A)).resolves.toBe(MEMBER_ONE);
            await expect(repository.findCredentialMemberUserId(WORK_B)).resolves.toBe(MEMBER_TWO);
        });

        it('moves the record on a second handover', async () => {
            await seed(WORK_A, { credentialMemberUserId: MEMBER_ONE });

            await repository.setCredentialMemberUserId(WORK_A, MEMBER_TWO);

            await expect(repository.findCredentialMemberUserId(WORK_A)).resolves.toBe(MEMBER_TWO);
            expect((await stored(WORK_A)).credentialMemberUserId).toBe(MEMBER_TWO);
        });

        it('refuses to record a handover on a Work that has no state row, and creates none', async () => {
            // The repository's own scope rule, measured: the credential write is
            // an UPDATE keyed by `workId`, so it can only ever move a row that
            // already belongs to that exact App Work. There is no insert path —
            // a Work of another Organization therefore cannot be handed a
            // credential by naming its id.
            await expect(repository.setCredentialMemberUserId(WORK_C, MEMBER_ONE)).resolves.toBe(
                false,
            );

            expect(await repository.findCredentialMemberUserId(WORK_C)).toBeNull();
            expect(await repository.findByWorkId(WORK_C)).toBeNull();
        });

        it('scopes the write to the one Work named, and reaches no other Work — including another Organization’s', async () => {
            await seed(WORK_A, { organizationId: ORG_A });
            await seed(WORK_B, { organizationId: ORG_B, credentialMemberUserId: MEMBER_TWO });

            await repository.setCredentialMemberUserId(WORK_A, MEMBER_ONE);

            expect((await stored(WORK_A)).credentialMemberUserId).toBe(MEMBER_ONE);
            // The other Work — stamped with the other Organization — is exactly
            // as it was, credential included.
            const other = await stored(WORK_B);
            expect(other.credentialMemberUserId).toBe(MEMBER_TWO);
            expect(other.organizationId).toBe(ORG_B);
        });

        it('carries the tenant and organization stamps through a credential write, and rewrites neither', async () => {
            // The scope columns are carried stamps on this row, never predicates
            // and never patch targets: `findByWorkId` / `update` filter on
            // `workId` alone (the Work is the scope — `uq_work_upstream_states_work`),
            // and the visibility rule that decides WHO may hand over lives one
            // layer up (`WorkRepository.findByIdForAccess` plus membership, read
            // by `AppUpstreamStateService.requireVisibleAppWork` and the
            // credential service's own `hasEditAccess`). Pinned here so a later
            // change to this repository cannot silently move a row between
            // Organizations as a side effect of a handover.
            await seed(WORK_A, { tenantId: 'tenant-1', organizationId: ORG_A });

            await repository.setCredentialMemberUserId(WORK_A, MEMBER_ONE);

            const row = await stored(WORK_A);
            expect(row.credentialMemberUserId).toBe(MEMBER_ONE);
            expect(row.tenantId).toBe('tenant-1');
            expect(row.organizationId).toBe(ORG_A);
        });
    });

    describe('claimDue (plan §3.1, §6.6)', () => {
        it('claims only rows whose slot has arrived', async () => {
            await seed(WORK_A, { nextSyncAt: new Date(NOW - MINUTE) });
            await seed(WORK_B, { nextSyncAt: new Date(NOW + HOUR) });
            // NULL is the paused state and the `link` relation: never claimed.
            await seed(WORK_C, { nextSyncAt: null, relation: 'link' });

            expect(ids(await repository.claimDue(NOW, 50))).toEqual([WORK_A]);
        });

        it('stamps the claim lease, so the row is not due again while it is in flight', async () => {
            await seed(WORK_A, { nextSyncAt: new Date(NOW - MINUTE) });

            await repository.claimDue(NOW, 50);

            const row = await stored(WORK_A);
            expect(row.nextSyncAt?.getTime()).toBe(NOW + UPSTREAM_SYNC_CLAIM_LEASE_MS);
        });

        it('reports the stamp it wrote, not the slot it selected on', async () => {
            await seed(WORK_A, { nextSyncAt: new Date(NOW - MINUTE) });

            const [claimed] = await repository.claimDue(NOW, 50);

            expect(claimed.nextSyncAt?.getTime()).toBe(NOW + UPSTREAM_SYNC_CLAIM_LEASE_MS);
        });

        it('hands a row to one caller only — a second call at the same instant claims nothing', async () => {
            await seed(WORK_A, { nextSyncAt: new Date(NOW - MINUTE) });

            expect(ids(await repository.claimDue(NOW, 50))).toEqual([WORK_A]);
            expect(await repository.claimDue(NOW, 50)).toEqual([]);
        });

        it('never returns a row twice across two concurrent calls', async () => {
            await seed(WORK_A, { nextSyncAt: new Date(NOW - MINUTE) });
            await seed(WORK_B, { nextSyncAt: new Date(NOW - MINUTE) });
            await seed(WORK_C, { nextSyncAt: new Date(NOW - 2 * MINUTE) });

            const [first, second] = await Promise.all([
                repository.claimDue(NOW, 50),
                repository.claimDue(NOW, 50),
            ]);

            const union = [...first, ...second].map((row) => row.id);
            expect(new Set(union).size).toBe(union.length);
            // Between them the two ticks dispatched each due Work exactly once.
            expect([...ids(first), ...ids(second)].sort()).toEqual([WORK_A, WORK_B, WORK_C]);
        });

        it('honours the limit and leaves the rest due for the next tick', async () => {
            await seed(WORK_A, { nextSyncAt: new Date(NOW - 3 * MINUTE) });
            await seed(WORK_B, { nextSyncAt: new Date(NOW - 2 * MINUTE) });
            await seed(WORK_C, { nextSyncAt: new Date(NOW - MINUTE) });

            expect(ids(await repository.claimDue(NOW, 2))).toEqual([WORK_A, WORK_B]);
            expect(ids(await repository.claimDue(NOW + 1, 50))).toEqual([WORK_C]);
        });

        it('claims the oldest slot first', async () => {
            await seed(WORK_A, { nextSyncAt: new Date(NOW - MINUTE) });
            await seed(WORK_B, { nextSyncAt: new Date(NOW - 3 * MINUTE) });
            await seed(WORK_C, { nextSyncAt: new Date(NOW - 2 * MINUTE) });

            expect(order(await repository.claimDue(NOW, 3))).toEqual([WORK_B, WORK_C, WORK_A]);
        });

        it('claims nothing for a non-positive or zero limit', async () => {
            await seed(WORK_A, { nextSyncAt: new Date(NOW - MINUTE) });

            expect(await repository.claimDue(NOW, 0)).toEqual([]);
            expect(await repository.claimDue(NOW, -1)).toEqual([]);
            expect((await stored(WORK_A)).nextSyncAt?.getTime()).toBe(NOW - MINUTE);
        });

        it('still claims a rate-limited row — the dispatcher, not the claim, skips it', async () => {
            // plan §6.6: `claimDue` then "skip rows with rateLimitedUntil > now",
            // so the claim has to bring the row back rather than hide it.
            await seed(WORK_A, {
                nextSyncAt: new Date(NOW - MINUTE),
                rateLimitedUntil: new Date(NOW + HOUR),
            });

            expect(ids(await repository.claimDue(NOW, 50))).toEqual([WORK_A]);
        });
    });

    describe('findStalePreparing (FR-23, S27)', () => {
        it('returns a preparing row that stopped reporting', async () => {
            await seed(WORK_A, {
                readinessState: 'preparing',
                readinessStartedAt: new Date(NOW - 30 * MINUTE),
                readinessHeartbeatAt: new Date(NOW - 20 * MINUTE),
            });

            expect(ids(await repository.findStalePreparing(NOW, 10 * MINUTE, 50))).toEqual([
                WORK_A,
            ]);
        });

        it('returns a preparing row whose job never reported at all', async () => {
            await seed(WORK_A, {
                readinessState: 'preparing',
                readinessStartedAt: new Date(NOW - 20 * MINUTE),
                readinessHeartbeatAt: null,
            });

            expect(ids(await repository.findStalePreparing(NOW, 10 * MINUTE, 50))).toEqual([
                WORK_A,
            ]);
        });

        it('leaves a row that is still reporting, or only just started, alone', async () => {
            await seed(WORK_A, {
                readinessState: 'preparing',
                readinessStartedAt: new Date(NOW - 30 * MINUTE),
                readinessHeartbeatAt: new Date(NOW - MINUTE),
            });
            await seed(WORK_B, {
                readinessState: 'preparing',
                readinessStartedAt: new Date(NOW - MINUTE),
                readinessHeartbeatAt: null,
            });

            expect(await repository.findStalePreparing(NOW, 10 * MINUTE, 50)).toEqual([]);
        });

        it('never returns a row that is not preparing', async () => {
            const states = ['ready', 'timed_out', 'failed', 'waiting_for_setup_pr'] as const;

            for (const [index, readinessState] of states.entries()) {
                await seed(workIdAt(index), {
                    readinessState,
                    readinessStartedAt: new Date(NOW - HOUR),
                    readinessHeartbeatAt: new Date(NOW - HOUR),
                });
            }

            expect(await repository.findStalePreparing(NOW, 10 * MINUTE, 50)).toEqual([]);
        });

        it('honours the limit, oldest start first', async () => {
            await seed(WORK_A, {
                readinessState: 'preparing',
                readinessStartedAt: new Date(NOW - 30 * MINUTE),
                readinessHeartbeatAt: null,
            });
            await seed(WORK_B, {
                readinessState: 'preparing',
                readinessStartedAt: new Date(NOW - 60 * MINUTE),
                readinessHeartbeatAt: null,
            });
            await seed(WORK_C, {
                readinessState: 'preparing',
                readinessStartedAt: new Date(NOW - 45 * MINUTE),
                readinessHeartbeatAt: null,
            });

            expect(order(await repository.findStalePreparing(NOW, 10 * MINUTE, 2))).toEqual([
                WORK_B,
                WORK_C,
            ]);
        });
    });

    describe('findUnavailableDueForRecheck (FR-41)', () => {
        it('returns an upstream last read back more than 24 hours ago', async () => {
            await seed(WORK_A, {
                upstreamStatus: 'unavailable',
                upstreamCheckedAt: new Date(NOW - UPSTREAM_RECHECK_INTERVAL_MS - MINUTE),
            });

            expect(ids(await repository.findUnavailableDueForRecheck(NOW, 50))).toEqual([WORK_A]);
            expect(UPSTREAM_RECHECK_INTERVAL_MS).toBe(86_400_000);
        });

        it('leaves an upstream that was checked recently alone', async () => {
            await seed(WORK_A, {
                upstreamStatus: 'unavailable',
                upstreamCheckedAt: new Date(NOW - HOUR),
            });

            expect(await repository.findUnavailableDueForRecheck(NOW, 50)).toEqual([]);
        });

        it('treats an unavailable row that was never checked as due now', async () => {
            await seed(WORK_A, { upstreamStatus: 'unavailable', upstreamCheckedAt: null });

            expect(ids(await repository.findUnavailableDueForRecheck(NOW, 50))).toEqual([WORK_A]);
        });

        it('never returns an upstream that is not unavailable', async () => {
            const statuses = ['available', 'archived', 'none', 'unknown'] as const;

            for (const [index, upstreamStatus] of statuses.entries()) {
                await seed(workIdAt(index), {
                    upstreamStatus,
                    upstreamCheckedAt: new Date(NOW - 10 * UPSTREAM_RECHECK_INTERVAL_MS),
                });
            }

            expect(await repository.findUnavailableDueForRecheck(NOW, 50)).toEqual([]);
        });

        it('honours the limit', async () => {
            await seed(WORK_A, {
                upstreamStatus: 'unavailable',
                upstreamCheckedAt: new Date(NOW - 30 * HOUR),
            });
            await seed(WORK_B, {
                upstreamStatus: 'unavailable',
                upstreamCheckedAt: new Date(NOW - 40 * HOUR),
            });

            expect(await repository.findUnavailableDueForRecheck(NOW, 1)).toHaveLength(1);
        });
    });

    describe('claimSetupPullRequestChecks (FR-24a)', () => {
        it('claims only rows waiting for their setup pull request', async () => {
            await seed(WORK_A, { readinessState: 'waiting_for_setup_pr', setupCheckedAt: null });
            await seed(WORK_B, { readinessState: 'ready', setupCheckedAt: null });
            await seed(WORK_C, { readinessState: 'preparing', setupCheckedAt: null });

            expect(ids(await repository.claimSetupPullRequestChecks(NOW, 10 * MINUTE, 50))).toEqual(
                [WORK_A],
            );
        });

        it('stamps the row it hands over, so the on-view check is throttled to once per interval', async () => {
            await seed(WORK_A, { readinessState: 'waiting_for_setup_pr', setupCheckedAt: null });

            const [claimed] = await repository.claimSetupPullRequestChecks(NOW, 10 * MINUTE, 50);
            expect(claimed.setupCheckedAt?.getTime()).toBe(NOW);
            expect((await stored(WORK_A)).setupCheckedAt?.getTime()).toBe(NOW);

            // A second tick inside the interval, and the owner opening the page
            // inside the interval, both see nothing (FR-24a's 60 s on-view rule
            // is the same predicate with a smaller interval).
            expect(await repository.claimSetupPullRequestChecks(NOW, 10 * MINUTE, 50)).toEqual([]);
            expect(await repository.claimSetupPullRequestChecks(NOW + 30_000, 60_000, 50)).toEqual(
                [],
            );
        });

        it('claims a row whose last check is older than the interval', async () => {
            await seed(WORK_A, {
                readinessState: 'waiting_for_setup_pr',
                setupCheckedAt: new Date(NOW - 11 * MINUTE),
            });

            expect(ids(await repository.claimSetupPullRequestChecks(NOW, 10 * MINUTE, 50))).toEqual(
                [WORK_A],
            );
        });

        it('never returns a row twice across two concurrent calls', async () => {
            await seed(WORK_A, { readinessState: 'waiting_for_setup_pr', setupCheckedAt: null });
            await seed(WORK_B, { readinessState: 'waiting_for_setup_pr', setupCheckedAt: null });
            await seed(WORK_C, {
                readinessState: 'waiting_for_setup_pr',
                setupCheckedAt: new Date(NOW - HOUR),
            });

            const [first, second] = await Promise.all([
                repository.claimSetupPullRequestChecks(NOW, 10 * MINUTE, 50),
                repository.claimSetupPullRequestChecks(NOW, 10 * MINUTE, 50),
            ]);

            const union = [...first, ...second].map((row) => row.id);
            expect(new Set(union).size).toBe(union.length);
            expect([...ids(first), ...ids(second)].sort()).toEqual([WORK_A, WORK_B, WORK_C]);
        });

        it('honours the limit and leaves the rest for the next tick', async () => {
            await seed(WORK_A, {
                readinessState: 'waiting_for_setup_pr',
                setupCheckedAt: new Date(NOW - 3 * HOUR),
            });
            await seed(WORK_B, {
                readinessState: 'waiting_for_setup_pr',
                setupCheckedAt: new Date(NOW - 2 * HOUR),
            });
            await seed(WORK_C, {
                readinessState: 'waiting_for_setup_pr',
                setupCheckedAt: new Date(NOW - HOUR),
            });

            expect(
                order(await repository.claimSetupPullRequestChecks(NOW, 10 * MINUTE, 2)),
            ).toEqual([WORK_A, WORK_B]);
            expect(ids(await repository.claimSetupPullRequestChecks(NOW, 10 * MINUTE, 50))).toEqual(
                [WORK_C],
            );
        });

        it('claims nothing when there is nothing waiting', async () => {
            await seed(WORK_A, { readinessState: 'ready', setupCheckedAt: null });

            expect(await repository.claimSetupPullRequestChecks(NOW, 10 * MINUTE, 50)).toEqual([]);
        });
    });

    describe('incrementManualSync (FR-33: six per rolling hour)', () => {
        it('allows six and denies the seventh', async () => {
            await seed(WORK_A);

            const allowed: boolean[] = [];
            for (let attempt = 0; attempt < 7; attempt += 1) {
                allowed.push((await repository.incrementManualSync(WORK_A, NOW, HOUR, 6)).allowed);
            }

            expect(allowed).toEqual([true, true, true, true, true, true, false]);
            expect(Number((await stored(WORK_A)).manualSyncCount)).toBe(6);
        });

        it('opens the window on the first attempt', async () => {
            await seed(WORK_A);

            const first = await repository.incrementManualSync(WORK_A, NOW, HOUR, 6);

            expect(first).toEqual({ allowed: true, count: 1, windowAtMs: NOW });
            expect((await stored(WORK_A)).manualSyncWindowAt?.getTime()).toBe(NOW);
        });

        it('rolls the window after an hour', async () => {
            await seed(WORK_A, { manualSyncCount: 6, manualSyncWindowAt: new Date(NOW - HOUR) });

            const after = await repository.incrementManualSync(WORK_A, NOW, HOUR, 6);

            expect(after.allowed).toBe(true);
            expect(after.count).toBe(1);
            expect(after.windowAtMs).toBe(NOW);
        });

        it('does not roll a window that is still open', async () => {
            await seed(WORK_A, {
                manualSyncCount: 6,
                manualSyncWindowAt: new Date(NOW - HOUR + MINUTE),
            });

            const inside = await repository.incrementManualSync(WORK_A, NOW, HOUR, 6);

            expect(inside.allowed).toBe(false);
            expect(inside.count).toBe(6);
            expect(inside.windowAtMs).toBe(NOW - HOUR + MINUTE);
        });

        it('does not advance the count when it denies', async () => {
            await seed(WORK_A, { manualSyncCount: 6, manualSyncWindowAt: new Date(NOW - MINUTE) });

            await repository.incrementManualSync(WORK_A, NOW, HOUR, 6);
            await repository.incrementManualSync(WORK_A, NOW + MINUTE, HOUR, 6);

            expect(Number((await stored(WORK_A)).manualSyncCount)).toBe(6);
        });

        it('denies every attempt when the allowance is zero, without opening a window', async () => {
            await seed(WORK_A);

            const denied = await repository.incrementManualSync(WORK_A, NOW, HOUR, 0);

            expect(denied).toEqual({ allowed: false, count: 0, windowAtMs: null });
            const row = await stored(WORK_A);
            expect(Number(row.manualSyncCount)).toBe(0);
            expect(row.manualSyncWindowAt ?? null).toBeNull();
        });

        it('denies a Work that has no state row', async () => {
            expect(await repository.incrementManualSync(WORK_C, NOW, HOUR, 6)).toEqual({
                allowed: false,
                count: 0,
                windowAtMs: null,
            });
        });

        it('counts one Work’s attempts only', async () => {
            await seed(WORK_A);
            await seed(WORK_B);

            await repository.incrementManualSync(WORK_A, NOW, HOUR, 6);
            await repository.incrementManualSync(WORK_A, NOW, HOUR, 6);
            await repository.incrementManualSync(WORK_B, NOW, HOUR, 6);

            expect(Number((await stored(WORK_A)).manualSyncCount)).toBe(2);
            expect(Number((await stored(WORK_B)).manualSyncCount)).toBe(1);
        });

        it('allows exactly six of twelve simultaneous attempts', async () => {
            await seed(WORK_A);

            const results = await Promise.all(
                Array.from({ length: 12 }, () =>
                    repository.incrementManualSync(WORK_A, NOW, HOUR, 6),
                ),
            );

            expect(results.filter((result) => result.allowed)).toHaveLength(6);
            expect(Number((await stored(WORK_A)).manualSyncCount)).toBe(6);
        });
    });

    describe('incrementManualRetry (FR-19: three per rolling hour)', () => {
        it('allows three and denies the fourth', async () => {
            await seed(WORK_A);

            const allowed: boolean[] = [];
            for (let attempt = 0; attempt < 4; attempt += 1) {
                allowed.push((await repository.incrementManualRetry(WORK_A, NOW, HOUR, 3)).allowed);
            }

            expect(allowed).toEqual([true, true, true, false]);
            expect(Number((await stored(WORK_A)).readinessManualRetries)).toBe(3);
        });

        it('rolls the retry window after an hour', async () => {
            await seed(WORK_A, {
                readinessManualRetries: 3,
                readinessManualWindowAt: new Date(NOW - HOUR),
            });

            const after = await repository.incrementManualRetry(WORK_A, NOW, HOUR, 3);

            expect(after).toEqual({ allowed: true, count: 1, windowAtMs: NOW });
        });

        it('keeps the two allowances apart', async () => {
            await seed(WORK_A);

            for (let attempt = 0; attempt < 6; attempt += 1) {
                await repository.incrementManualSync(WORK_A, NOW, HOUR, 6);
            }

            // Sync now being exhausted must not cost the owner a Try again.
            const retry = await repository.incrementManualRetry(WORK_A, NOW, HOUR, 3);
            expect(retry.allowed).toBe(true);

            const row = await stored(WORK_A);
            expect(Number(row.manualSyncCount)).toBe(6);
            expect(Number(row.readinessManualRetries)).toBe(1);
        });
    });
});
