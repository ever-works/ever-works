import { Injectable, Logger } from '@nestjs/common';
import type { Agent } from '../entities/agent.entity';

/**
 * Agents/Skills/Tasks PR #1017 — Phase 7.1–7.3.
 *
 * Concrete implementation of the 11-segment system-message recipe
 * defined in `docs/specs/architecture/agent-prompt-assembly.md §2`.
 *
 * Why a standalone service (not just a function): the token budget
 * is per-Agent (`maxSkillContextTokens` defaults to 4000), each
 * segment has its own cap, and truncation emits a structured
 * `AgentRunLog` warning row. Keeping the logic in a service lets
 * `AgentRunService.execute()` inject it and lets tests mock the
 * logger to assert that the truncation events were recorded.
 */

export type AgentRunKind = 'heartbeat' | 'task' | 'chat';

/**
 * Source of truth for the 11 segments. Order matters — segments
 * are emitted in the order listed here (segment 1 first).
 */
export const PROMPT_SEGMENTS = [
	'identity',
	'role',
	'capabilities',
	'operating-loop',
	'tools',
	'skills',
	'scope-advanced-prompts',
	'scope-context',
	'recent-activity',
	'recent-runs',
	'output-contract',
] as const;
export type PromptSegmentName = (typeof PROMPT_SEGMENTS)[number];

/**
 * Per-segment token caps. `null` means "no cap — emit full body".
 * Numbers match the spec table in agent-prompt-assembly.md §2.
 */
const SEGMENT_TOKEN_CAPS: Record<PromptSegmentName, number | null> = {
	identity: null,
	role: null,
	capabilities: null,
	'operating-loop': null,
	tools: 1500,
	skills: 4000, // overridden by agent.maxSkillContextTokens at assemble time
	'scope-advanced-prompts': null,
	'scope-context': 800,
	'recent-activity': 1200,
	'recent-runs': 800,
	'output-contract': 150,
};

/**
 * Total system-message budget target — when an unbounded segment
 * (identity / role / capabilities / operating-loop) is huge, the
 * assembler still respects this overall cap by truncating those
 * segments tail-first before the capped ones run.
 */
const TOTAL_SYSTEM_TOKEN_TARGET = 12_000;

const HEARTBEAT_USER_PROMPT = "What's the next action you should take? Choose ONE.";

const TASK_PREAMBLE = `You are working on a specific Task assigned to you. The Task body
follows. Your output should advance the Task — make progress, ask a
clarifying question in the Task chat, transition the Task status,
or escalate by creating a sub-task. Do NOT take actions outside the
scope of this Task.`;

const CHAT_PREAMBLE = `You were mentioned in a Task chat thread. Read the recent messages,
then post a single reply. Do NOT transition the Task status from a
chat reply — use the transition tool only when explicitly asked.
Keep the reply focused on the chat question.`;

export interface AssembleInput {
	agent: Pick<
		Agent,
		| 'id'
		| 'name'
		| 'slug'
		| 'title'
		| 'capabilities'
		| 'maxSkillContextTokens'
		| 'permissions'
		| 'soulMd'
		| 'agentsMd'
		| 'heartbeatMd'
		| 'toolsMd'
		| 'agentYml'
	>;
	kind: AgentRunKind;
	/** Filled when kind = task or chat. The Task body / new chat message. */
	immediateInput?: string;
	/** Conversation context for task / chat runs. Newest last. */
	conversationContext?: Array<{ author: string; body: string; createdAt?: string }>;
	/** Resolved active skills (Phase 9 will source this from SkillBindingRepository.resolveActive). */
	skills?: Array<{ slug: string; body: string; priority: number }>;
	/** Optional Mission / Idea / Work description that anchors the scope. */
	scopeContext?: string | null;
	/** Work-scoped Agent — relevant WorkAdvancedPrompts column. */
	advancedPrompts?: string | null;
	/** Compact JSON of last N=20 activity_log rows for the Agent's scope. */
	recentActivity?: Array<{ at: string; type: string; detail?: string }>;
	/** Last N=5 agent_runs summaries. */
	recentRuns?: Array<{ at: string; status: string; summary?: string | null }>;
	/** When caller used askJson() — appended as a segment-11 reminder. */
	outputSchemaName?: string;
}

export interface AssemblyTruncation {
	segment: PromptSegmentName;
	capTokens: number;
	originalTokens: number;
	truncatedTokens: number;
}

export interface AssembledPrompt {
	systemMessage: string;
	userMessage: string;
	totalSystemTokens: number;
	totalUserTokens: number;
	segments: Array<{ name: PromptSegmentName; tokens: number; included: boolean }>;
	truncations: AssemblyTruncation[];
}

@Injectable()
export class PromptAssemblerService {
	private readonly logger = new Logger(PromptAssemblerService.name);

	assemble(input: AssembleInput): AssembledPrompt {
		const truncations: AssemblyTruncation[] = [];
		const segments: AssembledPrompt['segments'] = [];

		// Per-Agent skill-context override beats the default cap.
		const skillsCap = input.agent.maxSkillContextTokens ?? SEGMENT_TOKEN_CAPS.skills ?? 4000;
		const effectiveCaps: Record<PromptSegmentName, number | null> = {
			...SEGMENT_TOKEN_CAPS,
			skills: skillsCap,
		};

		const pushSegment = (name: PromptSegmentName, raw: string | null | undefined): string => {
			if (!raw || raw.trim().length === 0) {
				segments.push({ name, tokens: 0, included: false });
				return '';
			}
			const cap = effectiveCaps[name];
			const tokens = estimateTokens(raw);
			if (cap !== null && tokens > cap) {
				const truncated = truncateTailFirst(raw, cap);
				truncations.push({
					segment: name,
					capTokens: cap,
					originalTokens: tokens,
					truncatedTokens: estimateTokens(truncated),
				});
				segments.push({ name, tokens: estimateTokens(truncated), included: true });
				return truncated;
			}
			segments.push({ name, tokens, included: true });
			return raw;
		};

		const operatingLoopBody = this.resolveOperatingLoop(input);
		const toolsBody = this.renderToolsBlock(input);
		const skillsBody = this.renderSkillsBlock(input);
		const activityBody = this.renderActivityBlock(input);
		const runsBody = this.renderRunsBlock(input);
		const outputContractBody = this.renderOutputContractBlock(input);

		const parts: string[] = [];
		const add = (heading: string, name: PromptSegmentName, body: string | null | undefined): void => {
			const rendered = pushSegment(name, body);
			if (rendered) {
				parts.push(`# ${heading}\n${rendered}`);
			}
		};

		add('IDENTITY (SOUL.md)', 'identity', input.agent.soulMd);
		add('ROLE (AGENTS.md)', 'role', input.agent.agentsMd);
		add('CAPABILITIES', 'capabilities', input.agent.capabilities);
		add('OPERATING LOOP', 'operating-loop', operatingLoopBody);
		add('TOOLS', 'tools', toolsBody);
		add('ACTIVE SKILLS', 'skills', skillsBody);
		add('WORK ADVANCED PROMPTS', 'scope-advanced-prompts', input.advancedPrompts ?? null);
		add('SCOPE CONTEXT', 'scope-context', input.scopeContext ?? null);
		add('RECENT ACTIVITY', 'recent-activity', activityBody);
		add('RECENT RUNS', 'recent-runs', runsBody);
		add('OUTPUT CONTRACT', 'output-contract', outputContractBody);

		let systemMessage = parts.join('\n\n');

		// Enforce the overall TOTAL_SYSTEM_TOKEN_TARGET as a final
		// safety net — uncapped segments (identity / role) can
		// individually fit but their sum might still blow the budget.
		const totalNow = estimateTokens(systemMessage);
		if (totalNow > TOTAL_SYSTEM_TOKEN_TARGET) {
			const before = totalNow;
			systemMessage = truncateTailFirst(systemMessage, TOTAL_SYSTEM_TOKEN_TARGET);
			truncations.push({
				segment: 'identity', // attributed to the first uncapped segment for visibility
				capTokens: TOTAL_SYSTEM_TOKEN_TARGET,
				originalTokens: before,
				truncatedTokens: estimateTokens(systemMessage),
			});
		}

		const userMessage = this.buildUserMessage(input);

		return {
			systemMessage,
			userMessage,
			totalSystemTokens: estimateTokens(systemMessage),
			totalUserTokens: estimateTokens(userMessage),
			segments,
			truncations,
		};
	}

	private resolveOperatingLoop(input: AssembleInput): string | null {
		switch (input.kind) {
			case 'heartbeat':
				return input.agent.heartbeatMd ?? null;
			case 'task':
				return TASK_PREAMBLE;
			case 'chat':
				return CHAT_PREAMBLE;
			default:
				return null;
		}
	}

	private renderToolsBlock(input: AssembleInput): string | null {
		const md = input.agent.toolsMd;
		const perms = input.agent.permissions;
		if (!md && !perms) return null;
		const lines: string[] = [];
		if (md) lines.push(md);
		if (perms) {
			lines.push('\nGranted capabilities (TRUE = the Agent is allowed to use this surface):');
			for (const [key, value] of Object.entries(perms)) {
				lines.push(`- ${key}: ${value ? 'TRUE' : 'false'}`);
			}
		}
		return lines.join('\n');
	}

	private renderSkillsBlock(input: AssembleInput): string | null {
		const skills = input.skills ?? [];
		if (skills.length === 0) return null;
		// Spec §2 — Skills before scope context, priority-sorted (caller already sorts).
		const lines: string[] = [];
		for (const skill of skills) {
			lines.push(`## Skill: ${skill.slug} (priority ${skill.priority})\n${skill.body}`);
		}
		return lines.join('\n\n');
	}

	private renderActivityBlock(input: AssembleInput): string | null {
		const acts = input.recentActivity ?? [];
		if (acts.length === 0) return null;
		const lines = acts.map(
			(a) => `- ${a.at} • ${a.type}${a.detail ? ` — ${truncateSingleLine(a.detail, 200)}` : ''}`,
		);
		return lines.join('\n');
	}

	private renderRunsBlock(input: AssembleInput): string | null {
		const runs = input.recentRuns ?? [];
		if (runs.length === 0) return null;
		const lines = runs.map(
			(r) => `- ${r.at} • ${r.status}${r.summary ? ` — ${truncateSingleLine(r.summary, 240)}` : ''}`,
		);
		return lines.join('\n');
	}

	private renderOutputContractBlock(input: AssembleInput): string | null {
		if (!input.outputSchemaName) return null;
		return `Respond ONLY with valid JSON conforming to the "${input.outputSchemaName}" schema. No prose, no markdown fences.`;
	}

	private buildUserMessage(input: AssembleInput): string {
		switch (input.kind) {
			case 'heartbeat':
				return HEARTBEAT_USER_PROMPT;
			case 'task':
			case 'chat': {
				const parts: string[] = [];
				if (input.immediateInput) parts.push(input.immediateInput);
				const ctx = input.conversationContext ?? [];
				if (ctx.length > 0) {
					parts.push('\n# Conversation context (newest last)');
					for (const m of ctx) {
						parts.push(`- **${m.author}** (${m.createdAt ?? 'unknown'}): ${m.body}`);
					}
				}
				return parts.join('\n');
			}
		}
	}
}

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Phase-7 v1 token estimator — char-count / 4. Good enough for budget
 * gates within ~20% of real tokenization for English Markdown. Phase 7
 * may upgrade to a proper tokenizer once the AiFacadeService surfaces
 * one.
 */
export function estimateTokens(text: string): number {
	if (!text) return 0;
	return Math.ceil(text.length / 4);
}

/**
 * Tail-first truncation: keep the END of the text (newest content),
 * drop the BEGINNING. Spec §2 wording: "newest preserved, oldest cut."
 */
export function truncateTailFirst(text: string, capTokens: number): string {
	const capChars = capTokens * 4;
	if (text.length <= capChars) return text;
	const sliceFrom = text.length - capChars;
	return `[…truncated ${text.length - capChars} chars…]\n${text.slice(sliceFrom)}`;
}

function truncateSingleLine(text: string, maxChars: number): string {
	const flat = text.replace(/\s+/g, ' ').trim();
	return flat.length > maxChars ? `${flat.slice(0, maxChars - 1)}…` : flat;
}
