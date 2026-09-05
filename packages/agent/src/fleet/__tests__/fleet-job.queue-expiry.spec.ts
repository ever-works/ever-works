import { createHash, randomBytes } from 'crypto';
import { IsNull, LessThan } from 'typeorm';
import {
    FLEET_JOB_QUEUE_EXPIRED_REASON,
    isQueueExpiredError,
    QUEUED_REASON_WAITING_FOR_RUNNER,
} from '@ever-works/contracts';
import { FleetJobCompletedEvent, FleetJobLeasedEvent } from '../../events/fleet-job.events';
import { FleetJob } from '../../entities/fleet-job.entity';
import { FleetJobRepository } from '../fleet-job.repository';
import { FleetJobService } from '../fleet-job.service';

/**
 * Self-build slice S (EW-775) — the two things `FleetJobService` learned
 * so a queued job can never wait forever:
 *
 *   1. the QUEUE SLA (`expireQueued`): a `queued` row older than its
 *      kind's max age is failed with the stable
 *      `queued-max-age-exceeded` prefix and exactly ONE
 *      `fleet.job.completed` (source `queue-expired`), through a CAS that
 *      loses to any claim / cancel / reclaim that lands first;
 *   2. HEARTBEAT PROMOTION (`promoteWaitingForNode`): when an eligible
 *      runner beats online and idle, `waiting-for-runner` is cleared on
 *      the rows it could lease — and on nothing else.
 *
 * Hand-rolled repository doubles over an in-memory table whose
 * conditional writes honour the same WHERE semantics the real repository
 * pins, because those conditions ARE the exactly-once guarantee.
 */

const NODE_A = '11111111-1111-4111-8111-111111111111';
const NODE_B = '22222222-2222-4222-8222-222222222222';
const OWNER = 'owner-1';
const OTHER_OWNER = 'owner-2';
const HOUR = 60 * 60 * 1000;

const sha256Hex = (value: string): string =>
    createHash('sha256').update(value, 'utf8').digest('hex');

function makeNode(id: string, secret: string, over: Record<string, unknown> = {}) {
    return {
        id,
        userId: OWNER,
        status: 'online',
        disabled: false,
        enrollmentTokenHash: sha256Hex(secret),
        capabilities: ['workspace', 'claude-code'],
        ...over,
    };
}

let seq = 0;
function makeJob(over: Partial<FleetJob> = {}): FleetJob {
    seq += 1;
    const created = new Date(Date.now() - 25 * HOUR);
    return {
        id: `job-${seq}`,
        userId: OWNER,
        organizationId: null,
        nodeId: null,
        targetNodeId: null,
        kind: 'agent-task',
        status: 'queued',
        payload: { taskId: 'task-1', runId: 'run-1', agentId: 'agent-1' },
        requiredCapabilities: [],
        leaseExpiresAt: null,
        attempts: 0,
        maxAttempts: 3,
        idempotencyKey: null,
        result: null,
        error: null,
        queuedReason: null,
        queuedAt: created,
        cancelRequestedAt: null,
        startedAt: null,
        completedAt: null,
        createdAt: created,
        updatedAt: created,
        ...over,
    } as FleetJob;
}

describe('FleetJobService — queue SLA + heartbeat promotion', () => {
    const originalEnv = process.env;
    const secretA = randomBytes(24).toString('base64url');
    let table: FleetJob[];
    let nodes: Array<ReturnType<typeof makeNode>>;
    let jobs: Record<string, jest.Mock>;
    let emitter: { emit: jest.Mock };
    let service: FleetJobService;

    const completions = (): FleetJobCompletedEvent[] =>
        emitter.emit.mock.calls
            .filter(([name]) => name === FleetJobCompletedEvent.EVENT_NAME)
            .map(([, event]) => event as FleetJobCompletedEvent);

    beforeEach(() => {
        process.env = { ...originalEnv };
        for (const key of Object.keys(process.env)) {
            if (key.startsWith('FLEET_NODE_QUEUE_MAX_AGE_SECONDS')) delete process.env[key];
        }
        table = [];
        nodes = [makeNode(NODE_A, secretA)];
        jobs = {
            findById: jest.fn(async (id: string) => table.find((j) => j.id === id) ?? null),
            findQueuedForNode: jest.fn(async (userId: string, nodeId: string, limit: number) =>
                table
                    .filter(
                        (j) =>
                            j.userId === userId &&
                            j.status === 'queued' &&
                            (!j.targetNodeId || j.targetNodeId === nodeId),
                    )
                    .slice(0, limit),
            ),
            claim: jest.fn(async (id: string, patch: Partial<FleetJob>) => {
                const row = table.find(
                    (j) => j.id === id && j.status === 'queued' && !j.cancelRequestedAt,
                );
                if (!row) return false;
                Object.assign(row, patch);
                return true;
            }),
            findExpiredLeases: jest.fn(async () => []),
            reclaim: jest.fn(async () => true),
            failExhausted: jest.fn(async () => true),
            findActiveForUser: jest.fn(async (userId: string) =>
                table.filter(
                    (j) =>
                        j.userId === userId &&
                        (j.status === 'leased' || j.status === 'running') &&
                        Boolean(j.nodeId),
                ),
            ),
            findQueuedOlderThan: jest.fn(
                async (kind: string, cutoff: Date, limit: number, userId?: string) =>
                    table
                        .filter(
                            (j) =>
                                (!userId || j.userId === userId) &&
                                j.kind === kind &&
                                j.status === 'queued' &&
                                Boolean(j.queuedAt) &&
                                j.queuedAt!.getTime() < cutoff.getTime() &&
                                !j.cancelRequestedAt,
                        )
                        .sort((a, b) => a.queuedAt!.getTime() - b.queuedAt!.getTime())
                        .slice(0, limit),
            ),
            failQueuedExpired: jest.fn(
                async (id: string, cutoff: Date, error: string, completedAt: Date) => {
                    // The real CAS: still queued, clock still older than the
                    // cutoff, not cancelled.
                    const row = table.find(
                        (j) =>
                            j.id === id &&
                            j.status === 'queued' &&
                            Boolean(j.queuedAt) &&
                            j.queuedAt!.getTime() < cutoff.getTime() &&
                            !j.cancelRequestedAt,
                    );
                    if (!row) return false;
                    Object.assign(row, {
                        status: 'failed',
                        error,
                        completedAt,
                        leaseExpiresAt: null,
                        queuedReason: null,
                    });
                    return true;
                },
            ),
            findWaitingForNode: jest.fn(async (userId: string, nodeId: string, limit: number) =>
                table
                    .filter(
                        (j) =>
                            j.userId === userId &&
                            j.status === 'queued' &&
                            j.queuedReason === QUEUED_REASON_WAITING_FOR_RUNNER &&
                            (!j.targetNodeId || j.targetNodeId === nodeId),
                    )
                    .slice(0, limit),
            ),
            promoteWaiting: jest.fn(async (id: string) => {
                const row = table.find(
                    (j) =>
                        j.id === id &&
                        j.status === 'queued' &&
                        j.queuedReason === QUEUED_REASON_WAITING_FOR_RUNNER,
                );
                if (!row) return false;
                row.queuedReason = null;
                return true;
            }),
        };
        emitter = { emit: jest.fn() };
        service = new FleetJobService(
            jobs as never,
            {
                findById: jest.fn(async (id: string) => nodes.find((n) => n.id === id) ?? null),
            } as never,
            { findForOwnedAgent: jest.fn(async () => null) } as never,
            emitter as never,
        );
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    describe('expireQueued', () => {
        it('fails a queued row older than its kind max age with the stable reason, exactly once', async () => {
            const job = makeJob();
            table.push(job);

            await expect(service.expireQueued()).resolves.toEqual({ scanned: 1, expired: 1 });

            expect(job.status).toBe('failed');
            expect(job.error!.startsWith(`${FLEET_JOB_QUEUE_EXPIRED_REASON}: `)).toBe(true);
            expect(isQueueExpiredError(job.error)).toBe(true);
            expect(job.error).toContain('24h');
            expect(job.queuedReason).toBeNull();
            expect(job.completedAt).toBeInstanceOf(Date);
            // `queuedAt` is evidence of how long it waited; it is not erased.
            expect(job.queuedAt).toBeInstanceOf(Date);

            const events = completions();
            expect(events).toHaveLength(1);
            expect(events[0].source).toBe('queue-expired');
            expect(events[0].userId).toBe(OWNER);
            expect(events[0].nodeId).toBeNull();
            expect(events[0].error).toBe(job.error);
            expect(events[0].job).toMatchObject({
                id: job.id,
                status: 'failed',
                queuedReason: null,
                leaseExpiresAt: null,
            });
            expect(events[0].job.queuedAt).toBe(job.queuedAt!.toISOString());
            expect(events[0].succeeded).toBe(false);

            // Settled rows are terminal: a second pass finds nothing.
            await expect(service.expireQueued()).resolves.toEqual({ scanned: 0, expired: 0 });
            expect(completions()).toHaveLength(1);
        });

        it('names the pinned node and the required tags in the reason', async () => {
            const job = makeJob({
                targetNodeId: NODE_B,
                requiredCapabilities: ['workspace', 'codex'],
            });
            table.push(job);

            await service.expireQueued();

            expect(job.error).toContain(`pinned to node ${NODE_B}`);
            expect(job.error).toContain('requires workspace, codex');
        });

        it('uses per-kind cutoffs: 3h is fresh for an agent-task and stale for a check', async () => {
            const threeHoursAgo = new Date(Date.now() - 3 * HOUR);
            const agentTask = makeJob({ queuedAt: threeHoursAgo });
            const checks = makeJob({ kind: 'acceptance-checks', queuedAt: threeHoursAgo });
            const browser = makeJob({ kind: 'browser-check', queuedAt: threeHoursAgo });
            table.push(agentTask, checks, browser);

            await expect(service.expireQueued()).resolves.toEqual({ scanned: 2, expired: 2 });

            expect(agentTask.status).toBe('queued');
            expect(checks.status).toBe('failed');
            expect(browser.status).toBe('failed');
            expect(checks.error).toContain('2h');
        });

        it('honours the per-kind env override, clamped to the floor (never disabled)', async () => {
            process.env.FLEET_NODE_QUEUE_MAX_AGE_SECONDS_AGENT_TASK = '120';
            const threeMinutes = makeJob({ queuedAt: new Date(Date.now() - 3 * 60_000) });
            // 90s, not 60s: the cutoff is `now - floor` and the CAS is a
            // strict `<`, so a row sitting EXACTLY on the floor expires only
            // if a millisecond ticks between its creation and the scan — a
            // clock race, not the clamp under test. 90s is still under the
            // 120s override above and over the 60s floor below.
            const ninetySeconds = makeJob({ queuedAt: new Date(Date.now() - 90_000) });
            table.push(threeMinutes, ninetySeconds);

            await service.expireQueued();
            expect(threeMinutes.status).toBe('failed');
            expect(threeMinutes.error).toContain('2m');
            expect(ninetySeconds.status).toBe('queued');

            // `10` clamps UP to the 60s floor: an operator cannot make the
            // SLA fire instantly, and `0` / garbage falls back to the
            // default rather than to "never".
            process.env.FLEET_NODE_QUEUE_MAX_AGE_SECONDS_AGENT_TASK = '10';
            const thirtySeconds = makeJob({ queuedAt: new Date(Date.now() - 30_000) });
            table.push(thirtySeconds);
            await service.expireQueued();
            expect(thirtySeconds.status).toBe('queued');
            expect(ninetySeconds.status).toBe('failed');

            process.env.FLEET_NODE_QUEUE_MAX_AGE_SECONDS_AGENT_TASK = '0';
            const twoHours = makeJob({ queuedAt: new Date(Date.now() - 2 * HOUR) });
            table.push(twoHours);
            await service.expireQueued();
            expect(twoHours.status).toBe('queued');
        });

        it('applies the all-kinds env value beneath the per-kind one', async () => {
            process.env.FLEET_NODE_QUEUE_MAX_AGE_SECONDS = '3600';
            process.env.FLEET_NODE_QUEUE_MAX_AGE_SECONDS_BROWSER_CHECK = '7200';
            const agentTask = makeJob({ queuedAt: new Date(Date.now() - 1.5 * HOUR) });
            const browser = makeJob({
                kind: 'browser-check',
                queuedAt: new Date(Date.now() - 1.5 * HOUR),
            });
            table.push(agentTask, browser);

            await service.expireQueued();

            expect(agentTask.status).toBe('failed');
            expect(browser.status).toBe('queued');
        });

        it('leaves fresh rows, unknown-age rows and cancel-requested rows alone', async () => {
            const fresh = makeJob({ queuedAt: new Date(Date.now() - HOUR) });
            const unknownAge = makeJob({ queuedAt: null });
            const cancelled = makeJob({ cancelRequestedAt: new Date() });
            const leased = makeJob({ status: 'leased', nodeId: NODE_A });
            table.push(fresh, unknownAge, cancelled, leased);

            await expect(service.expireQueued()).resolves.toEqual({ scanned: 0, expired: 0 });

            expect(table.map((j) => j.status)).toEqual(['queued', 'queued', 'queued', 'leased']);
            expect(completions()).toHaveLength(0);
        });

        it('never destructively fails an unknown age even if the scan returns one', async () => {
            // Belt on top of the query predicate: a driver that returned a
            // NULL-clock row must still not have it failed.
            const unknownAge = makeJob({ queuedAt: null });
            table.push(unknownAge);
            jobs.findQueuedOlderThan.mockResolvedValueOnce([unknownAge]);

            await expect(service.expireQueued()).resolves.toEqual({ scanned: 1, expired: 0 });
            expect(unknownAge.status).toBe('queued');
            expect(jobs.failQueuedExpired).not.toHaveBeenCalled();
        });

        it('loses to a claim that lands between the scan and the write — no event', async () => {
            const job = makeJob();
            table.push(job);
            // A node claims the row after the scan snapshot was taken.
            jobs.findQueuedOlderThan.mockImplementationOnce(async () => {
                const snapshot = { ...job } as FleetJob;
                Object.assign(job, { status: 'leased', nodeId: NODE_A });
                return [snapshot];
            });

            await expect(service.expireQueued()).resolves.toEqual({ scanned: 1, expired: 0 });

            expect(job.status).toBe('leased');
            expect(completions()).toHaveLength(0);
        });

        it('loses to a reclaim that re-stamped the clock between the scan and the write', async () => {
            const job = makeJob();
            table.push(job);
            jobs.findQueuedOlderThan.mockImplementationOnce(async () => {
                const snapshot = { ...job } as FleetJob;
                // Reclaim returned the row to the pool with a fresh clock.
                job.queuedAt = new Date();
                return [snapshot];
            });

            await expect(service.expireQueued()).resolves.toEqual({ scanned: 1, expired: 0 });
            expect(job.status).toBe('queued');
            expect(completions()).toHaveLength(0);
        });

        it('settles a backfilled row whose stored clock the driver cannot read back exactly', async () => {
            // The migration backfills `queuedAt = createdAt`, and `createdAt`
            // is stamped by the DATABASE clock: microsecond precision on
            // Postgres, whole seconds on sqlite. What TypeORM hands the
            // service is a JS Date that only approximates the stored value,
            // so the CAS must be a "still older than the cutoff" check, never
            // "equal to the instant we read". Modelled here as a scan that
            // returns a snapshot 1 ms off the row's own clock — the smallest
            // drift a JS Date can express.
            const job = makeJob({ queuedAt: new Date(Date.now() - 48 * HOUR) });
            table.push(job);
            // Kind-aware: the scan runs once per kind and this row is an
            // `agent-task`, so it must surface under the 24h pass only.
            jobs.findQueuedOlderThan.mockImplementation(async (kind: string) =>
                kind === 'agent-task'
                    ? [{ ...job, queuedAt: new Date(job.queuedAt!.getTime() - 1) } as FleetJob]
                    : [],
            );

            const scanStartedAt = Date.now();
            await expect(service.expireQueued()).resolves.toEqual({ scanned: 1, expired: 1 });

            expect(job.status).toBe('failed');
            expect(completions()).toHaveLength(1);
            // The CAS was pinned to the kind's cutoff (now - 24h), not to the
            // row's clock.
            const [, pinnedTo] = jobs.failQueuedExpired.mock.calls[0];
            expect(pinnedTo).toBeInstanceOf(Date);
            expect(pinnedTo.getTime()).toBeGreaterThan(job.queuedAt!.getTime());
            expect(pinnedTo.getTime()).toBeGreaterThanOrEqual(scanStartedAt - 24 * HOUR);
            expect(pinnedTo.getTime()).toBeLessThanOrEqual(Date.now() - 24 * HOUR);
        });

        it('is best-effort per row: one bad row does not abort the sweep', async () => {
            const bad = makeJob();
            const good = makeJob();
            table.push(bad, good);
            jobs.failQueuedExpired.mockImplementationOnce(async () => {
                throw new Error('deadlock');
            });

            await expect(service.expireQueued()).resolves.toEqual({ scanned: 2, expired: 1 });
            expect(bad.status).toBe('queued');
            expect(good.status).toBe('failed');
        });

        it('is owner-scoped on the lease path and global on the cron', async () => {
            const mine = makeJob();
            const theirs = makeJob({ userId: OTHER_OWNER });
            table.push(mine, theirs);

            // The lease poll runs the owner-scoped expiry inline and never
            // offers the expired row.
            const leased = await service.lease({ nodeId: NODE_A, secret: secretA, max: 5 });
            expect(leased).toEqual([]);
            expect(mine.status).toBe('failed');
            expect(theirs.status).toBe('queued');
            expect(jobs.findQueuedOlderThan).toHaveBeenCalledWith(
                'agent-task',
                expect.any(Date),
                expect.any(Number),
                OWNER,
            );

            // The cron reaches the owner whose runners are all offline.
            await expect(service.expireQueued()).resolves.toEqual({ scanned: 1, expired: 1 });
            expect(theirs.status).toBe('failed');
        });

        it('never refuses a healthy node its work when the SLA scan itself fails', async () => {
            const fresh = makeJob({ queuedAt: new Date() });
            table.push(fresh);
            jobs.findQueuedOlderThan.mockRejectedValue(new Error('column missing'));

            const leased = await service.lease({ nodeId: NODE_A, secret: secretA });

            expect(leased).toHaveLength(1);
            expect(leased![0].id).toBe(fresh.id);
        });
    });

    describe('promoteWaitingForNode', () => {
        const waiting = (over: Partial<FleetJob> = {}): FleetJob =>
            makeJob({
                queuedReason: QUEUED_REASON_WAITING_FOR_RUNNER,
                queuedAt: new Date(Date.now() - HOUR),
                ...over,
            });

        it('clears waiting-for-runner only on the rows this node could lease', async () => {
            const unbound = waiting();
            const pinnedHere = waiting({ targetNodeId: NODE_A });
            const pinnedElsewhere = waiting({ targetNodeId: NODE_B });
            const tagMismatch = waiting({ requiredCapabilities: ['gpu'] });
            const tagMatch = waiting({ requiredCapabilities: ['claude-code'] });
            const otherOwner = waiting({ userId: OTHER_OWNER });
            const cancelled = waiting({ cancelRequestedAt: new Date() });
            const notWaiting = makeJob({ queuedAt: new Date() });
            table.push(
                unbound,
                pinnedHere,
                pinnedElsewhere,
                tagMismatch,
                tagMatch,
                otherOwner,
                cancelled,
                notWaiting,
            );

            await expect(service.promoteWaitingForNode(NODE_A)).resolves.toBe(3);

            expect(unbound.queuedReason).toBeNull();
            expect(pinnedHere.queuedReason).toBeNull();
            expect(tagMatch.queuedReason).toBeNull();
            expect(pinnedElsewhere.queuedReason).toBe(QUEUED_REASON_WAITING_FOR_RUNNER);
            expect(tagMismatch.queuedReason).toBe(QUEUED_REASON_WAITING_FOR_RUNNER);
            expect(otherOwner.queuedReason).toBe(QUEUED_REASON_WAITING_FOR_RUNNER);
            expect(cancelled.queuedReason).toBe(QUEUED_REASON_WAITING_FOR_RUNNER);
            expect(notWaiting.queuedReason).toBeNull();
            // A promotion does not make the job younger.
            expect(unbound.queuedAt!.getTime()).toBeLessThan(Date.now() - HOUR + 5_000);

            // Idempotent: nothing left to promote.
            await expect(service.promoteWaitingForNode(NODE_A)).resolves.toBe(0);
        });

        it.each([
            ['offline', { status: 'offline' }],
            ['paused', { status: 'paused' }],
            ['disabled', { status: 'disabled' }],
        ])('promotes nothing for a %s node', async (_label, over) => {
            nodes = [makeNode(NODE_A, secretA, over)];
            const row = waiting();
            table.push(row);

            await expect(service.promoteWaitingForNode(NODE_A)).resolves.toBe(0);
            expect(row.queuedReason).toBe(QUEUED_REASON_WAITING_FOR_RUNNER);
        });

        it('promotes nothing for an unknown or malformed node id', async () => {
            const row = waiting();
            table.push(row);

            await expect(service.promoteWaitingForNode(NODE_B)).resolves.toBe(0);
            await expect(service.promoteWaitingForNode('not-a-uuid')).resolves.toBe(0);
            expect(row.queuedReason).toBe(QUEUED_REASON_WAITING_FOR_RUNNER);
        });

        it('promotes nothing while the node still holds a claim — a busy runner cannot take it', async () => {
            const running = makeJob({ status: 'running', nodeId: NODE_A });
            const row = waiting();
            table.push(running, row);

            await expect(service.promoteWaitingForNode(NODE_A)).resolves.toBe(0);
            expect(row.queuedReason).toBe(QUEUED_REASON_WAITING_FOR_RUNNER);
        });

        it('a promoted row still leases normally afterwards', async () => {
            const row = waiting();
            table.push(row);
            await service.promoteWaitingForNode(NODE_A);

            const leased = await service.lease({ nodeId: NODE_A, secret: secretA });

            expect(leased).toHaveLength(1);
            expect(leased![0]).toMatchObject({ id: row.id, status: 'leased', queuedReason: null });
            expect(leased![0].queuedAt).toBe(row.queuedAt!.toISOString());
            expect(emitter.emit).toHaveBeenCalledWith(
                FleetJobLeasedEvent.EVENT_NAME,
                expect.any(FleetJobLeasedEvent),
            );
        });

        it('never throws — a promotion failure must not fail the beat', async () => {
            table.push(waiting());
            jobs.findWaitingForNode.mockRejectedValue(new Error('db down'));

            await expect(service.promoteWaitingForNode(NODE_A)).resolves.toBe(0);
        });
    });
});

/**
 * The repository's own contribution: the SLA clock is stamped wherever a
 * row ENTERS `queued`, and the two new conditional writes pin exactly the
 * preconditions the service relies on. A fake TypeORM repository records
 * the WHERE / patch pairs, because those pairs are the contract.
 */
describe('FleetJobRepository — queue SLA writes', () => {
    let typeorm: { create: jest.Mock; save: jest.Mock; update: jest.Mock; find: jest.Mock };
    let repository: FleetJobRepository;

    beforeEach(() => {
        typeorm = {
            create: jest.fn((data: unknown) => data),
            save: jest.fn(async (data: unknown) => data),
            update: jest.fn(async () => ({ affected: 1 })),
            find: jest.fn(async () => []),
        };
        repository = new FleetJobRepository(typeorm as never);
    });

    it('stamps queuedAt at create', async () => {
        await repository.create({ userId: OWNER, kind: 'agent-task' });
        expect(typeorm.create.mock.calls[0][0]).toMatchObject({
            status: 'queued',
            queuedAt: expect.any(Date),
        });
    });

    it('re-stamps queuedAt when reclaim and drain return a row to the pool', async () => {
        const observed = { status: 'running' as const, nodeId: NODE_A, leaseExpiresAt: new Date() };
        await repository.reclaim('job-1', observed);
        expect(typeorm.update.mock.calls[0][1]).toMatchObject({
            status: 'queued',
            nodeId: null,
            queuedReason: null,
            queuedAt: expect.any(Date),
        });

        await repository.releaseClaimsForNode(OWNER, NODE_A);
        expect(typeorm.update.mock.calls[1][1]).toMatchObject({
            status: 'queued',
            nodeId: null,
            queuedAt: expect.any(Date),
        });
    });

    it('failQueuedExpired pins queued + still-older-than-the-cutoff + not-cancelled, never an exact clock', async () => {
        const cutoff = new Date('2026-09-01T00:00:00Z');
        const completedAt = new Date();
        await repository.failQueuedExpired('job-1', cutoff, 'why', completedAt);

        const [where, patch] = typeorm.update.mock.calls[0];
        // `LessThan(cutoff)`, not `queuedAt: <the instant the scan read>`:
        // a backfilled clock comes from the database's own `now()` /
        // `datetime('now')`, which a JS Date cannot reproduce bit-for-bit
        // (microseconds on Postgres, no fraction on sqlite), so an
        // equality pin would never settle the rows the backfill targets.
        expect(where).toEqual({
            id: 'job-1',
            status: 'queued',
            queuedAt: LessThan(cutoff),
            cancelRequestedAt: IsNull(),
        });
        expect(where.queuedAt).not.toEqual(cutoff);
        expect(patch).toEqual({
            status: 'failed',
            error: 'why',
            completedAt,
            leaseExpiresAt: null,
            queuedReason: null,
        });
    });

    it('findQueuedOlderThan scans one kind, oldest first, cancel-free, optionally owner-scoped', async () => {
        const cutoff = new Date();
        await repository.findQueuedOlderThan('browser-check', cutoff, 7, OWNER);
        expect(typeorm.find.mock.calls[0][0]).toEqual({
            where: {
                userId: OWNER,
                kind: 'browser-check',
                status: 'queued',
                queuedAt: LessThan(cutoff),
                cancelRequestedAt: IsNull(),
            },
            order: { queuedAt: 'ASC' },
            take: 7,
        });

        await repository.findQueuedOlderThan('agent-task', cutoff, 7);
        expect(typeorm.find.mock.calls[1][0].where).not.toHaveProperty('userId');
    });

    it('promoteWaiting pins the token so a claim that already cleared it is a no-op', async () => {
        await repository.promoteWaiting('job-1');
        expect(typeorm.update.mock.calls[0]).toEqual([
            { id: 'job-1', status: 'queued', queuedReason: QUEUED_REASON_WAITING_FOR_RUNNER },
            { queuedReason: null },
        ]);
    });

    it('findWaitingForNode reads unbound rows and rows pinned to this node, never another pin', async () => {
        await repository.findWaitingForNode(OWNER, NODE_A, 9);
        const { where } = typeorm.find.mock.calls[0][0];
        expect(where).toEqual([
            {
                userId: OWNER,
                status: 'queued',
                queuedReason: QUEUED_REASON_WAITING_FOR_RUNNER,
                targetNodeId: IsNull(),
            },
            {
                userId: OWNER,
                status: 'queued',
                queuedReason: QUEUED_REASON_WAITING_FOR_RUNNER,
                targetNodeId: NODE_A,
            },
        ]);
    });
});
