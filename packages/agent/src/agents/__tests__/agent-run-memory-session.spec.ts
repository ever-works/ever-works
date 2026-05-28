import { AgentRunService } from '../agent-run.service';
import { PromptAssemblerService } from '../prompt-assembler.service';
import {
    AgentAvatarMode,
    AgentIdleBehavior,
    AgentScope,
    AgentStatus,
} from '../../entities/agent.entity';
import type { Agent } from '../../entities/agent.entity';
import type { AgentAiDispatchFacade, AgentAiDispatchResult } from '../agent-ai-dispatch-facade';
import type { AgentToolService } from '../agent-tool.service';
import type { AgentRunChatBackPoster, AgentRunTaskFinisher } from '../agent-run-post-processor';
import type { AgentMemoryFacadeService } from '../../facades/agent-memory.facade';

/**
 * PR #1073 + #1081 follow-up — agent-memory session per run.
 *
 * AgentRunService.execute() opens a memory session at the start of the
 * run (when the agent-memory facade is bound + configured), persists
 * the returned session id on the agent_runs row, and closes the
 * session from finalize(). All paths are best-effort — a memory
 * outage must never derail the agent run.
 */
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
        permissions: {
            canCreateAgents: false,
            canAssignTasks: false,
            canEditSkills: false,
            canEditAgentFiles: false,
            canSpend: false,
            canCommitToRepo: false,
            canOpenPullRequests: false,
            canCallExternalTools: false,
        },
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

function aiResponse(over: Partial<AgentAiDispatchResult> = {}): AgentAiDispatchResult {
    return {
        text: 'Hello world',
        toolCalls: [],
        finishReason: 'stop',
        usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
        model: 'gpt-4o-mini',
        ...over,
    };
}

describe('AgentRunService — agent-memory session lifecycle', () => {
    let agents: any;
    let runs: any;
    let runLogs: any;
    let budgets: any;
    let skillBindings: any;
    let activity: any;
    let assembler: PromptAssemblerService;
    let chatBackPoster: jest.Mocked<AgentRunChatBackPoster>;
    let taskFinisher: jest.Mocked<AgentRunTaskFinisher>;
    let toolService: jest.Mocked<Pick<AgentToolService, 'resolveAllowedTools'>>;
    let ai: jest.Mocked<AgentAiDispatchFacade>;
    let agentMemory: jest.Mocked<
        Pick<AgentMemoryFacadeService, 'openSession' | 'closeSession' | 'isConfigured'>
    >;

    beforeEach(() => {
        agents = { findById: jest.fn().mockResolvedValue(makeAgent()) };
        runs = {
            findByAgent: jest.fn().mockResolvedValue([]),
            markFailed: jest.fn().mockResolvedValue(undefined),
            markCompleted: jest.fn().mockResolvedValue(undefined),
            setMemorySessionId: jest.fn().mockResolvedValue(undefined),
        };
        runLogs = { append: jest.fn().mockResolvedValue(undefined) };
        budgets = { findByAgentId: jest.fn().mockResolvedValue(null) };
        skillBindings = { resolveActive: jest.fn().mockResolvedValue([]) };
        activity = { log: jest.fn().mockResolvedValue(undefined) };
        assembler = new PromptAssemblerService();
        chatBackPoster = {
            postReply: jest.fn().mockResolvedValue({ messageId: 'msg-new' }),
        };
        taskFinisher = {
            finishTask: jest.fn().mockResolvedValue({ status: 'done' }),
        };
        toolService = { resolveAllowedTools: jest.fn().mockReturnValue([]) };
        ai = { dispatch: jest.fn().mockResolvedValue(aiResponse()) };
        agentMemory = {
            openSession: jest
                .fn()
                .mockResolvedValue({ id: 'sess-42', startedAt: '2026-05-28T00:00:00Z' }),
            closeSession: jest.fn().mockResolvedValue(undefined),
            isConfigured: jest.fn().mockReturnValue(true),
        };
    });

    function makeSvc(opts: { withMemory?: boolean } = { withMemory: true }): AgentRunService {
        return new AgentRunService(
            agents,
            runs,
            runLogs,
            budgets,
            assembler,
            skillBindings,
            activity,
            chatBackPoster,
            taskFinisher,
            toolService as unknown as AgentToolService,
            ai,
            opts.withMemory ? (agentMemory as unknown as AgentMemoryFacadeService) : undefined,
        );
    }

    const runContext = {
        runId: 'r1',
        agentId: 'a1',
        userId: 'u1',
        kind: 'heartbeat' as const,
    };

    it('opens a session at the start of a successful run + persists the id + closes it on finalize', async () => {
        const result = await makeSvc().execute(runContext);

        expect(result.status).toBe('dispatched');
        expect(agentMemory.openSession).toHaveBeenCalledTimes(1);
        expect(agentMemory.openSession).toHaveBeenCalledWith(
            expect.objectContaining({
                runId: 'r1',
                agentId: 'a1',
                triggerKind: 'heartbeat',
            }),
            expect.objectContaining({ userId: 'u1' }),
        );
        expect(runs.setMemorySessionId).toHaveBeenCalledWith('r1', 'sess-42');
        expect(agentMemory.closeSession).toHaveBeenCalledWith(
            'sess-42',
            expect.objectContaining({ userId: 'u1' }),
        );
        expect(runs.markCompleted).toHaveBeenCalled();
    });

    it('closes the session on the failure path (dispatch-failed)', async () => {
        ai.dispatch.mockRejectedValueOnce(new Error('AI provider blew up'));
        const result = await makeSvc().execute(runContext);

        expect(result.status).toBe('dispatch-failed');
        expect(agentMemory.openSession).toHaveBeenCalledTimes(1);
        expect(agentMemory.closeSession).toHaveBeenCalledWith(
            'sess-42',
            expect.objectContaining({ userId: 'u1' }),
        );
        expect(runs.markFailed).toHaveBeenCalled();
    });

    it('skips silently when openSession throws NoProviderError (no enabled provider for this user)', async () => {
        // The user has no agent-memory plugin enabled. The facade
        // throws NoProviderError; we log at debug and continue.
        const noProvider = new Error('No agent-memory provider configured or available');
        noProvider.name = 'NoProviderError';
        agentMemory.openSession.mockRejectedValueOnce(noProvider);
        const result = await makeSvc().execute(runContext);

        expect(result.status).toBe('dispatched');
        expect(runs.setMemorySessionId).not.toHaveBeenCalled();
        expect(agentMemory.closeSession).not.toHaveBeenCalled();
        expect(runs.markCompleted).toHaveBeenCalled();
    });

    it('continues the run when openSession throws an unexpected error (memory outage is non-fatal)', async () => {
        agentMemory.openSession.mockRejectedValueOnce(new Error('agentmemory unreachable'));
        const result = await makeSvc().execute(runContext);

        expect(result.status).toBe('dispatched');
        expect(runs.setMemorySessionId).not.toHaveBeenCalled();
        expect(agentMemory.closeSession).not.toHaveBeenCalled();
        expect(runs.markCompleted).toHaveBeenCalled();
    });

    it('forwards agent.workId to openSession + closeSession for Work-scoped agents', async () => {
        agents.findById.mockResolvedValueOnce(makeAgent({ workId: 'work-77' }));
        await makeSvc().execute(runContext);

        expect(agentMemory.openSession).toHaveBeenCalledWith(
            expect.any(Object),
            expect.objectContaining({ userId: 'u1', workId: 'work-77' }),
        );
        expect(agentMemory.closeSession).toHaveBeenCalledWith(
            'sess-42',
            expect.objectContaining({ userId: 'u1', workId: 'work-77' }),
        );
    });

    it('omits workId from FacadeOptions when the agent is not Work-scoped', async () => {
        agents.findById.mockResolvedValueOnce(makeAgent({ workId: null }));
        await makeSvc().execute(runContext);

        const openOpts = agentMemory.openSession.mock.calls[0][1];
        expect(openOpts).not.toHaveProperty('workId');
    });

    it('continues the run when setMemorySessionId fails (DB hiccup)', async () => {
        runs.setMemorySessionId.mockRejectedValueOnce(new Error('DB conflict'));
        const result = await makeSvc().execute(runContext);

        expect(result.status).toBe('dispatched');
        // Session WAS opened — close should still fire on finalize.
        expect(agentMemory.closeSession).toHaveBeenCalledWith('sess-42', expect.any(Object));
    });

    it('continues the run when closeSession throws on finalize', async () => {
        agentMemory.closeSession.mockRejectedValueOnce(new Error('close timeout'));
        const result = await makeSvc().execute(runContext);

        expect(result.status).toBe('dispatched');
        expect(runs.markCompleted).toHaveBeenCalled();
    });

    it('is a no-op when AgentMemoryFacadeService is not injected (OSS build / unit-test mode)', async () => {
        await makeSvc({ withMemory: false }).execute(runContext);

        expect(agentMemory.openSession).not.toHaveBeenCalled();
        expect(runs.setMemorySessionId).not.toHaveBeenCalled();
        expect(agentMemory.closeSession).not.toHaveBeenCalled();
    });
});
