import { Injectable, Logger, Optional } from '@nestjs/common';
import type { Agent } from '../entities/agent.entity';
import { AgentRepository } from '../database/repositories/agent.repository';
import { AgentRunRepository } from '../database/repositories/agent-run.repository';
import { AgentRunLogRepository } from '../database/repositories/agent-run-log.repository';
import { AgentBudgetRepository } from '../database/repositories/agent-budget.repository';
import { SkillBindingRepository, type ResolvedSkill } from '../database/repositories/skill-binding.repository';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { ActivityActionType, ActivityStatus } from '../entities/activity-log.types';
import {
	PromptAssemblerService,
	estimateTokens,
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
		@Optional() private readonly skillBindings?: SkillBindingRepository,
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
				at: (r.startedAt ?? r.createdAt ?? new Date()).toISOString?.() ?? String(r.startedAt ?? r.createdAt),
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
			await this.activityLog.log({
				userId: args.userId,
				action: args.actionType,
				actionType: args.actionType,
				status: ActivityStatus.SUCCESS,
				resourceType: args.skillId ? 'skill' : 'agent',
				resourceId: args.skillId ?? args.agentId,
				details: args.details,
			});
		} catch (err) {
			this.logger.warn(`Failed to log activity ${args.actionType}: ${err}`);
		}
	}
}
