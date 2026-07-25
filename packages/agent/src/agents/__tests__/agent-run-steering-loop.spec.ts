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
import type { AgentRunChatBackPoster, AgentRunTaskFinisher } from '../agent-run-post-processor';

/**
 * Run steering (Wave 4 M5) — the tool-loop guard.
 *
 * The steering signals are read at the SAME per-iteration checkpoint as the
 * cancel/abort signal, so the loop has exactly one place that answers "should
 * I keep going, and has anyone said anything?". These tests pin:
 *
 *  - an interrupt stops the loop BETWEEN iterations (never mid-round-trip) and
 *    the run is completed with an honest summary, not failed and not cancelled;
 *  - an interrupt applies NO externally-visible side effect (a stopped run must
 *    not flip its Task to done or post a chat reply);
 *  - queued steering messages are injected as `user` turns on the next round;
 *  - a repository without the steering methods (older replica / partial spec
 *    stub) degrades to today's behaviour instead of throwing inside the loop.
 */
function makeAgent(over: Partial<Agent> = {}): Agent {
    return {
        id: 'a1',
        userId: 'u1',
        scope: AgentScope.TENANT,
        missionId: null,
        ideaId: null,
        workId: null,
        name: 'Builder',
        slug: 'builder',
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
        soulMd: '# Who I am\nA builder.',
        agentsMd: null,
        heartbeatMd: '# Each tick\nBuild.',
        toolsMd: null,
        agentYml: null,
        contentHash: null,
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
        ...over,
    } as Agent;
}

describe('AgentRunService — steering signals in the tool loop (Wave 4 M5)', () => {
    let agents: any;
    let runs: any;
    let runLogs: any;
    let budgets: any;
    let skillBindings: any;
    let activity: any;
    let assembler: PromptAssemblerService;
    let chatBackPoster: jest.Mocked<AgentRunChatBackPoster>;
    let taskFinisher: jest.Mocked<AgentRunTaskFinisher>;
    let ai: jest.Mocked<AgentAiDispatchFacade>;

    function aiResponse(over: Partial<AgentAiDispatchResult> = {}): AgentAiDispatchResult {
        return {
            text: 'Working on it.',
            toolCalls: [],
            finishReason: 'stop',
            usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
            model: 'gpt-4o-mini',
            ...over,
        };
    }

    beforeEach(() => {
        agents = { findById: jest.fn().mockResolvedValue(makeAgent()) };
        runs = {
            findByAgent: jest.fn().mockResolvedValue([]),
            findById: jest.fn().mockResolvedValue({ status: 'running' }),
            markFailed: jest.fn().mockResolvedValue(undefined),
            markCompleted: jest.fn().mockResolvedValue(undefined),
            setAwaitingInput: jest.fn().mockResolvedValue(undefined),
            takeSteeringSignals: jest
                .fn()
                .mockResolvedValue({ pendingInput: [], interruptRequested: false }),
        };
        runLogs = { append: jest.fn().mockResolvedValue(undefined) };
        budgets = { findByAgentId: jest.fn().mockResolvedValue(null) };
        skillBindings = { resolveActive: jest.fn().mockResolvedValue([]) };
        activity = { log: jest.fn().mockResolvedValue(undefined) };
        assembler = new PromptAssemblerService();
        chatBackPoster = { postReply: jest.fn().mockResolvedValue({ messageId: 'm1' }) };
        taskFinisher = { finishTask: jest.fn().mockResolvedValue({ status: 'done' }) };
        ai = { dispatch: jest.fn().mockResolvedValue(aiResponse()) };
    });

    afterEach(() => jest.restoreAllMocks());

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
            undefined,
            ai,
        );
    }

    const ctx = { runId: 'r1', agentId: 'a1', userId: 'u1', kind: 'task' as const, taskId: 't1' };

    it('⭐ an interrupt requested before the first round stops the loop without calling the model', async () => {
        // THE BETWEEN-ITERATIONS TEST. If the guard were placed after the
        // dispatch, an interrupt would still burn a full model round-trip —
        // which is exactly the cost the control exists to avoid.
        runs.takeSteeringSignals.mockResolvedValue({
            pendingInput: [],
            interruptRequested: true,
        });

        const result = await makeSvc().execute(ctx);

        expect(result.status).toBe('interrupted');
        expect(ai.dispatch).not.toHaveBeenCalled();
        expect(result.toolLoopIterations).toBe(0);
    });

    it('⭐ marks the run COMPLETED with a summary — not failed, not cancelled', async () => {
        runs.takeSteeringSignals
            .mockResolvedValueOnce({ pendingInput: [], interruptRequested: false })
            .mockResolvedValue({ pendingInput: [], interruptRequested: true });
        ai.dispatch.mockResolvedValue(
            aiResponse({ toolCalls: [{ id: 'c1', name: 'noSuchTool', args: {} }] }),
        );

        const result = await makeSvc().execute(ctx);

        expect(result.status).toBe('interrupted');
        expect(result.finalizeResult?.status).toBe('completed');
        expect(runs.markCompleted).toHaveBeenCalledWith('r1', expect.stringContaining('Interrupt'));
        expect(runs.markFailed).not.toHaveBeenCalled();
    });

    it('applies no externally-visible side effect when interrupted', async () => {
        // An interrupted task run must not flip the Task to done: the human
        // stopped it precisely because the work was not what they wanted.
        runs.takeSteeringSignals.mockResolvedValue({
            pendingInput: [],
            interruptRequested: true,
        });
        await makeSvc().execute(ctx);
        expect(taskFinisher.finishTask).not.toHaveBeenCalled();
        expect(chatBackPoster.postReply).not.toHaveBeenCalled();
    });

    it('⭐ injects a queued steering message as a user turn on the next round', async () => {
        runs.takeSteeringSignals.mockResolvedValue({
            pendingInput: ['actually, target the staging bucket'],
            interruptRequested: false,
        });

        await makeSvc().execute(ctx);

        expect(ai.dispatch).toHaveBeenCalledWith(
            expect.objectContaining({
                messages: expect.arrayContaining([
                    expect.objectContaining({
                        role: 'user',
                        content: 'actually, target the staging bucket',
                    }),
                ]),
            }),
        );
        expect(runLogs.append).toHaveBeenCalledWith(expect.objectContaining({ step: 'steering' }));
    });

    it('injects several queued messages in order (nothing is dropped)', async () => {
        runs.takeSteeringSignals.mockResolvedValue({
            pendingInput: ['first', 'second'],
            interruptRequested: false,
        });

        await makeSvc().execute(ctx);

        const messages = ai.dispatch.mock.calls[0][0].messages;
        const userTurns = messages.filter((m: { role: string }) => m.role === 'user');
        expect(userTurns.map((m: { content: string }) => m.content)).toEqual(
            expect.arrayContaining(['first', 'second']),
        );
        expect(userTurns.findIndex((m: { content: string }) => m.content === 'first')).toBeLessThan(
            userTurns.findIndex((m: { content: string }) => m.content === 'second'),
        );
    });

    it('degrades to today’s behaviour when the repository has no steering methods', async () => {
        // Older API replica mid-rollout, or one of the many partial repo stubs
        // in the existing specs. A missing method must never throw inside the
        // loop and be misreported as a dispatch failure.
        delete runs.takeSteeringSignals;
        const result = await makeSvc().execute(ctx);
        expect(result.status).toBe('dispatched');
        expect(ai.dispatch).toHaveBeenCalledTimes(1);
    });

    it('degrades the same way when the steering read throws', async () => {
        runs.takeSteeringSignals.mockRejectedValue(new Error('db blip'));
        const result = await makeSvc().execute(ctx);
        expect(result.status).toBe('dispatched');
    });

    describe('awaiting-input lifecycle signal', () => {
        it('parks the run when the outcome reports it (never from prose)', async () => {
            await makeSvc().finalize(ctx, { errored: false, awaitingInput: true });
            expect(runs.setAwaitingInput).toHaveBeenCalledWith('r1', true);
        });

        it('leaves an ordinary completion unparked', async () => {
            await makeSvc().finalize(ctx, { errored: false, summary: 'all done' });
            expect(runs.setAwaitingInput).not.toHaveBeenCalled();
        });

        it('markAwaitingInput is a no-op on a repository without the column support', async () => {
            delete runs.setAwaitingInput;
            await expect(makeSvc().markAwaitingInput('r1')).resolves.toBeUndefined();
        });
    });
});
