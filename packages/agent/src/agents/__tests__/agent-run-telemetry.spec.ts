import { AgentRunService } from '../agent-run.service';
import { AgentToolService } from '../agent-tool.service';
import { PromptAssemblerService } from '../prompt-assembler.service';
import {
    AgentAvatarMode,
    AgentIdleBehavior,
    AgentScope,
    AgentStatus,
} from '../../entities/agent.entity';
import type { Agent, AgentPermissions } from '../../entities/agent.entity';
import type { AgentAiDispatchFacade, AgentAiDispatchResult } from '../agent-ai-dispatch-facade';
import type { AgentDomainToolSources } from '../agent-domain-tool-sources';

/**
 * Run telemetry + end-to-end tool assembly for the agent tool loop.
 *
 * Two previously-dead paths are pinned here:
 *
 *  1. `agent_runs.totalTokens` had columns, an API embed and UI, but no
 *     writer — the Sessions cockpit and the board run chip always showed
 *     a blank counter. The loop now folds each round-trip's usage in.
 *  2. The domain chat tools were never assembled, so a `task` run's tool
 *     list only ever carried the built-ins. It now carries them.
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
        scope: AgentScope.TENANT,
        missionId: null,
        ideaId: null,
        workId: null,
        name: 'CEO',
        slug: 'ceo',
        title: null,
        capabilities: null,
        aiProviderId: null,
        modelId: 'gpt-4o-mini',
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
        soulMd: '# Who I am\nThe boss.',
        agentsMd: null,
        heartbeatMd: '# Each tick\nLook at recent activity.',
        toolsMd: null,
        agentYml: null,
        contentHash: null,
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
        ...over,
    } as Agent;
}

describe('AgentRunService — run telemetry + assembled tool list', () => {
    let agents: any;
    let runs: any;
    let runLogs: any;
    let budgets: any;
    let assembler: PromptAssemblerService;
    let ai: jest.Mocked<AgentAiDispatchFacade>;
    let toolService: AgentToolService;
    let sources: AgentDomainToolSources;

    const baseContext = {
        runId: 'r1',
        agentId: 'a1',
        userId: 'u1',
        kind: 'chat' as const,
        taskId: 't1',
        chatMessageId: 'm1',
    };

    beforeEach(() => {
        agents = { findById: jest.fn().mockResolvedValue(makeAgent()) };
        runs = {
            findByAgent: jest.fn().mockResolvedValue([]),
            markFailed: jest.fn().mockResolvedValue(undefined),
            markCompleted: jest.fn().mockResolvedValue(undefined),
            addTokens: jest.fn().mockResolvedValue(undefined),
        };
        runLogs = { append: jest.fn().mockResolvedValue(undefined) };
        budgets = { findByAgentId: jest.fn().mockResolvedValue(null) };
        assembler = new PromptAssemblerService();
        ai = { dispatch: jest.fn() };
        sources = {
            ingest: {
                repository: { findRecentByUser: jest.fn().mockResolvedValue([]) } as any,
            },
            digest: {
                digestService: { composeDigest: jest.fn().mockResolvedValue({}) } as any,
            },
            meetings: {
                repository: {
                    findByUser: jest.fn().mockResolvedValue([]),
                    findById: jest.fn().mockResolvedValue(null),
                } as any,
            },
            fleet: { service: { listForUser: jest.fn().mockResolvedValue([]) } as any },
            mergePolicy: {
                service: { resolve: jest.fn().mockResolvedValue({}) } as any,
                authorize: jest.fn().mockResolvedValue(null) as any,
            },
        };
        toolService = new AgentToolService(
            { create: jest.fn(), findByIdAndUser: jest.fn() } as any,
            { create: jest.fn() } as any,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            sources,
        );
    });

    function makeSvc(): AgentRunService {
        return new AgentRunService(
            agents,
            runs,
            runLogs,
            budgets,
            assembler,
            undefined,
            undefined,
            { postReply: jest.fn().mockResolvedValue({ messageId: 'msg' }) } as any,
            { finishTask: jest.fn().mockResolvedValue({ status: 'done' }) } as any,
            toolService,
            ai,
        );
    }

    function aiResponse(over: Partial<AgentAiDispatchResult> = {}): AgentAiDispatchResult {
        return {
            text: 'ok',
            toolCalls: [],
            finishReason: 'stop',
            usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
            model: 'gpt-4o-mini',
            ...over,
        };
    }

    // ── assembled tool list ──────────────────────────────────────────

    it('a task-kind run dispatches with the domain tools in its tool list', async () => {
        ai.dispatch.mockResolvedValue(aiResponse());

        await makeSvc().execute({ ...baseContext, kind: 'task', immediateInput: 'go' });

        const toolNames = (ai.dispatch.mock.calls[0][0].tools ?? []).map((t) => t.name);
        expect(toolNames).toEqual(
            expect.arrayContaining([
                'list_recent_events',
                'get_digest',
                'list_meetings',
                'get_meeting_summary',
                'list_fleet_nodes',
                'resolve_merge_policy',
            ]),
        );
        // The virtual task-only tool and the built-ins are still there.
        expect(toolNames).toContain('transitionTask');
        expect(toolNames).toContain('getActivity');
    });

    it('the dispatched tool definitions carry a JSON-schema parameter block', async () => {
        ai.dispatch.mockResolvedValue(aiResponse());

        await makeSvc().execute({ ...baseContext, kind: 'task', immediateInput: 'go' });

        const defs = ai.dispatch.mock.calls[0][0].tools ?? [];
        const digest = defs.find((d) => d.name === 'get_digest');
        expect(digest).toBeDefined();
        expect((digest!.parameters as { type?: string }).type).toBe('object');
        expect(digest!.description.length).toBeGreaterThan(0);
    });

    it('still gates permissioned domain tools inside a real run', async () => {
        ai.dispatch.mockResolvedValue(aiResponse());
        agents.findById.mockResolvedValue(makeAgent({ permissions: makePerms() }));

        await makeSvc().execute({ ...baseContext, kind: 'task', immediateInput: 'go' });

        const toolNames = (ai.dispatch.mock.calls[0][0].tools ?? []).map((t) => t.name);
        expect(toolNames).not.toContain('createTask');
        expect(toolNames).not.toContain('review_pull_request');
    });

    // ── token telemetry ──────────────────────────────────────────────

    it('accumulates the token counter across every model round-trip', async () => {
        ai.dispatch
            .mockResolvedValueOnce(
                aiResponse({
                    toolCalls: [{ id: 'tc1', name: 'getActivity', args: {} }],
                    finishReason: 'tool_calls',
                    usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
                }),
            )
            .mockResolvedValueOnce(
                aiResponse({
                    usage: { promptTokens: 40, completionTokens: 5, totalTokens: 45 },
                }),
            );

        await makeSvc().execute(baseContext);

        expect(runs.addTokens).toHaveBeenCalledTimes(2);
        expect(runs.addTokens).toHaveBeenNthCalledWith(1, 'r1', 120);
        expect(runs.addTokens).toHaveBeenNthCalledWith(2, 'r1', 45);
    });

    it('falls back to promptTokens + completionTokens when totalTokens is absent', async () => {
        ai.dispatch.mockResolvedValue(
            aiResponse({ usage: { promptTokens: 7, completionTokens: 3 } as never }),
        );

        await makeSvc().execute(baseContext);

        expect(runs.addTokens).toHaveBeenCalledWith('r1', 10);
    });

    it('writes nothing when the provider reports no usage at all', async () => {
        ai.dispatch.mockResolvedValue(aiResponse({ usage: undefined }));

        await makeSvc().execute(baseContext);

        expect(runs.addTokens).not.toHaveBeenCalled();
    });

    it('a rejecting token writer never fails the run', async () => {
        runs.addTokens.mockRejectedValue(new Error('db down'));
        ai.dispatch.mockResolvedValue(aiResponse());

        const result = await makeSvc().execute(baseContext);

        expect(result.status).toBe('dispatched');
        expect(runs.markFailed).not.toHaveBeenCalled();
    });

    it('a repository with no addTokens method at all never fails the run', async () => {
        // Older RPC proxies / partial doubles throw SYNCHRONOUSLY here,
        // which a bare `.catch()` would not absorb.
        delete runs.addTokens;
        ai.dispatch.mockResolvedValue(aiResponse());

        const result = await makeSvc().execute(baseContext);

        expect(result.status).toBe('dispatched');
        expect(runs.markFailed).not.toHaveBeenCalled();
    });
});
