/**
 * Memory facts — the atomic tier of Memory.
 *
 * ## What a fact is
 *
 * One durable statement an owner wants every agent to carry into future
 * runs: a decision, a preference, a constraint, a person. Before this tier
 * existed Memory held documents, uploads, meetings and provider sessions,
 * but never an individual fact — so "I told it this last week" had no row
 * to point at, nothing to correct and nothing to forget.
 *
 * ## Why these values live here
 *
 * The API validates against them, the web composer counts characters against
 * them, and the chat capture tool describes them to the model. Three copies
 * of `500` is how a fact that the composer accepts gets refused by the API.
 * Every number in this file exists exactly once in the repository.
 *
 * ## Status lifecycle
 *
 * `proposed → active` (accept) · `proposed → forgotten` (discard) ·
 * `active → forgotten` (forget) · `forgotten → active` (restore, inside the
 * retention window) · `forgotten → purged` (the nightly sweep; terminal).
 *
 * "Forget", not "delete", is the verb: the memory capability contract in
 * `@ever-works/plugin` already calls its delete-one-record operation the
 * "forget me" operation, so the word is already ours.
 */

/** Every status a fact can hold. Ordered for reading, not for walking. */
export const MEMORY_FACT_STATUSES = ['proposed', 'active', 'forgotten'] as const;
export type MemoryFactStatus = (typeof MEMORY_FACT_STATUSES)[number];

/**
 * Where a fact came from. A human's own write (`user`) lands `active`;
 * everything an agent writes lands `proposed` until a human accepts it.
 */
export const MEMORY_FACT_ORIGINS = ['user', 'agent', 'consolidation', 'import'] as const;
export type MemoryFactOrigin = (typeof MEMORY_FACT_ORIGINS)[number];

/**
 * `workspace` reaches every agent in the workspace (the default); `agent`
 * reaches exactly one. There is deliberately no third scope.
 */
export const MEMORY_FACT_SCOPES = ['workspace', 'agent'] as const;
export type MemoryFactScope = (typeof MEMORY_FACT_SCOPES)[number];

/** Inclusive upper bound on a fact body, counted after trimming. */
export const MEMORY_FACT_BODY_MAX = 500;
/** Most active facts one workspace may hold. The next write is refused. */
export const MEMORY_FACT_ACTIVE_MAX = 2000;
/** Most proposals awaiting review. Further proposals are dropped, not queued. */
export const MEMORY_FACT_PROPOSED_MAX = 200;
/** Most pinned facts per workspace. Pinned facts ride along on every run. */
export const MEMORY_FACT_PINNED_MAX = 20;
/** Most facts recalled into one run (pinned facts come on top of this). */
export const MEMORY_FACT_RECALL_TOP_K = 8;
/** Cosine similarity a fact must reach to be recalled into a run. */
export const MEMORY_FACT_RECALL_MIN_SCORE = 0.72;
/** Most results one Facts search returns. */
export const MEMORY_FACT_SEARCH_TOP_K = 50;
/** Cosine similarity a meaning-based search hit must reach to be listed. */
export const MEMORY_FACT_SEARCH_MIN_SCORE = 0.55;
/** Token cap on the facts block a run receives. */
export const MEMORY_FACT_RECALL_MAX_TOKENS = 1200;
/** Days a forgotten fact stays restorable before the sweep purges it. */
export const MEMORY_FACT_FORGET_RETENTION_DAYS = 30;
/** Most facts one sweep pass embeds or re-embeds. */
export const MEMORY_FACT_SWEEP_BATCH_MAX = 500;
/** Page size cap for the Facts list. */
export const MEMORY_FACT_LIST_LIMIT_MAX = 50;
/** The literal a caller must type to forget every fact at once. */
export const MEMORY_FACT_FORGET_ALL_CONFIRMATION = 'FORGET ALL';

/**
 * Map a cosine similarity onto the `normalizedScore` scale of the
 * vector-store capability.
 *
 * The capability contract makes `normalizedScore ∈ [0, 1]` the ONLY score a
 * consumer may compare, and both vector stores the platform ships normalise
 * cosine as `(1 + cos) / 2` — so the spec's cosine thresholds have to be
 * translated before they can be applied to a hit. Thresholding the raw
 * number instead would turn `0.55` into "cosine ≥ 0.1", which lists
 * practically every fact.
 */
export function cosineToNormalizedScore(cosine: number): number {
	if (!Number.isFinite(cosine)) return 0;
	const clamped = Math.max(-1, Math.min(1, cosine));
	return (1 + clamped) / 2;
}

/** Inverse of {@link cosineToNormalizedScore}, clamped to `[0, 1]` for display. */
export function normalizedScoreToCosine(normalized: number): number {
	if (!Number.isFinite(normalized)) return 0;
	return Math.max(0, Math.min(1, normalized * 2 - 1));
}

/** Narrowing guard for a status arriving from a query string or a column. */
export function isMemoryFactStatus(value: unknown): value is MemoryFactStatus {
	return typeof value === 'string' && (MEMORY_FACT_STATUSES as readonly string[]).includes(value);
}

/** Narrowing guard for a scope arriving from a request body. */
export function isMemoryFactScope(value: unknown): value is MemoryFactScope {
	return typeof value === 'string' && (MEMORY_FACT_SCOPES as readonly string[]).includes(value);
}

/** One fact as the API projects it. Dates are ISO strings on the wire. */
export interface MemoryFactDto {
	id: string;
	body: string;
	status: MemoryFactStatus;
	origin: MemoryFactOrigin;
	scope: MemoryFactScope;
	/** Set iff `scope === 'agent'`. */
	agentId: string | null;
	pinned: boolean;
	/** The run that produced the fact, when an agent wrote it. */
	sourceRunId: string | null;
	/** The conversation the fact was captured from, when there was one. */
	sourceConversationId: string | null;
	/** The agent that proposed the fact, when one did. */
	sourceAgentId: string | null;
	recallCount: number;
	lastRecalledAt: string | null;
	/** When the fact was forgotten; the retention clock starts here. */
	forgottenAt: string | null;
	/** Last day a forgotten fact can still be restored. */
	restorableUntil: string | null;
	/** Whether the fact has a vector in the workspace's vector store. */
	embedded: boolean;
	/**
	 * Relevance on the cosine scale, `[0, 1]`, present only on results of a
	 * meaning-based search. A literal-only hit carries `null`.
	 */
	score: number | null;
	/** True when a search listed this fact because its text contains the query. */
	literalMatch: boolean;
	createdAt: string;
	updatedAt: string;
}

/** Counts per status plus the pinned count, for the rail and the filters. */
export interface MemoryFactCounts {
	proposed: number;
	active: number;
	forgotten: number;
	pinned: number;
}

/** `GET /api/memory/facts` response. */
export interface MemoryFactListDto {
	facts: MemoryFactDto[];
	/** Total rows matching the filter (ignores paging). */
	total: number;
	counts: MemoryFactCounts;
	/** Opaque cursor for the next page; absent on the last page and on search. */
	nextCursor?: string;
	/**
	 * `true` when the listing used meaning-based matching. `false` on a
	 * search means the UI must show the "matching by exact words" note.
	 */
	semantic: boolean;
}

/** `GET /api/memory/facts/stats` response. */
export interface MemoryFactStatsDto extends MemoryFactCounts {
	capacity: number;
	pinnedCapacity: number;
	proposedCapacity: number;
	/** Whether meaning-based search is available right now. */
	semantic: boolean;
}

/** `POST /api/memory/facts/:id/forget` response. */
export interface MemoryFactForgetResultDto {
	id: string;
	status: 'forgotten';
	restorableUntil: string;
}

/** `POST /api/memory/facts/forget-all` response. */
export interface MemoryFactForgetAllResultDto {
	forgotten: number;
}
