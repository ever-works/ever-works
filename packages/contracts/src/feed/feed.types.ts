/**
 * Live Feed — wire types for the narrated view of the activity log.
 *
 * The Live Feed is a reading surface over the `activity_log` rows Ever Works
 * already writes. It owns no store of its own: every entry below is one
 * existing activity record, projected into a line a person can read without
 * decoding an action token.
 *
 * The API returns STRUCTURE, never English. A narration is a message key plus
 * sanitized parameters, and a destination is a typed pointer, so the web
 * renders both through its own translations and route constants and any
 * other client (CLI, MCP) can do the same.
 */

/** The five buckets every entry classifies into. Derived, never stored. */
export type FeedKind = 'work' | 'decision' | 'delivery' | 'problem' | 'system';

/** Display order of the kind chips (keyboard `1`-`5` follows this order). */
export const FEED_KINDS: readonly FeedKind[] = ['work', 'decision', 'delivery', 'problem', 'system'];

/**
 * Who did the thing: an agent, the signed-in user, an external source
 * (a connector, a repository, a deployed site), or the platform itself.
 */
export type FeedActorKind = 'agent' | 'user' | 'external' | 'system';

export const FEED_ACTOR_KINDS: readonly FeedActorKind[] = ['agent', 'user', 'external', 'system'];

/** Default page size. */
export const FEED_PAGE_SIZE_DEFAULT = 30;

/** A page never holds more than this many entries. */
export const FEED_PAGE_SIZE_MAX = 50;

/** At most this many agents can be watched at once. */
export const FEED_MAX_AGENT_FILTER = 20;

/** How far back the feed reads. Older records stay on the Activity log. */
export const FEED_HISTORY_DAYS = 90;

/** Automatic paging stops after this many pages in one visit. */
export const FEED_MAX_AUTO_PAGES = 20;

/** Every interpolated narration value is truncated to this many characters. */
export const FEED_NARRATION_PARAM_MAX_CHARS = 120;

/** Default and maximum look-back window of the actor roster, in hours. */
export const FEED_ACTORS_WINDOW_HOURS_DEFAULT = 168;
export const FEED_ACTORS_WINDOW_HOURS_MAX = 720;

export interface FeedActorDto {
	kind: FeedActorKind;
	/** Set when `kind === 'agent'`. */
	agentId?: string | null;
	/**
	 * Display name. For an agent, the name captured when the record was
	 * written, else the agent's current name. `null` when no name is known,
	 * in which case the renderer uses its own label for the kind.
	 */
	label: string | null;
	/** An agent's avatar mode, when it still exists. */
	avatarMode?: string | null;
}

export interface FeedNarrationDto {
	/** A leaf key under the renderer's narration namespace, or `fallback`. */
	key: string;
	/** Sanitized values. Only fields allowed for the action type ever appear. */
	params: Record<string, string | number>;
}

/** What an entry can point at. */
export type FeedTargetType = 'run' | 'task' | 'mission' | 'idea' | 'agent' | 'work' | 'inbox' | 'skill';

export const FEED_TARGET_TYPES: readonly FeedTargetType[] = [
	'run',
	'task',
	'mission',
	'idea',
	'agent',
	'work',
	'inbox',
	'skill'
];

/**
 * The most specific thing an entry is about. `null` on the entry when there
 * is nothing to open (for example the agent was deleted), in which case the
 * entry renders as plain text rather than a dead link.
 */
export interface FeedTargetDto {
	type: FeedTargetType;
	id: string;
}

export interface FeedEntryDto {
	/** The activity record id. */
	id: string;
	/** ISO timestamp of when it happened. */
	createdAt: string;
	kind: FeedKind;
	/** The record's own status (`pending`, `in_progress`, `completed`, `failed`, `cancelled`). */
	status: string;
	/** The record's action type, for clients that want to group or count. */
	actionType: string;
	actor: FeedActorDto;
	narration: FeedNarrationDto;
	target: FeedTargetDto | null;
	workId?: string | null;
}

export interface FeedPageDto {
	/** Newest first. */
	items: FeedEntryDto[];
	/** Opaque cursor for the next older page, or `null` at the end. */
	nextCursor: string | null;
	hasMore: boolean;
	/** Oldest point the feed reads back to (ISO). Paging stops here. */
	historyFloor: string;
	/** Populated once per-user seen state is available. */
	unseenCount?: number;
	lastSeenAt?: string | null;
}

export interface FeedActorSummaryDto {
	agentId: string;
	label: string;
	/** The agent's current status (`active`, `running`, `paused`, ...). */
	status: string;
	avatarMode?: string | null;
	/** Entries attributed to the agent inside the requested window. */
	count: number;
	/** ISO timestamp of the agent's newest entry in the window, if any. */
	lastActivityAt: string | null;
}

export interface FeedActorsDto {
	actors: FeedActorSummaryDto[];
	windowHours: number;
}

/** Computed while-you-were-away payload. Never stored. */
export interface FeedAwaySummaryDto {
	awayForMs: number;
	windowStart: string;
	windowEnd: string;
	truncatedToWindow: boolean;
	truncatedToScanCap: boolean;
	total: number;
	byKind: Record<FeedKind, number>;
	topActors: FeedActorSummaryDto[];
	otherActorCount: number;
	decisionsWaiting: number;
	failures: number;
	narrative?: { text: string; model: string; tokens: number } | null;
}

/** Stable error codes the feed endpoints answer with. */
export type FeedErrorCode = 'invalid-cursor' | 'too-many-agents';
