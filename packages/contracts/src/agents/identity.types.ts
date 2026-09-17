/**
 * Agent identity card (AW-23 P1) — the composed read model behind the one
 * panel that answers "who is this agent, what is it doing, and why is it
 * not working?" without a click.
 *
 * It is a READ MODEL, not an entity: everything here is assembled per
 * request from the agent row, its persisted halt reason, its in-flight run
 * and its open decisions. Nothing new is stored.
 *
 * Zero-dependency value types only.
 */

import type { AgentStatusDto } from './status.types.js';

/** Longest pause note we store and render. The dialog counts against it. */
export const AGENT_HALT_NOTE_MAX = 200;

/** How many parked runs one Resume releases before it stops for the next tick. */
export const AGENT_RESUME_PROMOTION_BUDGET = 50;

/** Default page size of the "held while paused" panel. */
export const AGENT_HELD_WORK_PAGE_SIZE = 20;

/** Why an agent is not working, as persisted on the agent row. */
export const AGENT_HALT_REASONS = ['user', 'credential', 'failures', 'cap', 'platform'] as const;

export type AgentHaltReasonCode = (typeof AGENT_HALT_REASONS)[number];

/**
 * What kind of thing refused the agent. Coarse on purpose — the precise
 * identity of a provider belongs to the plugin that owns it, and a halt
 * detail must never branch on a plugin id.
 */
export type AgentHaltSubjectKind = 'model-provider' | 'tool' | 'repository' | 'other';

/**
 * Non-secret descriptor of what refused the agent.
 *
 * 🛑 Display names only. No credential, no token fragment, no raw provider
 * error body ever enters this object — it is rendered on the card, written
 * to the activity feed and returned by the API.
 */
export interface AgentHaltDetailDto {
	/** Human display name resolved through the existing facade — never a plugin id. */
	subjectLabel?: string;
	subjectKind?: AgentHaltSubjectKind;
}

/**
 * The agent's declared autonomy tier, as it appears on the card.
 *
 * P1 ships the SHAPE with `value: null` for every agent, because no agent
 * has a level yet: the four-rung ladder, its defaults table and its preview
 * are AW-23 P2. `value` is deliberately typed `string | null` until then so
 * P2 can narrow it to its own closed union in one place without a second
 * summary type appearing here.
 */
export interface AgentIdentityLevelDto {
	value: string | null;
	/** Settings that differ from the level's defaults. Always `0` until P2. */
	driftCount: number;
	/** Promotion readiness. Always `null` until P2; no agent is ever promoted automatically. */
	readiness: null;
}

/** The in-flight run the card's "Working on" row points at. */
export interface AgentWorkingOnDto {
	runId: string;
	activity: string | null;
	startedAt: string;
}

/** One parked item in the "held while paused" panel. */
export interface AgentHeldWorkItemDto {
	runId: string;
	/** Which path the held work arrived on. */
	kind: 'task' | 'chat' | 'email' | 'other';
	title: string | null;
	heldAt: string;
}

export interface AgentHeldWorkDto {
	total: number;
	items: AgentHeldWorkItemDto[];
}

/**
 * Everything the identity card paints, in ONE response — the card may not
 * fan out to a second endpoint for its first paint.
 */
export interface AgentIdentityDto {
	agent: {
		id: string;
		name: string;
		slug: string;
		title: string | null;
		status: string;
		avatarMode: string;
		avatarIcon: string | null;
	};
	status: AgentStatusDto;
	level: AgentIdentityLevelDto;
	/**
	 * First lines of the agent's own durable notes.
	 *
	 * P1 renders the row and its empty state. The notes FILE — its storage,
	 * its every-run load, its budget and its revision history — belongs to
	 * the memory-and-context-files work, and this epic adds no second notes
	 * mechanism: the preview arrives through the optional
	 * `AGENT_NOTES_PREVIEW` port, and reads `null` while nothing is bound.
	 */
	notesPreview: string | null;
	/** First lines of the agent's Personality file. `null` until AW-23 P3 adds the file. */
	personalityPreview: string | null;
	workingOn: AgentWorkingOnDto | null;
	/** Next scheduled heartbeat. `null` when the agent has no cadence. */
	nextRunAt: string | null;
}
