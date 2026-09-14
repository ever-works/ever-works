/**
 * Skills shelf — readiness, tags and provenance contracts.
 *
 * A Skill can be completely inert and still look healthy: it may have no
 * binding, every binding may be muted, the workspace's tool grants may refuse
 * every tool it declares, or a connection or credential it relies on may never
 * have been set up. The shelf answers "will this actually be picked up on the
 * next run?" with exactly one state per Skill, and names the missing item by
 * its own identifier when something is missing.
 *
 * Shared by the agent package (which computes the verdict), the API (which
 * validates filters against these unions) and the web app (which renders the
 * badge), so the three can never disagree about the vocabulary.
 *
 * Pure data + pure functions only — no I/O, no framework imports.
 */

/**
 * The verdict persisted on a Skill.
 *
 * `unknown` means nothing has checked the Skill yet (every Skill starts there);
 * `check_failed` means a check ran and could not finish. The two are kept apart
 * so a Skill nobody has looked at never reads as a failure.
 */
export const SKILL_READINESS_STATES = [
	'ready',
	'needs_setup',
	'missing_requirements',
	'blocked_by_access',
	'unknown',
	'check_failed'
] as const;

export type SkillReadinessState = (typeof SKILL_READINESS_STATES)[number];

/**
 * What a card renders: the stored verdict widened by the two switches a person
 * controls (`disabled`, `needs_review`). Those two are derived at read time from
 * their own columns so they can never drift from the cached verdict.
 */
export const SKILL_CARD_STATES = [...SKILL_READINESS_STATES, 'disabled', 'needs_review'] as const;

export type SkillCardState = (typeof SKILL_CARD_STATES)[number];

/** Readiness filter values accepted by the shelf: any card state, or every state except `ready`. */
export const SKILL_READINESS_FILTERS = [...SKILL_CARD_STATES, 'attention'] as const;

export type SkillReadinessFilter = (typeof SKILL_READINESS_FILTERS)[number];

export const SKILL_REQUIREMENT_KINDS = ['tool', 'credential', 'connection', 'pluginSetting'] as const;

export type SkillRequirementKind = (typeof SKILL_REQUIREMENT_KINDS)[number];

export const SKILL_REQUIREMENT_STATUSES = ['met', 'missing', 'refused', 'unknown'] as const;

export type SkillRequirementStatus = (typeof SKILL_REQUIREMENT_STATUSES)[number];

/** Stable machine reasons; the web app maps each to translated copy. Never free prose. */
export const SKILL_REQUIREMENT_REASONS = [
	'notSet',
	'notConnected',
	'disabled',
	'refusedByGrants',
	'pluginNotEnabled',
	'settingMissing',
	'checkFailed'
] as const;

export type SkillRequirementReason = (typeof SKILL_REQUIREMENT_REASONS)[number];

/** Where a person goes to fix a requirement. The web app turns this into a route. */
export const SKILL_REQUIREMENT_FIX_SURFACES = ['credentials', 'connections', 'plugins', 'access'] as const;

export type SkillRequirementFixSurface = (typeof SKILL_REQUIREMENT_FIX_SURFACES)[number];

export interface SkillRequirement {
	kind: SkillRequirementKind;
	/** The identifier a person can act on: a tool name, a credential KEY, a connection name. Never a value. */
	id: string;
	status: SkillRequirementStatus;
	reason?: SkillRequirementReason;
	/** Deep-link hint. `ref` is an identifier (a connection name, an agent id), never a URL. */
	fixTarget?: { surface: SkillRequirementFixSurface; ref: string };
}

/**
 * A run dropped the Skill because every tool it declares was refused for that
 * run's agent. Kept on the cached verdict so a later check that did not cover
 * the agent cannot silently undo it.
 */
export interface SkillRunSuppression {
	agentId: string;
	/** Tool names only. */
	refusedTools: string[];
	/** ISO timestamp of the run that observed it. */
	suppressedAt: string;
}

export interface SkillReadinessDetail {
	/** At most {@link SKILL_READINESS_REQUIREMENTS_MAX} rows; `truncated` says more existed. */
	requirements: SkillRequirement[];
	truncated?: boolean;
	/** How many requirement rows were cut by the cap (0 when not truncated). */
	truncatedCount?: number;
	/** Bindings the Skill has. 0 means nothing will ever resolve it. */
	boundTargetCount: number;
	/** Bindings switched off for agent runs. */
	mutedBindingCount: number;
	/** The agents the verdict was computed against (at most {@link SKILL_READINESS_AGENTS_MAX}). */
	evaluatedForAgentIds: string[];
	/** ISO timestamp. */
	evaluatedAt: string;
	/**
	 * The agents a `blocked_by_access` applies to: every tool the Skill declares
	 * is refused for each of them. Absent when no agent is blocked.
	 */
	blockedForAgentIds?: string[];
	/** Run-time suppressions still in force (at most {@link SKILL_READINESS_AGENTS_MAX}). */
	runSuppressions?: SkillRunSuppression[];
}

/** Where a Skill came from. Derived from stored columns — never persisted. */
export const SKILL_PROVENANCES = ['firstParty', 'plugin', 'package', 'authored'] as const;

export type SkillProvenance = (typeof SKILL_PROVENANCES)[number];

export const SKILL_SHELF_SORTS = ['updated', 'name', 'attention'] as const;

export type SkillShelfSort = (typeof SKILL_SHELF_SORTS)[number];

/** `reviewState` value for a Skill an agent drafted and a person has not accepted. `null` means accepted. */
export const SKILL_REVIEW_STATE_PROPOSED = 'proposed' as const;

export type SkillReviewState = typeof SKILL_REVIEW_STATE_PROPOSED;

export const SKILL_TAG_MAX_LENGTH = 40;
export const SKILL_TAGS_PER_SKILL_MAX = 12;
export const SKILL_TAG_FACET_LIMIT = 200;
export const SKILL_TAG_CHIPS_SHOWN = 12;
export const SKILL_TAG_FILTER_MAX = 6;
export const SKILL_READINESS_TTL_MS = 3_600_000;
export const SKILL_READINESS_SWEEP_BATCH = 500;
export const SKILL_READINESS_SWEEP_PER_USER = 200;
export const SKILL_READINESS_REQUIREMENTS_MAX = 20;
export const SKILL_READINESS_AGENTS_MAX = 10;
/** Cron of the hourly readiness sweep — shared by every scheduler that fires it. */
export const SKILL_READINESS_SWEEP_CRON = '17 * * * *';
/** How long a run-time suppression holds for an agent that no later check covered. */
export const SKILL_READINESS_RUN_SUPPRESSION_TTL_MS = 86_400_000;
/** How many unchecked or stale Skills one shelf list request may re-check in the background. */
export const SKILL_READINESS_LIST_RECHECK_MAX = 5;
export const SKILL_CAPTURE_BODY_MAX_CHARS = 16_000;
export const SKILL_CAPTURE_BODY_MIN_CHARS = 200;
export const SKILL_CAPTURE_BUDGET_MS = 90_000;

/** A normalised tag: lower-case letters, digits and hyphens, starting with a letter or digit. */
export const SKILL_TAG_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function isSkillReadinessState(value: unknown): value is SkillReadinessState {
	return typeof value === 'string' && (SKILL_READINESS_STATES as readonly string[]).includes(value);
}

export function isSkillCardState(value: unknown): value is SkillCardState {
	return typeof value === 'string' && (SKILL_CARD_STATES as readonly string[]).includes(value);
}

/**
 * The one card state a Skill shows. `disabled` wins over `needs_review`, which
 * wins over the stored verdict. An unrecognised stored verdict reads as
 * `unknown` — never as `ready`.
 */
export function deriveSkillCardState(input: {
	readiness?: string | null;
	disabledAt?: Date | string | null;
	reviewState?: string | null;
}): SkillCardState {
	if (input.disabledAt) return 'disabled';
	if (input.reviewState === SKILL_REVIEW_STATE_PROPOSED) return 'needs_review';
	return isSkillReadinessState(input.readiness) ? input.readiness : 'unknown';
}

/** True for every card state that asks something of a person. */
export function skillCardStateNeedsAttention(state: SkillCardState): boolean {
	return state !== 'ready';
}

/** Normalise one raw tag. Returns `null` when nothing usable is left. */
export function normalizeSkillTag(raw: unknown): string | null {
	if (typeof raw !== 'string') return null;
	const cleaned = raw
		.trim()
		.toLowerCase()
		.replace(/\s+/g, '-')
		.replace(/[^a-z0-9-]/g, '')
		.replace(/-{2,}/g, '-')
		.replace(/^-+/, '')
		.slice(0, SKILL_TAG_MAX_LENGTH)
		.replace(/-+$/, '');
	return cleaned.length > 0 ? cleaned : null;
}

/**
 * Normalise a Skill's declared tags: trim, lower-case, whitespace to a single
 * hyphen, strip anything outside `[a-z0-9-]`, clamp to 40 characters, drop
 * empties, dedupe (first occurrence wins), and keep at most `max`. Tags past the
 * cap are reported in `dropped` so the write can say so.
 */
export function normalizeSkillTags(
	raw: unknown,
	max: number = SKILL_TAGS_PER_SKILL_MAX
): { tags: string[]; dropped: string[] } {
	if (!Array.isArray(raw)) return { tags: [], dropped: [] };
	const unique: string[] = [];
	const seen = new Set<string>();
	for (const entry of raw) {
		const tag = normalizeSkillTag(entry);
		if (!tag || seen.has(tag)) continue;
		seen.add(tag);
		unique.push(tag);
	}
	return { tags: unique.slice(0, max), dropped: unique.slice(max) };
}
