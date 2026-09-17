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
import type { SafetyGate, SafetyGateVerdict } from '../../safety/safety-gate.port';

/**
 * Safety rails (AW-24) — the one choke point.
 *
 * `invokeTool` is the single place every tool call converges, which is what
 * makes FR-14 ("every rail is evaluated in the platform, after the model has
 * produced its intent and before the side effect") satisfiable at all.
 *
 * Two contracts are pinned here and they matter equally:
 *
 *  1. An UNBOUND gate behaves exactly as the tool loop did before this epic.
 *  2. A refusal or a hold returns a TOOL RESULT and never fails the run
 *     (FR-30) — a run whose action was held must be able to proceed
 *     differently, not die.
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
        tenantId: 'tenant-1',
        organizationId: 'org-1',
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
        ...over,
    } as Agent;
}

describe('AgentRunService — the safety gate at the tool choke point', () => {
    let agents: any;
    let runs: any;
    let runLogs: any;
    let budgets: any;
    let skillBindings: any;
    let assembler: PromptAssemblerService;
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
        assembler = new PromptAssemblerService();
        ai = { dispatch: jest.fn().mockResolvedValue(aiResponse()) } as never;
    });

    afterEach(() => jest.restoreAllMocks());

    function makeSvc(gate?: SafetyGate): AgentRunService {
        return new AgentRunService(
            agents,
            runs,
            runLogs,
            budgets,
            assembler,
            skillBindings,
            undefined,
            undefined,
            undefined,
            undefined,
            ai,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            gate,
        );
    }

    const ctx = {
        runId: 'r1',
        agentId: 'a1',
        userId: 'u1',
        kind: 'task' as const,
        taskId: 't1',
        immediateInput: 'Move the task to done.',
    };

    function callTransitionTask(): void {
        ai.dispatch
            .mockResolvedValueOnce(
                aiResponse({
                    toolCalls: [{ id: 'c1', name: 'transitionTask', args: { to: 'done' } }],
                    finishReason: 'tool_calls',
                }),
            )
            .mockResolvedValueOnce(aiResponse({ text: 'All done.' }));
    }

    function toolResultMessage(): Record<string, unknown> {
        const dispatched = ai.dispatch.mock.calls[1][0] as {
            messages: Array<{ role: string; content: string }>;
        };
        const toolMessage = dispatched.messages.find((message) => message.role === 'tool');
        const fenced = /<<<TOOL_RESULT\n([\s\S]*?)\n>>>END_TOOL_RESULT/.exec(
            toolMessage?.content ?? '',
        );
        return JSON.parse(fenced?.[1] ?? '{}');
    }

    function appendedRows(): any[] {
        return runLogs.append.mock.calls.map((call: any[]) => call[0]);
    }

    it('behaves exactly as before when the gate is not bound', async () => {
        callTransitionTask();

        const result = await makeSvc().execute(ctx);

        expect(result.status).toBe('dispatched');
        expect(toolResultMessage()).toEqual({ captured: true, to: 'done' });
        expect(appendedRows().some((row) => row.step === 'safety-gate')).toBe(false);
    });

    it('asks the gate with the platform entry point, never the arguments', async () => {
        // FR-4 / FR-15 — classification comes from the descriptor the platform
        // resolved, and nothing the model produced is passed along.
        const evaluate = jest.fn<Promise<SafetyGateVerdict>, [never]>().mockResolvedValue({
            decision: 'allow',
            railId: null,
            category: null,
            rung: null,
            reasonCode: null,
            summary: null,
        });
        callTransitionTask();

        await makeSvc({ evaluate } as never).execute(ctx);

        expect(evaluate).toHaveBeenCalledTimes(1);
        const asked = evaluate.mock.calls[0][0] as Record<string, unknown>;
        expect(asked).toEqual({
            entryPointId: 'transitionTask',
            toolName: 'transitionTask',
            userId: 'u1',
            agentId: 'a1',
            runId: 'r1',
            subjectType: 'run',
            subjectId: 'r1',
            tenantId: 'tenant-1',
            organizationId: 'org-1',
        });
        expect(JSON.stringify(asked)).not.toContain('done');
    });

    it('lets an allow verdict through untouched', async () => {
        const gate: SafetyGate = {
            evaluate: async () => ({
                decision: 'allow',
                railId: null,
                category: null,
                rung: null,
                reasonCode: null,
                summary: null,
            }),
        };
        callTransitionTask();

        await makeSvc(gate).execute(ctx);

        expect(toolResultMessage()).toEqual({ captured: true, to: 'done' });
    });

    it('returns a refusal as a tool result and does NOT fail the run', async () => {
        const gate: SafetyGate = {
            evaluate: async () => ({
                decision: 'refused',
                railId: 'ladder',
                category: 'write.internal',
                rung: 'off',
                reasonCode: 'rung-off',
                summary: '"write.internal" is switched off for this workspace.',
            }),
        };
        callTransitionTask();

        const result = await makeSvc(gate).execute(ctx);

        expect(result.status).toBe('dispatched');
        expect(runs.markFailed).not.toHaveBeenCalled();
        expect(toolResultMessage()).toEqual({
            error: '"write.internal" is switched off for this workspace.',
            refusedBy: 'ladder',
            category: 'write.internal',
            rung: 'off',
            retryable: false,
        });
    });

    it('returns a hold as a tool result that says not to retry', async () => {
        // A retry loop against a hold is the failure mode the wording exists
        // to prevent: the send is waiting for a person, not for a better try.
        const gate: SafetyGate = {
            evaluate: async () => ({
                decision: 'held',
                railId: 'ladder',
                category: 'message.external',
                rung: 'draft',
                reasonCode: 'rung-held',
                summary: '"message.external" waits for you.',
            }),
        };
        callTransitionTask();

        const result = await makeSvc(gate).execute(ctx);

        expect(result.status).toBe('dispatched');
        expect(toolResultMessage()).toEqual({
            held: true,
            reason: '"message.external" waits for you.',
            category: 'message.external',
            rung: 'draft',
            retryable: false,
        });
    });

    it('writes one safety-gate run-log row naming the rail', async () => {
        const gate: SafetyGate = {
            evaluate: async () => ({
                decision: 'refused',
                railId: 'caps',
                category: 'spend.metered',
                rung: null,
                reasonCode: 'cap-reached',
                summary: 'A spending cap refused this.',
            }),
        };
        callTransitionTask();

        await makeSvc(gate).execute(ctx);

        const row = appendedRows().find((entry) => entry.step === 'safety-gate');
        expect(row).toBeDefined();
        expect(row.level).toBe('WARN');
        expect(row.metadata).toEqual(
            expect.objectContaining({
                toolName: 'transitionTask',
                railId: 'caps',
                category: 'spend.metered',
                reasonCode: 'cap-reached',
            }),
        );
    });

    it('lets the call proceed when the gate itself throws', async () => {
        // The gate converts its own failures into the fail-closed verdict. A
        // gate that threw anyway is a WIRING failure, not a policy answer, and
        // turning it into a failed run would take the product down on a DI
        // mistake — the tool's own enforcement is still in front of it.
        const gate: SafetyGate = {
            evaluate: async () => {
                throw new Error('gate exploded');
            },
        };
        callTransitionTask();

        const result = await makeSvc(gate).execute(ctx);

        expect(result.status).toBe('dispatched');
        expect(toolResultMessage()).toEqual({ captured: true, to: 'done' });
    });

    it('never reaches the gate for a tool that is not in the allow-list', async () => {
        // The unresolvable name is refused before classification, so a model
        // cannot use the gate as an oracle for which tools exist.
        const evaluate = jest.fn();
        ai.dispatch
            .mockResolvedValueOnce(
                aiResponse({
                    toolCalls: [{ id: 'c1', name: 'notARealTool', args: {} }],
                    finishReason: 'tool_calls',
                }),
            )
            .mockResolvedValueOnce(aiResponse({ text: 'ok' }));

        await makeSvc({ evaluate } as never).execute(ctx);

        expect(evaluate).not.toHaveBeenCalled();
    });
});
