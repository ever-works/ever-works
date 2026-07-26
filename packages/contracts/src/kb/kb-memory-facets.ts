/**
 * Memory facets + health wire types (memory upgrades M9–M11 and the
 * Memory facets feature).
 *
 * Lives in `@ever-works/contracts` so Web / CLI / MCP can render the
 * badges, filter chips and health panel without importing NestJS or
 * TypeORM. The agent package owns the runtime enums; these are the
 * wire-format mirror, same convention as `kb-document-class.ts`.
 */

import type { KbDocumentSource } from './kb-document-class.js';

/**
 * Provenance badge rendered next to a memory / KB document.
 *
 * DERIVED, never stored — the badge is a pure function of the existing
 * `source` column plus the ingest provenance the event-ingest spine
 * already stamps into `metadata.provenance`. Nothing new is persisted,
 * so every pre-existing row gets a correct badge with no backfill.
 *
 * `human`       — authored by a person (`source: 'user'` / `'seeded'`, or absent)
 * `agent`       — written by an agent run (`source: 'agent'`)
 * `synthesized` — merged by the consolidation pass out of several documents
 * `connector`   — arrived from outside the platform: an ingested connector
 *                 event (Slack / GitHub / Linear / Notion / Zoom / …) or an
 *                 explicit import (`source: 'imported'`)
 */
export const KB_MEMORY_SOURCE_BADGES = ['human', 'agent', 'synthesized', 'connector'] as const;

export type KbMemorySourceBadge = (typeof KB_MEMORY_SOURCE_BADGES)[number];

/**
 * Path prefix the consolidation pass uses for the documents it merges
 * out of a near-duplicate cluster
 * (`MemoryConsolidationService.synthesisPath`). Kept here so the badge
 * derivation and the service agree on one literal.
 */
export const KB_SYNTHESIS_PATH_PREFIX = 'memory/synthesis-';

/** Tag the consolidation pass attaches to every synthesized document. */
export const KB_SYNTHESIS_TAG = 'synthesis';

/** The subset of a document the badge derivation needs. */
export interface KbMemorySourceBadgeInput {
	source?: KbDocumentSource | string | null;
	path?: string | null;
	tags?: ReadonlyArray<string> | null;
	/**
	 * Document metadata. Only `metadata.provenance.source` is read — the
	 * shape the event-ingest spine writes for connector-derived memory.
	 */
	metadata?: Record<string, unknown> | null;
}

/**
 * Read the connector name an ingested event left on the document, if
 * any. `metadata.provenance.source` is the field
 * `EventIngestService.provenance()` stamps (e.g. `'slack'`,
 * `'github'`); anything else returns `null`.
 */
export function readKbConnectorSource(input: KbMemorySourceBadgeInput): string | null {
	const provenance = (input.metadata as { provenance?: unknown } | null | undefined)?.provenance;
	if (!provenance || typeof provenance !== 'object') return null;
	const source = (provenance as { source?: unknown }).source;
	if (typeof source !== 'string') return null;
	const trimmed = source.trim();
	return trimmed.length > 0 ? trimmed : null;
}

/**
 * Derive the provenance badge for a document. Deterministic, total, and
 * ordered most-specific-first:
 *
 *  1. ingest provenance present → `connector` (it came off a connector
 *     event regardless of which writer materialized the row),
 *  2. `source: 'imported'` → `connector` (came from outside too),
 *  3. `source: 'agent'` + a synthesis marker (tag or path) → `synthesized`,
 *  4. `source: 'agent'` → `agent`,
 *  5. everything else (`user`, `seeded`, unknown, absent) → `human`.
 */
export function deriveKbMemorySourceBadge(input: KbMemorySourceBadgeInput): KbMemorySourceBadge {
	if (readKbConnectorSource(input) !== null) return 'connector';
	if (input.source === 'imported') return 'connector';
	if (input.source === 'agent') {
		const tagged = (input.tags ?? []).some((tag) => tag === KB_SYNTHESIS_TAG);
		const pathed = (input.path ?? '').startsWith(KB_SYNTHESIS_PATH_PREFIX);
		return tagged || pathed ? 'synthesized' : 'agent';
	}
	return 'human';
}

/**
 * How often the `memory-consolidation-tick` cron runs a given
 * organization's consolidation pass. Per-org configurable (founder
 * configurability rule); `weekly` is the default.
 */
export const KB_MEMORY_CONSOLIDATION_CADENCES = ['daily', 'weekly', 'monthly'] as const;
export type KbMemoryConsolidationCadence = (typeof KB_MEMORY_CONSOLIDATION_CADENCES)[number];

/**
 * What the scheduled pass is allowed to do.
 *
 * `dry-run` (DEFAULT) — compute the report, persist nothing at all.
 * `propose`           — run the pass with `apply: true`. Synthesized
 *                       documents land as `reviewState: 'proposed'`
 *                       (excluded from context injection until a human
 *                       accepts them in the review queue) and duplicates
 *                       are MARKED superseded, never deleted. Nothing is
 *                       ever auto-accepted.
 */
export const KB_MEMORY_CONSOLIDATION_MODES = ['dry-run', 'propose'] as const;
export type KbMemoryConsolidationMode = (typeof KB_MEMORY_CONSOLIDATION_MODES)[number];

export const KB_MEMORY_CONSOLIDATION_DEFAULT_CADENCE: KbMemoryConsolidationCadence = 'weekly';
export const KB_MEMORY_CONSOLIDATION_DEFAULT_MODE: KbMemoryConsolidationMode = 'dry-run';

/**
 * Per-organization consolidation-cadence settings, persisted on
 * `organizations.memory_consolidation` (nullable simple-json).
 *
 * `null` / absent ⇒ the cadence is OFF for that organization. Opt-in by
 * construction: the cron only ever touches organizations that
 * explicitly set `enabled: true`.
 */
export interface KbMemoryConsolidationSettings {
	/** Master switch. Absent / false ⇒ the tick skips this org entirely. */
	enabled?: boolean;
	/** How often the pass runs. Default `weekly`. */
	cadence?: KbMemoryConsolidationCadence;
	/** What the pass may persist. Default `dry-run`. */
	mode?: KbMemoryConsolidationMode;
	/** Send the report as an in-app notification. Default `true`. */
	notify?: boolean;
	/** ISO timestamp of the last scheduled pass (written by the tick). */
	lastRunAt?: string | null;
}

/** Interval in whole days for each cadence. */
export const KB_MEMORY_CONSOLIDATION_INTERVAL_DAYS: Readonly<Record<KbMemoryConsolidationCadence, number>> = {
	daily: 1,
	weekly: 7,
	monthly: 30
};

// ─── Health metrics (M10) ────────────────────────────────────────────

/** One retrieval gap: a query the Knowledge Base could not answer. */
export interface KbMemoryGapTopic {
	/** The query text, capped and trimmed at write time. */
	query: string;
	/** How many times that query returned nothing in the window. */
	occurrences: number;
	/** ISO timestamp of the most recent occurrence. */
	lastSeenAt: string;
}

/** One document that was injected into prompts but never cited back. */
export interface KbMemoryUncitedDoc {
	documentId: string;
	title: string;
	/** How many times it was retrieved in the window. */
	retrievals: number;
}

/**
 * Memory health for one organization over a rolling window.
 *
 * Every rate is `number | null`: `null` means "not measurable yet"
 * (no observations in the window) and MUST render as an explanation,
 * never as `0%` — the loud-empty rule that the recall-injection path
 * already follows.
 */
export interface KbMemoryHealth {
	/** Rolling window the metrics were computed over. */
	windowDays: number;
	/** ISO timestamp the metrics were computed at. */
	computedAt: string;

	/**
	 * Share of retrieval events whose injected documents were later
	 * cited by a consumer (agent run, generation, conversation, …).
	 * `null` when no retrieval events were logged in the window, or when
	 * no citation signal exists at all (see `citationSignal`).
	 */
	recallHitRate: number | null;
	/** Retrieval events logged in the window. */
	retrievalEvents: number;
	/** Distinct documents injected in the window. */
	documentsRetrieved: number;
	/** Distinct documents injected AND cited afterwards. */
	documentsCited: number;
	/**
	 * False when the platform recorded zero citation rows in the window
	 * — the recall-hit rate is then unknowable rather than 0%.
	 */
	citationSignal: boolean;
	/** Injected-but-never-cited documents, worst first (bounded list). */
	uncitedDocs: KbMemoryUncitedDoc[];

	/**
	 * Share of accepted `decision` documents that have not been touched
	 * for `staleAfterDays`. `null` when the org has no accepted decisions.
	 */
	staleDecisionRate: number | null;
	/** Accepted decisions considered. */
	decisionsAccepted: number;
	/** Accepted decisions older than `staleAfterDays`. */
	decisionsStale: number;
	/** Age threshold (days) at which an untouched decision counts stale. */
	staleAfterDays: number;

	/** Documents currently sitting in the review queue. */
	proposedBacklog: number;
	/** Age in whole days of the OLDEST proposed document (`null` if none). */
	proposedOldestAgeDays: number | null;
	/** Mean age in whole days across the backlog (`null` if none). */
	proposedAverageAgeDays: number | null;

	/** Queries that returned nothing — the synthesis gap list (M11). */
	gapTopics: KbMemoryGapTopic[];
	/** Retrieval events in the window that returned zero documents. */
	zeroResultRetrievals: number;
}

/** One row of the deterministic "Ask why" retrieval trail (M11). */
export interface KbRetrievalTrailEntry {
	/** ISO timestamp of the retrieval. */
	at: string;
	/** The query that pulled this document in (`null` for always-injected). */
	query: string | null;
	/** How many documents that retrieval returned in total. */
	resultCount: number;
	/** Which surface asked (`pipeline`, `pr-review`, `agent-run`, …). */
	consumerKind: string | null;
}

/**
 * "Ask why" payload for one document — deterministic retrieval history,
 * zero LLM. Answers "what made this document part of the answer?".
 */
export interface KbRetrievalTrail {
	documentId: string;
	/** Retrieval events that injected this document, newest first. */
	entries: KbRetrievalTrailEntry[];
	/** Total retrievals in the window (may exceed `entries.length`). */
	totalRetrievals: number;
	/** Citation rows recorded against this document. */
	citations: number;
	/** Window (days) the trail was gathered over. */
	windowDays: number;
}
