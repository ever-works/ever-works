import type { AgentTaskExecuteDispatcher } from '@ever-works/agent/tasks-domain';
import { Task, TaskStatus, TaskTransitionService } from '@ever-works/agent/tasks-domain';
import { NodeDispatcherFactory, NodeJobRuntimePlugin } from '@ever-works/job-runtime-node-plugin';
import { createFleetAwareAgentTaskExecuteDispatcher } from '../fleet-agent-task.dispatcher';
import { FleetRunRouterService } from '../fleet-run-router.service';

/**
 * Panic controls (EW-778) — the GLOBAL STOP FLAG, end to end through
 * `TaskTransitionService.dispatchAgentRun` (the single implementation
 * every dispatch enters), the routing wrapper and the router.
 *
 * Sibling of `fleet-kill-switch-routing.spec.ts`, split out because
 * loading the tasks domain drags the whole agent module graph under
 * Jest; the routing assertions stay runnable without it.
 *
 * What is pinned: a dispatch attempted while the flag is set REFUSES —
 * the run row is marked `dispatch-failed`, nothing reaches the fleet
 * store, nothing reaches the platform dispatcher, no remote id is
 * stamped. That is "refuse", not "proceed".
 */

function buildTask(overrides: Partial<Task> = {}): Task {
    return {
        id: 'task-1',
        userId: 'user-1',
        slug: 'TSK-1',
        title: 'Stopped work',
        status: TaskStatus.IN_PROGRESS,
        workId: null,
        tenantId: null,
        organizationId: null,
        recurrenceOccurredCount: 0,
        ...overrides,
    } as unknown as Task;
}

describe('dispatchAgentRun under the global stop flag (EW-778)', () => {
    const originalEnv = process.env;

    let store: { enqueue: jest.Mock; findById: jest.Mock };
    let delegate: AgentTaskExecuteDispatcher & { enqueue: jest.Mock };
    let killSwitch: { isStopped: jest.Mock };
    let runs: {
        createQueued: jest.Mock;
        setTriggerRunId: jest.Mock;
        markDispatchFailed: jest.Mock;
    };

    const buildRouter = (): FleetRunRouterService => {
        const factory = new NodeDispatcherFactory({ store });
        const plugin = new NodeJobRuntimePlugin().useDispatcherFactory(factory);
        return new FleetRunRouterService(
            factory,
            plugin,
            undefined,
            undefined,
            undefined,
            undefined,
            killSwitch as never,
        );
    };

    const buildTransition = (dispatcher: AgentTaskExecuteDispatcher): TaskTransitionService =>
        new TaskTransitionService(
            { findById: jest.fn() } as never,
            { findByTaskId: jest.fn().mockResolvedValue([]) } as never,
            { allApproved: jest.fn().mockResolvedValue(true) } as never,
            undefined,
            runs as never,
            dispatcher,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            {
                findByIdAndUser: jest.fn().mockImplementation((id, userId, scope) =>
                    Promise.resolve({
                        id,
                        userId,
                        tenantId: scope?.tenantId ?? null,
                        organizationId: scope?.organizationId ?? null,
                    }),
                ),
            } as never,
        );

    beforeEach(() => {
        process.env = { ...originalEnv };
        delete process.env.FLEET_NODE_RUNTIME_ENABLED;
        delete process.env.FLEET_NODE_AGENT_TASK_COMMAND;
        process.env.EVER_WORKS_JOB_RUNTIME = 'node';
        store = {
            enqueue: jest.fn(async () => ({
                id: 'fleet-job-1',
                kind: 'agent-task',
                status: 'queued',
                nodeId: null,
                requiredCapabilities: [],
                payload: null,
                leaseExpiresAt: null,
                attempts: 0,
                maxAttempts: 3,
                createdAt: null,
                startedAt: null,
                completedAt: null,
            })),
            findById: jest.fn(async () => null),
        };
        delegate = { enqueue: jest.fn(async () => ({ runId: 'trigger-run-1' })) };
        killSwitch = { isStopped: jest.fn(async () => false) };
        runs = {
            createQueued: jest.fn().mockResolvedValue({ id: 'run-1' }),
            setTriggerRunId: jest.fn().mockResolvedValue(undefined),
            markDispatchFailed: jest.fn().mockResolvedValue(undefined),
        };
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    it('REFUSES: the run is marked dispatch-failed and nothing runs anywhere', async () => {
        killSwitch.isStopped.mockResolvedValue(true);
        const dispatcher = createFleetAwareAgentTaskExecuteDispatcher(delegate, buildRouter(), {
            killSwitch,
        });

        const result = await buildTransition(dispatcher).dispatchAgentRun(buildTask(), 'agent-1');

        expect(result.dispatched).toBe(false);
        expect(delegate.enqueue).not.toHaveBeenCalled();
        expect(store.enqueue).not.toHaveBeenCalled();
        expect(runs.setTriggerRunId).not.toHaveBeenCalled();
        expect(runs.markDispatchFailed).toHaveBeenCalledWith(
            'run-1',
            expect.stringContaining('global stop flag'),
        );
    });

    it('dispatches onto the fleet as before while the flag is clear', async () => {
        const dispatcher = createFleetAwareAgentTaskExecuteDispatcher(delegate, buildRouter(), {
            killSwitch,
        });

        const result = await buildTransition(dispatcher).dispatchAgentRun(buildTask(), 'agent-1');

        expect(result).toEqual({ runId: 'run-1', dispatched: true, parked: false });
        expect(store.enqueue).toHaveBeenCalledTimes(1);
        expect(runs.markDispatchFailed).not.toHaveBeenCalled();
    });
});
