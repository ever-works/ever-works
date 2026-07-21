import { AgentRunService } from '../agent-run.service';
import { PromptAssemblerService } from '../prompt-assembler.service';
import {
    AgentAvatarMode,
    AgentIdleBehavior,
    AgentScope,
    AgentStatus,
} from '../../entities/agent.entity';
import type { Agent } from '../../entities/agent.entity';
import type { AgentAiDispatchResult } from '../agent-ai-dispatch-facade';
import type { AgentToolService } from '../agent-tool.service';
import type { AgentMemoryFacadeService } from '../../facades/agent-memory.facade';

/**
 * Cooperative mid-run abort.
 *
 * Cancelling an AgentRun CAS-transitions the row to 'cancelled' and cancels the
 * Trigger.dev run. This covers what the WORKER does once it notices: stop the
 * tool loop promptly, write no status (the row is already terminal), close the
 * memory session, and suppress the externally-visible side effects the CAS does
 * NOT protect — the chat-back post and the task transition.
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

/** A round that always asks for another tool call, so the loop never self-terminates. */
function toolCallRound(over: Partial<AgentAiDispatchResult> = {}): AgentAiDispatchResult {
    return {
        text: null,
        toolCalls: [{ id: 'tc-1', name: 'noop', arguments: {} }],
        finishReason: 'tool_calls',
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        model: 'gpt-4o-mini',
        ...over,
    } as AgentAiDispatchResult;
}

describe('AgentRunService — cooperative mid-run abort', () => {
    let agents: any;
    let runs: any;
    let runLogs: any;
    let budgets: any;
    let skillBindings: any;
    let activity: any;
    let assembler: PromptAssemblerService;
    let chatBackPoster: any;
    let taskFinisher: any;
    let toolService: any;
    let ai: any;
    let agentMemory: any;

    beforeEach(() => {
        agents = { findById: jest.fn().mockResolvedValue(makeAgent()) };
        runs = {
            findByAgent: jest.fn().mockResolvedValue([]),
            findById: jest.fn().mockResolvedValue({ id: 'r1', status: 'running' }),
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
        // A tool the loop can "invoke" so a round with tool calls keeps going.
        toolService = {
            resolveAllowedTools: jest.fn().mockReturnValue([
                {
                    name: 'noop',
                    description: 'noop',
                    parameters: { type: 'object', properties: {} },
                    invoke: jest.fn().mockResolvedValue({ ok: true }),
                },
            ]),
        };
        ai = { dispatch: jest.fn().mockResolvedValue(toolCallRound()) };
        agentMemory = {
            openSession: jest
                .fn()
                .mockResolvedValue({ id: 'sess-42', startedAt: '2026-05-28T00:00:00Z' }),
            closeSession: jest.fn().mockResolvedValue(undefined),
            isConfigured: jest.fn().mockReturnValue(true),
        };
    });

    function makeSvc(): AgentRunService {
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
            agentMemory as unknown as AgentMemoryFacadeService,
        );
    }

    const baseContext = {
        runId: 'r1',
        agentId: 'a1',
        userId: 'u1',
        kind: 'heartbeat' as const,
    };

    it('stops the tool loop on the very next round when the signal aborts', async () => {
        // THE no-op catcher. `mockResolvedValue` (not ...Once) means an
        // implementation that reads the flag but never breaks would run all 10
        // iterations. Only a call-count assertion proves the loop stopped.
        const controller = new AbortController();
        ai.dispatch.mockImplementation(async () => {
            controller.abort();
            return toolCallRound();
        });
        const result = await makeSvc().execute({ ...baseContext, signal: controller.signal });
        expect(ai.dispatch).toHaveBeenCalledTimes(1);
        expect(result.status).toBe('cancelled');
    });

    it('falls back to the DB status when no signal is present', async () => {
        // Covers the real windows where the Trigger.dev cancel never fires:
        // the canceller returned 'failed', or triggerRunId was still NULL.
        runs.findById
            .mockResolvedValueOnce({ id: 'r1', status: 'running' })
            .mockResolvedValue({ id: 'r1', status: 'cancelled' });
        const result = await makeSvc().execute(baseContext);
        expect(ai.dispatch).toHaveBeenCalledTimes(1);
        expect(result.status).toBe('cancelled');
    });

    it('writes no run status — the row is already cancelled', async () => {
        const controller = new AbortController();
        controller.abort();
        await makeSvc().execute({ ...baseContext, signal: controller.signal });
        // Both would no-op against the CAS, but calling them emits a
        // misleading warnTerminalNoOp WARN on every user cancel.
        expect(runs.markFailed).not.toHaveBeenCalled();
        expect(runs.markCompleted).not.toHaveBeenCalled();
    });

    it('still closes the memory session', async () => {
        // This is why abort routes through finalize() rather than returning
        // early — memorySessionId is a local with no try/finally around it.
        const controller = new AbortController();
        controller.abort();
        await makeSvc().execute({ ...baseContext, signal: controller.signal });
        expect(agentMemory.closeSession).toHaveBeenCalledWith('sess-42', expect.anything());
    });

    it('reports cancelled in both the result and the finalize result', async () => {
        const controller = new AbortController();
        controller.abort();
        const result = await makeSvc().execute({ ...baseContext, signal: controller.signal });
        expect(result.status).toBe('cancelled');
        expect(result.finalizeResult?.status).toBe('cancelled');
    });

    it('does NOT post a chat reply for a cancelled chat run', async () => {
        // The CAS protects the row, not the side effects. A posted reply is
        // externally visible and not undoable.
        const controller = new AbortController();
        controller.abort();
        await makeSvc().execute({
            ...baseContext,
            kind: 'chat',
            taskId: 't1',
            chatMessageId: 'm1',
            immediateInput: 'hello',
            signal: controller.signal,
        });
        expect(chatBackPoster.postReply).not.toHaveBeenCalled();
    });

    it('does NOT transition the Task for a cancelled task run', async () => {
        const controller = new AbortController();
        controller.abort();
        await makeSvc().execute({
            ...baseContext,
            kind: 'task',
            taskId: 't1',
            immediateInput: 'do the thing',
            signal: controller.signal,
        });
        expect(taskFinisher.finishTask).not.toHaveBeenCalled();
    });

    it('still reports dispatch-failed for a genuine provider error', async () => {
        // Guards against over-broadening the classifier: a real failure must
        // not be laundered into a cancel.
        ai.dispatch.mockRejectedValueOnce(new Error('provider exploded'));
        const result = await makeSvc().execute(baseContext);
        expect(result.status).toBe('dispatch-failed');
        expect(runs.markFailed).toHaveBeenCalled();
    });

    it('classifies as cancelled when the signal aborted and the provider also threw', async () => {
        // Cancel wins: the provider error is a consequence of the abort.
        const controller = new AbortController();
        ai.dispatch.mockImplementation(async () => {
            controller.abort();
            throw new Error('socket closed');
        });
        const result = await makeSvc().execute({ ...baseContext, signal: controller.signal });
        expect(result.status).toBe('cancelled');
        expect(runs.markFailed).not.toHaveBeenCalled();
    });

    it('proceeds normally when the status read throws', async () => {
        runs.findById.mockRejectedValue(new Error('DB down'));
        ai.dispatch.mockResolvedValue({
            text: 'done',
            toolCalls: [],
            finishReason: 'stop',
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            model: 'gpt-4o-mini',
        } as AgentAiDispatchResult);
        const result = await makeSvc().execute(baseContext);
        expect(result.status).toBe('dispatched');
    });

    it('never reads the DB when the signal is already aborted', async () => {
        // Proves the short-circuit: the happy path pays zero query cost.
        const controller = new AbortController();
        controller.abort();
        await makeSvc().execute({ ...baseContext, signal: controller.signal });
        expect(runs.findById).not.toHaveBeenCalled();
    });

    it('threads the abort signal into the model call so in-flight requests are cancelled', async () => {
        // Without this the run only stops BETWEEN round-trips, so a cancel
        // during a long model call waits for it to finish.
        const controller = new AbortController();
        ai.dispatch.mockResolvedValue({
            text: 'done',
            toolCalls: [],
            finishReason: 'stop',
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            model: 'gpt-4o-mini',
        } as AgentAiDispatchResult);
        await makeSvc().execute({ ...baseContext, signal: controller.signal });
        expect(ai.dispatch).toHaveBeenCalledWith(
            expect.objectContaining({ abortSignal: controller.signal }),
        );
    });
});
