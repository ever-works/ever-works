import { FleetJobCompletedEvent } from '@ever-works/agent/events';
import type { FleetAgentTaskResult, FleetJobView } from '@ever-works/contracts';
import { FleetAgentTaskReconcilerService } from '../fleet-agent-task-reconciler.service';

/**
 * APW-08 T48 (FR-70, ACC-08-34) — the reconciler hands a node's RAW containment block to the
 * containment recorder (the 14th, optional, slot), right after the receipt and for every verdict;
 * the recorder normalizes it and writes it for App Work runs only. Absent a recorder, or absent a
 * containment block, nothing is asked. `fleet-agent-task-reconciler.spec.ts` builds the service
 * with 13 slots and passes unchanged.
 */

const RUN = 'run-1';
const TASK = 'task-1';
const AGENT = 'agent-1';
const USER = 'user-1';
const NODE = '11111111-1111-4111-8111-111111111111';
const WORK = 'work-app';

const CONTAINMENT = {
    executionPath: 'ordinary',
    isolatedHome: false,
    localSessionHome: null,
    downgrades: [{ control: 'isolated-home', reason: 'modelHomeIsolation=inherit' }],
};

function job(payload: Record<string, unknown> = { appWorkId: WORK }): FleetJobView {
    return {
        id: 'job-1',
        kind: 'agent-task',
        status: 'done',
        nodeId: NODE,
        requiredCapabilities: [],
        // `appWorkId` is the platform-written marker the fleet-aware dispatcher stamps on an
        // admitted App Work run (review of #3040: the reconciler reads nothing to find out).
        payload: { taskId: TASK, runId: RUN, agentId: AGENT, userId: USER, ...payload },
        leaseExpiresAt: null,
        attempts: 1,
        maxAttempts: 3,
        createdAt: null,
        startedAt: null,
        completedAt: null,
    };
}

const result = (over: Partial<FleetAgentTaskResult> = {}): FleetAgentTaskResult => ({
    status: 'failed',
    taskId: TASK,
    runId: RUN,
    workspace: null,
    steps: [],
    model: null,
    checks: [],
    gateStatus: 'none',
    git: null,
    failureReason: 'red',
    ...over,
});

describe('FleetAgentTaskReconcilerService — the containment record (APW-08 T48)', () => {
    let recorder: { recordRunContainment: jest.Mock };
    let pluginUsage: { record: jest.Mock };
    let markFailed: jest.Mock;
    let order: string[];

    const build = (withRecorder = true) =>
        new FleetAgentTaskReconcilerService(
            {
                findById: jest
                    .fn()
                    .mockResolvedValue({ id: RUN, userId: USER, agentId: AGENT, workId: 'w' }),
                markFailed,
                markCompleted: jest.fn().mockResolvedValue(undefined),
                tryMarkCompleted: jest.fn().mockResolvedValue(true),
                setAwaitingInput: jest.fn().mockResolvedValue(undefined),
                updateGateResults: jest.fn().mockResolvedValue(undefined),
                updateTelemetry: jest.fn().mockResolvedValue(undefined),
                addTokens: jest.fn().mockResolvedValue(undefined),
                stampCostCents: jest.fn().mockResolvedValue(undefined),
                recordFleetCliSession: jest.fn().mockResolvedValue(undefined),
            } as never,
            {
                findById: jest
                    .fn()
                    .mockResolvedValue({ id: TASK, workId: 'w', title: 'T', organizationId: null }),
            } as never,
            { findById: jest.fn().mockResolvedValue({ id: AGENT, permissions: {} }) } as never,
            {
                recordStarted: jest.fn().mockResolvedValue(true),
                recordTerminal: jest.fn().mockResolvedValue(true),
            } as never,
            {
                finalizeRemotePush: jest.fn(),
                finalizeMountPush: jest.fn(),
                recordRemotePush: jest.fn().mockResolvedValue(undefined),
                judgeAppWorkBranch: jest.fn().mockResolvedValue(null),
                judgeMountedPullRequests: jest.fn().mockResolvedValue([]),
            } as never,
            { post: jest.fn().mockResolvedValue({}) } as never,
            { drainForWork: jest.fn().mockResolvedValue({ dispatched: false }) } as never,
            { notice: jest.fn().mockResolvedValue(undefined), questionRaised: jest.fn() } as never,
            {
                findById: jest
                    .fn()
                    .mockResolvedValue({ id: NODE, userId: USER, name: 'everdesk2' }),
            } as never,
            pluginUsage as never,
            undefined,
            undefined,
            undefined,
            withRecorder ? (recorder as never) : undefined,
        );

    const complete = (
        svc: FleetAgentTaskReconcilerService,
        body: Record<string, unknown>,
        payload?: Record<string, unknown>,
    ) =>
        svc.onCompleted(
            new FleetJobCompletedEvent(job(payload), USER, 'node-report', NODE, body, null),
        );

    beforeEach(() => {
        order = [];
        markFailed = jest.fn().mockResolvedValue(undefined);
        pluginUsage = {
            record: jest.fn(async () => {
                order.push('receipt');
                return { id: 'usage-1' };
            }),
        };
        recorder = {
            recordRunContainment: jest.fn(async () => {
                order.push('containment');
                return true;
            }),
        };
    });

    it('hands the RAW block, the run, the Task and the reporting node to the recorder — after the receipt', async () => {
        await complete(
            build(),
            result({
                model: {
                    provider: 'claude-code',
                    status: 'succeeded',
                    exitCode: 0,
                    durationMs: 10,
                    summary: null,
                    costUsd: 0.1,
                },
                containment: CONTAINMENT as never,
            }) as never,
        );

        expect(recorder.recordRunContainment).toHaveBeenCalledWith({
            taskId: TASK,
            runId: RUN,
            userId: USER,
            workId: WORK,
            nodeId: NODE,
            rawContainment: CONTAINMENT,
        });
        expect(order).toEqual(['receipt', 'containment']);
    });

    it('records for a question too (taken before the three-way split)', async () => {
        await complete(
            build(),
            result({
                containment: CONTAINMENT as never,
                question: { text: 'Which branch?', context: '' } as never,
            }) as never,
        );
        expect(recorder.recordRunContainment).toHaveBeenCalledTimes(1);
    });

    it('asks nothing when the node sent no containment block', async () => {
        await complete(build(), result() as never);
        expect(recorder.recordRunContainment).not.toHaveBeenCalled();
    });

    it('review of #3040: asks nothing for a job WITHOUT the App Work marker — every non-App completion', async () => {
        await complete(build(), result({ containment: CONTAINMENT as never }) as never, {});
        expect(recorder.recordRunContainment).not.toHaveBeenCalled();
    });

    it('a recorder that throws never costs the run its verdict', async () => {
        recorder.recordRunContainment.mockRejectedValue(new Error('db down'));
        const svc = build();
        await expect(
            complete(svc, result({ containment: CONTAINMENT as never }) as never),
        ).resolves.toBeUndefined();
        expect(markFailed).toHaveBeenCalledWith(RUN, 'red');
    });

    it('without a recorder (every graph before T48) the reconcile is unchanged', async () => {
        await expect(
            complete(build(false), result({ containment: CONTAINMENT as never }) as never),
        ).resolves.toBeUndefined();
        expect(recorder.recordRunContainment).not.toHaveBeenCalled();
    });
});
