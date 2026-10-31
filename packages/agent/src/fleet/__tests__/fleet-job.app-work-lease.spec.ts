import { createHash, randomBytes } from 'crypto';
import { FleetJob } from '../../entities/fleet-job.entity';
import { FleetJobService } from '../fleet-job.service';

/**
 * APW-08 T12 / T48 (review of #3040, MAJOR 2) — the LEASE judges the node that actually takes an
 * App Work job.
 *
 * Dispatch admits a run some eligible node may take; whichever node polls first is the one that
 * leases it. So for an `agent-task` job whose platform-written payload names its App Work
 * (`appWorkId`), `lease()` asks `FleetAppWorkLeaseAdmission` about THIS node and simply does not
 * offer the job to a node it refuses (the job stays queued for an admissible node, or until the
 * queue SLA). Pinned:
 *   - an admitted node leases it; a refused node gets `[]` and never claims;
 *   - a port that throws, or no port at all, refuses (fail closed);
 *   - a job without the marker — every other job — leases exactly as before, with no question.
 */

const NODE = '11111111-1111-4111-8111-111111111111';
const JOB = '55555555-5555-4555-8555-555555555555';
const USER = 'user-1';
const sha256Hex = (value: string): string =>
    createHash('sha256').update(value, 'utf8').digest('hex');

function makeJob(over: Partial<FleetJob> = {}): FleetJob {
    return {
        id: JOB,
        userId: USER,
        organizationId: null,
        nodeId: null,
        targetNodeId: null,
        kind: 'agent-task',
        status: 'queued',
        payload: { taskId: 'task-1', runId: 'run-1', agentId: 'agent-1', appWorkId: 'work-app' },
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
        createdAt: new Date('2026-10-30T10:00:00Z'),
        updatedAt: new Date('2026-10-30T10:00:00Z'),
        leaseGeneration: 1,
        ...over,
    } as FleetJob;
}

describe('FleetJobService — App Work lease admission (APW-08 T12 / T48)', () => {
    const secret = randomBytes(24).toString('base64url');
    let job: FleetJob;
    let jobs: Record<string, jest.Mock>;
    let nodes: { findById: jest.Mock };
    let admission: { admitsLease: jest.Mock };

    const build = (port: unknown = admission) =>
        new FleetJobService(
            jobs as never,
            nodes as never,
            { findForOwnedAgent: jest.fn(async () => null) } as never,
            undefined,
            undefined,
            port as never,
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
            findExpiredLeases: jest.fn(async () => []),
        };
        nodes = {
            findById: jest.fn(async (id: string) =>
                id === NODE
                    ? {
                          id: NODE,
                          userId: USER,
                          status: 'online',
                          enrollmentTokenHash: sha256Hex(secret),
                          capabilities: [],
                      }
                    : null,
            ),
        };
        admission = { admitsLease: jest.fn(async () => true) };
    });

    it('offers the App Work job to a node the admission admits, asking about THAT node', async () => {
        const leased = await build().lease({ nodeId: NODE, secret, max: 1 });
        expect(leased).toHaveLength(1);
        expect(admission.admitsLease).toHaveBeenCalledWith({
            userId: USER,
            nodeId: NODE,
            workId: 'work-app',
            jobId: JOB,
            // APW-08 T51 — the job's Task, so a node that reported a missing tool is passed over.
            taskId: 'task-1',
        });
        expect(jobs.claim).toHaveBeenCalledTimes(1);
    });

    it('does not offer it to a node the admission refuses: [] and no claim — the job stays queued', async () => {
        admission.admitsLease.mockResolvedValue(false);
        expect(await build().lease({ nodeId: NODE, secret, max: 1 })).toEqual([]);
        expect(jobs.claim).not.toHaveBeenCalled();
        expect(job.status).toBe('queued');
    });

    it('fails closed: a port that throws, or no port at all, offers nothing', async () => {
        admission.admitsLease.mockRejectedValue(new Error('db down'));
        expect(await build().lease({ nodeId: NODE, secret, max: 1 })).toEqual([]);
        expect(await build(undefined).lease({ nodeId: NODE, secret, max: 1 })).toEqual([]);
        expect(jobs.claim).not.toHaveBeenCalled();
    });

    it('leases every job WITHOUT the marker exactly as before, asking nothing', async () => {
        job = makeJob({ payload: { taskId: 'task-1', runId: 'run-1', agentId: 'agent-1' } });
        admission.admitsLease.mockResolvedValue(false);
        expect(await build().lease({ nodeId: NODE, secret, max: 1 })).toHaveLength(1);
        expect(admission.admitsLease).not.toHaveBeenCalled();

        job = makeJob({ kind: 'acceptance-checks' as FleetJob['kind'], status: 'queued' });
        expect(await build(undefined).lease({ nodeId: NODE, secret, max: 1 })).toHaveLength(1);
    });

    // APW-08 T43 — `app.change.run_admitted` is reported for the node that WON the claim.
    it('reports a WON App Work lease once, with the node, the Work and the Task', async () => {
        const onLeased = jest.fn(async () => undefined);
        const leased = await build({ ...admission, onLeased }).lease({ nodeId: NODE, secret, max: 1 });
        expect(leased).toHaveLength(1);
        expect(onLeased).toHaveBeenCalledTimes(1);
        expect(onLeased).toHaveBeenCalledWith({
            userId: USER,
            nodeId: NODE,
            workId: 'work-app',
            jobId: JOB,
            taskId: 'task-1',
        });
    });

    it('reports nothing for a claim lost to another node, or for a job without the marker', async () => {
        const onLeased = jest.fn(async () => undefined);
        jobs.claim.mockResolvedValueOnce(false);
        expect(await build({ ...admission, onLeased }).lease({ nodeId: NODE, secret, max: 1 })).toEqual([]);
        job = makeJob({ payload: { taskId: 'task-1', runId: 'run-1', agentId: 'agent-1' } });
        expect(await build({ ...admission, onLeased }).lease({ nodeId: NODE, secret, max: 1 })).toHaveLength(1);
        expect(onLeased).not.toHaveBeenCalled();
    });

    it('a report that throws never costs the lease anything', async () => {
        const onLeased = jest.fn(async () => {
            throw new Error('sink down');
        });
        expect(await build({ ...admission, onLeased }).lease({ nodeId: NODE, secret, max: 1 })).toHaveLength(1);
    });

    it('a report still pending never delays the lease (CodeRabbit on #3047)', async () => {
        let release!: () => void;
        const pending = new Promise<void>((resolve) => {
            release = resolve;
        });
        const onLeased = jest.fn(() => pending);
        // `lease()` resolves while the report is still pending: it is never awaited.
        const leased = await build({ ...admission, onLeased }).lease({ nodeId: NODE, secret, max: 1 });
        expect(leased).toHaveLength(1);
        expect(onLeased).toHaveBeenCalledTimes(1);
        release();
        await pending;
    });
});
