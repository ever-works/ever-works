import { createHash, randomBytes } from 'crypto';
import { FleetJobCompletedEvent, FleetJobLeasedEvent } from '../../events/fleet-job.events';
import { FleetJob } from '../../entities/fleet-job.entity';
import { FleetJobService, FLEET_JOB_CANCELLED_ERROR } from '../fleet-job.service';

/**
 * Agent execution v2 (slice B) — the two things `FleetJobService` learned:
 *
 *   1. it TELLS someone when a node claims a job and when a job reaches a
 *      verdict (`fleet.job.leased` / `fleet.job.completed`), so the
 *      API-side reconciler can move the AgentRun / Task along;
 *   2. it can CANCEL: a queued job is failed outright, an active one is
 *      flagged and the node's next heartbeat is refused — the "lease lost"
 *      signal the node already aborts on.
 *
 * Hand-rolled repository doubles rather than the big lease harness: the
 * behaviour under test is the service's own transitions and emissions,
 * and a narrow double makes each expectation about exactly one call.
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
        disabled: false,
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
        createdAt: new Date('2026-09-02T10:00:00Z'),
        updatedAt: new Date('2026-09-02T10:00:00Z'),
        ...over,
    } as FleetJob;
}

describe('FleetJobService — cancel + lifecycle events', () => {
    const secret = randomBytes(24).toString('base64url');
    let job: FleetJob;
    let jobs: Record<string, jest.Mock>;
    let nodes: { findById: jest.Mock };
    let emitter: { emit: jest.Mock };
    let service: FleetJobService;

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
            complete: jest.fn(async (_id: string, _nodeId: string, patch: Partial<FleetJob>) => {
                Object.assign(job, patch, { leaseExpiresAt: null });
                return true;
            }),
            cancelQueued: jest.fn(async (_id: string, error: string, completedAt: Date) => {
                if (job.status !== 'queued') return false;
                Object.assign(job, {
                    status: 'failed',
                    error,
                    completedAt,
                    cancelRequestedAt: completedAt,
                });
                return true;
            }),
            requestCancel: jest.fn(async (_id: string, at: Date) => {
                if (job.status !== 'leased' && job.status !== 'running') return false;
                if (job.cancelRequestedAt) return false;
                job.cancelRequestedAt = at;
                return true;
            }),
            findExpiredLeases: jest.fn(async () => []),
            reclaim: jest.fn(async () => true),
            failExhausted: jest.fn(
                async (_id: string, _observed: unknown, error: string, completedAt: Date) => {
                    Object.assign(job, {
                        status: 'failed',
                        error,
                        completedAt,
                        leaseExpiresAt: null,
                    });
                    return true;
                },
            ),
        };
        nodes = {
            findById: jest.fn(async (id: string) => (id === NODE ? makeNode(secret) : null)),
        };
        emitter = { emit: jest.fn() };
        service = new FleetJobService(
            jobs as never,
            nodes as never,
            { findForOwnedAgent: jest.fn(async () => null) } as never,
            emitter as never,
        );
    });

    const leaseIt = async () => {
        const leased = await service.lease({ nodeId: NODE, secret, max: 1 });
        expect(leased).toHaveLength(1);
        return leased![0];
    };

    it('emits fleet.job.leased once per claimed job', async () => {
        const view = await leaseIt();
        expect(emitter.emit).toHaveBeenCalledTimes(1);
        const [name, event] = emitter.emit.mock.calls[0];
        expect(name).toBe(FleetJobLeasedEvent.EVENT_NAME);
        expect(event).toBeInstanceOf(FleetJobLeasedEvent);
        expect(event.job.id).toBe(view.id);
        expect(event.job.status).toBe('leased');
        expect(event.nodeId).toBe(NODE);
        expect(event.userId).toBe(USER);
    });

    it('emits fleet.job.completed with the node report on complete', async () => {
        await leaseIt();
        emitter.emit.mockClear();
        const done = await service.completeJob({
            nodeId: NODE,
            secret,
            jobId: JOB,
            success: true,
            result: { status: 'succeeded', taskId: 'task-1' },
        });
        expect(done?.status).toBe('done');
        expect(emitter.emit).toHaveBeenCalledTimes(1);
        const [name, event] = emitter.emit.mock.calls[0];
        expect(name).toBe(FleetJobCompletedEvent.EVENT_NAME);
        expect(event).toBeInstanceOf(FleetJobCompletedEvent);
        expect(event.source).toBe('node-report');
        expect(event.nodeId).toBe(NODE);
        expect(event.succeeded).toBe(true);
        expect(event.result).toEqual({ status: 'succeeded', taskId: 'task-1' });
    });

    it('emits fleet.job.completed (lease-exhausted) when the reclaim sweep fails a job', async () => {
        await leaseIt();
        emitter.emit.mockClear();
        job.attempts = 3;
        job.leaseExpiresAt = new Date(Date.now() - 60_000);
        jobs.findExpiredLeases.mockResolvedValue([job]);
        const summary = await service.reclaimExpired(USER);
        expect(summary.failed).toBe(1);
        const [name, event] = emitter.emit.mock.calls[0];
        expect(name).toBe(FleetJobCompletedEvent.EVENT_NAME);
        expect(event.source).toBe('lease-exhausted');
        expect(event.succeeded).toBe(false);
        expect(event.error).toMatch(/attempt budget exhausted/);
    });

    it('never fails the lease protocol when a listener throws', async () => {
        emitter.emit.mockImplementation(() => {
            throw new Error('listener exploded');
        });
        await expect(leaseIt()).resolves.toBeDefined();
    });

    it('works with no emitter at all (positional-arity compatibility)', async () => {
        const silent = new FleetJobService(
            jobs as never,
            nodes as never,
            { findForOwnedAgent: jest.fn() } as never,
        );
        await expect(silent.lease({ nodeId: NODE, secret, max: 1 })).resolves.toHaveLength(1);
    });

    describe('cancel', () => {
        it('drops a queued job outright and emits a cancelled completion', async () => {
            const outcome = await service.cancel(JOB);
            expect(outcome).toEqual({ cancelled: true, state: 'queued-dropped' });
            expect(jobs.cancelQueued).toHaveBeenCalledWith(
                JOB,
                FLEET_JOB_CANCELLED_ERROR,
                expect.any(Date),
            );
            expect(job.status).toBe('failed');
            const [name, event] = emitter.emit.mock.calls[0];
            expect(name).toBe(FleetJobCompletedEvent.EVENT_NAME);
            expect(event.source).toBe('cancelled');
            expect(event.error).toBe(FLEET_JOB_CANCELLED_ERROR);
        });

        it('flags an active job and refuses the node’s next heartbeat', async () => {
            await leaseIt();
            emitter.emit.mockClear();
            const outcome = await service.cancel(JOB);
            expect(outcome).toEqual({ cancelled: true, state: 'cancel-requested' });
            expect(jobs.requestCancel).toHaveBeenCalledWith(JOB, expect.any(Date));
            // No completion yet — the node has not reported.
            expect(emitter.emit).not.toHaveBeenCalled();

            const beat = await service.heartbeatJob(NODE, secret, JOB, 300);
            expect(beat).toBeNull();
            expect(jobs.extendLease).not.toHaveBeenCalled();

            // The node aborts and reports; the report is still accepted.
            const reported = await service.completeJob({
                nodeId: NODE,
                secret,
                jobId: JOB,
                success: false,
                error: 'Fleet job lease was lost',
            });
            expect(reported?.status).toBe('failed');
            expect(emitter.emit.mock.calls[0][1].source).toBe('node-report');
        });

        it('is idempotent on an already-flagged job', async () => {
            await leaseIt();
            await service.cancel(JOB);
            jobs.requestCancel.mockClear();
            await expect(service.cancel(JOB)).resolves.toEqual({
                cancelled: true,
                state: 'cancel-requested',
            });
            expect(jobs.requestCancel).not.toHaveBeenCalled();
        });

        it('reports terminal and not-found honestly', async () => {
            job.status = 'done';
            await expect(service.cancel(JOB)).resolves.toEqual({
                cancelled: false,
                state: 'terminal',
            });
            await expect(service.cancel('99999999-9999-4999-8999-999999999999')).resolves.toEqual({
                cancelled: false,
                state: 'not-found',
            });
            await expect(service.cancel('run_trigger_abc')).resolves.toEqual({
                cancelled: false,
                state: 'not-found',
            });
        });

        it('falls through to the active path when a node claims the job first', async () => {
            jobs.cancelQueued.mockImplementationOnce(async () => {
                // Simulate the race: the claim landed between the read and the update.
                Object.assign(job, {
                    status: 'leased',
                    nodeId: NODE,
                    leaseExpiresAt: new Date(Date.now() + 60_000),
                });
                return false;
            });
            await expect(service.cancel(JOB)).resolves.toEqual({
                cancelled: true,
                state: 'cancel-requested',
            });
            expect(job.cancelRequestedAt).toBeInstanceOf(Date);
        });
    });
});
