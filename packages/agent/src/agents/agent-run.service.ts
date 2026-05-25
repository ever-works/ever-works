import { Injectable, Logger, Optional } from '@nestjs/common';
import type { Agent } from '../entities/agent.entity';
import { AgentRepository } from '../database/repositories/agent.repository';
import { AgentRunRepository } from '../database/repositories/agent-run.repository';
import { AgentRunLogRepository } from '../database/repositories/agent-run-log.repository';
import { AgentBudgetRepository } from '../database/repositories/agent-budget.repository';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { ActivityActionType, ActivityStatus } from '../entities/activity-log.types';
import {
	PromptAssemblerService,
	type AssembledPrompt,
	type AgentRunKind,
} from './prompt-assembler.service';
import {
	getCurrentPeriodStart,
	getNextPeriodStart,
} from './budget-period';

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
	status: 'assembled' | 'budget-blocked' | 'agent-not-found';
	prompt?: AssembledPrompt;
	budgetCheck?: AgentRunBudgetCheck;
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
		@Optional() private readonly activityLog?: ActivityLogService,
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

		// 2. Load assembly inputs in parallel. v1 ships with the cheap
		// inputs only (recent runs + activity). Skill resolution + scope
		// description loaders land alongside Phase 9 (Skills) and Phase
		// 14 (Mission tab strip wiring respectively).
		const [recentRuns, recentActivityRows] = await Promise.all([
			this.runs.findByAgent(agent.id, 5, 0).catch(() => []),
			this.findRecentActivityForAgent(agent.userId, agent.id).catch(() => []),
		]);

		// 3. Assemble the system + user messages per the 11-segment recipe.
		const prompt = this.assembler.assemble({
			agent,
			kind: context.kind,
			immediateInput: context.immediateInput ?? undefined,
			conversationContext: context.conversationContext,
			skills: [], // Phase 9 wires SkillBindingRepository.resolveActive
			scopeContext: context.scopeContext ?? null,
			advancedPrompts: null, // Phase 7.5+ wires WorkAdvancedPrompts on Work-scoped Agents
			recentActivity: recentActivityRows,
			recentRuns: recentRuns.map((r: any) => ({
				at: (r.startedAt ?? r.createdAt ?? new Date()).toISOString?.() ?? String(r.startedAt ?? r.createdAt),
				status: r.status,
				summary: r.summary ?? null,
			})),
			outputSchemaName: context.outputSchemaName,
		});

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

		// 5. v1 stops here — the actual AI call + tool loop lands in
		// the follow-up sub-tick once Skill catalog + Tools surface are
		// live. Caller (the Trigger.dev heartbeat / task / chat task)
		// receives the assembled prompt + budget check and can decide
		// to invoke AiFacadeService.createChatCompletion() directly
		// while this orchestrator's full surface is being built out.
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

		return {
			runId: context.runId,
			status: 'assembled',
			prompt,
			budgetCheck,
		};
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

	private async logActivity(args: {
		userId: string;
		agentId: string;
		actionType: ActivityActionType;
	}): Promise<void> {
		if (!this.activityLog) return;
		try {
			await this.activityLog.log({
				userId: args.userId,
				action: args.actionType,
				actionType: args.actionType,
				status: ActivityStatus.SUCCESS,
				resourceType: 'agent',
				resourceId: args.agentId,
			});
		} catch (err) {
			this.logger.warn(`Failed to log activity ${args.actionType}: ${err}`);
		}
	}
}
