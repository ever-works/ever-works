/**
 * Playbook catalogue (AW-21) — the wire and plugin contract for a
 * **Playbook**: a packaged outcome that names its trigger, its steps, the
 * connections it needs, what it produces and the exact moments it stops and
 * asks a human.
 *
 * Playbook definitions are catalogue data, not user data. They are supplied
 * by enabled `playbook-provider` plugins exactly as Skill catalogue entries
 * are supplied by `skills-provider` plugins, so this file carries no entity
 * and no schema — only the shape every provider must return and the pure
 * checks the platform applies to whatever a provider returns.
 *
 * Every connection a playbook declares names a CAPABILITY (`search`,
 * `email-outbound`), never a provider id. Which enabled plugin satisfies a
 * capability is resolved at read time through the plugin registry.
 */

import type { WorkflowGraph } from '../workflow/workflow-graph.types.js';

/** The four ways a playbook can be started. */
export const PLAYBOOK_TRIGGER_KINDS = ['schedule', 'inbound_trigger', 'event', 'manual'] as const;
export type PlaybookTriggerKind = (typeof PLAYBOOK_TRIGGER_KINDS)[number];

/** The five catalogue categories the Playbooks section filters by. */
export const PLAYBOOK_CATEGORIES = ['reporting', 'content', 'operations', 'research', 'inbox'] as const;
export type PlaybookCategory = (typeof PLAYBOOK_CATEGORIES)[number];

/**
 * Declared token cost of one run: `low` < 15k, `medium` 15k–60k, `high` > 60k.
 * A declaration by the playbook author — the real cost shows on the run receipt.
 */
export const PLAYBOOK_COST_BANDS = ['low', 'medium', 'high'] as const;
export type PlaybookCostBand = (typeof PLAYBOOK_COST_BANDS)[number];

/** The kinds of output a playbook may declare it produces. */
export const PLAYBOOK_ARTEFACT_KINDS = ['kb_document', 'mission', 'task', 'email_draft', 'run_receipt'] as const;
export type PlaybookArtefactKind = (typeof PLAYBOOK_ARTEFACT_KINDS)[number];

/** Which existing surface an escalation point becomes. */
export const PLAYBOOK_ESCALATION_TARGETS = ['approval', 'escalation'] as const;
export type PlaybookEscalationTarget = (typeof PLAYBOOK_ESCALATION_TARGETS)[number];

/** Approval postures, mirroring the Agent guardrail modes the platform enforces. */
export const PLAYBOOK_GUARDRAIL_MODES = ['require_approval', 'autonomous'] as const;
export type PlaybookGuardrailMode = (typeof PLAYBOOK_GUARDRAIL_MODES)[number];

/** A slug is lowercase, starts alphanumeric, and is at most 64 characters. */
export const PLAYBOOK_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** `MAJOR.MINOR.PATCH`, numeric only. */
export const PLAYBOOK_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;

/** Length caps applied to every catalogue string before it is rendered. */
export const PLAYBOOK_TEXT_LIMITS = {
	title: 120,
	outcome: 200,
	summary: 600,
	stepTitle: 120,
	stepProduces: 200,
	reason: 200,
	shortText: 200
} as const;

/** A playbook declares between 2 and 8 steps. */
export const PLAYBOOK_MIN_STEPS = 2;
export const PLAYBOOK_MAX_STEPS = 8;

/** A workspace may hold at most this many running adoptions. */
export const PLAYBOOK_ADOPTION_CEILING = 25;

/** A workspace may hold at most this many non-retired copies of one playbook. */
export const PLAYBOOK_COPY_LIMIT = 3;

/**
 * The approval posture a playbook applies or offers, structurally identical
 * to the Agent guardrails shape the platform already validates and enforces.
 * Kept here (rather than imported) because this package depends on nothing.
 */
export interface PlaybookGuardrails {
	readonly mode: PlaybookGuardrailMode;
	readonly autoApproveActionTypes?: readonly string[];
	readonly blockedActionTypes?: readonly string[];
}

export interface PlaybookStep {
	/** 1-based order. */
	readonly position: number;
	readonly title: string;
	/** One sentence: what this step produces. */
	readonly produces: string;
	readonly agentTemplateSlug?: string;
	/** True when this step stops for a human decision. */
	readonly requiresApproval: boolean;
	readonly prompt?: string;
}

export interface PlaybookConnectionNeed {
	/** A plugin capability name — never a provider id. */
	readonly capability: string;
	readonly required: boolean;
	/** One sentence: why the playbook needs it. */
	readonly reason: string;
	/** For optional connections: what degrades without it. */
	readonly degradedWithout?: string;
}

export interface PlaybookArtefact {
	readonly kind: PlaybookArtefactKind;
	readonly title: string;
	/** Where it lands, in words. */
	readonly where: string;
}

export interface PlaybookEscalationPoint {
	/** The condition that stops the playbook. */
	readonly when: string;
	readonly becomes: PlaybookEscalationTarget;
	readonly carriesRecommendation: boolean;
}

export interface PlaybookCaps {
	readonly maxPerRun?: number;
	readonly maxSourcesTracked?: number;
	readonly maxWordCount?: number;
	readonly maxDecisionsPerRun?: number;
}

export interface PlaybookTrigger {
	readonly kind: PlaybookTriggerKind;
	/** Cron-style cadence for `schedule` triggers. */
	readonly cadence?: string;
	/** `HH:MM`, in the workspace timezone, for `schedule` triggers. */
	readonly defaultLocalTime?: string;
	/** Human description of when it runs. */
	readonly description: string;
}

export interface PlaybookTaskTemplateProvision {
	readonly name: string;
	readonly slug: string;
}

/** What adopting the playbook would provision, through existing services only. */
export interface PlaybookProvision {
	/** One of the built-in Agent template slugs. */
	readonly agentTemplateSlug: string;
	/** The name the created Agent gets. */
	readonly agentName: string;
	readonly skillSlugs: readonly string[];
	/** The Task template built from the playbook's own `steps`. */
	readonly taskTemplate: PlaybookTaskTemplateProvision;
	/** Applied at adoption. Adoption always asks before acting, whatever this says. */
	readonly guardrailsAtAdoption: PlaybookGuardrails;
	/** Offered later, never applied at adoption. */
	readonly graduatedGuardrails?: PlaybookGuardrails;
	readonly workflowGraph?: WorkflowGraph;
}

export interface PlaybookTokenEstimate {
	readonly min: number;
	readonly max: number;
}

export interface PlaybookCatalogEntry {
	readonly slug: string;
	readonly title: string;
	readonly outcome: string;
	readonly summary: string;
	readonly category: PlaybookCategory;
	readonly version: string;
	/** A short icon key; the UI falls back to the category icon for unknown keys. */
	readonly icon: string;
	readonly trigger: PlaybookTrigger;
	readonly steps: readonly PlaybookStep[];
	readonly connections: readonly PlaybookConnectionNeed[];
	readonly artefacts: readonly PlaybookArtefact[];
	readonly escalations: readonly PlaybookEscalationPoint[];
	readonly caps: PlaybookCaps;
	readonly costBand: PlaybookCostBand;
	readonly estimatedTokensPerRun: PlaybookTokenEstimate;
	readonly tags: readonly string[];
	readonly provision: PlaybookProvision;
}

// ---------------------------------------------------------------------------
// Pure checks
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown, max: number): value is string {
	return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
	return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

function validateGuardrailsShape(value: unknown, path: string): string | null {
	if (!isRecord(value)) return `${path} must be an object`;
	if (!isOneOf(value.mode, PLAYBOOK_GUARDRAIL_MODES)) return `${path}.mode is not a known guardrail mode`;
	for (const key of ['autoApproveActionTypes', 'blockedActionTypes'] as const) {
		const list = value[key];
		if (list === undefined) continue;
		if (!Array.isArray(list) || list.some((item) => typeof item !== 'string')) {
			return `${path}.${key} must be a list of action types`;
		}
	}
	return null;
}

/**
 * Validate one catalogue entry and return the FIRST violation, or `null` when
 * the entry is well-formed. Never throws: a provider's malformed entry is a
 * value to drop, not an error to propagate.
 */
export function validatePlaybookEntry(value: unknown): string | null {
	if (!isRecord(value)) return 'entry must be an object';
	if (typeof value.slug !== 'string' || !PLAYBOOK_SLUG_PATTERN.test(value.slug)) {
		return 'slug must match ^[a-z0-9][a-z0-9-]{0,63}$';
	}
	if (!isNonEmptyString(value.title, PLAYBOOK_TEXT_LIMITS.title)) return 'title must be 1-120 characters';
	if (!isNonEmptyString(value.outcome, PLAYBOOK_TEXT_LIMITS.outcome)) return 'outcome must be 1-200 characters';
	if (typeof value.summary !== 'string' || value.summary.length > PLAYBOOK_TEXT_LIMITS.summary) {
		return 'summary must be at most 600 characters';
	}
	if (!isOneOf(value.category, PLAYBOOK_CATEGORIES)) return 'category is not a known category';
	if (typeof value.version !== 'string' || !PLAYBOOK_VERSION_PATTERN.test(value.version)) {
		return 'version must be MAJOR.MINOR.PATCH';
	}
	if (typeof value.icon !== 'string') return 'icon must be a string';
	if (!isOneOf(value.costBand, PLAYBOOK_COST_BANDS)) return 'costBand is not a known cost band';

	const estimate = value.estimatedTokensPerRun;
	if (
		!isRecord(estimate) ||
		typeof estimate.min !== 'number' ||
		typeof estimate.max !== 'number' ||
		estimate.min < 0 ||
		estimate.max < estimate.min
	) {
		return 'estimatedTokensPerRun must be { min, max } with 0 <= min <= max';
	}

	const trigger = value.trigger;
	if (!isRecord(trigger)) return 'trigger must be an object';
	if (!isOneOf(trigger.kind, PLAYBOOK_TRIGGER_KINDS)) return 'trigger.kind is not a known trigger kind';
	if (!isNonEmptyString(trigger.description, PLAYBOOK_TEXT_LIMITS.shortText)) {
		return 'trigger.description must be 1-200 characters';
	}

	const steps = value.steps;
	if (!Array.isArray(steps) || steps.length < PLAYBOOK_MIN_STEPS || steps.length > PLAYBOOK_MAX_STEPS) {
		return 'steps must hold between 2 and 8 steps';
	}
	for (const [index, step] of steps.entries()) {
		if (!isRecord(step)) return `steps[${index}] must be an object`;
		if (!isNonEmptyString(step.title, PLAYBOOK_TEXT_LIMITS.stepTitle)) {
			return `steps[${index}].title must be 1-120 characters`;
		}
		if (!isNonEmptyString(step.produces, PLAYBOOK_TEXT_LIMITS.stepProduces)) {
			return `steps[${index}].produces must be 1-200 characters`;
		}
		if (typeof step.requiresApproval !== 'boolean') return `steps[${index}].requiresApproval must be a boolean`;
	}

	const connections = value.connections;
	if (!Array.isArray(connections)) return 'connections must be a list';
	for (const [index, need] of connections.entries()) {
		if (!isRecord(need)) return `connections[${index}] must be an object`;
		if (!isNonEmptyString(need.capability, 64)) return `connections[${index}].capability must be a capability name`;
		if (typeof need.required !== 'boolean') return `connections[${index}].required must be a boolean`;
		if (!isNonEmptyString(need.reason, PLAYBOOK_TEXT_LIMITS.reason)) {
			return `connections[${index}].reason must be 1-200 characters`;
		}
	}

	const artefacts = value.artefacts;
	if (!Array.isArray(artefacts)) return 'artefacts must be a list';
	for (const [index, artefact] of artefacts.entries()) {
		if (!isRecord(artefact) || !isOneOf(artefact.kind, PLAYBOOK_ARTEFACT_KINDS)) {
			return `artefacts[${index}].kind is not a known artefact kind`;
		}
	}

	const escalations = value.escalations;
	if (!Array.isArray(escalations)) return 'escalations must be a list';
	for (const [index, point] of escalations.entries()) {
		if (!isRecord(point) || !isOneOf(point.becomes, PLAYBOOK_ESCALATION_TARGETS)) {
			return `escalations[${index}].becomes must be approval or escalation`;
		}
	}

	if (!isRecord(value.caps)) return 'caps must be an object';
	if (!Array.isArray(value.tags) || value.tags.some((tag) => typeof tag !== 'string')) {
		return 'tags must be a list of strings';
	}

	const provision = value.provision;
	if (!isRecord(provision)) return 'provision must be an object';
	if (!isNonEmptyString(provision.agentTemplateSlug, 64)) return 'provision.agentTemplateSlug is required';
	if (!isNonEmptyString(provision.agentName, PLAYBOOK_TEXT_LIMITS.shortText))
		return 'provision.agentName is required';
	if (!Array.isArray(provision.skillSlugs) || provision.skillSlugs.some((slug) => typeof slug !== 'string')) {
		return 'provision.skillSlugs must be a list of skill slugs';
	}
	if (
		!isRecord(provision.taskTemplate) ||
		!isNonEmptyString(provision.taskTemplate.name, PLAYBOOK_TEXT_LIMITS.title)
	) {
		return 'provision.taskTemplate.name is required';
	}
	const guardrailsError = validateGuardrailsShape(provision.guardrailsAtAdoption, 'provision.guardrailsAtAdoption');
	if (guardrailsError) return guardrailsError;
	if (provision.graduatedGuardrails !== undefined) {
		const graduatedError = validateGuardrailsShape(provision.graduatedGuardrails, 'provision.graduatedGuardrails');
		if (graduatedError) return graduatedError;
	}
	return null;
}

/**
 * Compare two `MAJOR.MINOR.PATCH` versions numerically (`1.10.0 > 1.9.0`).
 * A malformed version sorts below every well-formed one, so it can never
 * displace a valid entry.
 */
export function comparePlaybookVersions(a: string, b: string): -1 | 0 | 1 {
	const parse = (version: string): number[] | null => {
		const match = PLAYBOOK_VERSION_PATTERN.exec(version);
		return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
	};
	const left = parse(a);
	const right = parse(b);
	if (!left && !right) return 0;
	if (!left) return -1;
	if (!right) return 1;
	for (let i = 0; i < 3; i++) {
		if (left[i]! > right[i]!) return 1;
		if (left[i]! < right[i]!) return -1;
	}
	return 0;
}

/** A catalogue search needs at least this many characters. */
export const CATALOG_SEARCH_MIN_CHARS = 2;

/** The fields a catalogue card can be searched by, in ranking order. */
export interface CatalogSearchFields {
	readonly title: string;
	readonly tags?: readonly string[];
	readonly summary?: readonly string[];
	/** Lowest-ranked text, e.g. a playbook's step titles. */
	readonly extra?: readonly string[];
}

/**
 * Rank a catalogue card against a search: `0` title, `1` tag, `2` summary,
 * `3` other text, `null` no match. Case-insensitive substring matching. A
 * query shorter than {@link CATALOG_SEARCH_MIN_CHARS} matches everything.
 * One rule for the API's playbook search and the catalogue page's
 * cross-section search, so the two can never rank differently.
 */
export function catalogSearchRank(fields: CatalogSearchFields, query: string): number | null {
	const needle = query.trim().toLowerCase();
	if (needle.length < CATALOG_SEARCH_MIN_CHARS) return 0;
	const has = (value: string) => value.toLowerCase().includes(needle);
	if (has(fields.title)) return 0;
	if ((fields.tags ?? []).some(has)) return 1;
	if ((fields.summary ?? []).some(has)) return 2;
	if ((fields.extra ?? []).some(has)) return 3;
	return null;
}

/** The search fields of a playbook: title, tags, outcome + summary, then step titles. */
export function playbookSearchFields(entry: {
	readonly title: string;
	readonly tags: readonly string[];
	readonly outcome: string;
	readonly summary: string;
	readonly stepTitles: readonly string[];
}): CatalogSearchFields {
	return {
		title: entry.title,
		tags: entry.tags,
		summary: [entry.outcome, entry.summary],
		extra: entry.stepTitles
	};
}

const HTML_TAG_PATTERN = /<[^>]*>/g;

/** Strip HTML tags, trim, and cap a catalogue string at `max` characters. */
export function sanitizePlaybookText(value: string, max: number): string {
	return value.replace(HTML_TAG_PATTERN, '').trim().slice(0, max);
}

export type PlaybookEntryAcceptance =
	| { readonly entry: PlaybookCatalogEntry; readonly violation: null }
	| { readonly entry: null; readonly violation: string };

/**
 * The one gate every provider-supplied value passes through: sanitise first
 * (so an over-long title is truncated rather than rejected), then validate
 * the sanitised copy (so an invalid slug or structure is dropped). Never
 * throws.
 */
export function acceptPlaybookEntry(value: unknown): PlaybookEntryAcceptance {
	if (!isRecord(value)) return { entry: null, violation: 'entry must be an object' };
	let sanitized: PlaybookCatalogEntry;
	try {
		sanitized = sanitizePlaybookEntry(value as unknown as PlaybookCatalogEntry);
	} catch {
		return { entry: null, violation: validatePlaybookEntry(value) ?? 'entry is malformed' };
	}
	const violation = validatePlaybookEntry(sanitized);
	return violation ? { entry: null, violation } : { entry: sanitized, violation: null };
}

/**
 * Return a copy of an entry with every rendered string HTML-stripped and
 * length-capped. Applied to every entry whatever its source, so a provider
 * can never ship markup or an unbounded string to the page.
 */
export function sanitizePlaybookEntry(entry: PlaybookCatalogEntry): PlaybookCatalogEntry {
	const text = (value: string | undefined, max: number = PLAYBOOK_TEXT_LIMITS.shortText): string =>
		sanitizePlaybookText(value ?? '', max);
	const optionalText = (value: string | undefined): string | undefined =>
		value === undefined ? undefined : text(value);

	const trigger: PlaybookTrigger = {
		kind: entry.trigger.kind,
		description: text(entry.trigger.description)
	};
	if (entry.trigger.cadence !== undefined) Object.assign(trigger, { cadence: text(entry.trigger.cadence, 64) });
	if (entry.trigger.defaultLocalTime !== undefined) {
		Object.assign(trigger, { defaultLocalTime: text(entry.trigger.defaultLocalTime, 5) });
	}

	return {
		...entry,
		title: text(entry.title, PLAYBOOK_TEXT_LIMITS.title),
		outcome: text(entry.outcome, PLAYBOOK_TEXT_LIMITS.outcome),
		summary: text(entry.summary, PLAYBOOK_TEXT_LIMITS.summary),
		icon: text(entry.icon, 32),
		trigger,
		steps: entry.steps.map((step) => ({
			...step,
			title: text(step.title, PLAYBOOK_TEXT_LIMITS.stepTitle),
			produces: text(step.produces, PLAYBOOK_TEXT_LIMITS.stepProduces)
		})),
		connections: entry.connections.map((need) => {
			const sanitized: PlaybookConnectionNeed = {
				capability: text(need.capability, 64),
				required: need.required,
				reason: text(need.reason, PLAYBOOK_TEXT_LIMITS.reason)
			};
			const degraded = optionalText(need.degradedWithout);
			return degraded === undefined ? sanitized : { ...sanitized, degradedWithout: degraded };
		}),
		artefacts: entry.artefacts.map((artefact) => ({
			kind: artefact.kind,
			title: text(artefact.title),
			where: text(artefact.where)
		})),
		escalations: entry.escalations.map((point) => ({
			when: text(point.when),
			becomes: point.becomes,
			carriesRecommendation: point.carriesRecommendation
		})),
		tags: entry.tags.map((tag) => text(tag, 40)).filter((tag) => tag.length > 0),
		provision: {
			...entry.provision,
			agentName: text(entry.provision.agentName),
			taskTemplate: {
				name: text(entry.provision.taskTemplate.name, PLAYBOOK_TEXT_LIMITS.title),
				slug: text(entry.provision.taskTemplate.slug, 64)
			}
		}
	};
}
