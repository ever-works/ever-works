/**
 * Shared Knowledge Base classification + scope types.
 *
 * Mirrors the corresponding enums in
 * `@ever-works/agent/entities/kb-types.ts` but lives in the contracts
 * package so it can be consumed by Web / CLI / MCP without dragging in
 * NestJS or TypeORM.
 *
 * Keep in sync with the agent-side enums — when a value is added there,
 * add it here too. The agent's runtime enums are the source of truth;
 * these are the wire-format mirror.
 */

export const KB_DOCUMENT_CLASSES = [
	'brand',
	'legal',
	'seo',
	'style',
	'glossary',
	'competitors',
	'personas',
	'research',
	'output',
	'freeform',
	'decision'
] as const;

export type KbDocumentClass = (typeof KB_DOCUMENT_CLASSES)[number];

/**
 * Lifecycle status of a `decision`-class KB document (memory upgrades
 * M4). Transitions are platform-side only — an API call flips the
 * status transactionally, validated against the status machine:
 *
 *   proposed → accepted | archived
 *   accepted → superseded | archived
 *   superseded → archived
 *   archived → (terminal)
 *
 * `superseded` / `archived` decisions are "historical": excluded from
 * default context injection and labelled as historical when directly
 * retrieved. See the agent-side `KB_DECISION_STATUS_TRANSITIONS`.
 */
export const KB_DECISION_STATUSES = ['proposed', 'accepted', 'superseded', 'archived'] as const;
export type KbDecisionStatus = (typeof KB_DECISION_STATUSES)[number];

/**
 * Review state of a KB document (memory upgrades M7). Agent-authored
 * and consolidation-synthesized documents land as `proposed` and are
 * excluded from context injection until a human accepts them. `null` /
 * absent (all human-authored docs, plus every pre-existing row) is
 * treated as `accepted`.
 */
export const KB_REVIEW_STATES = ['proposed', 'accepted'] as const;
export type KbReviewState = (typeof KB_REVIEW_STATES)[number];

/**
 * Classes that may be authored at the organization level and inherited
 * (with Work-level override) by every Work in the org.
 *
 * v1: legal + style + seo only. Brand identity stays per-Work always.
 */
export const KB_ORG_INHERITABLE_CLASSES = ['legal', 'style', 'seo'] as const satisfies ReadonlyArray<KbDocumentClass>;

export type KbInheritableClass = (typeof KB_ORG_INHERITABLE_CLASSES)[number];

/**
 * Lifecycle status of a KB document.
 */
export const KB_DOCUMENT_STATUSES = ['draft', 'active', 'archived'] as const;
export type KbDocumentStatus = (typeof KB_DOCUMENT_STATUSES)[number];

/**
 * Lock mode for a KB document. `null` when unlocked.
 */
export const KB_LOCK_MODES = ['full', 'additions-only'] as const;
export type KbLockMode = (typeof KB_LOCK_MODES)[number];

/**
 * Source attribution.
 */
export const KB_DOCUMENT_SOURCES = ['user', 'agent', 'imported', 'seeded'] as const;
export type KbDocumentSource = (typeof KB_DOCUMENT_SOURCES)[number];

/**
 * Upload extraction lifecycle.
 */
export const KB_UPLOAD_EXTRACTION_STATUSES = ['pending', 'running', 'succeeded', 'failed', 'skipped'] as const;
export type KbUploadExtractionStatus = (typeof KB_UPLOAD_EXTRACTION_STATUSES)[number];

/**
 * Polymorphic consumer of a KB citation row.
 */
export const KB_CITATION_CONSUMER_TYPES = [
	'agent-run',
	'generation-history',
	'conversation-message',
	'community-pr',
	'comparison'
] as const;
export type KbCitationConsumerType = (typeof KB_CITATION_CONSUMER_TYPES)[number];

/**
 * Per-class org-level inheritance mode.
 */
export type KbInheritanceMode = 'inherit' | 'override' | 'disabled';
