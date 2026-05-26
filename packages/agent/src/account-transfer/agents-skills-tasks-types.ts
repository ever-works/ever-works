import type { AgentExportEnvelope } from '../agents/agent-export.service';

/**
 * Agents/Skills/Tasks PR #1017 — Phase 19 (ADR-008 v1 requirement).
 *
 * Account-transfer payload extensions for Agents / Skills / Tasks.
 * These types are ADDITIVE to the v1 `AccountExportPayload` — the
 * `AccountExportPayload.version` bumps to `2` when any of the new
 * arrays is non-empty (`profile`, `works`, `userPlugins` stay shaped
 * identically, so v1 readers can still parse v2 envelopes minus the
 * new tail).
 *
 * Per-Agent export envelope (`AgentExportEnvelope`) is re-used
 * verbatim from Phase 6a — the account-transfer flow just bundles
 * many of them. Same posture for Skills + Tasks (compact
 * representations defined here).
 */

export interface ExportedAgent extends AgentExportEnvelope {
	// Direct reuse — the per-Agent envelope already carries the
	// information account-transfer needs. No wrapping needed.
	__kind: 'agent';
}

export interface ExportedSkillBinding {
	targetType: 'agent' | 'work' | 'mission' | 'idea' | 'tenant';
	/** Resolved by slug on import — the source id is lost across tenants. */
	targetSlug: string | null;
	priority: number;
	injectIntoAgent: boolean;
	injectIntoGenerator: boolean;
}

export interface ExportedSkill {
	__kind: 'skill';
	ownerType: 'tenant' | 'mission' | 'idea' | 'work' | 'agent';
	/** Source-id resolution table — empty when the Skill is tenant-owned. */
	ownerSourceSlug: string | null;
	slug: string;
	title: string;
	description: string;
	frontmatter: Record<string, unknown>;
	instructionsMd: string;
	sourceCatalogSlug: string | null;
	sourceCatalogVersion: string | null;
	version: string;
	bindings: ExportedSkillBinding[];
}

export interface ExportedTaskChatMessage {
	authorType: 'user' | 'agent';
	authorIdentifier: string;
	body: string;
	createdAt: string;
}

export interface ExportedTask {
	__kind: 'task';
	slug: string;
	title: string;
	description: string | null;
	status: string;
	priority: string;
	labels: string[] | null;
	/** Scope identifiers carried as the source ids; importer maps to local. */
	missionSourceSlug: string | null;
	ideaSourceSlug: string | null;
	workSourceSlug: string | null;
	parentTaskSlug: string | null;
	isRecurring: boolean;
	recurrenceRule: string | null;
	recurrenceTimezone: string | null;
	recurrenceEndsAt: string | null;
	recurrenceMaxOccurrences: number | null;
	parentRecurringTaskSlug: string | null;
	assignees: Array<{ type: 'user' | 'agent'; identifier: string }>;
	reviewers: Array<{ type: 'user' | 'agent'; identifier: string }>;
	approvers: Array<{ type: 'user' | 'agent'; identifier: string }>;
	requireAllApprovers: boolean;
	createdAt: string;
	startedAt?: string | null;
	completedAt?: string | null;
	chat?: ExportedTaskChatMessage[];
}

/**
 * The v2 export payload tail. Existing `AccountExportPayload.data`
 * gets these three optional arrays added when the user opts into
 * including them. Empty arrays = v1-compatible payload (version
 * stays at 1; bumps to 2 only when any array has rows).
 */
export interface AccountExportV2Tail {
	agents?: ExportedAgent[];
	skills?: ExportedSkill[];
	tasks?: ExportedTask[];
}

/**
 * Per-feature toggles on the export/import options envelope. All
 * default `false` to preserve the v1 surface — the user opts into
 * the new payload sections on the /settings/import-export page.
 */
export interface AgentsSkillsTasksExportOptions {
	includeAgents?: boolean;
	includeSkills?: boolean;
	includeTasks?: boolean;
	/** When `true`, include task chat threads in the export. v1 default: false. */
	includeTaskChat?: boolean;
}

export interface AgentsSkillsTasksImportOptions {
	importAgents?: boolean;
	importSkills?: boolean;
	importTasks?: boolean;
	onConflictAgent?: 'skip' | 'overwrite' | 'rename';
	onConflictSkill?: 'skip' | 'overwrite' | 'rename';
	onConflictTask?: 'skip' | 'rename';
}
