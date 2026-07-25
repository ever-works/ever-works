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
import { NO_MEMORY_FOUND_NOTE } from '../../services/memory-recall';

/**
 * Memory upgrades M2 — recall injection into task-kind agent runs.
 *
 * `AgentRunService.execute()` splices a fenced `<agent_memory>` block
 * built from `AgentMemoryFacadeService.buildContextWithProvider` into
 * the assembled system message for `kind: 'task'` runs. Contract under
 * test: best-effort (failure → run continues, WARN row), loud-empty
 * (configured-but-empty → explicit note + row), toggle-respecting
 * (`agent.memoryRecallEnabled === false` → skip + row), task-kind-only,
 * and an AgentRunLog row carrying recall size + provider.
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
        memoryRecallEnabled: true,
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
        heartbeatMd: null,
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

describe('AgentRunService — memory recall injection (M2)', () => {
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
        Pick<
            AgentMemoryFacadeService,
            'openSession' | 'closeSession' | 'isConfigured' | 'buildContextWithProvider'
        >
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
        chatBackPoster = { postReply: jest.fn().mockResolvedValue({ messageId: 'msg-new' }) };
        taskFinisher = { finishTask: jest.fn().mockResolvedValue({ status: 'done' }) };
        toolService = { resolveAllowedTools: jest.fn().mockReturnValue([]) };
        ai = { dispatch: jest.fn().mockResolvedValue(aiResponse()) };
        agentMemory = {
            openSession: jest
                .fn()
                .mockResolvedValue({ id: 'sess-42', startedAt: '2026-07-25T00:00:00Z' }),
            closeSession: jest.fn().mockResolvedValue(undefined),
            isConfigured: jest.fn().mockReturnValue(true),
            buildContextWithProvider: jest.fn().mockResolvedValue({
                context: { content: 'Previously: shipped the login fix.', approxTokens: 12 },
                providerId: 'agentmemory-plugin',
            }),
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

    const taskContext = {
        runId: 'r1',
        agentId: 'a1',
        userId: 'u1',
        kind: 'task' as const,
        taskId: 't1',
        immediateInput: 'Fix the login redirect bug',
    };

    function recallRows() {
        return runLogs.append.mock.calls
            .map(([row]: [any]) => row)
            .filter((row: any) => row.step === 'memory-recall');
    }

    it('splices the fenced recall block into the system message for a task-kind run', async () => {
        const result = await makeSvc().execute(taskContext);

        expect(result.status).toBe('dispatched');
        expect(result.prompt?.systemMessage).toContain('<agent_memory>');
        expect(result.prompt?.systemMessage).toContain('Previously: shipped the login fix.');
        expect(result.prompt?.systemMessage).toContain('</agent_memory>');
        // The dispatched messages carry the recall too (system message is
        // what runToolLoop sends).
        expect(agentMemory.buildContextWithProvider).toHaveBeenCalledWith(
            expect.objectContaining({
                query: 'Fix the login redirect bug',
                purpose: 'task',
                sessionId: 'sess-42',
            }),
            expect.objectContaining({ userId: 'u1' }),
        );
    });

    it('records an AgentRunLog row with recall size + provider on successful injection', async () => {
        await makeSvc().execute(taskContext);

        const rows = recallRows();
        expect(rows).toHaveLength(1);
        expect(rows[0].level).toBe('INFO');
        expect(rows[0].metadata).toEqual(
            expect.objectContaining({
                status: 'injected',
                provider: 'agentmemory-plugin',
                approxTokens: 12,
            }),
        );
        expect(rows[0].metadata.contentChars).toBeGreaterThan(0);
    });

    it('is loud-empty: configured provider returning nothing injects the explicit note + logs status=empty', async () => {
        agentMemory.buildContextWithProvider.mockResolvedValueOnce({
            context: { content: '' },
            providerId: 'agentmemory-plugin',
        });

        const result = await makeSvc().execute(taskContext);

        expect(result.prompt?.systemMessage).toContain(NO_MEMORY_FOUND_NOTE);
        const rows = recallRows();
        expect(rows).toHaveLength(1);
        expect(rows[0].metadata).toEqual(
            expect.objectContaining({ status: 'empty', provider: 'agentmemory-plugin' }),
        );
    });

    it('is best-effort: a recall failure logs a WARN row and the run continues without the block', async () => {
        agentMemory.buildContextWithProvider.mockRejectedValueOnce(
            new Error('memory backend unreachable'),
        );

        const result = await makeSvc().execute(taskContext);

        expect(result.status).toBe('dispatched');
        expect(result.prompt?.systemMessage).not.toContain('<agent_memory>');
        const rows = recallRows();
        expect(rows).toHaveLength(1);
        expect(rows[0].level).toBe('WARN');
        expect(rows[0].metadata).toEqual(expect.objectContaining({ status: 'failed' }));
        expect(runs.markCompleted).toHaveBeenCalled();
    });

    it('respects the per-Agent toggle: memoryRecallEnabled=false skips buildContext and logs status=disabled', async () => {
        agents.findById.mockResolvedValueOnce(makeAgent({ memoryRecallEnabled: false }));

        const result = await makeSvc().execute(taskContext);

        expect(result.status).toBe('dispatched');
        expect(agentMemory.buildContextWithProvider).not.toHaveBeenCalled();
        expect(result.prompt?.systemMessage).not.toContain('<agent_memory>');
        const rows = recallRows();
        expect(rows).toHaveLength(1);
        expect(rows[0].metadata).toEqual(expect.objectContaining({ status: 'disabled' }));
    });

    it('distinguishes recall-off from recall-empty: NoProviderError logs status=no-provider, injects nothing', async () => {
        const noProvider = new Error('No agent-memory provider configured or available');
        noProvider.name = 'NoProviderError';
        // Session open AND recall both hit the unconfigured facade.
        agentMemory.openSession.mockRejectedValueOnce(noProvider);
        agentMemory.buildContextWithProvider.mockRejectedValueOnce(noProvider);

        const result = await makeSvc().execute(taskContext);

        expect(result.status).toBe('dispatched');
        expect(result.prompt?.systemMessage).not.toContain('<agent_memory>');
        const rows = recallRows();
        expect(rows).toHaveLength(1);
        expect(rows[0].level).toBe('INFO');
        expect(rows[0].metadata).toEqual(expect.objectContaining({ status: 'no-provider' }));
    });

    it('does not inject recall for non-task run kinds (heartbeat)', async () => {
        const result = await makeSvc().execute({
            runId: 'r2',
            agentId: 'a1',
            userId: 'u1',
            kind: 'heartbeat' as const,
        });

        expect(result.status).toBe('dispatched');
        expect(agentMemory.buildContextWithProvider).not.toHaveBeenCalled();
        expect(recallRows()).toHaveLength(0);
    });

    it('threads workId into projectId + FacadeOptions for Work-scoped agents', async () => {
        agents.findById.mockResolvedValueOnce(makeAgent({ workId: 'work-77' }));

        await makeSvc().execute(taskContext);

        expect(agentMemory.buildContextWithProvider).toHaveBeenCalledWith(
            expect.objectContaining({ projectId: 'work-77' }),
            expect.objectContaining({ userId: 'u1', workId: 'work-77' }),
        );
    });

    it('is a no-op when the agent-memory facade is not injected (OSS build)', async () => {
        const result = await makeSvc({ withMemory: false }).execute(taskContext);

        expect(result.status).toBe('dispatched');
        expect(agentMemory.buildContextWithProvider).not.toHaveBeenCalled();
        expect(recallRows()).toHaveLength(0);
    });
});
