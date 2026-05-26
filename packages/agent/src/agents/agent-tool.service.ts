import { Injectable, Logger, Optional } from '@nestjs/common';
import type { Agent } from '../entities/agent.entity';
import { AgentScope } from '../entities/agent.entity';
import { AgentRepository } from '../database/repositories/agent.repository';
import { AgentFileService } from './agent-file.service';
import { SkillBindingRepository } from '../database/repositories/skill-binding.repository';
import { SkillRepository } from '../database/repositories/skill.repository';
import { createGetSkillBodyTool } from './agent-tools-skill';

/**
 * Tool descriptor — stable shape across every Agent tool. The
 * `invoke` callback is bound to the resolved context at descriptor-
 * build time, so callers (the AiFacadeService tool-loop wrapper)
 * don't need to thread the user/agent/scope ids back in.
 */
export interface AgentToolDescriptor<TArgs = unknown, TResult = unknown> {
	name: string;
	description: string;
	parameters: {
		type: 'object';
		properties: Record<string, { type: string; description: string }>;
		required: string[];
	};
	invoke: (args: TArgs) => Promise<TResult | { error: string }>;
}

/**
 * Tasks/Tools feature — Phase 16.1.
 *
 * Resolves the per-run allow-list of tools an Agent can call, per
 * `agent-tools-catalog.md §4`. The Agent's `permissions` JSON and
 * `TOOLS.md` body both gate the surface — permissions denylist
 * (canCommitToRepo / canOpenPullRequests / canCallExternalTools /
 * canAssignTasks / canCreateAgents / canEditAgentFiles) wins; an
 * empty TOOLS.md does NOT exclude permitted tools (the file is a
 * model hint, not a security boundary).
 *
 * v1 ships descriptors for the 5 agent-internal tools that don't
 * need external plugins or git access:
 *   - getSkillBody          (Phase 10.3, re-exported here)
 *   - editAgentFile         (Phase 16.5 — re-uses AgentFileService.write)
 *   - createSubAgent        (Phase 16.8 — sub-Agents always in DRAFT,
 *                            permissions all false)
 *   - getActivity           (Phase 16.9 — placeholder hook)
 *   - getKbDocument         (Phase 16.9 — placeholder hook)
 *
 * createTask / commentOnTask / transitionTask / commitToRepo /
 * openPullRequest + the plugin pass-throughs (searchWeb /
 * screenshot / extractContent) wire in once their respective
 * platform surfaces are reachable from the agent package (the
 * facades are circular-dep-sensitive — we'll inject them via the
 * tool-loop wrapper in `AiFacadeService` rather than here).
 */
@Injectable()
export class AgentToolService {
	private readonly logger = new Logger(AgentToolService.name);

	constructor(
		private readonly agents: AgentRepository,
		@Optional() private readonly skills?: SkillRepository,
		@Optional() private readonly bindings?: SkillBindingRepository,
		@Optional() private readonly files?: AgentFileService,
	) {}

	/**
	 * Build the descriptor list for one Agent run. Caller filters
	 * further based on which tools the LangChain tool-loop wrapper
	 * actually knows how to invoke.
	 *
	 * The `editsThisRunByFile` arg tracks which Agent files have
	 * already been edited inside this same run — used by the
	 * once-per-file-per-run cap on `editAgentFile` (security §7
	 * mitigation against tool-loop hammering).
	 */
	resolveAllowedTools(
		agent: Agent,
		runContext: { runId: string; editsThisRunByFile: Set<string> } = {
			runId: 'no-run',
			editsThisRunByFile: new Set(),
		},
	): AgentToolDescriptor[] {
		const tools: AgentToolDescriptor[] = [];

		// getSkillBody — auto-registered when at least one skill is bound.
		// Phase 10.3 ships the factory; the registration predicate is
		// applied by AgentRunService when assembling the prompt. Here
		// we always expose the descriptor when both repos are wired —
		// the model only sees it when bindings exist (AgentRunService
		// filters), and the descriptor itself errors on unbound slugs.
		if (this.skills && this.bindings) {
			tools.push(
				createGetSkillBodyTool(this.skills, this.bindings, {
					userId: agent.userId,
					agentId: agent.id,
					workId: agent.workId ?? undefined,
					missionId: agent.missionId ?? undefined,
					ideaId: agent.ideaId ?? undefined,
				}) as AgentToolDescriptor,
			);
		}

		// editAgentFile — gated by permissions.canEditAgentFiles.
		// 1 edit per file per run (frequency cap from security spec §7).
		if (agent.permissions?.canEditAgentFiles && this.files) {
			tools.push(this.buildEditAgentFileTool(agent, runContext));
		}

		// createSubAgent — gated by permissions.canCreateAgents.
		if (agent.permissions?.canCreateAgents) {
			tools.push(this.buildCreateSubAgentTool(agent));
		}

		// getActivity + getKbDocument — placeholders that document the
		// surface; real implementations land alongside the activity
		// log + KB document read surfaces wiring into this package.
		tools.push(this.buildGetActivityTool(agent));
		tools.push(this.buildGetKbDocumentTool(agent));

		return tools;
	}

	// ── tool builders ─────────────────────────────────────────────

	private buildEditAgentFileTool(
		agent: Agent,
		runContext: { runId: string; editsThisRunByFile: Set<string> },
	): AgentToolDescriptor<
		{ name: string; body: string; expectedHash?: string },
		{ newHash: string }
	> {
		return {
			name: 'editAgentFile',
			description:
				"Edit one of YOUR OWN definition files (SOUL.md / AGENTS.md / HEARTBEAT.md / TOOLS.md / agent.yml). Body is secret-scanned, 64 KB cap, once per file per run. Pass expectedHash for optimistic concurrency. NEVER edit another Agent's files.",
			parameters: {
				type: 'object',
				properties: {
					name: { type: 'string', description: 'One of SOUL.md / AGENTS.md / HEARTBEAT.md / TOOLS.md / agent.yml' },
					body: { type: 'string', description: 'Full new body of the file. ≤ 64 KB.' },
					expectedHash: {
						type: 'string',
						description: 'Optional content hash of the LAST version you read. Pass it for optimistic concurrency.',
					},
				},
				required: ['name', 'body'],
			},
			invoke: async (args) => {
				if (!args?.name || !args?.body) {
					return { error: 'name and body are required' };
				}
				const key = `${agent.id}:${args.name}`;
				if (runContext.editsThisRunByFile.has(key)) {
					return {
						error: `editAgentFile: file "${args.name}" was already edited once in this run (cap: 1 edit per file per run).`,
					};
				}
				try {
					const result = await this.files!.write({
						userId: agent.userId,
						agentId: agent.id,
						name: args.name as any,
						body: args.body,
						expectedHash: args.expectedHash,
					});
					runContext.editsThisRunByFile.add(key);
					return result;
				} catch (err) {
					return { error: err instanceof Error ? err.message : String(err) };
				}
			},
		};
	}

	private buildCreateSubAgentTool(
		actor: Agent,
	): AgentToolDescriptor<{ name: string; title?: string; capabilities?: string }, { id: string; slug: string }> {
		return {
			name: 'createSubAgent',
			description:
				'Spawn a new Agent inside YOUR scope. The sub-Agent is created in DRAFT status with ALL permissions FALSE — the user must activate it + grant capabilities manually. Returns the new Agent id + slug.',
			parameters: {
				type: 'object',
				properties: {
					name: { type: 'string', description: 'Human-readable name. The slug is derived from it.' },
					title: { type: 'string', description: 'Optional role line (e.g. "Frontend reviewer").' },
					capabilities: {
						type: 'string',
						description: 'Optional free-form capability summary.',
					},
				},
				required: ['name'],
			},
			invoke: async (args) => {
				if (!args?.name) return { error: 'name is required' };
				try {
					// Sub-Agent inherits actor's scope verbatim — Mission-
					// scoped Agent creates Mission-scoped sub-Agent on the
					// same Mission. permissions stay all-false per the spec
					// (security §6 — explicit grant required).
					const created = await this.agents.create({
						userId: actor.userId,
						scope: actor.scope,
						missionId: actor.scope === AgentScope.MISSION ? actor.missionId : null,
						ideaId: actor.scope === AgentScope.IDEA ? actor.ideaId : null,
						workId: actor.scope === AgentScope.WORK ? actor.workId : null,
						name: args.name,
						slug: slugify(args.name),
						title: args.title ?? null,
						capabilities: args.capabilities ?? null,
						aiProviderId: actor.aiProviderId ?? null,
						modelId: actor.modelId ?? null,
						maxSkillContextTokens: 4000,
						status: 'draft' as any,
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
						idleBehavior: actor.idleBehavior,
						pauseAfterFailures: 3,
						errorCount: 0,
						avatarMode: 'initials' as any,
						avatarIcon: null,
						avatarImageUploadId: null,
					});
					return { id: created.id, slug: created.slug };
				} catch (err) {
					return { error: err instanceof Error ? err.message : String(err) };
				}
			},
		};
	}

	private buildGetActivityTool(
		agent: Agent,
	): AgentToolDescriptor<{ since?: string; limit?: number }, { entries: unknown[] }> {
		return {
			name: 'getActivity',
			description:
				"Read recent activity-log rows for YOUR scope (last 30 days max). Useful when context wasn't injected by default and you need to look up what happened. Returns a compact JSON array.",
			parameters: {
				type: 'object',
				properties: {
					since: { type: 'string', description: 'ISO timestamp lower bound. Defaults to 24h ago.' },
					limit: { type: 'string', description: 'Max rows. Defaults to 50, capped at 200.' },
				},
				required: [],
			},
			invoke: async () => {
				// Phase 16 v1 — placeholder. Wires once ActivityLogService
				// exposes a scope-filterable findRecent() method that this
				// package can call without a circular import.
				void agent;
				return { entries: [] };
			},
		};
	}

	private buildGetKbDocumentTool(
		agent: Agent,
	): AgentToolDescriptor<{ slug: string }, { slug: string; body: string }> {
		return {
			name: 'getKbDocument',
			description:
				'Fetch the full body of a KB document by slug from a Mission/Work/Idea you have access to. Errors when the slug is not reachable from this Agent.',
			parameters: {
				type: 'object',
				properties: {
					slug: { type: 'string', description: 'KB document slug (lowercase-with-hyphens).' },
				},
				required: ['slug'],
			},
			invoke: async (args) => {
				void agent;
				if (!args?.slug) return { error: 'slug is required' };
				// Phase 16 v1 — placeholder. Wires once KB read surface
				// is reachable from this package (mirror approach for the
				// scope filter is the same as getActivity).
				return { error: `getKbDocument: not yet available in v1 — slug ${args.slug} unreachable.` };
			},
		};
	}
}

function slugify(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 80);
}
