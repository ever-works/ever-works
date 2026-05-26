import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { Agent } from '../entities/agent.entity';
import { AgentRepository } from '../database/repositories/agent.repository';
import { AgentRunRepository } from '../database/repositories/agent-run.repository';
import { AgentRunLogRepository } from '../database/repositories/agent-run-log.repository';
import { AgentBudgetRepository } from '../database/repositories/agent-budget.repository';
import {
    SkillBindingRepository,
    type ResolvedSkill,
} from '../database/repositories/skill-binding.repository';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { ActivityActionType, ActivityStatus } from '../entities/activity-log.types';
import {
    PromptAssemblerService,
    estimateTokens,
    type AssembledPrompt,
    type AgentRunKind,
} from './prompt-assembler.service';
import { getCurrentPeriodStart, getNextPeriodStart } from './budget-period';
import {
    AGENT_RUN_CHAT_BACK_POSTER,
    AGENT_RUN_TASK_FINISHER,
    type AgentRunChatBackPoster,
    type AgentRunOutcome,
    type AgentRunTaskFinisher,
} from './agent-run-post-processor';
import { AgentToolService, type AgentToolDescriptor } from './agent-tool.service';
import {
    AGENT_AI_DISPATCH_FACADE,
    type AgentAiDispatchFacade,
    type AgentAiMessage,
    type AgentAiToolCall,
} from './agent-ai-dispatch-facade';

export interface AgentRunContext {
    runId: string;
    agentId: string;
    userId: string;
    kind: AgentRunKind;
    /** Task body / chat message body / null (heartbeat). */
    immediateInput?: string | null;
    /** Conversation context for task / chat runs. */
    conversationContext?: Array<{ author: string; body: string; createdAt?: string }>;
    /** Optional scope description override. */
    scopeContext?: string | null;
    /** Caller-supplied schema name for the OUTPUT CONTRACT segment. */
    outputSchemaName?: string;
    /**
     * Originating Task — supplied for `task` and `chat` kinds. The
     * Phase-15.5 `finalize()` path routes auto-reply posts and
     * status-flip transitions back to this Task. Heartbeat runs leave
     * this null/undefined.
     */
    taskId?: string | null;
    /**
     * Originating chat message — supplied for `chat` kinds. Reserved
     * for the LLM-dispatch path so the worker can tie its reply to
     * the triggering message (T6 chat-dedup posture).
     */
    chatMessageId?: string | null;
}

export interface AgentRunBudgetCheck {
    allowed: boolean;
    reason: 'ok' | 'over-cap' | 'unlimited' | 'no-budget';
    currentSpendCents: number;
    capCents: number | null;
    periodStart: Date;
    periodEnd: Date;
}

export interface AgentRunExecuteResult {
    runId: string;
    status: 'assembled' | 'budget-blocked' | 'agent-not-found' | 'dispatched' | 'dispatch-failed';
    prompt?: AssembledPrompt;
    budgetCheck?: AgentRunBudgetCheck;
    /** Set when the LLM-dispatch path ran end-to-end. */
    outcome?: AgentRunOutcome;
    /** Set when the LLM-dispatch path ran end-to-end. */
    finalizeResult?: {
        status: 'completed' | 'failed';
        postedMessageId?: string;
        finishedTaskStatus?: string;
    };
    /** Number of model round-trips the tool loop performed (1 = no tool calls). */
    toolLoopIterations?: number;
}

/**
 * Agents/Skills/Tasks PR #1017 — Phase 7.4.
 *
 * Orchestrator for one Agent run — heartbeat tick, task execution,
 * or chat reply. Mirrors the pseudocode in
 * `docs/specs/architecture/agent-prompt-assembly.md §8`.
 *
 * v1 of this service stops at "prompt assembled + logged + budget
 * cleared". The actual AI call + tool loop + agent-side
 * post-processing wire in once the Skill catalog (Phase 9) and
 * tool surface (Phase 16) ship. Keeping the integration point here
 * lets `agent-heartbeat.task.ts` and `agent-task-execute.task.ts`
 * share one orchestrator from day one — the LLM call drops in as a
 * `dispatchToAi(...)` extension below without changing the public
 * surface.
 *
 * The service deliberately does NOT inject `AiFacadeService` yet —
 * doing so today would couple the Agent package to a much larger
 * graph for a placeholder. The hand-off happens in the next sub-tick.
 */
@Injectable()
export class AgentRunService {
    private readonly logger = new Logger(AgentRunService.name);

    constructor(
        private readonly agents: AgentRepository,
        private readonly runs: AgentRunRepository,
        private readonly runLogs: AgentRunLogRepository,
        private readonly budgets: AgentBudgetRepository,
        private readonly assembler: PromptAssemblerService,
        @Optional() private readonly skillBindings?: SkillBindingRepository,
        @Optional() private readonly activityLog?: ActivityLogService,
        @Optional()
        @Inject(AGENT_RUN_CHAT_BACK_POSTER)
        private readonly chatBackPoster?: AgentRunChatBackPoster,
        @Optional()
        @Inject(AGENT_RUN_TASK_FINISHER)
        private readonly taskFinisher?: AgentRunTaskFinisher,
        // FU-1 — LLM dispatch + tool loop. Both injections are optional
        // so existing unit-test constructor calls (which omit them) keep
        // working — the path falls back to the assemble-only behaviour
        // documented above. Production binding lives in the api-side
        // `AgentsModule` (see `apps/api/src/agents/agents.module.ts`).
        @Optional() private readonly toolService?: AgentToolService,
        @Optional()
        @Inject(AGENT_AI_DISPATCH_FACADE)
        private readonly aiDispatch?: AgentAiDispatchFacade,
    ) {}

    async execute(context: AgentRunContext): Promise<AgentRunExecuteResult> {
        const agent = await this.agents.findById(context.agentId);
        if (!agent) {
            this.logger.warn(`AgentRunService.execute: Agent ${context.agentId} not found`);
            return { runId: context.runId, status: 'agent-not-found' };
        }

        // 1. Pre-flight budget check.
        const budgetCheck = await this.checkBudget(agent);
        if (!budgetCheck.allowed) {
            await this.runs.markFailed(context.runId, 'Budget exceeded');
            await this.runLogs
                .append({
                    runId: context.runId,
                    level: 'ERROR',
                    step: 'budget',
                    message: `Budget exceeded — ${budgetCheck.currentSpendCents}/${budgetCheck.capCents ?? '?'} cents in period.`,
                    metadata: {
                        currentSpendCents: budgetCheck.currentSpendCents,
                        capCents: budgetCheck.capCents,
                        periodStart: budgetCheck.periodStart.toISOString(),
                        periodEnd: budgetCheck.periodEnd.toISOString(),
                    },
                })
                .catch(() => undefined);
            await this.logActivity({
                userId: agent.userId,
                agentId: agent.id,
                actionType: ActivityActionType.AGENT_BUDGET_EXCEEDED,
            });
            return { runId: context.runId, status: 'budget-blocked', budgetCheck };
        }

        // 2. Load assembly inputs in parallel. Phase 10 adds Skills
        // resolution alongside the cheap inputs. Scope-description
        // loaders land in Phase 14 (Mission tab strip).
        const [recentRuns, recentActivityRows, resolvedSkills] = await Promise.all([
            this.runs.findByAgent(agent.id, 5, 0).catch(() => []),
            this.findRecentActivityForAgent(agent.userId, agent.id).catch(() => []),
            this.resolveSkillsForRun(agent).catch(() => []),
        ]);

        // 2a. Priority-based drop on the skills bundle when its
        // combined token count exceeds the per-Agent budget. Skills
        // are already priority-sorted (lower = higher); we keep the
        // front of the array and drop from the back, emitting one
        // WARN run-log row per dropped Skill (spec §10.4 + plan §10).
        const skillsForPrompt = this.selectSkillsWithinBudget(
            resolvedSkills,
            agent.maxSkillContextTokens ?? 4000,
            context.runId,
        );

        // 3. Assemble the system + user messages per the 11-segment recipe.
        const prompt = this.assembler.assemble({
            agent,
            kind: context.kind,
            immediateInput: context.immediateInput ?? undefined,
            conversationContext: context.conversationContext,
            skills: skillsForPrompt,
            scopeContext: context.scopeContext ?? null,
            advancedPrompts: null, // Phase 7.5+ wires WorkAdvancedPrompts on Work-scoped Agents
            recentActivity: recentActivityRows,
            recentRuns: recentRuns.map((r: any) => ({
                at:
                    (r.startedAt ?? r.createdAt ?? new Date()).toISOString?.() ??
                    String(r.startedAt ?? r.createdAt),
                status: r.status,
                summary: r.summary ?? null,
            })),
            outputSchemaName: context.outputSchemaName,
        });

        // 3a. SKILL_INVOKED activity — one row per Skill that made it
        // into the system message (spec §10.5).
        for (const s of skillsForPrompt) {
            void this.logActivity({
                userId: agent.userId,
                agentId: agent.id,
                skillId: undefined,
                actionType: ActivityActionType.SKILL_INVOKED,
                details: { skillSlug: s.slug, priority: s.priority, runId: context.runId },
            });
        }

        // 4. Record any prompt-assembly truncations as WARN run-log
        // rows per spec §2 ("Truncation events emit an AgentRunLog row
        // at level=WARN, step='prompt-assembly'").
        for (const trunc of prompt.truncations) {
            await this.runLogs
                .append({
                    runId: context.runId,
                    level: 'WARN',
                    step: 'prompt-assembly',
                    message: `Segment "${trunc.segment}" truncated tail-first: ${trunc.originalTokens} → ${trunc.truncatedTokens} tokens (cap ${trunc.capTokens}).`,
                    metadata: {
                        segment: trunc.segment,
                        capTokens: trunc.capTokens,
                        originalTokens: trunc.originalTokens,
                        truncatedTokens: trunc.truncatedTokens,
                    },
                })
                .catch(() => undefined);
        }

        // 5. Prompt-assembly INFO row.
        await this.runLogs
            .append({
                runId: context.runId,
                level: 'INFO',
                step: 'prompt-assembly',
                message: `Assembled ${prompt.segments.filter((s) => s.included).length} segments, ${prompt.totalSystemTokens} system tokens.`,
                metadata: {
                    kind: context.kind,
                    segments: prompt.segments,
                    totalSystemTokens: prompt.totalSystemTokens,
                    totalUserTokens: prompt.totalUserTokens,
                },
            })
            .catch(() => undefined);

        // 6. FU-1 — LLM dispatch. When the AI dispatch facade isn't
        // bound (unit-test mode, or operator hasn't wired it yet),
        // fall back to the assemble-only return so callers can drive
        // the AI call themselves. Production binds the facade in
        // api-side AgentsModule via AGENT_AI_DISPATCH_FACADE.
        if (!this.aiDispatch) {
            return {
                runId: context.runId,
                status: 'assembled',
                prompt,
                budgetCheck,
            };
        }

        const dispatchResult = await this.runToolLoop(context, agent, prompt);
        if (dispatchResult.errored) {
            const finalizeResult = await this.finalize(context, {
                errored: true,
                errorMessage: dispatchResult.errorMessage,
            });
            return {
                runId: context.runId,
                status: 'dispatch-failed',
                prompt,
                budgetCheck,
                outcome: {
                    errored: true,
                    errorMessage: dispatchResult.errorMessage,
                },
                finalizeResult,
                toolLoopIterations: dispatchResult.iterations,
            };
        }

        const finalizeResult = await this.finalize(context, dispatchResult.outcome);
        return {
            runId: context.runId,
            status: 'dispatched',
            prompt,
            budgetCheck,
            outcome: dispatchResult.outcome,
            finalizeResult,
            toolLoopIterations: dispatchResult.iterations,
        };
    }

    /**
     * FU-1 — tool-loop wrapper around `AgentAiDispatchFacade.dispatch`.
     *
     * Capped at `TOOL_LOOP_MAX_ITERATIONS` round-trips. Each iteration:
     *   1. Call dispatch with the running message list.
     *   2. Log an INFO `ai-dispatch` row capturing usage / finish reason.
     *   3. If the assistant emitted tool calls, look each one up in
     *      the resolved descriptor set, invoke it, append a `tool`
     *      message with the JSON-stringified result, and loop.
     *   4. Otherwise return the assistant text as the final reply.
     *
     * `errored: true` surfaces both AI-provider exceptions and the
     * cap-hit (loop ran out without a stop) — the caller marks the
     * run failed and skips side effects.
     */
    private async runToolLoop(
        context: AgentRunContext,
        agent: Agent,
        prompt: AssembledPrompt,
    ): Promise<{
        errored: boolean;
        errorMessage?: string;
        outcome: AgentRunOutcome;
        iterations: number;
    }> {
        const TOOL_LOOP_MAX_ITERATIONS = 10;
        const editsThisRunByFile = new Set<string>();
        const baseDescriptors: AgentToolDescriptor[] = this.toolService
            ? this.toolService.resolveAllowedTools(agent, {
                  runId: context.runId,
                  editsThisRunByFile,
              })
            : [];
        // Virtual transitionTask descriptor — only exposed on `task`
        // kind runs. It captures the model's transition intent rather
        // than doing the transition itself (that runs through
        // `finalize()` → AGENT_RUN_TASK_FINISHER so it observes the
        // state-machine + force semantics).
        let capturedFinishStatus: AgentRunOutcome['taskFinishStatus'] = null;
        let capturedForce = false;
        const toolDescriptors: AgentToolDescriptor[] =
            context.kind === 'task'
                ? [
                      ...baseDescriptors,
                      this.buildTransitionTaskTool((status, force) => {
                          capturedFinishStatus = status;
                          capturedForce = force;
                      }),
                  ]
                : baseDescriptors;
        const toolDefs = toolDescriptors.map((d) => ({
            name: d.name,
            description: d.description,
            parameters: d.parameters as unknown as Record<string, unknown>,
        }));
        const descriptorByName = new Map(toolDescriptors.map((d) => [d.name, d]));

        const messages: AgentAiMessage[] = [
            { role: 'system', content: prompt.systemMessage },
            { role: 'user', content: prompt.userMessage },
        ];

        let iterations = 0;
        let assistantText: string | null = null;
        let lastFinishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null = null;

        try {
            while (iterations < TOOL_LOOP_MAX_ITERATIONS) {
                iterations += 1;
                const round = await this.aiDispatch!.dispatch({
                    messages,
                    tools: toolDefs.length > 0 ? toolDefs : undefined,
                    model: agent.modelId ?? undefined,
                    facadeOptions: {
                        userId: context.userId,
                        workId: agent.workId ?? undefined,
                        agentId: agent.id,
                        taskId: context.taskId ?? undefined,
                        providerOverride: agent.aiProviderId ?? undefined,
                    },
                });

                lastFinishReason = round.finishReason;
                assistantText = round.text;

                await this.runLogs
                    .append({
                        runId: context.runId,
                        level: 'INFO',
                        step: 'ai-dispatch',
                        message: `Round ${iterations}: ${round.toolCalls.length} tool call(s), finishReason=${round.finishReason ?? 'n/a'}.`,
                        metadata: {
                            iteration: iterations,
                            model: round.model,
                            finishReason: round.finishReason,
                            toolCallCount: round.toolCalls.length,
                            promptTokens: round.usage?.promptTokens,
                            completionTokens: round.usage?.completionTokens,
                            totalTokens: round.usage?.totalTokens,
                        },
                    })
                    .catch(() => undefined);

                if (round.toolCalls.length === 0) {
                    break;
                }

                messages.push({
                    role: 'assistant',
                    content: round.text ?? '',
                    toolCalls: round.toolCalls,
                });

                for (const call of round.toolCalls) {
                    const result = await this.invokeTool(context.runId, descriptorByName, call);
                    messages.push({
                        role: 'tool',
                        toolCallId: call.id,
                        name: call.name,
                        content: JSON.stringify(result),
                    });
                }
            }
        } catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            this.logger.warn(`AI dispatch failed for run ${context.runId}: ${errorMessage}`);
            await this.runLogs
                .append({
                    runId: context.runId,
                    level: 'ERROR',
                    step: 'ai-dispatch',
                    message: `AI dispatch errored: ${errorMessage}`,
                    metadata: { iteration: iterations, errorName: (err as Error)?.name },
                })
                .catch(() => undefined);
            return {
                errored: true,
                errorMessage,
                outcome: { errored: true, errorMessage },
                iterations,
            };
        }

        if (iterations >= TOOL_LOOP_MAX_ITERATIONS && lastFinishReason === 'tool_calls') {
            const errorMessage = `Tool loop hit cap (${TOOL_LOOP_MAX_ITERATIONS} iterations) without a stop.`;
            await this.runLogs
                .append({
                    runId: context.runId,
                    level: 'ERROR',
                    step: 'ai-dispatch',
                    message: errorMessage,
                    metadata: { iteration: iterations, cap: TOOL_LOOP_MAX_ITERATIONS },
                })
                .catch(() => undefined);
            return {
                errored: true,
                errorMessage,
                outcome: { errored: true, errorMessage },
                iterations,
            };
        }

        const outcome = this.parseOutcome(
            context.kind,
            assistantText,
            capturedFinishStatus,
            capturedForce,
        );
        return { errored: false, outcome, iterations };
    }

    /**
     * FU-1 — virtual `transitionTask` tool. Exposed on `task`-kind
     * runs so the model has a structured way to declare "this Task
     * is done / blocked / in_review / cancelled". The capture
     * callback stores the intent on the closure; the real transition
     * happens via `finalize()` → AGENT_RUN_TASK_FINISHER so blocker /
     * approver gates apply uniformly across the heartbeat / chat /
     * task paths.
     */
    private buildTransitionTaskTool(
        capture: (status: 'done' | 'in_review' | 'blocked' | 'cancelled', force: boolean) => void,
    ): AgentToolDescriptor<
        { to: 'done' | 'in_review' | 'blocked' | 'cancelled'; force?: boolean },
        { captured: true; to: string }
    > {
        return {
            name: 'transitionTask',
            description:
                'Mark the originating Task done / in_review / blocked / cancelled. Use this when you have finished the work (or determined you cannot continue) — the platform records your intent and the transition runs through the state machine post-run. `force` overrides approver gate only (not blocker).',
            parameters: {
                type: 'object',
                properties: {
                    to: {
                        type: 'string',
                        description: 'Target status: done | in_review | blocked | cancelled.',
                    },
                    force: {
                        type: 'boolean',
                        description: 'Override approver gate (not blocker). Default false.',
                    },
                },
                required: ['to'],
            },
            invoke: async (args) => {
                if (!args?.to) {
                    return { error: 'transitionTask: `to` is required.' } as { error: string };
                }
                if (!['done', 'in_review', 'blocked', 'cancelled'].includes(args.to)) {
                    return {
                        error: `transitionTask: \`to\` must be done | in_review | blocked | cancelled (got ${args.to}).`,
                    } as { error: string };
                }
                capture(args.to, args.force ?? false);
                return { captured: true, to: args.to };
            },
        };
    }

    private async invokeTool(
        runId: string,
        descriptorByName: Map<string, AgentToolDescriptor>,
        call: AgentAiToolCall,
    ): Promise<unknown> {
        const descriptor = descriptorByName.get(call.name);
        if (!descriptor) {
            await this.runLogs
                .append({
                    runId,
                    level: 'WARN',
                    step: 'tool-invocation',
                    message: `Tool "${call.name}" requested by the model is not in the allow-list.`,
                    metadata: { toolName: call.name, callId: call.id },
                })
                .catch(() => undefined);
            return { error: `tool "${call.name}" is not available to this Agent.` };
        }
        try {
            const result = await descriptor.invoke(call.args as never);
            const isError = result && typeof result === 'object' && 'error' in (result as object);
            await this.runLogs
                .append({
                    runId,
                    level: isError ? 'WARN' : 'INFO',
                    step: 'tool-invocation',
                    message: `Invoked tool "${call.name}"${isError ? ' (returned error)' : ''}.`,
                    metadata: { toolName: call.name, callId: call.id },
                })
                .catch(() => undefined);
            return result;
        } catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            await this.runLogs
                .append({
                    runId,
                    level: 'WARN',
                    step: 'tool-invocation',
                    message: `Tool "${call.name}" threw: ${errorMessage}`,
                    metadata: { toolName: call.name, callId: call.id },
                })
                .catch(() => undefined);
            return { error: errorMessage };
        }
    }

    /**
     * FU-1 — parse the assistant's final response into an
     * `AgentRunOutcome`. Stays intentionally lenient: when the model
     * didn't emit a tool call to transition the task or didn't give a
     * usable reply body, the corresponding side effect simply doesn't
     * fire (rather than failing the whole run).
     *
     * The protocol the prompt assembler asks the model to honor:
     *   - chat:      natural-language reply text → `replyBody`
     *   - task:      natural-language progress note + optional
     *                `transitionTask` tool call (handled inline in the
     *                tool loop, not here) → status sets `taskFinishStatus`
     *   - heartbeat: free-form note → `summary`
     *
     * The `summary` is always extracted as the first non-empty line of
     * the assistant text so the AgentRun row gets a useful one-liner
     * regardless of kind.
     */
    private parseOutcome(
        kind: AgentRunKind,
        assistantText: string | null,
        capturedFinishStatus: AgentRunOutcome['taskFinishStatus'],
        capturedForce: boolean,
    ): AgentRunOutcome {
        const text = (assistantText ?? '').trim();
        const firstLine =
            text.length > 0 ? (text.split('\n').find((l) => l.trim().length > 0) ?? null) : null;
        const summary =
            firstLine && firstLine.length > 200 ? firstLine.slice(0, 200).trim() + '…' : firstLine;

        if (kind === 'chat') {
            return {
                summary,
                replyBody: text.length > 0 ? text : null,
            };
        }
        if (kind === 'task') {
            return {
                summary,
                taskFinishStatus: capturedFinishStatus,
                force: capturedForce,
            };
        }
        return { summary };
    }

    /**
     * Agents/Skills/Tasks PR #1017 — Phase 15.5.
     *
     * Post-process a completed Agent run. Called by the dispatch path
     * after the LLM round-trip finishes (or by tests that simulate
     * one). Three kind-specific side effects:
     *
     *  - `chat`: when `outcome.replyBody` is non-empty, posts that as
     *    an agent-authored chat message back to the originating Task
     *    via the `AgentRunChatBackPoster` token (bound to
     *    `TaskChatService` in the platform module).
     *  - `task`: when `outcome.taskFinishStatus` is set, flips the
     *    Task status via the `AgentRunTaskFinisher` token (bound to
     *    `TasksService.transition`). The transition still runs through
     *    `TaskTransitionService`, so blocker/approver gates apply.
     *  - `heartbeat`: no-op — heartbeat outcomes feed back into the
     *    Agent's own HEARTBEAT.md only, which the orchestrator handles
     *    on the file-edit path.
     *
     * The AgentRun row itself is always marked completed (or failed
     * when `outcome.errored`). Side-effect failures are logged as WARN
     * `AgentRunLog` rows but do NOT mark the run failed — the LLM
     * already did its work, the auto-followup is best-effort.
     */
    async finalize(
        context: AgentRunContext,
        outcome: AgentRunOutcome,
    ): Promise<{
        runId: string;
        status: 'completed' | 'failed';
        postedMessageId?: string;
        finishedTaskStatus?: string;
    }> {
        const summary = outcome.summary ?? null;

        if (outcome.errored) {
            await this.runs
                .markFailed(context.runId, outcome.errorMessage ?? 'Agent run errored')
                .catch(() => undefined);
            return { runId: context.runId, status: 'failed' };
        }

        await this.runs.markCompleted(context.runId, summary ?? undefined).catch(() => undefined);

        let postedMessageId: string | undefined;
        let finishedTaskStatus: string | undefined;

        // Kind-specific side effects. Best-effort — a chat-back failure
        // or transition rejection does not unwind the LLM work.
        if (context.kind === 'chat' && outcome.replyBody && outcome.replyBody.trim().length > 0) {
            postedMessageId = await this.tryPostChatReply(context, outcome.replyBody);
        }
        if (context.kind === 'task' && outcome.taskFinishStatus) {
            finishedTaskStatus = await this.tryFinishTask(
                context,
                outcome.taskFinishStatus,
                outcome.force ?? false,
            );
        }

        return {
            runId: context.runId,
            status: 'completed',
            postedMessageId,
            finishedTaskStatus,
        };
    }

    private async tryPostChatReply(
        context: AgentRunContext,
        body: string,
    ): Promise<string | undefined> {
        const taskId = context.taskId ?? undefined;
        if (!this.chatBackPoster) {
            await this.runLogs
                .append({
                    runId: context.runId,
                    level: 'WARN',
                    step: 'post-process',
                    message: 'chat-back poster not bound — skipping auto-reply post.',
                })
                .catch(() => undefined);
            return undefined;
        }
        if (!taskId) {
            await this.runLogs
                .append({
                    runId: context.runId,
                    level: 'WARN',
                    step: 'post-process',
                    message: 'chat-kind run has no taskId — skipping auto-reply post.',
                })
                .catch(() => undefined);
            return undefined;
        }
        try {
            const result = await this.chatBackPoster.postReply({
                userId: context.userId,
                taskId,
                agentId: context.agentId,
                body,
            });
            await this.runLogs
                .append({
                    runId: context.runId,
                    level: 'INFO',
                    step: 'post-process',
                    message: `Posted chat-back reply ${result.messageId}.`,
                    metadata: { messageId: result.messageId, taskId },
                })
                .catch(() => undefined);
            return result.messageId;
        } catch (err) {
            this.logger.warn(`Chat-back post failed for run ${context.runId}: ${err}`);
            await this.runLogs
                .append({
                    runId: context.runId,
                    level: 'WARN',
                    step: 'post-process',
                    message: `Chat-back post failed: ${err instanceof Error ? err.message : String(err)}`,
                })
                .catch(() => undefined);
            return undefined;
        }
    }

    private async tryFinishTask(
        context: AgentRunContext,
        to: 'done' | 'in_review' | 'blocked' | 'cancelled',
        force: boolean,
    ): Promise<string | undefined> {
        const taskId = context.taskId ?? undefined;
        if (!this.taskFinisher) {
            await this.runLogs
                .append({
                    runId: context.runId,
                    level: 'WARN',
                    step: 'post-process',
                    message: 'task finisher not bound — skipping status flip.',
                })
                .catch(() => undefined);
            return undefined;
        }
        if (!taskId) {
            await this.runLogs
                .append({
                    runId: context.runId,
                    level: 'WARN',
                    step: 'post-process',
                    message: 'task-kind run has no taskId — skipping status flip.',
                })
                .catch(() => undefined);
            return undefined;
        }
        try {
            const result = await this.taskFinisher.finishTask({
                userId: context.userId,
                taskId,
                to,
                force,
            });
            await this.runLogs
                .append({
                    runId: context.runId,
                    level: 'INFO',
                    step: 'post-process',
                    message: `Transitioned Task ${taskId} to ${result.status}.`,
                    metadata: { taskId, to: result.status, force },
                })
                .catch(() => undefined);
            return result.status;
        } catch (err) {
            this.logger.warn(`Task-finish failed for run ${context.runId}: ${err}`);
            await this.runLogs
                .append({
                    runId: context.runId,
                    level: 'WARN',
                    step: 'post-process',
                    message: `Task-finish failed: ${err instanceof Error ? err.message : String(err)}`,
                })
                .catch(() => undefined);
            return undefined;
        }
    }

    /**
     * Polymorphic budget check for an Agent's current period. Reads
     * the Agent's `AgentBudget` row (if any), aggregates this user's
     * `PluginUsageEvent` spend over the period, returns an
     * allow/deny + spend metadata.
     *
     * Phase 7 v1 returns synthetic `currentSpendCents=0` until the
     * `PluginUsageEvent` aggregator is wired up (Phase 7.5 follow-up).
     * The shape is stable so callers don't need to re-do their
     * handling once that lands.
     */
    async checkBudget(agent: Agent): Promise<AgentRunBudgetCheck> {
        const budget = await this.budgets.findByAgentId(agent.id).catch(() => null);
        if (!budget) {
            return {
                allowed: true,
                reason: 'no-budget',
                currentSpendCents: 0,
                capCents: null,
                periodStart: new Date(0),
                periodEnd: new Date(8_640_000_000_000_000),
            };
        }
        const intervalUnit = (budget as any).intervalUnit ?? 'month';
        const intervalCount = (budget as any).intervalCount ?? 1;
        const capCents = (budget as any).capCents ?? null;
        const periodStart = getCurrentPeriodStart(intervalUnit, new Date(), intervalCount);
        const periodEnd = getNextPeriodStart(intervalUnit, new Date(), intervalCount);

        if (intervalUnit === 'unlimited' || capCents === null) {
            return {
                allowed: true,
                reason: 'unlimited',
                currentSpendCents: 0,
                capCents,
                periodStart,
                periodEnd,
            };
        }

        // TODO Phase 7.5 follow-up: aggregate from PluginUsageEvent
        // joined by (userId, agentId, occurredAt BETWEEN periodStart
        // AND periodEnd). For now we synthesize 0 spend so the
        // allow/deny contract is stable; callers that genuinely care
        // about enforcement today should consult BudgetGuardService
        // directly with ownerType='agent'.
        const currentSpendCents = 0;
        return {
            allowed: currentSpendCents < capCents,
            reason: currentSpendCents < capCents ? 'ok' : 'over-cap',
            currentSpendCents,
            capCents,
            periodStart,
            periodEnd,
        };
    }

    private async findRecentActivityForAgent(
        _userId: string,
        _agentId: string,
    ): Promise<Array<{ at: string; type: string; detail?: string }>> {
        // Phase 7.5 follow-up: wire to ActivityLogService.findByAgent(...)
        // once that method exists. v1 returns an empty array so the
        // PromptAssembler sees no recent-activity segment — the
        // Agent's own SOUL/AGENTS/HEARTBEAT still drive the run.
        return [];
    }

    /**
     * Skills feature — Phase 10.2. Resolve active skills for this
     * Agent run from the binding table. Returns an empty array when
     * the skill-bindings repository is not wired (unit-test mode).
     */
    private async resolveSkillsForRun(
        agent: Agent,
    ): Promise<Array<{ slug: string; body: string; priority: number }>> {
        if (!this.skillBindings) return [];
        const rows: ResolvedSkill[] = await this.skillBindings.resolveActive({
            userId: agent.userId,
            agentId: agent.id,
            workId: agent.workId ?? undefined,
            missionId: agent.missionId ?? undefined,
            ideaId: agent.ideaId ?? undefined,
            forAgentRun: true,
        });
        return rows.map(({ binding, skill }) => ({
            slug: skill.slug,
            body: skill.instructionsMd,
            priority: binding.priority,
        }));
    }

    /**
     * Skills feature — Phase 10.4. Greedy fit-into-budget — keep
     * skills in priority order (lower = higher) until the next one
     * would push the bundle over the per-Agent
     * `maxSkillContextTokens` cap. Each dropped skill emits a
     * WARN AgentRunLog row.
     *
     * Token-count uses the same char/4 v1 estimator as PromptAssembler
     * so the upstream cap math stays consistent.
     */
    private selectSkillsWithinBudget(
        resolved: Array<{ slug: string; body: string; priority: number }>,
        capTokens: number,
        runId: string,
    ): Array<{ slug: string; body: string; priority: number }> {
        if (resolved.length === 0) return [];
        const sorted = [...resolved].sort((a, b) => a.priority - b.priority);
        const kept: typeof sorted = [];
        let used = 0;
        for (const skill of sorted) {
            const cost = estimateTokens(skill.body);
            if (used + cost <= capTokens) {
                kept.push(skill);
                used += cost;
            } else {
                void this.runLogs
                    ?.append({
                        runId,
                        level: 'WARN',
                        step: 'skill-injection',
                        message: `Skill "${skill.slug}" dropped — would exceed maxSkillContextTokens (${capTokens}).`,
                        metadata: {
                            skillSlug: skill.slug,
                            priority: skill.priority,
                            skillTokens: cost,
                            usedTokens: used,
                            capTokens,
                        },
                    })
                    .catch(() => undefined);
            }
        }
        return kept;
    }

    private async logActivity(args: {
        userId: string;
        agentId: string;
        skillId?: string;
        actionType: ActivityActionType;
        details?: Record<string, unknown>;
    }): Promise<void> {
        if (!this.activityLog) return;
        try {
            // Post-rebase fix: develop's CreateActivityLogDto dropped
            // `resourceType` + `resourceId` (now lives under `details`),
            // and `ActivityStatus.SUCCESS` was renamed `COMPLETED`.
            const resourceType = args.skillId ? 'skill' : 'agent';
            const resourceId = args.skillId ?? args.agentId;
            await this.activityLog.log({
                userId: args.userId,
                action: args.actionType,
                actionType: args.actionType,
                status: ActivityStatus.COMPLETED,
                summary: `${resourceType} ${resourceId} — ${args.actionType}`,
                details: { ...(args.details ?? {}), resourceType, resourceId },
            });
        } catch (err) {
            this.logger.warn(`Failed to log activity ${args.actionType}: ${err}`);
        }
    }
}
