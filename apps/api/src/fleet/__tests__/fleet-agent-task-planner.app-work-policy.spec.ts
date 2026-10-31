import { PromptAssemblerService } from '@ever-works/agent/agents';
import type { Agent, Task } from '@ever-works/agent/entities';
import { TaskStatus } from '@ever-works/agent/tasks-domain';
import { FleetAgentTaskPlannerService } from '../fleet-agent-task-planner.service';

/**
 * APW-08 T47 (XC-05, FR-69) — the App Work Task tool policy on the fleet path.
 *
 * On a node the run's platform tools ARE the MCP bridge (`payload.mcp`), and the run-credential
 * mint refuses any job whose payload carries none. So the policy's "no MCP tool" is the bridge
 * being withheld at plan time, whatever the three bridge switches say — and the instructions
 * then tell the model it has no platform tools, never that it has some. Every case with the
 * switches on and an App Work fails on `develop` before this lane: the bridge was stamped.
 */

const USER = 'user-1';

function task(over: Partial<Task> = {}): Task {
    return {
        id: 'task-1',
        userId: USER,
        slug: 'TSK-9',
        title: 'Add a dark mode toggle',
        description: 'Add a toggle to the settings page.',
        status: TaskStatus.IN_PROGRESS,
        priority: 'p2',
        labels: [],
        workId: 'work-app',
        tenantId: null,
        organizationId: null,
        ...over,
    } as unknown as Task;
}

function agent(over: Partial<Agent> = {}): Agent {
    return {
        id: 'agent-1',
        userId: USER,
        name: 'App Engineer',
        slug: 'app-engineer',
        title: 'Changes this app on request',
        soulMd: '# SOUL\nYou change apps.',
        agentsMd: null,
        workId: null,
        permissions: {
            canCreateAgents: false,
            canAssignTasks: false,
            canEditSkills: false,
            canEditAgentFiles: false,
            canSpend: false,
            canCommitToRepo: true,
            canOpenPullRequests: true,
            canCallExternalTools: true,
        },
        maxSkillContextTokens: 4000,
        ...over,
    } as unknown as Agent;
}

const workspace = {
    repositoryId: 'member/cal-fork',
    repoUrl: 'https://github.com/member/cal-fork.git',
    baseRef: 'main',
    branch: 'task/task-1-tsk-9',
};

const payload = {
    agentId: 'agent-1',
    userId: USER,
    taskId: 'task-1',
    dedupKey: 'task-1:agent-1:1',
    runId: 'run-1',
};

const WORKS: Record<string, { id: string; kind: string; checksPolicy: string }> = {
    'work-app': { id: 'work-app', kind: 'app', checksPolicy: 'off' },
    'work-site': { id: 'work-site', kind: 'directory', checksPolicy: 'off' },
};

describe('FleetAgentTaskPlannerService — the App Work Task tool policy withholds the MCP bridge', () => {
    const originalEnv = process.env;
    let tasks: { findById: jest.Mock };
    let agents: { findByIdAndUser: jest.Mock };
    let works: { findById: jest.Mock };

    const build = (appRunBriefs?: unknown, appWorksSink?: unknown) =>
        new FleetAgentTaskPlannerService(
            tasks as never,
            agents as never,
            works as never,
            {
                describeFleetWorkspace: jest.fn().mockResolvedValue(workspace),
                resolveFleetRunEnvGrants: jest.fn().mockResolvedValue([]),
                readFleetRepoDeclaredCommands: jest
                    .fn()
                    .mockResolvedValue({ setup: [], checks: [] }),
            } as never,
            new PromptAssemblerService(),
            undefined,
            { getResolvedSettings: jest.fn().mockResolvedValue({}) } as never,
            {
                findById: jest.fn().mockResolvedValue(null),
                findRecentForTask: jest.fn().mockResolvedValue([]),
            } as never,
            {
                describeScope: jest.fn().mockResolvedValue({
                    ok: true,
                    reason: null,
                    installationEntityId: 'inst-entity-1',
                    installationId: '9001',
                    repositoryIds: ['1'],
                    repositories: ['member/cal-fork'],
                }),
            } as never,
            appRunBriefs as never,
            appWorksSink as never,
        );

    beforeEach(() => {
        process.env = { ...originalEnv };
        for (const key of Object.keys(process.env)) {
            if (key.startsWith('FLEET_NODE_AGENT_EXECUTION_')) delete process.env[key];
        }
        process.env.FLEET_NODE_AGENT_EXECUTION_MODE = 'model-cli';
        // All three bridge switches say yes: operator switch, URL, and the Agent's permission.
        process.env.FLEET_NODE_MCP_BRIDGE_ENABLED = 'true';
        process.env.FLEET_NODE_MCP_URL = 'https://mcp.ever.works/mcp';
        tasks = { findById: jest.fn().mockResolvedValue(task()) };
        agents = { findByIdAndUser: jest.fn().mockResolvedValue(agent()) };
        works = { findById: jest.fn(async (id: string) => WORKS[id] ?? null) };
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    it('withholds the bridge from a Task on an App Work, and says the session has no platform tools', async () => {
        const plan = await build().plan(payload);

        expect(plan).not.toBeNull();
        expect(plan!.mcp).toBeUndefined();
        expect(plan!.execution.instructions).toContain(
            'You have no platform tools in this session.',
        );
        expect(plan!.execution.instructions).not.toContain('MCP server');
    });

    it('withholds it from a run of an Agent scoped to an App Work, whatever the Task’s Work', async () => {
        tasks.findById.mockResolvedValue(task({ workId: 'work-site' }));
        agents.findByIdAndUser.mockResolvedValue(agent({ workId: 'work-app' }));

        const plan = await build().plan(payload);

        expect(plan!.mcp).toBeUndefined();
    });

    // APW-08 T43 (plan §8.1, XC-05) — the withheld bridge is reported as `app.change.tool_denied`
    // with the group only, attributed to the App Work (the Task's, else the Agent's own).
    describe('app.change.tool_denied (T43)', () => {
        const sink = () => ({ track: jest.fn() });

        it('is sent once, group `mcp`, for a Task on an App Work', async () => {
            const telemetry = sink();
            await build(undefined, telemetry).plan(payload);
            expect(telemetry.track).toHaveBeenCalledTimes(1);
            const [distinctId, event, properties] = telemetry.track.mock.calls[0];
            expect(event).toBe('app.change.tool_denied');
            expect(distinctId).toBe(task().userId);
            expect(properties).toEqual({ workId: 'work-app', taskId: task().id, group: 'mcp' });
        });

        it('names the Agent’s App Work when the Task’s Work is another kind', async () => {
            tasks.findById.mockResolvedValue(task({ workId: 'work-site' }));
            agents.findByIdAndUser.mockResolvedValue(agent({ workId: 'work-app' }));
            const telemetry = sink();
            await build(undefined, telemetry).plan(payload);
            expect(telemetry.track.mock.calls[0][2]).toMatchObject({ workId: 'work-app' });
        });

        it('is not sent for an ordinary Work (the bridge is stamped)', async () => {
            tasks.findById.mockResolvedValue(task({ workId: 'work-site' }));
            const telemetry = sink();
            await build(undefined, telemetry).plan(payload);
            expect(telemetry.track).not.toHaveBeenCalled();
        });
    });

    it('fails closed when the Agent’s Work cannot be read', async () => {
        tasks.findById.mockResolvedValue(task({ workId: 'work-site' }));
        agents.findByIdAndUser.mockResolvedValue(agent({ workId: 'work-gone' }));

        const plan = await build().plan(payload);

        expect(plan!.mcp).toBeUndefined();
    });

    /**
     * APW-08 T49 (R-30) — a resumed or drained run reaches the planner without passing
     * `dispatchAgentRun`, so the planner reads the change switch itself.
     */
    it('refuses an App Work Task while EVER_WORKS_APP_CHANGES_ENABLED is off, before any job', async () => {
        process.env.EVER_WORKS_APP_CHANGES_ENABLED = 'false';

        await expect(build().plan(payload)).rejects.toThrow(
            /switch_off: EVER_WORKS_APP_CHANGES_ENABLED is off/,
        );
    });

    it('plans a Task on another Work while the change switch is off', async () => {
        process.env.EVER_WORKS_APP_CHANGES_ENABLED = 'false';
        tasks.findById.mockResolvedValue(task({ workId: 'work-site' }));

        await expect(build().plan(payload)).resolves.not.toBeNull();
    });

    it('still stamps the bridge for an ordinary Work (the switches mean what they meant)', async () => {
        tasks.findById.mockResolvedValue(task({ workId: 'work-site' }));

        const plan = await build().plan(payload);

        expect(plan!.mcp).toEqual(
            expect.objectContaining({ enabled: true, serverName: 'ever-works' }),
        );
    });

    /**
     * APW-08 T18 — the fleet brief carries the App rules (in the never-truncated tail, before the
     * Task) and the fenced instruction files (after the workspace facts), read at the workspace's
     * own base ref.
     */
    describe('the App Work run brief (T18)', () => {
        const brief = {
            rules: ['# APP RULES (platform rules)', 'Protected paths:', '- `src/billing/**`'].join(
                '\n',
            ),
            instructions: [
                '# UNTRUSTED REPOSITORY CONTENT',
                '<untrusted_repository_content id="n1">',
                'Use tabs.',
                '</untrusted_repository_content id="n1">',
            ].join('\n'),
        };

        it('puts the rules before the Task and the instruction files after the workspace', async () => {
            const source = { forTask: jest.fn().mockResolvedValue(brief) };

            const plan = await build(source).plan(payload);

            expect(source.forTask).toHaveBeenCalledWith({ taskId: 'task-1', baseRef: 'main' });
            const text = plan!.execution.instructions;
            const rulesAt = text.indexOf('# APP RULES');
            const workspaceAt = text.indexOf('# WORKSPACE (fleet node)');
            const filesAt = text.indexOf('# UNTRUSTED REPOSITORY CONTENT');
            expect(rulesAt).toBeGreaterThan(-1);
            expect(rulesAt).toBeLessThan(text.indexOf('TSK-9'));
            expect(filesAt).toBeGreaterThan(workspaceAt);
        });

        it('a run without a brief (not an App Work, or none could be composed) is planned as before', async () => {
            const plan = await build({ forTask: jest.fn().mockResolvedValue(null) }).plan(payload);
            expect(plan!.execution.instructions).not.toContain('# APP RULES');
        });

        it('a brief source that throws never fails the plan', async () => {
            const plan = await build({
                forTask: jest.fn().mockRejectedValue(new Error('down')),
            }).plan(payload);
            expect(plan).not.toBeNull();
        });
    });
});
