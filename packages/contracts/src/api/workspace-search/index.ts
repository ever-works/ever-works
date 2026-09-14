/**
 * AW-01 — wire-types for the workspace-wide search behind the dashboard
 * command palette (`GET /api/workspace-search`).
 *
 * Deliberately a different word from the existing `/api/search`, which means
 * "search the web through the configured search plugin". The two surfaces
 * never share a path, a controller or a type.
 */

/**
 * Every record kind the palette can return. The first ten ship with the live
 * fan-out; the remaining kinds are reserved so a later index-backed read can
 * add them without a wire change.
 */
export const WORKSPACE_SEARCH_KINDS = [
	'mission',
	'task',
	'agent',
	'work',
	'idea',
	'skill',
	'team',
	'knowledge',
	'run',
	'decision',
	'memory',
	'goal',
	'meeting',
	'node',
	'connection'
] as const;

export type WorkspaceSearchKind = (typeof WORKSPACE_SEARCH_KINDS)[number];

/** How a hit matched the query — the band that produced its base score. */
export type WorkspaceSearchMatchReason =
	| 'exact'
	| 'prefix'
	| 'wordPrefix'
	| 'contains'
	| 'identifier'
	| 'secondary'
	| 'fuzzy';

/** Shortest trimmed query the server answers; shorter queries return no groups. */
export const WORKSPACE_SEARCH_MIN_QUERY_LENGTH = 2;
/** Longest query the server matches; longer input is truncated, not rejected. */
export const WORKSPACE_SEARCH_MAX_QUERY_LENGTH = 128;
/** Hard ceiling on rows across all groups in one response. */
export const WORKSPACE_SEARCH_MAX_TOTAL = 60;
/** Default rows per group when no filter is applied. */
export const WORKSPACE_SEARCH_DEFAULT_PER_KIND = 5;
/** Hard ceiling on rows for one group, reached when a group filter is applied. */
export const WORKSPACE_SEARCH_MAX_PER_KIND = 25;
/** How many recently opened records a client may send to boost ranking. */
export const WORKSPACE_SEARCH_MAX_RECENT = 12;

export interface WorkspaceSearchHit {
	/** `${kind}:${sourceId}` — a stable client key. */
	id: string;
	kind: WorkspaceSearchKind;
	sourceId: string;
	title: string;
	/** Breadcrumb, path, identifier or owner. */
	subtitle: string | null;
	/** Raw status value of the source record (rendered as a badge). */
	statusLabel: string | null;
	/** Locale-agnostic dashboard route the row opens. */
	destination: string;
	/** Deterministic 0..100. */
	score: number;
	matchReason: WorkspaceSearchMatchReason;
	/** ISO 8601. */
	updatedAt: string | null;
}

export interface WorkspaceSearchGroup {
	kind: WorkspaceSearchKind;
	/** Matches before the per-group cap — drives the "Show all" row. */
	total: number;
	hits: WorkspaceSearchHit[];
}

export interface WorkspaceSearchResponse {
	query: string;
	groups: WorkspaceSearchGroup[];
	/** Kinds whose source failed; the client renders a partial-results notice. */
	degradedKinds: WorkspaceSearchKind[];
	servedBy: 'index' | 'fanout' | 'mixed';
	tookMs: number;
}
