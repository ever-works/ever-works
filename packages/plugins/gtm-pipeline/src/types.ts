/**
 * Go-to-Market pipeline — stage ids and stage data contracts.
 *
 * The stage set mirrors the roadmap's go-to-market stage list:
 * research → qualify → draft → review → act → follow-up → enrich → measure.
 *
 * Every stage declares its input/output keys (`requires`/`provides` on the
 * step definitions) so stage handoffs stay explicit and auditable. The
 * `review` stage is the human gate placed BEFORE any outbound action —
 * the pipeline's default posture is drafts-not-sends.
 */

export const GTM_STAGE_IDS = [
	'research',
	'qualify',
	'draft',
	'review',
	'act',
	'follow-up',
	'enrich',
	'measure'
] as const;

export type GtmStageId = (typeof GTM_STAGE_IDS)[number];

/**
 * Declared stage data keys — the vocabulary used by `provides`/`requires`
 * on the stage definitions AND by the context's `hasStageResult`.
 */
export const GTM_STAGE_DATA_KEYS = [
	'contacts',
	'signals',
	'scored_contacts',
	'drafts',
	'approved_drafts',
	'action_log',
	'follow_up_queue',
	'enriched_contacts',
	'campaign_report'
] as const;

export type GtmStageDataKey = (typeof GTM_STAGE_DATA_KEYS)[number];

// ============================================================================
// Stage IO data shapes
// ============================================================================

/** A lead/contact candidate collected by the `research` stage. */
export interface GtmContact {
	/** Display name (person or business). */
	readonly name: string;
	readonly email?: string | null;
	readonly company?: string | null;
	readonly title?: string | null;
	/** Where this contact came from (seed list, signal, referral, …). */
	readonly source?: string | null;
	readonly notes?: string | null;
}

/** A market/news signal collected by the `research` stage. */
export interface GtmSignal {
	readonly query: string;
	readonly title: string;
	readonly url: string;
	readonly publishedDate?: string | null;
}

/** Output of the `qualify` stage — deterministic-first scoring. */
export interface GtmScoredContact extends GtmContact {
	/** Priority score 0–100 (higher = better fit). */
	readonly score: number;
	readonly scoreReasons: readonly string[];
	/** Risk score 0–10 (higher = riskier; ≥ threshold is excluded). */
	readonly riskScore: number;
	readonly riskReasons: readonly string[];
}

/** A personalized outbound draft produced by the `draft` stage. */
export interface GtmDraft {
	/** Stable reference used by review approvals and the action log. */
	readonly ref: string;
	/** Contact display name this draft targets (empty for broadcast content). */
	readonly contactName: string;
	readonly channel: string;
	readonly subject?: string | null;
	readonly body: string;
}

/** An entry in the `act` stage's action log. NEVER 'sent' — drafts-not-sends. */
export interface GtmActionRecord {
	readonly draftRef: string;
	readonly channel: string;
	/** 'prepared' = staged for a connector/human to deliver; 'skipped' = not actioned. */
	readonly status: 'prepared' | 'skipped';
	readonly reason?: string | null;
	readonly preparedAt: number;
}

/** A timed re-engagement item produced by the `follow-up` stage. */
export interface GtmFollowUpItem {
	readonly draftRef: string;
	readonly channel: string;
	/** Days after preparation when a quiet thread should be re-engaged. */
	readonly dueAfterDays: number;
	readonly rationale: string;
}

/** Report compiled by the `measure` stage — closes the loop into the next draft cycle. */
export interface GtmCampaignReport {
	readonly summary: string;
	readonly totals: {
		readonly contacts: number;
		readonly qualified: number;
		readonly excluded: number;
		readonly drafts: number;
		readonly approved: number;
		readonly prepared: number;
		readonly followUpsQueued: number;
	};
	readonly insights: readonly string[];
	/** Hints for the next draft cycle's variants (measure → draft loop). */
	readonly nextVariantHints: readonly string[];
}
