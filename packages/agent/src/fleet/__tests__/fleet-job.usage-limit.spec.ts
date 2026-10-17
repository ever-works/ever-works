import { createHash, randomBytes } from 'crypto';
import {
    FLEET_JOB_FAILURE_KIND_MODEL_USAGE_LIMIT,
    FLEET_JOB_MAX_USAGE_LIMIT_PARKS,
    FLEET_JOB_MODEL_USAGE_LIMIT_QUEUED_REASON,
} from '@ever-works/contracts';
import { FleetJobCompletedEvent, FleetJobParkedEvent } from '../../events/fleet-job.events';
import type { FleetJob } from '../../entities/fleet-job.entity';
import { blockedByModelThrottle, FleetJobService } from '../fleet-job.service';

/**
 * Fleet usage limits on the platform (prod, 2026-10-17).
 *
 * A Task pinned to an Agent on EVERDESK4 failed with Claude Code's "You've
 * hit your weekly limit · resets Oct 19, 3am (Europe/Paris)". Pinned here:
 * such a result PARKS the job instead of settling it — back to `queued`,
 * attempt refunded, re-leasable after the reset — throttles that CLI on that
 * node (a pinned job waits for it, an unpinned one goes elsewhere), fires a
 * park event (never a completion, so no run fails and no Agent error is
 * counted), and announces a NEW throttle window only once.
 */

const NODE_A = '11111111-1111-4111-8111-111111111111';
const NODE_B = '22222222-2222-4222-8222-222222222222';
const USER = 'owner-1';
const RESET = new Date(Date.now() + 36 * 3_600_000).toISOString();
const sha256Hex = (value: string): string =>
    createHash('sha256').update(value, 'utf8').digest('hex');

type Row = FleetJob;

const usageLimitResult = () => ({
    status: 'failed',
    taskId: 'task-13',
    runId: 'run-13',
    failureKind: FLEET_JOB_FAILURE_KIND_MODEL_USAGE_LIMIT,
    modelUsageLimit: {
        provider: 'claude-code',
        window: 'weekly',
        resetsAt: RESET,
        retryAfter: RESET,
        message: "You've hit your weekly limit · resets Oct 19, 3am (Europe/Paris)",
    },
});

describe('FleetJobService — model usage limits', () => {
    const secretA = randomBytes(24).toString('base64url');
    const secretB = randomBytes(24).toString('base64url');
    let rows: Row[];
    let nodeRows: Record<string, Record<string, unknown>>;
    let emitter: { emit: jest.Mock };
    let nodes: { findById: jest.Mock; update: jest.Mock };
    let service: FleetJobService;

    const active = (row: Row, id: string, nodeId: string, generation: number) =>
        row.id === id &&
        row.nodeId === nodeId &&
        row.leaseGeneration === generation &&
        (row.status === 'leased' || row.status === 'running');

    beforeEach(() => {
        rows = [];
        nodeRows = {
            [NODE_A]: {
                id: NODE_A,
                userId: USER,
                name: 'everdesk4',
                status: 'online',
                enrollmentTokenHash: sha256Hex(secretA),
                capabilities: ['claude-code'],
                modelThrottles: null,
            },
            [NODE_B]: {
                id: NODE_B,
                userId: USER,
                name: 'everdesk5',
                status: 'online',
                enrollmentTokenHash: sha256Hex(secretB),
                capabilities: ['claude-code'],
                modelThrottles: null,
            },
        };
        nodes = {
            findById: jest.fn(async (id: string) => (nodeRows[id] ? { ...nodeRows[id] } : null)),
            update: jest.fn(async (id: string, patch: Record<string, unknown>) => {
                Object.assign(nodeRows[id], patch);
            }),
        };
        const jobs = {
            findById: jest.fn(async (id: string) => rows.find((r) => r.id === id) ?? null),
            findQueuedForNode: jest.fn(async (userId: string, nodeId: string) =>
                rows.filter(
                    (r) =>
                        r.userId === userId &&
                        r.status === 'queued' &&
                        (!r.targetNodeId || r.targetNodeId === nodeId),
                ),
            ),
            claim: jest.fn(async (id: string, patch: Record<string, unknown>) => {
                const row = rows.find(
                    (r) =>
                        r.id === id &&
                        r.status === 'queued' &&
                        r.leaseGeneration === (patch.leaseGeneration as number) - 1,
                );
                if (!row) return false;
                Object.assign(row, patch);
                return true;
            }),
            complete: jest.fn(
                async (
                    id: string,
                    nodeId: string,
                    patch: Record<string, unknown>,
                    generation: number,
                ) => {
                    const row = rows.find((r) => active(r, id, nodeId, generation));
                    if (!row) return false;
                    Object.assign(row, patch, { leaseExpiresAt: null });
                    return true;
                },
            ),
            parkForUsageLimit: jest.fn(
                async (
                    id: string,
                    nodeId: string,
                    generation: number,
                    patch: Record<string, unknown>,
                ) => {
                    const row = rows.find((r) => active(r, id, nodeId, generation));
                    if (!row) return false;
                    Object.assign(row, patch, {
                        status: 'queued',
                        nodeId: null,
                        leaseExpiresAt: null,
                        startedAt: null,
                    });
                    return true;
                },
            ),
            findExpiredLeases: jest.fn(async () => []),
        };
        emitter = { emit: jest.fn() };
        service = new FleetJobService(
            jobs as never,
            nodes as never,
            { findForOwnedAgent: jest.fn(async () => null) } as never,
            emitter as never,
        );
    });

    const addJob = (overrides: Partial<Row> = {}): Row => {
        const row = {
            id: `job-${rows.length + 1}`,
            userId: USER,
            kind: 'agent-task',
            status: 'queued',
            nodeId: null,
            targetNodeId: null,
            payload: { taskId: 'task-13', runId: 'run-13', execution: { provider: 'claude-code' } },
            requiredCapabilities: ['claude-code'],
            attempts: 0,
            maxAttempts: 3,
            leaseGeneration: 0,
            usageLimitParks: 0,
            leaseExpiresAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            ...overrides,
        } as Row;
        rows.push(row);
        return row;
    };
    const leaseAs = (nodeId: string, secret: string) => service.lease({ nodeId, secret, max: 1 });
    const completeAs = (
        nodeId: string,
        secret: string,
        jobId: string,
        result: Record<string, unknown>,
    ) =>
        service.completeJob({
            nodeId,
            secret,
            jobId,
            success: true,
            result,
            leaseGeneration: rows.find((r) => r.id === jobId)!.leaseGeneration,
        });
    const events = (name: string) =>
        emitter.emit.mock.calls.filter(([eventName]) => eventName === name);

    it('parks a pinned job, refunds the attempt, and keeps it off its node until the reset', async () => {
        const job = addJob({ targetNodeId: NODE_A });
        expect(await leaseAs(NODE_A, secretA)).toHaveLength(1);
        expect(job.attempts).toBe(1);

        const view = await completeAs(NODE_A, secretA, job.id, usageLimitResult());

        expect(view?.status).toBe('queued');
        expect(job).toMatchObject({
            status: 'queued',
            nodeId: null,
            attempts: 0,
            usageLimitParks: 1,
            queuedReason: FLEET_JOB_MODEL_USAGE_LIMIT_QUEUED_REASON,
        });
        // The queue SLA measures from the reset, not from the limit.
        expect(job.queuedAt?.toISOString()).toBe(RESET);
        // A park is never a completion: nothing downstream may settle the run.
        expect(events(FleetJobCompletedEvent.EVENT_NAME)).toHaveLength(0);
        const [[, parked]] = events(FleetJobParkedEvent.EVENT_NAME) as [
            [string, FleetJobParkedEvent],
        ];
        expect(parked).toMatchObject({ nodeId: NODE_A, nodeName: 'everdesk4', newWindow: true });
        expect(parked.limit).toMatchObject({
            provider: 'claude-code',
            window: 'weekly',
            retryAfter: RESET,
        });
        expect(nodeRows[NODE_A].modelThrottles).toEqual([
            expect.objectContaining({ provider: 'claude-code', window: 'weekly', until: RESET }),
        ]);

        // Pinned: the throttled node does not get it back, and no other node may.
        expect(await leaseAs(NODE_A, secretA)).toEqual([]);
        expect(await leaseAs(NODE_B, secretB)).toEqual([]);

        // After the reset the node takes it again.
        nodeRows[NODE_A].modelThrottles = [
            {
                provider: 'claude-code',
                window: 'weekly',
                until: new Date(Date.now() - 1).toISOString(),
                reason: 'x',
                since: RESET,
            },
        ];
        expect(await leaseAs(NODE_A, secretA)).toHaveLength(1);
    });

    it('lets another node take an unpinned parked job, and announces a window only once', async () => {
        const first = addJob();
        const second = addJob();
        await leaseAs(NODE_A, secretA);
        await completeAs(NODE_A, secretA, first.id, usageLimitResult());

        // The throttled node skips BOTH claude-code jobs; the other node takes one.
        expect(await leaseAs(NODE_A, secretA)).toEqual([]);
        const [onB] = (await leaseAs(NODE_B, secretB))!;
        expect([first.id, second.id]).toContain(onB.id);

        // Node A hitting the same limit again (an older daemon that does not
        // throttle itself) is not a new window: no second notice.
        nodeRows[NODE_A].modelThrottles = null;
        const other = rows.find((r) => r.status === 'queued')!;
        await leaseAs(NODE_A, secretA);
        nodeRows[NODE_A].modelThrottles = [
            { provider: 'claude-code', window: 'weekly', until: RESET, reason: 'x', since: RESET },
        ];
        await completeAs(NODE_A, secretA, other.id, usageLimitResult());
        const parks = events(FleetJobParkedEvent.EVENT_NAME).map(
            ([, event]) => (event as FleetJobParkedEvent).newWindow,
        );
        expect(parks).toEqual([true, false]);
    });

    it("recognises an OLDER node's plain failure result from the model summary", async () => {
        const job = addJob();
        await leaseAs(NODE_A, secretA);
        await completeAs(NODE_A, secretA, job.id, {
            status: 'failed',
            taskId: 'task-13',
            runId: 'run-13',
            failureReason:
                "claude-code reported an error: You've hit your weekly limit · resets Oct 19, 3am (Europe/Paris)",
            model: {
                provider: 'claude-code',
                status: 'failed',
                summary: "You've hit your weekly limit · resets Oct 19, 3am (Europe/Paris)",
            },
        });
        expect(job.status).toBe('queued');
        expect(events(FleetJobCompletedEvent.EVENT_NAME)).toHaveLength(0);
    });

    it('settles ordinary failures, and a job past its park budget, the ordinary way', async () => {
        const failed = addJob();
        await leaseAs(NODE_A, secretA);
        await completeAs(NODE_A, secretA, failed.id, {
            status: 'failed',
            taskId: 'task-13',
            runId: 'run-13',
            failureReason: 'a required acceptance check did not pass',
        });
        expect(failed.status).toBe('done');

        const exhausted = addJob({ usageLimitParks: FLEET_JOB_MAX_USAGE_LIMIT_PARKS });
        await leaseAs(NODE_A, secretA);
        await completeAs(NODE_A, secretA, exhausted.id, usageLimitResult());
        expect(exhausted.status).toBe('done');
        expect(events(FleetJobCompletedEvent.EVENT_NAME)).toHaveLength(2);
        expect(events(FleetJobParkedEvent.EVENT_NAME)).toHaveLength(0);
    });
});

describe('blockedByModelThrottle', () => {
    const throttled = new Set(['claude-code']);

    it('blocks a job that needs the throttled CLI, by tag or by its execution block', () => {
        expect(
            blockedByModelThrottle(
                { kind: 'agent-task', requiredCapabilities: ['claude-code'], payload: null },
                throttled,
            ),
        ).toBe(true);
        expect(
            blockedByModelThrottle(
                {
                    kind: 'agent-task',
                    requiredCapabilities: [],
                    payload: { execution: { provider: 'claude-code' } },
                },
                throttled,
            ),
        ).toBe(true);
    });

    it('leaves other CLIs, other kinds and an empty throttle set alone', () => {
        expect(
            blockedByModelThrottle(
                {
                    kind: 'agent-task',
                    requiredCapabilities: ['codex'],
                    payload: { execution: { provider: 'codex' } },
                },
                throttled,
            ),
        ).toBe(false);
        expect(
            blockedByModelThrottle(
                {
                    kind: 'acceptance-checks',
                    requiredCapabilities: [],
                    payload: { execution: { provider: 'claude-code' } },
                },
                throttled,
            ),
        ).toBe(false);
        expect(
            blockedByModelThrottle(
                { kind: 'agent-task', requiredCapabilities: ['claude-code'], payload: null },
                new Set(),
            ),
        ).toBe(false);
    });
});
