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
 * Session detail (Feature K) — richer run capture in the tool loop.
 *
 * Pins the four contracts the detail page depends on:
 *
 *  - 'tool-invocation' rows carry redacted argsPreview / resultPreview +
 *    durationMs;
 *  - 'assistant-message' / 'user-message' rows are written at the loop's
 *    turn boundaries (initial prompt, per-round assistant text, injected
 *    steering messages);
 *  - the per-run volume cap stops message rows with exactly ONE
 *    'capture-truncated' marker;
 *  - capture and filesTouched persistence are best-effort — a failing
 *    log repository or a missing/mergeFilesTouched-rejecting run
 *    repository must never fail the run.
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

describe('AgentRunService — session-detail capture (Feature K)', () => {
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
            addTokens: jest.fn().mockResolvedValue(undefined),
            mergeFilesTouched: jest.fn().mockResolvedValue(undefined),
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

    function makeSvc(toolService?: any): AgentRunService {
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
            toolService,
            ai,
        );
    }

    const ctx = {
        runId: 'r1',
        agentId: 'a1',
        userId: 'u1',
        kind: 'task' as const,
        taskId: 't1',
        immediateInput: 'Ship the sessions drill-in.',
    };

    function appendedRows(): any[] {
        return runLogs.append.mock.calls.map((c: any[]) => c[0]);
    }

    it('⭐ tool-invocation rows carry argsPreview + resultPreview + durationMs', async () => {
        ai.dispatch
            .mockResolvedValueOnce(
                aiResponse({
                    toolCalls: [{ id: 'c1', name: 'transitionTask', args: { to: 'done' } }],
                    finishReason: 'tool_calls',
                }),
            )
            .mockResolvedValueOnce(aiResponse({ text: 'All done.' }));

        const result = await makeSvc().execute(ctx);

        expect(result.status).toBe('dispatched');
        const toolRow = appendedRows().find((r) => r.step === 'tool-invocation');
        expect(toolRow).toBeDefined();
        expect(toolRow.metadata).toEqual(
            expect.objectContaining({
                toolName: 'transitionTask',
                callId: 'c1',
                argsPreview: '{"to":"done"}',
                resultPreview: '{"captured":true,"to":"done"}',
                durationMs: expect.any(Number),
            }),
        );
    });

    it('⭐ writes user-message and assistant-message rows at turn boundaries', async () => {
        ai.dispatch.mockResolvedValueOnce(aiResponse({ text: 'Here is my answer.' }));

        await makeSvc().execute(ctx);

        const rows = appendedRows();
        const userRow = rows.find((r) => r.step === 'user-message');
        const assistantRow = rows.find((r) => r.step === 'assistant-message');
        expect(userRow).toBeDefined();
        // The HUMAN's text, not the assembled prompt (which fences the
        // conversation context and, on heartbeats, a machine preamble).
        expect(userRow.message).toBe('Ship the sessions drill-in.');
        expect(userRow.metadata).toEqual(
            expect.objectContaining({ role: 'user', bytes: 'Ship the sessions drill-in.'.length }),
        );
        expect(assistantRow).toBeDefined();
        expect(assistantRow.message).toBe('Here is my answer.');
        expect(assistantRow.metadata).toEqual(
            expect.objectContaining({ role: 'assistant', bytes: 'Here is my answer.'.length }),
        );
    });

    it('opens on the assistant turn when the run carries no human input (heartbeat)', async () => {
        ai.dispatch.mockResolvedValueOnce(aiResponse({ text: 'Tick handled.' }));

        await makeSvc().execute({
            runId: 'r1',
            agentId: 'a1',
            userId: 'u1',
            kind: 'heartbeat' as const,
        });

        const rows = appendedRows();
        expect(rows.find((r) => r.step === 'user-message')).toBeUndefined();
        expect(rows.find((r) => r.step === 'assistant-message')?.message).toBe('Tick handled.');
    });

    it('captures injected steering messages as user-message rows', async () => {
        runs.takeSteeringSignals
            .mockResolvedValueOnce({
                pendingInput: ['change of plan — target the staging branch'],
                interruptRequested: false,
            })
            .mockResolvedValue({ pendingInput: [], interruptRequested: false });

        await makeSvc().execute(ctx);

        const steeringUserRow = appendedRows().find(
            (r) =>
                r.step === 'user-message' &&
                r.message === 'change of plan — target the staging branch',
        );
        expect(steeringUserRow).toBeDefined();
    });

    it('⭐ caps capture volume: message rows stop after the cap with ONE marker row', async () => {
        // Two rounds of 100 tool calls each blow past CAPTURE_MAX_ENTRIES
        // (200); the final round's assistant text must then be skipped and
        // exactly one 'capture-truncated' marker written.
        const manyCalls = (round: number) =>
            Array.from({ length: 100 }, (_, i) => ({
                id: `r${round}-c${i}`,
                name: 'transitionTask',
                args: { to: 'done' },
            }));
        ai.dispatch
            .mockResolvedValueOnce(
                aiResponse({ toolCalls: manyCalls(1), finishReason: 'tool_calls' }),
            )
            .mockResolvedValueOnce(
                aiResponse({ toolCalls: manyCalls(2), finishReason: 'tool_calls' }),
            )
            .mockResolvedValueOnce(aiResponse({ text: 'the very final answer' }));

        const result = await makeSvc().execute(ctx);

        expect(result.status).toBe('dispatched');
        const rows = appendedRows();
        expect(rows.filter((r) => r.step === 'capture-truncated')).toHaveLength(1);
        expect(
            rows.find(
                (r) => r.step === 'assistant-message' && r.message === 'the very final answer',
            ),
        ).toBeUndefined();
        // Tool rows keep flowing past the cap — only their previews stop.
        const toolRows = rows.filter((r) => r.step === 'tool-invocation');
        expect(toolRows).toHaveLength(200);
        expect(toolRows[toolRows.length - 1].metadata.argsPreview).toBeUndefined();
    });

    it('⭐ a failing log repository never fails the run', async () => {
        runLogs.append.mockRejectedValue(new Error('log db down'));
        ai.dispatch
            .mockResolvedValueOnce(
                aiResponse({
                    toolCalls: [{ id: 'c1', name: 'transitionTask', args: { to: 'done' } }],
                    finishReason: 'tool_calls',
                }),
            )
            .mockResolvedValueOnce(aiResponse());

        const result = await makeSvc().execute(ctx);

        expect(result.status).toBe('dispatched');
        expect(runs.markCompleted).toHaveBeenCalled();
        expect(runs.markFailed).not.toHaveBeenCalled();
    });

    it('persists commitToRepo file paths as filesTouched after the loop', async () => {
        const toolService = {
            resolveAllowedTools: jest.fn().mockResolvedValue([
                {
                    name: 'commitToRepo',
                    description: 'commit',
                    parameters: { type: 'object', properties: {} },
                    invoke: jest.fn().mockResolvedValue({ sha: 'abc123', filesChanged: 2 }),
                },
            ]),
        };
        ai.dispatch
            .mockResolvedValueOnce(
                aiResponse({
                    toolCalls: [
                        {
                            id: 'c1',
                            name: 'commitToRepo',
                            args: {
                                message: 'feat: add pages',
                                files: [
                                    { path: 'src/a.ts', body: 'x' },
                                    { path: 'src/b.ts', body: 'y' },
                                ],
                            },
                        },
                    ],
                    finishReason: 'tool_calls',
                }),
            )
            .mockResolvedValueOnce(aiResponse());

        await makeSvc(toolService).execute(ctx);

        expect(runs.mergeFilesTouched).toHaveBeenCalledWith(
            'r1',
            expect.arrayContaining(['src/a.ts', 'src/b.ts']),
            200,
        );
    });

    it('does not record filesTouched for a tool invocation that returned an error', async () => {
        const toolService = {
            resolveAllowedTools: jest.fn().mockResolvedValue([
                {
                    name: 'commitToRepo',
                    description: 'commit',
                    parameters: { type: 'object', properties: {} },
                    invoke: jest.fn().mockResolvedValue({ error: 'no repo configured' }),
                },
            ]),
        };
        ai.dispatch
            .mockResolvedValueOnce(
                aiResponse({
                    toolCalls: [
                        {
                            id: 'c1',
                            name: 'commitToRepo',
                            args: { message: 'x', files: [{ path: 'src/a.ts', body: 'x' }] },
                        },
                    ],
                    finishReason: 'tool_calls',
                }),
            )
            .mockResolvedValueOnce(aiResponse());

        await makeSvc(toolService).execute(ctx);

        expect(runs.mergeFilesTouched).not.toHaveBeenCalled();
    });

    it('a rejecting mergeFilesTouched (or one missing entirely) never fails the run', async () => {
        runs.mergeFilesTouched.mockRejectedValue(new Error('meta write down'));
        const toolService = {
            resolveAllowedTools: jest.fn().mockResolvedValue([
                {
                    name: 'commitToRepo',
                    description: 'commit',
                    parameters: { type: 'object', properties: {} },
                    invoke: jest.fn().mockResolvedValue({ sha: 'abc' }),
                },
            ]),
        };
        ai.dispatch
            .mockResolvedValueOnce(
                aiResponse({
                    toolCalls: [
                        {
                            id: 'c1',
                            name: 'commitToRepo',
                            args: { message: 'x', files: [{ path: 'src/a.ts', body: 'x' }] },
                        },
                    ],
                    finishReason: 'tool_calls',
                }),
            )
            .mockResolvedValueOnce(aiResponse());

        const withMethod = await makeSvc(toolService).execute(ctx);
        expect(withMethod.status).toBe('dispatched');

        // Older RPC proxy / partial double: method absent entirely.
        delete runs.mergeFilesTouched;
        ai.dispatch
            .mockResolvedValueOnce(
                aiResponse({
                    toolCalls: [
                        {
                            id: 'c2',
                            name: 'commitToRepo',
                            args: { message: 'x', files: [{ path: 'src/c.ts', body: 'x' }] },
                        },
                    ],
                    finishReason: 'tool_calls',
                }),
            )
            .mockResolvedValueOnce(aiResponse());
        const withoutMethod = await makeSvc(toolService).execute(ctx);
        expect(withoutMethod.status).toBe('dispatched');
    });

    it('redacts secrets in tool args previews', async () => {
        const secret = 'ghp_' + 'a'.repeat(40);
        ai.dispatch
            .mockResolvedValueOnce(
                aiResponse({
                    // Unknown tool — the allow-list-miss row must STILL carry
                    // a redacted args preview.
                    toolCalls: [{ id: 'c1', name: 'noSuchTool', args: { token: secret } }],
                    finishReason: 'tool_calls',
                }),
            )
            .mockResolvedValueOnce(aiResponse());

        await makeSvc().execute(ctx);

        const toolRow = appendedRows().find((r) => r.step === 'tool-invocation');
        expect(toolRow.metadata.argsPreview).toContain('[redacted secret]');
        expect(toolRow.metadata.argsPreview).not.toContain(secret);
    });
});
