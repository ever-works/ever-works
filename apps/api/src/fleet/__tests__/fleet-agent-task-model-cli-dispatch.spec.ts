import type {
    AgentTaskExecuteDispatcher,
    AgentTaskExecuteDispatchPayload,
} from '@ever-works/agent/tasks-domain';
import { NodeDispatcherFactory, NodeJobRuntimePlugin } from '@ever-works/job-runtime-node-plugin';
import {
    createFleetAwareAgentTaskExecuteDispatcher,
    type FleetAgentTaskPlan,
} from '../fleet-agent-task.dispatcher';
import { FleetRunRouterService } from '../fleet-run-router.service';

/**
 * Agent execution v2 — the WIRING from a planned run to the job row.
 *
 * The planner and the router are each unit-tested; what this suite
 * proves is that a plan actually reaches the `fleet_jobs` payload with
 * the legacy steps LEFT OUT, that the provider tag becomes a required
 * capability, that a `null` plan writes the exact legacy job, and that a
 * planner failure is not swallowed into a job the node cannot run.
 */

function payload(
    over: Partial<AgentTaskExecuteDispatchPayload> = {},
): AgentTaskExecuteDispatchPayload {
    return {
        agentId: 'agent-1',
        userId: 'user-1',
        taskId: 'task-1',
        dedupKey: 'task-1:agent-1:1',
        runId: 'run-1',
        tenantId: null,
        organizationId: null,
        ...over,
    };
}

const plan: FleetAgentTaskPlan = {
    execution: {
        provider: 'claude-code',
        instructions: '# IDENTITY\n…\n# TASK\nFix it.',
        permissionMode: 'acceptEdits',
        timeoutSec: 1200,
        envPassthrough: ['CLAUDE_CODE_OAUTH_TOKEN'],
    },
    workspace: {
        repositoryId: 'ever-works/ever-works',
        repoUrl: 'https://github.com/ever-works/ever-works.git',
        baseRef: 'develop',
        branch: 'task/task-1',
    },
    acceptanceChecks: [
        { id: 'unit', name: 'Unit', kind: 'test', command: 'pnpm test', required: true },
    ],
    git: { commit: true, push: true, commitMessage: 'feat(task): TSK-1 agent run output' },
};

describe('fleet agent-task dispatch — model-cli plan wiring', () => {
    const originalEnv = process.env;
    let store: { enqueue: jest.Mock; findById: jest.Mock };
    let delegate: AgentTaskExecuteDispatcher & { enqueue: jest.Mock };

    const buildDispatcher = (planner?: { plan: jest.Mock }): AgentTaskExecuteDispatcher => {
        const factory = new NodeDispatcherFactory({ store });
        const plugin = new NodeJobRuntimePlugin().useDispatcherFactory(factory);
        const router = new FleetRunRouterService(factory, plugin, undefined);
        return createFleetAwareAgentTaskExecuteDispatcher(
            delegate,
            router,
            planner ? { planner } : {},
        );
    };

    beforeEach(() => {
        process.env = {
            ...originalEnv,
            EVER_WORKS_JOB_RUNTIME: 'node',
            FLEET_NODE_RUNTIME_ENABLED: 'true',
        };
        process.env.FLEET_NODE_AGENT_TASK_COMMAND = 'ever-works run {taskId}';
        process.env.FLEET_NODE_REQUIRED_CAPABILITIES = 'workspace';
        delete process.env.FLEET_NODE_AGENT_TASK_WORKSPACE;
        store = {
            enqueue: jest.fn().mockImplementation(async (request) => ({
                id: 'fleet-job-1',
                kind: request.kind,
                status: 'queued',
                nodeId: null,
                requiredCapabilities: request.requiredCapabilities ?? [],
                payload: request.payload ?? null,
                leaseExpiresAt: null,
                attempts: 0,
                maxAttempts: 3,
                createdAt: null,
                startedAt: null,
                completedAt: null,
            })),
            findById: jest.fn().mockResolvedValue(null),
        };
        delegate = { enqueue: jest.fn().mockResolvedValue({ runId: 'trigger-run' }) };
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    it('writes the plan into the job payload, drops the legacy steps and requires the provider tag', async () => {
        const planner = { plan: jest.fn().mockResolvedValue(plan) };
        const out = await buildDispatcher(planner).enqueue(payload());
        expect(out).toEqual({ runId: 'fleet-job-1' });
        expect(planner.plan).toHaveBeenCalledWith(payload());
        expect(delegate.enqueue).not.toHaveBeenCalled();

        expect(store.enqueue).toHaveBeenCalledTimes(1);
        const request = store.enqueue.mock.calls[0][0];
        expect(request.kind).toBe('agent-task');
        expect(request.requiredCapabilities).toEqual(['workspace', 'claude-code']);
        expect(request.payload).toEqual({
            taskId: 'task-1',
            agentId: 'agent-1',
            userId: 'user-1',
            runId: 'run-1',
            execution: plan.execution,
            workspace: plan.workspace,
            acceptanceChecks: plan.acceptanceChecks,
            git: plan.git,
        });
        expect(request.payload.steps).toBeUndefined();
        expect(request.payload.workspacePath).toBeUndefined();
    });

    it('writes the exact legacy job when the planner returns null', async () => {
        const planner = { plan: jest.fn().mockResolvedValue(null) };
        await buildDispatcher(planner).enqueue(payload());
        const request = store.enqueue.mock.calls[0][0];
        expect(request.requiredCapabilities).toEqual(['workspace']);
        expect(request.payload.execution).toBeUndefined();
        expect(request.payload.workspace).toBeUndefined();
        expect(request.payload.steps).toEqual([
            expect.objectContaining({
                id: 'agent-task',
                command: 'ever-works run task-1',
                required: true,
            }),
        ]);
    });

    it('behaves exactly as before when no planner is wired', async () => {
        await buildDispatcher().enqueue(payload());
        const request = store.enqueue.mock.calls[0][0];
        expect(request.payload.execution).toBeUndefined();
        expect(request.payload.steps).toHaveLength(1);
    });

    it('lets a planner failure propagate instead of enqueuing a job the node cannot run', async () => {
        const planner = {
            plan: jest.fn().mockRejectedValue(new Error('Task TSK-1 has no repository to work in')),
        };
        await expect(buildDispatcher(planner).enqueue(payload())).rejects.toThrow(/no repository/);
        expect(store.enqueue).not.toHaveBeenCalled();
        expect(delegate.enqueue).not.toHaveBeenCalled();
    });

    it('never plans a run that is routed to the cloud', async () => {
        process.env.EVER_WORKS_JOB_RUNTIME = 'trigger';
        const planner = { plan: jest.fn().mockResolvedValue(plan) };
        await buildDispatcher(planner).enqueue(payload());
        expect(planner.plan).not.toHaveBeenCalled();
        expect(delegate.enqueue).toHaveBeenCalledTimes(1);
        expect(store.enqueue).not.toHaveBeenCalled();
    });

    /**
     * Self-build slice Z (EW-796) — the MCP block reaches the node the same
     * way `execution` / `workspace` / `git` do, and ONLY when the planner
     * put one on the plan.
     *
     * This matters beyond wiring: `FleetRunCredentialService.mint` re-reads
     * `payload.mcp.enabled` on the job row before it will issue anything, so
     * a payload without the block is a job for which no credential can ever
     * be minted — by a node, or by anyone who has one.
     */
    describe('MCP bridge block (slice Z)', () => {
        const bridge = {
            enabled: true,
            serverUrl: 'https://mcp.ever.works/mcp',
            serverName: 'ever-works',
            toolFamilies: ['Tasks', 'Inbox'],
        };

        it('carries the bridge onto the job payload when the planner enabled it', async () => {
            const planner = { plan: jest.fn().mockResolvedValue({ ...plan, mcp: bridge }) };
            await buildDispatcher(planner).enqueue(payload());

            const request = store.enqueue.mock.calls[0][0];
            expect(request.payload.mcp).toEqual(bridge);
        });

        it('omits the key entirely when the planner did not — no `mcp: null` on the wire', async () => {
            const planner = { plan: jest.fn().mockResolvedValue(plan) };
            await buildDispatcher(planner).enqueue(payload());

            const request = store.enqueue.mock.calls[0][0];
            expect('mcp' in request.payload).toBe(false);
        });

        it('never puts a credential on the payload — only where to reach the server', async () => {
            const planner = { plan: jest.fn().mockResolvedValue({ ...plan, mcp: bridge }) };
            await buildDispatcher(planner).enqueue(payload());

            const serialized = JSON.stringify(store.enqueue.mock.calls[0][0].payload);
            expect(serialized).not.toContain('ew_run_');
            expect(serialized).not.toContain('ew_live_');
            expect(serialized.toLowerCase()).not.toContain('authorization');
        });
    });
});
