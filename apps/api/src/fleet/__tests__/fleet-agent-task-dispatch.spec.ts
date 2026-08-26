import type {
    AgentTaskExecuteDispatcher,
    AgentTaskExecuteDispatchPayload,
} from '@ever-works/agent/tasks-domain';
import { Task, TaskStatus, TaskTransitionService } from '@ever-works/agent/tasks-domain';
import type { FleetJobRepository, FleetJobService } from '@ever-works/agent/fleet';
import { NodeDispatcherFactory, NodeJobRuntimePlugin } from '@ever-works/job-runtime-node-plugin';
import { createFleetAwareAgentTaskExecuteDispatcher } from '../fleet-agent-task.dispatcher';
import {
    FleetAgentTaskCommandError,
    FleetRunRouterService,
    renderAgentTaskCommand,
} from '../fleet-run-router.service';
import { createFleetJobStore } from '../node-job-runtime.providers';

/**
 * AUDIT A46/A24 — proof that the fleet queue now has a PRODUCER.
 *
 * The whole finding was that `FleetJobService.enqueue` had zero
 * production callers: a user could enroll a machine, see it heartbeat
 * green, and it would never receive work because nothing ever wrote a
 * lease-able row. A unit test that only exercised `FleetRunRouterService`
 * in isolation would not have caught that — the gap was the WIRING, not
 * the service.
 *
 * So this suite drives the real dispatch path end to end with only the
 * database mocked: `TaskTransitionService.dispatchAgentRun` (the single
 * implementation every dispatch enters — drag-to-in-progress, the board
 * "Run" button, the recurrence dispatcher) → the routing dispatcher →
 * `NodeDispatcherFactory` → the `FleetJobStore` adapter →
 * `FleetJobService.enqueue`. If any link is unwired, the enqueue
 * assertion fails.
 */

interface RunStub {
    id: string;
}

function buildTask(overrides: Partial<Task> = {}): Task {
    return {
        id: 'task-1',
        userId: 'user-1',
        slug: 'TSK-1',
        title: 'Ship the fleet producer',
        status: TaskStatus.IN_PROGRESS,
        workId: null,
        tenantId: null,
        organizationId: null,
        recurrenceOccurredCount: 0,
        ...overrides,
    } as unknown as Task;
}

describe('fleet agent-task dispatch (AUDIT A46/A24 producer wiring)', () => {
    const originalEnv = process.env;

    let fleetJobs: { enqueue: jest.Mock };
    let fleetJobRepository: { findById: jest.Mock };
    let runs: {
        createQueued: jest.Mock;
        setTriggerRunId: jest.Mock;
        markDispatchFailed: jest.Mock;
    };
    let delegate: AgentTaskExecuteDispatcher & { enqueue: jest.Mock };
    let router: FleetRunRouterService;
    let dispatcher: AgentTaskExecuteDispatcher;

    const buildRouter = (overlay?: {
        findOne: jest.Mock;
    }): { router: FleetRunRouterService; factory: NodeDispatcherFactory } => {
        const store = createFleetJobStore(
            fleetJobs as unknown as FleetJobService,
            fleetJobRepository as unknown as FleetJobRepository,
        );
        const factory = new NodeDispatcherFactory({ store });
        const plugin = new NodeJobRuntimePlugin().useDispatcherFactory(factory);
        return {
            router: new FleetRunRouterService(factory, plugin, overlay as never),
            factory,
        };
    };

    const buildTransition = (): TaskTransitionService =>
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
        delete process.env.EVER_WORKS_JOB_RUNTIME;
        delete process.env.FLEET_NODE_RUNTIME_ENABLED;
        delete process.env.FLEET_NODE_AGENT_TASK_COMMAND;
        delete process.env.FLEET_NODE_AGENT_TASK_WORKSPACE;
        delete process.env.FLEET_NODE_REQUIRED_CAPABILITIES;
        delete process.env.FLEET_NODE_LEASE_TTL_SECONDS;

        fleetJobs = {
            enqueue: jest.fn().mockImplementation(async () => ({
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
        };
        fleetJobRepository = { findById: jest.fn().mockResolvedValue(null) };
        runs = {
            createQueued: jest.fn().mockResolvedValue({ id: 'run-1' } as RunStub),
            setTriggerRunId: jest.fn().mockResolvedValue(undefined),
            markDispatchFailed: jest.fn().mockResolvedValue(undefined),
        };
        delegate = { enqueue: jest.fn().mockResolvedValue({ runId: 'trigger-run-1' }) };
        router = buildRouter().router;
        dispatcher = createFleetAwareAgentTaskExecuteDispatcher(delegate, router);
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    it('calls FleetJobService.enqueue when the resolved runtime is the fleet', async () => {
        process.env.EVER_WORKS_JOB_RUNTIME = 'node';
        process.env.FLEET_NODE_AGENT_TASK_COMMAND = 'ever-works agent run --task {taskId}';

        const result = await buildTransition().dispatchAgentRun(buildTask(), 'agent-1');

        expect(fleetJobs.enqueue).toHaveBeenCalledTimes(1);
        expect(delegate.enqueue).not.toHaveBeenCalled();
        expect(result).toEqual({ runId: 'run-1', dispatched: true, parked: false });

        const enqueued = fleetJobs.enqueue.mock.calls[0][0];
        expect(enqueued.kind).toBe('agent-task');
        expect(enqueued.userId).toBe('user-1');
        // Idempotency rides the same dedup key the Trigger.dev adapter
        // uses, so a rapid flip-flop cannot double-fire onto the fleet.
        expect(enqueued.idempotencyKey).toBe('task-1:agent-1:1');
        expect(enqueued.payload).toMatchObject({
            taskId: 'task-1',
            runId: 'run-1',
            agentId: 'agent-1',
            userId: 'user-1',
            steps: [
                { id: 'agent-task', command: 'ever-works agent run --task task-1', required: true },
            ],
        });
    });

    it('stamps the fleet job id onto the AgentRun so a later status lookup can reach it', async () => {
        process.env.EVER_WORKS_JOB_RUNTIME = 'node';

        await buildTransition().dispatchAgentRun(buildTask(), 'agent-1');

        expect(runs.setTriggerRunId).toHaveBeenCalledWith('run-1', 'fleet-job-1');
        expect(runs.markDispatchFailed).not.toHaveBeenCalled();
    });

    it('applies the FLEET_NODE_* capability + lease knobs to the enqueued job', async () => {
        process.env.EVER_WORKS_JOB_RUNTIME = 'node';
        process.env.FLEET_NODE_REQUIRED_CAPABILITIES = 'git, docker ,git';
        process.env.FLEET_NODE_LEASE_TTL_SECONDS = '900';
        process.env.FLEET_NODE_AGENT_TASK_WORKSPACE = '/srv/ever-works';

        await buildTransition().dispatchAgentRun(buildTask(), 'agent-1');

        const enqueued = fleetJobs.enqueue.mock.calls[0][0];
        expect(enqueued.requiredCapabilities).toEqual(['git', 'docker']);
        expect(enqueued.payload.workspacePath).toBe('/srv/ever-works');
    });

    it('grants the well-known CLI credential names to the agent-task step by default', async () => {
        // A node builds its subprocess env from scratch and drops secret-SHAPED
        // names unless the step grants them. Without this the credential never
        // arrives and the agent runs unauthenticated — failing in a way that
        // reads as a model problem rather than a config one.
        process.env.EVER_WORKS_JOB_RUNTIME = 'node';
        process.env.FLEET_NODE_AGENT_TASK_COMMAND = 'ever-works agent run --task {taskId}';

        await buildTransition().dispatchAgentRun(buildTask(), 'agent-1');

        const step = fleetJobs.enqueue.mock.calls[0][0].payload.steps[0];
        expect(step.envPassthrough).toEqual([
            'CLAUDE_CODE_OAUTH_TOKEN',
            'ANTHROPIC_API_KEY',
            'CODEX_ACCESS_TOKEN',
            'OPENAI_API_KEY',
        ]);
    });

    it('honours an operator override of the granted credential names', async () => {
        process.env.EVER_WORKS_JOB_RUNTIME = 'node';
        process.env.FLEET_NODE_AGENT_TASK_COMMAND = 'ever-works agent run --task {taskId}';
        process.env.FLEET_NODE_AGENT_TASK_ENV_PASSTHROUGH = ' MY_WRAPPER_TOKEN , OTHER_KEY ';

        await buildTransition().dispatchAgentRun(buildTask(), 'agent-1');

        const step = fleetJobs.enqueue.mock.calls[0][0].payload.steps[0];
        expect(step.envPassthrough).toEqual(['MY_WRAPPER_TOKEN', 'OTHER_KEY']);
    });

    it('omits envPassthrough entirely when the operator grants nothing', async () => {
        // Opting out must leave the field ABSENT rather than an empty array, so a
        // node sees "no grant" instead of "granted nothing", and the step shape
        // stays identical to what shipped before this setting existed.
        process.env.EVER_WORKS_JOB_RUNTIME = 'node';
        process.env.FLEET_NODE_AGENT_TASK_COMMAND = 'ever-works agent run --task {taskId}';
        process.env.FLEET_NODE_AGENT_TASK_ENV_PASSTHROUGH = '';

        await buildTransition().dispatchAgentRun(buildTask(), 'agent-1');

        const step = fleetJobs.enqueue.mock.calls[0][0].payload.steps[0];
        expect(step.envPassthrough).toBeUndefined();
    });

    it('keeps the platform dispatcher when no fleet runtime is selected', async () => {
        const result = await buildTransition().dispatchAgentRun(buildTask(), 'agent-1');

        expect(fleetJobs.enqueue).not.toHaveBeenCalled();
        expect(delegate.enqueue).toHaveBeenCalledTimes(1);
        expect(result.dispatched).toBe(true);
        expect(runs.setTriggerRunId).toHaveBeenCalledWith('run-1', 'trigger-run-1');
    });

    it('routes to the fleet from a tenant overlay row even when the instance default is not node', async () => {
        const overlay = {
            findOne: jest.fn().mockResolvedValue({
                tenantId: 'tenant-1',
                providerId: 'node',
                mode: 'override',
                enabled: true,
            }),
        };
        router = buildRouter(overlay).router;
        dispatcher = createFleetAwareAgentTaskExecuteDispatcher(delegate, router);

        await buildTransition().dispatchAgentRun(buildTask({ tenantId: 'tenant-1' }), 'agent-1');

        expect(overlay.findOne).toHaveBeenCalledWith({ where: { tenantId: 'tenant-1' } });
        expect(fleetJobs.enqueue).toHaveBeenCalledTimes(1);
        expect(delegate.enqueue).not.toHaveBeenCalled();
    });

    it.each<[string, Record<string, unknown> | null]>([
        ['disabled row', { providerId: 'node', mode: 'override', enabled: false }],
        ['inherit row', { providerId: 'node', mode: 'inherit', enabled: true }],
        ['no row', null],
    ])('ignores a %s overlay and stays on the platform dispatcher', async (_label, row) => {
        const overlay = { findOne: jest.fn().mockResolvedValue(row) };
        router = buildRouter(overlay).router;
        dispatcher = createFleetAwareAgentTaskExecuteDispatcher(delegate, router);

        await buildTransition().dispatchAgentRun(buildTask({ tenantId: 'tenant-1' }), 'agent-1');

        expect(fleetJobs.enqueue).not.toHaveBeenCalled();
        expect(delegate.enqueue).toHaveBeenCalledTimes(1);
    });

    it('honours FLEET_NODE_RUNTIME_ENABLED=false as a kill switch', async () => {
        process.env.EVER_WORKS_JOB_RUNTIME = 'node';
        process.env.FLEET_NODE_RUNTIME_ENABLED = 'false';

        await buildTransition().dispatchAgentRun(buildTask(), 'agent-1');

        expect(fleetJobs.enqueue).not.toHaveBeenCalled();
        expect(delegate.enqueue).toHaveBeenCalledTimes(1);
    });

    it('falls back to the platform dispatcher when the overlay lookup throws', async () => {
        const overlay = { findOne: jest.fn().mockRejectedValue(new Error('db down')) };
        router = buildRouter(overlay).router;
        dispatcher = createFleetAwareAgentTaskExecuteDispatcher(delegate, router);

        await buildTransition().dispatchAgentRun(buildTask({ tenantId: 'tenant-1' }), 'agent-1');

        expect(fleetJobs.enqueue).not.toHaveBeenCalled();
        expect(delegate.enqueue).toHaveBeenCalledTimes(1);
    });

    it('records a dispatch failure on the run when the fleet enqueue throws', async () => {
        process.env.EVER_WORKS_JOB_RUNTIME = 'node';
        fleetJobs.enqueue.mockRejectedValue(new Error('fleet_jobs is unreachable'));

        const result = await buildTransition().dispatchAgentRun(buildTask(), 'agent-1');

        expect(result.dispatched).toBe(false);
        expect(result.error).toContain('fleet_jobs is unreachable');
        expect(runs.markDispatchFailed).toHaveBeenCalledWith(
            'run-1',
            expect.stringContaining('fleet_jobs is unreachable'),
        );
    });

    describe('renderAgentTaskCommand', () => {
        it('substitutes every supported placeholder', () => {
            expect(
                renderAgentTaskCommand('run {taskId} {runId} {agentId}', {
                    taskId: 'a1',
                    runId: 'b2',
                    agentId: 'c3',
                }),
            ).toBe('run a1 b2 c3');
        });

        it('leaves a template without placeholders untouched', () => {
            expect(renderAgentTaskCommand('pnpm build', { taskId: 'a1' })).toBe('pnpm build');
        });

        it('refuses to build a shell command out of a non-opaque id', () => {
            expect(() =>
                renderAgentTaskCommand('run {taskId}', { taskId: 'a1; rm -rf /' }),
            ).toThrow(FleetAgentTaskCommandError);
        });

        it('refuses when a referenced placeholder has no value at all', () => {
            expect(() => renderAgentTaskCommand('run {runId}', { taskId: 'a1' })).toThrow(
                FleetAgentTaskCommandError,
            );
        });
    });
});
