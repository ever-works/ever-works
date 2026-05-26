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

/**
 * Agents/Skills/Tasks PR #1019 follow-up — FU-1.
 *
 * Tests for the LLM-dispatch path in `AgentRunService.execute()`. The
 * tool-loop wrapper:
 *   - calls AiDispatch with the assembled system+user messages
 *   - feeds tool-call results back as `tool` messages
 *   - caps at 10 iterations
 *   - parses outcome → calls finalize (chat reply / task transition)
 *
 * The base-behaviour tests (assemble-only, budget block) live in
 * agent-run.service.spec.ts — those constructor calls pass no
 * `AgentAiDispatchFacade`, so the assemble-only branch still fires.
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

describe('AgentRunService.execute() — LLM dispatch (FU-1)', () => {
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

    beforeEach(() => {
        agents = { findById: jest.fn() };
        runs = {
            findByAgent: jest.fn().mockResolvedValue([]),
            markFailed: jest.fn().mockResolvedValue(undefined),
            markCompleted: jest.fn().mockResolvedValue(undefined),
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
        ai = { dispatch: jest.fn() };
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
        );
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

    it('chat kind — dispatches to AI, posts the reply back via chatBackPoster', async () => {
        agents.findById.mockResolvedValueOnce(makeAgent());
        ai.dispatch.mockResolvedValueOnce(aiResponse({ text: 'Sure thing.' }));

        const result = await makeSvc().execute({
            runId: 'r1',
            agentId: 'a1',
            userId: 'u1',
            kind: 'chat',
            taskId: 't1',
            chatMessageId: 'm1',
        });

        expect(result.status).toBe('dispatched');
        expect(ai.dispatch).toHaveBeenCalledTimes(1);
        expect(ai.dispatch).toHaveBeenCalledWith(
            expect.objectContaining({
                messages: expect.arrayContaining([
                    expect.objectContaining({ role: 'system' }),
                    expect.objectContaining({ role: 'user' }),
                ]),
                facadeOptions: expect.objectContaining({
                    userId: 'u1',
                    agentId: 'a1',
                    taskId: 't1',
                }),
            }),
        );
        expect(chatBackPoster.postReply).toHaveBeenCalledWith(
            expect.objectContaining({ taskId: 't1', agentId: 'a1', body: 'Sure thing.' }),
        );
        expect(runs.markCompleted).toHaveBeenCalled();
        expect(runs.markFailed).not.toHaveBeenCalled();
        expect(runLogs.append).toHaveBeenCalledWith(
            expect.objectContaining({ level: 'INFO', step: 'ai-dispatch' }),
        );
    });

    it('task kind — captures transitionTask tool call → finishTask runs with the captured status', async () => {
        agents.findById.mockResolvedValueOnce(makeAgent());
        ai.dispatch
            .mockResolvedValueOnce(
                aiResponse({
                    text: 'Done.',
                    toolCalls: [
                        {
                            id: 'tc1',
                            name: 'transitionTask',
                            args: { to: 'done', force: false },
                        },
                    ],
                    finishReason: 'tool_calls',
                }),
            )
            .mockResolvedValueOnce(aiResponse({ text: 'Done.', finishReason: 'stop' }));

        const result = await makeSvc().execute({
            runId: 'r1',
            agentId: 'a1',
            userId: 'u1',
            kind: 'task',
            taskId: 't1',
        });

        expect(result.status).toBe('dispatched');
        expect(ai.dispatch).toHaveBeenCalledTimes(2);
        expect(taskFinisher.finishTask).toHaveBeenCalledWith(
            expect.objectContaining({ taskId: 't1', to: 'done' }),
        );
        expect(runs.markCompleted).toHaveBeenCalled();
    });

    it('heartbeat kind — assistant text becomes the run summary, no chat/task side-effects', async () => {
        agents.findById.mockResolvedValueOnce(makeAgent());
        ai.dispatch.mockResolvedValueOnce(aiResponse({ text: 'Nothing to do this tick.' }));

        const result = await makeSvc().execute({
            runId: 'r1',
            agentId: 'a1',
            userId: 'u1',
            kind: 'heartbeat',
        });

        expect(result.status).toBe('dispatched');
        expect(result.outcome?.summary).toBe('Nothing to do this tick.');
        expect(chatBackPoster.postReply).not.toHaveBeenCalled();
        expect(taskFinisher.finishTask).not.toHaveBeenCalled();
        expect(runs.markCompleted).toHaveBeenCalled();
    });

    it('AI throws → run marked failed + ERROR run-log + side effects skipped', async () => {
        agents.findById.mockResolvedValueOnce(makeAgent());
        ai.dispatch.mockRejectedValueOnce(new Error('provider 429'));

        const result = await makeSvc().execute({
            runId: 'r1',
            agentId: 'a1',
            userId: 'u1',
            kind: 'chat',
            taskId: 't1',
        });

        expect(result.status).toBe('dispatch-failed');
        expect(result.outcome?.errored).toBe(true);
        expect(result.outcome?.errorMessage).toBe('provider 429');
        expect(runs.markFailed).toHaveBeenCalledWith('r1', 'provider 429');
        expect(chatBackPoster.postReply).not.toHaveBeenCalled();
        expect(runLogs.append).toHaveBeenCalledWith(
            expect.objectContaining({ level: 'ERROR', step: 'ai-dispatch' }),
        );
    });

    it('tool loop hits the 10-iteration cap → run failed + ERROR log', async () => {
        agents.findById.mockResolvedValueOnce(makeAgent());
        // Every round keeps requesting an unknown tool — the loop never reaches stop.
        toolService.resolveAllowedTools.mockReturnValue([]);
        ai.dispatch.mockResolvedValue(
            aiResponse({
                toolCalls: [{ id: 'tc1', name: 'doesNotExist', args: {} }],
                finishReason: 'tool_calls',
            }),
        );

        const result = await makeSvc().execute({
            runId: 'r1',
            agentId: 'a1',
            userId: 'u1',
            kind: 'heartbeat',
        });

        expect(result.status).toBe('dispatch-failed');
        expect(ai.dispatch).toHaveBeenCalledTimes(10);
        expect(runs.markFailed).toHaveBeenCalled();
        expect(runLogs.append).toHaveBeenCalledWith(
            expect.objectContaining({
                level: 'ERROR',
                step: 'ai-dispatch',
                message: expect.stringContaining('cap'),
            }),
        );
    });

    it('without AgentAiDispatchFacade injection, falls back to assemble-only (backward-compat)', async () => {
        agents.findById.mockResolvedValueOnce(makeAgent());
        const svc = new AgentRunService(
            agents,
            runs,
            runLogs,
            budgets,
            assembler,
            skillBindings,
            activity,
        );
        const result = await svc.execute({
            runId: 'r1',
            agentId: 'a1',
            userId: 'u1',
            kind: 'heartbeat',
        });
        expect(result.status).toBe('assembled');
        expect(ai.dispatch).not.toHaveBeenCalled();
    });
});
