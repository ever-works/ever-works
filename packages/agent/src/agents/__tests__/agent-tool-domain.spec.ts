import { AgentToolService } from '../agent-tool.service';
import {
    AgentScope,
    AgentStatus,
    AgentAvatarMode,
    AgentIdleBehavior,
} from '../../entities/agent.entity';
import type { Agent, AgentPermissions } from '../../entities/agent.entity';
import type { AgentDomainToolSources } from '../agent-domain-tool-sources';

/**
 * Domain chat tools — assembly into the ONE tool-resolution point.
 *
 * Six descriptor factories shipped alongside their domains (Waves 3, 6,
 * 7, 8, 12) but nothing ever called them, so no agent run could reach
 * any of those tools. These tests pin the fix: the factories are now
 * assembled by `AgentToolService.resolveAllowedTools` — the same list
 * `AgentRunService.runToolLoop` turns into the model's tool definitions
 * — with the same owner/permission scoping as the built-in tools.
 */

function makePerms(over: Partial<AgentPermissions> = {}): AgentPermissions {
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
        scope: AgentScope.WORK,
        missionId: null,
        ideaId: null,
        workId: 'w1',
        name: 'Operator',
        slug: 'operator',
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
        soulMd: '# Soul',
        agentsMd: null,
        heartbeatMd: null,
        toolsMd: null,
        agentYml: null,
        contentHash: null,
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
        ...over,
    } as Agent;
}

/** Every domain tool the six previously-dead factories produce. */
const DOMAIN_TOOL_NAMES = [
    'commentOnTask',
    'list_recent_events',
    'get_digest',
    'list_meetings',
    'get_meeting_summary',
    'list_fleet_nodes',
    'resolve_merge_policy',
];

describe('AgentToolService — domain chat tool assembly', () => {
    let agentsRepo: any;
    let agentsService: any;
    let sources: AgentDomainToolSources;
    let authorize: jest.Mock;

    beforeEach(() => {
        agentsRepo = { create: jest.fn(), findByIdAndUser: jest.fn() };
        agentsService = { create: jest.fn() };
        authorize = jest.fn().mockResolvedValue({ workId: 'w1', agentId: null });
        sources = {
            tasks: {
                tasksService: {
                    create: jest.fn().mockResolvedValue({ id: 't-new', slug: 'task-new' }),
                    transition: jest.fn().mockResolvedValue({ id: 't1', status: 'done' }),
                } as any,
                chatService: {
                    post: jest
                        .fn()
                        .mockResolvedValue({ id: 'msg1', createdAt: new Date('2026-01-01') }),
                } as any,
                assignees: {
                    findByTaskId: jest
                        .fn()
                        .mockResolvedValue([{ assigneeType: 'agent', assigneeId: 'a1' }]),
                } as any,
                reviewers: { findByTaskId: jest.fn().mockResolvedValue([]) } as any,
                approvers: { findByTaskId: jest.fn().mockResolvedValue([]) } as any,
            },
            ingest: {
                repository: { findRecentByUser: jest.fn().mockResolvedValue([]) } as any,
            },
            digest: {
                digestService: {
                    composeDigest: jest.fn().mockResolvedValue({ counts: {} }),
                } as any,
            },
            meetings: {
                repository: {
                    findByUser: jest.fn().mockResolvedValue([]),
                    findById: jest.fn().mockResolvedValue(null),
                } as any,
            },
            fleet: { service: { listForUser: jest.fn().mockResolvedValue([]) } as any },
            prReview: {
                prReviewService: {
                    reviewPullRequest: jest.fn().mockResolvedValue({ status: 'reviewed' }),
                } as any,
            },
            mergePolicy: {
                service: { resolve: jest.fn().mockResolvedValue({ source: 'work' }) } as any,
                authorize: authorize as any,
            },
        };
    });

    /** `null` = the token is unbound (an explicit `undefined` would hit the default). */
    function makeSvc(bundle: AgentDomainToolSources | null = sources): AgentToolService {
        return new AgentToolService(
            agentsRepo,
            agentsService,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            bundle ?? undefined,
        );
    }

    it('registers every domain tool the factories produce when the sources token is bound', () => {
        const names = makeSvc()
            .resolveAllowedTools(makeAgent())
            .map((tool) => tool.name);
        for (const expected of DOMAIN_TOOL_NAMES) {
            expect(names).toContain(expected);
        }
    });

    it('registers NO domain tools when the sources token is unbound (the pre-fix state)', () => {
        const names = makeSvc(null)
            .resolveAllowedTools(makeAgent())
            .map((tool) => tool.name);
        for (const notExpected of DOMAIN_TOOL_NAMES) {
            expect(names).not.toContain(notExpected);
        }
        // …but the built-in tools are untouched.
        expect(names).toContain('getActivity');
        expect(names).toContain('getKbDocument');
    });

    it('keeps the built-in tools alongside the domain tools (additive, not a replacement)', () => {
        const names = makeSvc()
            .resolveAllowedTools(makeAgent())
            .map((tool) => tool.name);
        expect(names).toContain('getActivity');
        expect(names).toContain('getKbDocument');
        expect(new Set(names).size).toBe(names.length);
    });

    it('gates createTask / transitionTask behind canAssignTasks', () => {
        const without = makeSvc()
            .resolveAllowedTools(makeAgent())
            .map((tool) => tool.name);
        expect(without).not.toContain('createTask');
        expect(without).not.toContain('transitionTask');

        const withPerm = makeSvc()
            .resolveAllowedTools(makeAgent({ permissions: makePerms({ canAssignTasks: true }) }))
            .map((tool) => tool.name);
        expect(withPerm).toContain('createTask');
        expect(withPerm).toContain('transitionTask');
    });

    it('gates review_pull_request behind canCallExternalTools (outbound risk class)', () => {
        const without = makeSvc()
            .resolveAllowedTools(makeAgent())
            .map((tool) => tool.name);
        expect(without).not.toContain('review_pull_request');

        const withPerm = makeSvc()
            .resolveAllowedTools(
                makeAgent({ permissions: makePerms({ canCallExternalTools: true }) }),
            )
            .map((tool) => tool.name);
        expect(withPerm).toContain('review_pull_request');
    });

    it('registers only the domains the bundle actually carries', () => {
        const names = makeSvc({ fleet: sources.fleet })
            .resolveAllowedTools(makeAgent())
            .map((tool) => tool.name);
        expect(names).toContain('list_fleet_nodes');
        expect(names).not.toContain('list_meetings');
        expect(names).not.toContain('get_digest');
        expect(names).not.toContain('commentOnTask');
    });

    it('scopes every read tool to the AGENT OWNER, never a model-supplied user', async () => {
        const tools = makeSvc().resolveAllowedTools(makeAgent({ userId: 'owner-9' }));
        const byName = new Map(tools.map((tool) => [tool.name, tool]));

        await byName.get('list_recent_events')!.invoke({ limit: 5 });
        // `findRecentByUser` takes either a bare limit or a filter object;
        // the tool passes the filter form so `workId` / `source` can ride
        // along. What this assertion is actually for is the FIRST
        // argument — the owner is the agent's user, never the model's.
        expect((sources.ingest!.repository as any).findRecentByUser).toHaveBeenCalledWith(
            'owner-9',
            expect.objectContaining({ limit: 5 }),
        );

        await byName.get('list_meetings')!.invoke({});
        expect((sources.meetings!.repository as any).findByUser).toHaveBeenCalledWith(
            'owner-9',
            expect.any(Object),
        );

        await byName.get('list_fleet_nodes')!.invoke({});
        expect((sources.fleet!.service as any).listForUser).toHaveBeenCalledWith('owner-9');

        await byName.get('get_digest')!.invoke({ period: 'weekly' });
        expect((sources.digest!.digestService as any).composeDigest).toHaveBeenCalledWith(
            'owner-9',
            { period: 'weekly' },
        );
    });

    it('authorizes resolve_merge_policy against the agent owner before resolving', async () => {
        const tools = makeSvc().resolveAllowedTools(makeAgent({ userId: 'owner-9' }));
        const tool = tools.find((t) => t.name === 'resolve_merge_policy')!;

        await tool.invoke({ workId: 'w1' });

        expect(authorize).toHaveBeenCalledWith('owner-9', { workId: 'w1' });
        expect((sources.mergePolicy!.service as any).resolve).toHaveBeenCalled();
    });

    it('refuses resolve_merge_policy for a scope the owner may not reach (no existence leak)', async () => {
        authorize.mockResolvedValue(null);
        const tools = makeSvc().resolveAllowedTools(makeAgent());
        const tool = tools.find((t) => t.name === 'resolve_merge_policy')!;

        const result = await tool.invoke({ workId: 'someone-elses-work' });

        expect(result).toEqual({ error: 'Not found or not accessible to the current user.' });
        expect((sources.mergePolicy!.service as any).resolve).not.toHaveBeenCalled();
    });

    it('keeps commentOnTask fail-closed on membership', async () => {
        (sources.tasks!.assignees as any).findByTaskId.mockResolvedValue([]);
        const tools = makeSvc().resolveAllowedTools(makeAgent());
        const tool = tools.find((t) => t.name === 'commentOnTask')!;

        const result = (await tool.invoke({ taskId: 't1', body: 'hi' })) as { error?: string };

        expect(result.error).toContain('not a member of the Task');
        expect((sources.tasks!.chatService as any).post).not.toHaveBeenCalled();
    });

    it('skips a domain whose factory throws instead of failing tool resolution', () => {
        // A source object that makes `buildFleetTools` throw at build time.
        const exploding = {
            ...sources,
            fleet: {
                get service(): never {
                    throw new Error('fleet wiring exploded');
                },
            },
        } as unknown as AgentDomainToolSources;

        const names = makeSvc(exploding)
            .resolveAllowedTools(makeAgent())
            .map((tool) => tool.name);

        expect(names).not.toContain('list_fleet_nodes');
        // Every other domain still resolved.
        expect(names).toContain('list_meetings');
        expect(names).toContain('get_digest');
        expect(names).toContain('getActivity');
    });

    it('exposes a JSON-schema parameter block for every domain tool', () => {
        const tools = makeSvc()
            .resolveAllowedTools(makeAgent({ permissions: makePerms({ canAssignTasks: true }) }))
            .filter((tool) => DOMAIN_TOOL_NAMES.includes(tool.name));
        expect(tools.length).toBeGreaterThanOrEqual(DOMAIN_TOOL_NAMES.length);
        for (const tool of tools) {
            expect(tool.parameters.type).toBe('object');
            expect(tool.description.length).toBeGreaterThan(0);
            expect(typeof tool.invoke).toBe('function');
        }
    });
});
