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
});
