import { createHash, randomBytes } from 'crypto';
import { FleetJob } from '../../entities/fleet-job.entity';
import { FleetJobService } from '../fleet-job.service';
import { FleetKillSwitchService } from '../fleet-kill-switch.service';

/**
 * Panic controls (EW-778) — EVERY lease consults the global stop flag.
 *
 * What is pinned:
 *   - a stopped fleet answers `[]` to a valid node and never claims;
 *   - a flag that CANNOT be read counts as stopped (fail-closed) — the
 *     real `FleetKillSwitchService` over a throwing repository, not a
 *     stub that happens to say true;
 *   - a bad credential is STILL a 401 (null), never "no work", so the
 *     flag cannot be used to tell the two apart;
 *   - heartbeat and complete keep working while stopped, or a stopped
 *     fleet could never settle the work it already holds;
 *   - without the service (positional-arity compatibility) the lease
 *     protocol is byte-for-byte what it was.
 */

const NODE = '11111111-1111-4111-8111-111111111111';
const JOB = '55555555-5555-4555-8555-555555555555';
const USER = 'user-1';
const sha256Hex = (value: string): string =>
    createHash('sha256').update(value, 'utf8').digest('hex');

function makeNode(secret: string) {
    return {
        id: NODE,
        userId: USER,
        status: 'online',
        enrollmentTokenHash: sha256Hex(secret),
        capabilities: ['workspace'],
    };
}

function makeJob(over: Partial<FleetJob> = {}): FleetJob {
    return {
        id: JOB,
        userId: USER,
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
        cancelRequestedAt: null,
        startedAt: null,
        completedAt: null,
        createdAt: new Date('2026-09-05T10:00:00Z'),
        updatedAt: new Date('2026-09-05T10:00:00Z'),
        // Suspend-safe leases (EW-792): a claim carries a generation and the
        // platform refuses 0. The literal is cast, so leaving this out would
        // read as undefined and every settle below would be a stale lease.
        leaseGeneration: 1,
        ...over,
    } as FleetJob;
}

describe('FleetJobService — global stop flag on the lease path', () => {
    const secret = randomBytes(24).toString('base64url');
    let job: FleetJob;
    let jobs: Record<string, jest.Mock>;
    let nodes: { findById: jest.Mock };
    let killSwitch: { isStopped: jest.Mock };

    const build = (switchImpl?: unknown) =>
        new FleetJobService(
            jobs as never,
            nodes as never,
            { findForOwnedAgent: jest.fn(async () => null) } as never,
            undefined,
            switchImpl as never,
        );

    beforeEach(() => {
        job = makeJob();
        jobs = {
            findById: jest.fn(async (id: string) => (id === job.id ? job : null)),
            findQueuedForNode: jest.fn(async () => [job]),
            claim: jest.fn(async (_id: string, patch: Partial<FleetJob>) => {
                Object.assign(job, patch);
                return true;
            }),
            extendLease: jest.fn(async () => true),
            complete: jest.fn(async () => true),
            findExpiredLeases: jest.fn(async () => []),
        };
        nodes = {
            findById: jest.fn(async (id: string) => (id === NODE ? makeNode(secret) : null)),
        };
        killSwitch = { isStopped: jest.fn(async () => false) };
    });

    it('leases normally while the flag is clear', async () => {
        const leased = await build(killSwitch).lease({ nodeId: NODE, secret, max: 1 });
        expect(leased).toHaveLength(1);
        expect(jobs.claim).toHaveBeenCalledTimes(1);
    });

    it('answers [] and never claims while the flag is set', async () => {
        killSwitch.isStopped.mockResolvedValue(true);
        const leased = await build(killSwitch).lease({ nodeId: NODE, secret, max: 1 });
        expect(leased).toEqual([]);
        expect(jobs.claim).not.toHaveBeenCalled();
        expect(jobs.findQueuedForNode).not.toHaveBeenCalled();
        // Not even the inline reclaim runs — a stopped fleet writes nothing.
        expect(jobs.findExpiredLeases).not.toHaveBeenCalled();
        expect(job.status).toBe('queued');
    });

    /**
     * Fail-closed, end to end: the REAL kill-switch service over a
     * repository that cannot read the row. The service folds that into
     * "stopped", and the lease honours it.
     */
    it('refuses to lease when the flag CANNOT be read (fail-closed)', async () => {
        const realSwitch = new FleetKillSwitchService(
            { read: jest.fn(async () => Promise.reject(new Error('db down'))) } as never,
            { record: jest.fn() } as never,
        );
        jest.spyOn(
            (realSwitch as never as { logger: { error: () => void } }).logger,
            'error',
        ).mockImplementation(() => undefined);

        const leased = await build(realSwitch).lease({ nodeId: NODE, secret, max: 1 });
        expect(leased).toEqual([]);
        expect(jobs.claim).not.toHaveBeenCalled();
    });

    /**
     * Fail-closed at the LEASE, not only inside the service: a port that
     * throws (a stub, a future implementation) must still mean "no work".
     */
    it('refuses to lease when isStopped() itself THROWS (fail-closed)', async () => {
        killSwitch.isStopped.mockRejectedValueOnce(new Error('boom'));
        const service = build(killSwitch);
        jest.spyOn(
            (service as never as { logger: { error: () => void } }).logger,
            'error',
        ).mockImplementation(() => undefined);

        const leased = await service.lease({ nodeId: NODE, secret, max: 1 });
        expect(leased).toEqual([]);
        expect(jobs.claim).not.toHaveBeenCalled();
        expect(jobs.findQueuedForNode).not.toHaveBeenCalled();
        expect(jobs.findExpiredLeases).not.toHaveBeenCalled();
    });

    it('refuses to lease when the row is missing (migration not applied)', async () => {
        const realSwitch = new FleetKillSwitchService(
            { read: jest.fn(async () => null) } as never,
            { record: jest.fn() } as never,
        );
        jest.spyOn(
            (realSwitch as never as { logger: { error: () => void } }).logger,
            'error',
        ).mockImplementation(() => undefined);

        await expect(build(realSwitch).lease({ nodeId: NODE, secret, max: 1 })).resolves.toEqual(
            [],
        );
    });

    it('still answers 401 (null) to a bad credential while stopped — never "no work"', async () => {
        killSwitch.isStopped.mockResolvedValue(true);
        const leased = await build(killSwitch).lease({ nodeId: NODE, secret: 'wrong-secret' });
        expect(leased).toBeNull();
        // Auth comes first; the flag is not even consulted for a stranger.
        expect(killSwitch.isStopped).not.toHaveBeenCalled();
    });

    it('keeps accepting job heartbeats while stopped', async () => {
        killSwitch.isStopped.mockResolvedValue(true);
        job = makeJob({ nodeId: NODE, status: 'leased', leaseExpiresAt: new Date() });
        const beat = await build(killSwitch).heartbeatJob(NODE, secret, JOB, 60, 1);
        expect(beat?.status).toBe('running');
        expect(jobs.extendLease).toHaveBeenCalledTimes(1);
    });

    it('keeps accepting job completions while stopped', async () => {
        killSwitch.isStopped.mockResolvedValue(true);
        job = makeJob({ nodeId: NODE, status: 'running', leaseExpiresAt: new Date() });
        const done = await build(killSwitch).completeJob({
            nodeId: NODE,
            secret,
            jobId: JOB,
            success: true,
            result: { ok: true },
            leaseGeneration: 1,
        });
        expect(done?.status).toBe('done');
        expect(jobs.complete).toHaveBeenCalledTimes(1);
    });

    it('leases as before when no kill switch is bound (positional-arity compatibility)', async () => {
        const leased = await build(undefined).lease({ nodeId: NODE, secret, max: 1 });
        expect(leased).toHaveLength(1);
        expect(jobs.claim).toHaveBeenCalledTimes(1);
    });
});
