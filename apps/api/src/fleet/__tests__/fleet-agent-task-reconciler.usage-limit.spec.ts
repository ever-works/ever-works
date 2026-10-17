import { Logger } from '@nestjs/common';
import { FleetJobLeasedEvent, FleetJobParkedEvent } from '@ever-works/agent/events';
import {
    FLEET_JOB_MODEL_USAGE_LIMIT_QUEUED_REASON,
    type FleetJobView,
    type FleetModelUsageLimit,
} from '@ever-works/contracts';
import {
    FleetAgentTaskReconcilerService,
    formatUsageLimitInstant,
} from '../fleet-agent-task-reconciler.service';

/**
 * Fleet usage limits on the reconciler (prod, 2026-10-17: "You've hit your
 * weekly limit" on EVERDESK4). A PARKED job is not a verdict: the AgentRun
 * goes back to `queued` with the usage-limit reason — never `markFailed`, so
 * the Agent's error count and its `pauseAfterFailures` halt are untouched —
 * and the owner gets ONE actionable Inbox notice per node per window.
 */

const RUN = 'run-13';
const TASK = 'task-13';
const AGENT = 'agent-1';
const USER = 'user-1';
const NODE = '44444444-4444-4444-8444-444444444444';

const limit: FleetModelUsageLimit = {
    provider: 'claude-code',
    window: 'weekly',
    resetsAt: '2026-10-19T01:00:00.000Z',
    retryAfter: '2026-10-19T01:01:00.000Z',
    message: "You've hit your weekly limit · resets Oct 19, 3am (Europe/Paris)",
};

function parkedJob(over: Partial<FleetJobView> = {}): FleetJobView {
    return {
        id: 'job-13',
        kind: 'agent-task',
        status: 'queued',
        nodeId: null,
        targetNodeId: NODE,
        requiredCapabilities: ['claude-code'],
        payload: { taskId: TASK, runId: RUN, agentId: AGENT, userId: USER },
        leaseExpiresAt: null,
        attempts: 0,
        maxAttempts: 3,
        createdAt: null,
        startedAt: null,
        completedAt: null,
        queuedReason: FLEET_JOB_MODEL_USAGE_LIMIT_QUEUED_REASON,
        ...over,
    };
}

describe('FleetAgentTaskReconcilerService — model usage limits', () => {
    let runs: Record<string, jest.Mock>;
    let tasks: { findById: jest.Mock };
    let inbox: { notice: jest.Mock; questionRaised: jest.Mock };

    const build = () =>
        new FleetAgentTaskReconcilerService(
            runs as never,
            tasks as never,
            { findById: jest.fn() } as never,
            { recordStarted: jest.fn(), recordTerminal: jest.fn() } as never,
            {} as never,
            undefined,
            undefined,
            inbox as never,
            {
                findById: jest
                    .fn()
                    .mockResolvedValue({ id: NODE, userId: USER, name: 'everdesk4' }),
            } as never,
        );

    beforeEach(() => {
        jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
        runs = {
            parkQueued: jest.fn().mockResolvedValue(true),
            clearQueuedReason: jest.fn().mockResolvedValue(true),
            updateTelemetry: jest.fn().mockResolvedValue(undefined),
            markStarted: jest.fn().mockResolvedValue(true),
            markFailed: jest.fn().mockResolvedValue(undefined),
        };
        tasks = {
            findById: jest.fn().mockResolvedValue({
                id: TASK,
                workId: 'work-1',
                title: 'Add dark mode',
                organizationId: 'org-1',
            }),
        };
        inbox = {
            notice: jest.fn().mockResolvedValue(undefined),
            questionRaised: jest.fn().mockResolvedValue(undefined),
        };
    });

    afterEach(() => jest.restoreAllMocks());

    it('re-queues the run without failing it, and files ONE notice for a new window', async () => {
        const service = build();
        await service.onParked(
            new FleetJobParkedEvent(parkedJob(), USER, NODE, 'everdesk4', limit, true),
        );

        expect(runs.parkQueued).toHaveBeenCalledWith(
            RUN,
            FLEET_JOB_MODEL_USAGE_LIMIT_QUEUED_REASON,
        );
        expect(runs.markFailed).not.toHaveBeenCalled();
        expect(runs.updateTelemetry).toHaveBeenCalledWith(RUN, {
            currentActivity:
                'Waiting for everdesk4: Claude Code weekly limit until 2026-10-19 01:01 UTC',
        });
        expect(inbox.notice).toHaveBeenCalledTimes(1);
        const [user, notice] = inbox.notice.mock.calls[0];
        expect(user).toBe(USER);
        expect(notice).toMatchObject({
            title: 'everdesk4: Claude Code weekly limit until 2026-10-19 01:01 UTC',
            agentId: AGENT,
            agentRunId: RUN,
            taskId: TASK,
            workId: 'work-1',
            organizationId: 'org-1',
        });
        expect(notice.body).toContain('Nothing failed');
        expect(notice.body).toContain('pinned to everdesk4');
        expect(notice.body).toContain(limit.message);
    });

    it('stays quiet for a park inside a window already announced', async () => {
        await build().onParked(
            new FleetJobParkedEvent(parkedJob(), USER, NODE, 'everdesk4', limit, false),
        );
        expect(runs.parkQueued).toHaveBeenCalled();
        expect(inbox.notice).not.toHaveBeenCalled();
    });

    it('says an unpinned run may go to another node', async () => {
        await build().onParked(
            new FleetJobParkedEvent(
                parkedJob({ targetNodeId: null }),
                USER,
                NODE,
                'everdesk4',
                limit,
                true,
            ),
        );
        expect(inbox.notice.mock.calls[0][1].body).toContain('Unpinned work runs on another node');
    });

    it('clears the park reason when the run is leased again', async () => {
        await build().onLeased(
            new FleetJobLeasedEvent(parkedJob({ status: 'leased', nodeId: NODE }), NODE, USER),
        );
        expect(runs.markStarted).toHaveBeenCalledWith(RUN, 'job-13');
        expect(runs.clearQueuedReason).toHaveBeenCalledWith(
            RUN,
            FLEET_JOB_MODEL_USAGE_LIMIT_QUEUED_REASON,
        );
    });

    it('formats the reset for a notice title', () => {
        expect(formatUsageLimitInstant('2026-10-19T01:01:00.000Z')).toBe('2026-10-19 01:01 UTC');
        expect(formatUsageLimitInstant('soon')).toBe('soon');
    });
});
