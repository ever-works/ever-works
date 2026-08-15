import { AgentToolService } from '../agent-tool.service';
import {
    AgentAvatarMode,
    AgentIdleBehavior,
    AgentScope,
    AgentStatus,
} from '../../entities/agent.entity';
import type { Agent } from '../../entities/agent.entity';

/**
 * Agent Collaborators — the `delegateToAgent` chat tool.
 *
 * Pinned here:
 *  - the gate: canAssignTasks + BOTH backing services bound;
 *  - target resolution runs against SELF + ENABLED collaborators only —
 *    an unknown / disabled / cross-user target errors with the current
 *    enabled roster instead of probing the agent table;
 *  - the delegation request drives the SAME SubAgentDelegationService
 *    path with childAgentId set, the parent's own resolved tool set as
 *    `limits.parentScope`, and a per-run sibling count.
 */

function makePerms(over: Partial<Agent['permissions']> = {}): Agent['permissions'] {
    return {
        canCreateAgents: false,
        canAssignTasks: false,
        canEditSkills: false,
        canEditAgentFiles: false,
        canSpend: false,
        canCommitToRepo: false,
        canOpenPullRequests: false,
        canCallExternalTools: false,
        ...over,
    };
}

function makeAgent(over: Partial<Agent> = {}): Agent {
    return {
        id: 'a1',
        userId: 'u1',
        scope: AgentScope.TENANT,
        missionId: null,
        ideaId: null,
        workId: null,
        organizationId: null,
        name: 'CEO',
        slug: 'ceo',
        title: null,
        capabilities: null,
        aiProviderId: null,
        modelId: null,
        maxSkillContextTokens: 4000,
        status: AgentStatus.ACTIVE,
        permissions: makePerms(),
        targets: null,
        heartbeatCadence: null,
        idleBehavior: AgentIdleBehavior.PROPOSE,
        nextHeartbeatAt: null,
        lastRunAt: null,
        lastRunStatus: null,
        errorCount: 0,
        pauseAfterFailures: 3,
        avatarMode: AgentAvatarMode.INITIALS,
        avatarIcon: null,
        avatarImageUploadId: null,
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
        ...over,
    } as Agent;
}

const RESEARCHER = {
    id: 'a2',
    userId: 'u1',
    name: 'Researcher',
    slug: 'researcher',
} as Agent;

describe('delegateToAgent tool', () => {
    let agents: any;
    let agentsService: any;
    let delegation: { delegate: jest.Mock };
    let collaborators: { listForAgent: jest.Mock; listEnabledForAgent: jest.Mock };

    const build = (svcOverrides: { delegation?: unknown; collaborators?: unknown } = {}) =>
        new AgentToolService(
            agents,
            agentsService,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            ('delegation' in svcOverrides ? svcOverrides.delegation : delegation) as never,
            ('collaborators' in svcOverrides ? svcOverrides.collaborators : collaborators) as never,
        );

    beforeEach(() => {
        agents = {
            findById: jest.fn(),
            findByIdAndUser: jest.fn(async (id: string, userId: string) =>
                id === RESEARCHER.id && userId === 'u1' ? RESEARCHER : null,
            ),
        };
        agentsService = { create: jest.fn() };
        delegation = {
            delegate: jest.fn().mockResolvedValue({
                delegationId: 'del-1',
                status: 'completed',
                summary: 'done',
                output: 'done',
                childAgentId: RESEARCHER.id,
            }),
        };
        collaborators = {
            listForAgent: jest.fn().mockResolvedValue([]),
            listEnabledForAgent: jest
                .fn()
                .mockResolvedValue([{ collaboratorAgentId: RESEARCHER.id, enabled: true }]),
        };
    });

    const delegator = () =>
        makeAgent({ permissions: makePerms({ canAssignTasks: true, canCallExternalTools: true }) });

    const getTool = (svc: AgentToolService, agent: Agent, runId = 'run-1') => {
        const tools = svc.resolveAllowedTools(agent, {
            runId,
            editsThisRunByFile: new Set(),
        });
        return tools.find((t) => t.name === 'delegateToAgent');
    };

    it('is gated on canAssignTasks', () => {
        const svc = build();
        expect(getTool(svc, makeAgent())).toBeUndefined();
        expect(getTool(svc, delegator())).toBeDefined();
    });

    it('is absent when the delegation service or repository is unbound', () => {
        expect(getTool(build({ delegation: undefined }), delegator())).toBeUndefined();
        expect(getTool(build({ collaborators: undefined }), delegator())).toBeUndefined();
    });

    it('delegates to an enabled collaborator by id — through the shared delegation path', async () => {
        const svc = build();
        const tool = getTool(svc, delegator())!;

        const result = (await tool.invoke({
            targetAgentId: RESEARCHER.id,
            objective: 'Summarise the release notes',
        })) as Record<string, unknown>;

        expect(result.status).toBe('completed');
        expect(delegation.delegate).toHaveBeenCalledTimes(1);
        const [request, limits] = delegation.delegate.mock.calls[0];
        expect(request.childAgentId).toBe(RESEARCHER.id);
        expect(request.parentAgentId).toBe('a1');
        expect(request.parentRunId).toBe('run-1');
        expect(request.objective).toBe('Summarise the release notes');
        // The wildcard scope is narrowed against the parent's REAL tools.
        expect(request.scope.allowedTools).toEqual(['*']);
        expect(limits.parentScope.allowedTools).toContain('delegateToAgent');
        expect(limits.parentScope.networkAccess).toBe(true);
    });

    it('resolves the target by slug within the enabled-collaborator set', async () => {
        const svc = build();
        const tool = getTool(svc, delegator())!;

        await tool.invoke({ targetAgentSlug: 'researcher', objective: 'Do the thing' });

        expect(delegation.delegate.mock.calls[0][0].childAgentId).toBe(RESEARCHER.id);
    });

    it('errors with the enabled roster when the target is not a collaborator', async () => {
        const svc = build();
        const tool = getTool(svc, delegator())!;

        const result = (await tool.invoke({
            targetAgentId: 'a-unknown',
            objective: 'x',
        })) as { error: string };

        expect(result.error).toContain('not an enabled collaborator');
        expect(result.error).toContain('Researcher (researcher)');
        expect(delegation.delegate).not.toHaveBeenCalled();
    });

    it('tells the model when NO collaborators are enabled at all', async () => {
        collaborators.listEnabledForAgent.mockResolvedValue([]);
        const svc = build();
        const tool = getTool(svc, delegator())!;

        const result = (await tool.invoke({
            targetAgentId: RESEARCHER.id,
            objective: 'x',
        })) as { error: string };

        expect(result.error).toContain('No collaborators are enabled');
        expect(delegation.delegate).not.toHaveBeenCalled();
    });

    it('never offers a collaborator row the owner does not actually own', async () => {
        // A stale/poisoned row naming a foreign agent must not resolve —
        // the owner-scoped load drops it from the candidate set.
        collaborators.listEnabledForAgent.mockResolvedValue([
            { collaboratorAgentId: 'a-foreign', enabled: true },
        ]);
        const svc = build();
        const tool = getTool(svc, delegator())!;

        const result = (await tool.invoke({
            targetAgentId: 'a-foreign',
            objective: 'x',
        })) as { error: string };

        expect(result.error).toContain('not an enabled collaborator');
        expect(delegation.delegate).not.toHaveBeenCalled();
    });

    it('forwards `context` as the request `inputs` the child brief is built from', async () => {
        const svc = build();
        const tool = getTool(svc, delegator())!;

        await tool.invoke({
            targetAgentId: RESEARCHER.id,
            objective: 'Summarise the findings',
            context: { findings: ['a', 'b'] },
        });

        // The tool advertises `context` to the model; if it does not land
        // on `inputs` the child never receives it and the delegation still
        // reports `completed`.
        expect(delegation.delegate.mock.calls[0][0].inputs).toEqual({ findings: ['a', 'b'] });
    });

    it('drops an ARCHIVED collaborator from the roster it offers the model', async () => {
        // The rule outlives the archive. Offering a retired agent would
        // name a target the runner refuses on every call.
        agents.findByIdAndUser.mockResolvedValue({
            ...RESEARCHER,
            status: AgentStatus.ARCHIVED,
        } as Agent);
        const svc = build();
        const tool = getTool(svc, delegator())!;

        const result = (await tool.invoke({
            targetAgentId: RESEARCHER.id,
            objective: 'x',
        })) as { error: string };

        expect(result.error).toContain('No collaborators are enabled');
        expect(result.error).not.toContain('Researcher');
        expect(delegation.delegate).not.toHaveBeenCalled();
    });

    it('allows self-delegation without any collaborator rows', async () => {
        collaborators.listEnabledForAgent.mockResolvedValue([]);
        const svc = build();
        const tool = getTool(svc, delegator())!;

        await tool.invoke({ targetAgentId: 'a1', objective: 'Self-check' });

        expect(delegation.delegate.mock.calls[0][0].childAgentId).toBe('a1');
    });

    it('requires an objective and a target', async () => {
        const svc = build();
        const tool = getTool(svc, delegator())!;

        expect(await tool.invoke({ targetAgentId: RESEARCHER.id } as never)).toMatchObject({
            error: expect.stringContaining('objective'),
        });
        expect(await tool.invoke({ objective: 'x' })).toMatchObject({
            error: expect.stringContaining('targetAgentId or targetAgentSlug'),
        });
        expect(delegation.delegate).not.toHaveBeenCalled();
    });

    it('feeds an increasing per-run sibling count into the fan-out cap', async () => {
        const svc = build();
        const tool = getTool(svc, delegator())!;

        await tool.invoke({ targetAgentId: RESEARCHER.id, objective: 'one' });
        await tool.invoke({ targetAgentId: RESEARCHER.id, objective: 'two' });

        expect(delegation.delegate.mock.calls[0][1].siblingCount).toBe(0);
        expect(delegation.delegate.mock.calls[1][1].siblingCount).toBe(1);
    });

    it('surfaces a thrown delegation as a tool error, never a crash', async () => {
        delegation.delegate.mockRejectedValue(new Error('runner exploded'));
        const svc = build();
        const tool = getTool(svc, delegator())!;

        expect(await tool.invoke({ targetAgentId: RESEARCHER.id, objective: 'x' })).toMatchObject({
            error: 'runner exploded',
        });
    });
});
