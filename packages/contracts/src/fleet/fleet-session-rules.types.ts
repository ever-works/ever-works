/**
 * Fleet — the screen rules files (FL-05 P2, spec FR-33 … FR-36, plan §4.3).
 *
 * For prompts no hook reports — a Codex approval, an older CLI, a trust
 * prompt — the node reads the terminal's OWN screen: a data-driven rules file
 * per agent provider, with rules over three regions (the live screen, the
 * lower-cased tail, the terminal title). Each rule names the state it raises
 * (and the reason, the options and the keys that answer them) and carries a
 * `why` — the rule is data, and its reason for existing is part of it.
 *
 * A rule may raise `needs_you` (permission · question · blocked), `working`,
 * or a weak `idle` — **never `done`** (a screen cannot prove a turn finished;
 * FR-34). Rules ship inside the node package only (spec §8b default): a stale
 * rule is fixed by a node release, nothing behaviour-changing is fetched at
 * runtime. {@link validateFleetSessionRulesFile} runs at node start and names
 * the rule id of the first problem (FR-36).
 */

export const FLEET_SESSION_RULE_REGIONS = ['screen', 'tail', 'title'] as const;

/** `screen` — the last 40 lines as shown; `tail` — the last 10, lower-cased; `title` — the terminal title. */
export type FleetSessionRuleRegion = (typeof FLEET_SESSION_RULE_REGIONS)[number];

export const FLEET_SESSION_RULE_STATES = ['needs_you', 'working', 'idle'] as const;

/** What a rule may raise. `done` is deliberately absent (FR-34). */
export type FleetSessionRuleState = (typeof FLEET_SESSION_RULE_STATES)[number];

export const FLEET_SESSION_RULE_REASONS = ['permission', 'question', 'blocked'] as const;

export type FleetSessionRuleReason = (typeof FLEET_SESSION_RULE_REASONS)[number];

/** One option a rule offers, and the keys the node types to choose it (FR-35). */
export interface FleetSessionRuleOption {
	id: string;
	label: string;
	/** What the node types — e.g. `y\r`, `2\r`, `\u001b`. Never leaves the node. */
	keys: string;
	primary?: boolean;
	deny?: boolean;
}

export interface FleetSessionRule {
	/** Stable id (`codex.exec-approval`): named in counters, evidence and validation errors. */
	id: string;
	when: {
		region: FleetSessionRuleRegion;
		/** A regular expression source, matched against the region. */
		match: string;
		/** Only `i` is allowed. */
		flags?: string;
		/** The screen must have matched for this long before the rule fires (debounce). */
		quietMs?: number;
	};
	then: {
		state: FleetSessionRuleState;
		reason?: FleetSessionRuleReason;
		/** The options the CLI shows for this prompt, with their keys. */
		options?: FleetSessionRuleOption[];
		/** Free text answers (typed, then Enter) are accepted. */
		allowsText?: boolean;
		/** What the card shows: the matched line (default) or a fixed sentence. */
		prompt?: string;
	};
	/** Why this rule exists — required (FR-33). */
	why: string;
}

export interface FleetSessionRulesFile {
	version: 1;
	/** `claude-code` · `codex` · `shell` · `other:<id>`. */
	provider: string;
	/** Strings that must appear somewhere on screen for ANY rule of this file to run (cheap pre-filter). */
	anchors?: string[];
	rules: FleetSessionRule[];
}

export type FleetSessionRulesValidation =
	| { ok: true; file: FleetSessionRulesFile }
	| { ok: false; ruleId: string | null; problem: string };

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate a rules file (FR-36): every rule has an id, a region, a regular
 * expression that compiles with no flag but `i`, a state that is not `done`,
 * a reason when it raises `needs_you`, options with ids and keys, and a
 * `why`. The first problem is answered with its rule id.
 */
export function validateFleetSessionRulesFile(value: unknown): FleetSessionRulesValidation {
	if (!isRecord(value)) return { ok: false, ruleId: null, problem: 'not an object' };
	if (value.version !== 1) return { ok: false, ruleId: null, problem: 'version must be 1' };
	if (typeof value.provider !== 'string' || value.provider.length === 0)
		return { ok: false, ruleId: null, problem: 'provider is required' };
	if (
		value.anchors !== undefined &&
		(!Array.isArray(value.anchors) || value.anchors.some((a) => typeof a !== 'string'))
	)
		return { ok: false, ruleId: null, problem: 'anchors must be strings' };
	if (!Array.isArray(value.rules)) return { ok: false, ruleId: null, problem: 'rules must be a list' };
	const seen = new Set<string>();
	for (const raw of value.rules) {
		if (!isRecord(raw)) return { ok: false, ruleId: null, problem: 'a rule is not an object' };
		const id = typeof raw.id === 'string' ? raw.id : null;
		if (!id || !ID_PATTERN.test(id)) return { ok: false, ruleId: id, problem: 'a rule needs an id' };
		if (seen.has(id)) return { ok: false, ruleId: id, problem: 'duplicate rule id' };
		seen.add(id);
		if (typeof raw.why !== 'string' || raw.why.trim().length < 3)
			return { ok: false, ruleId: id, problem: 'every rule says why it exists' };
		const when = raw.when;
		if (!isRecord(when)) return { ok: false, ruleId: id, problem: 'when is required' };
		if (!(FLEET_SESSION_RULE_REGIONS as readonly string[]).includes(when.region as string))
			return { ok: false, ruleId: id, problem: 'unknown region' };
		if (typeof when.match !== 'string' || when.match.length === 0 || when.match.length > 500)
			return { ok: false, ruleId: id, problem: 'match is required' };
		if (when.flags !== undefined && when.flags !== 'i' && when.flags !== '')
			return { ok: false, ruleId: id, problem: "only the 'i' flag is allowed" };
		try {
			new RegExp(when.match, typeof when.flags === 'string' ? when.flags : '');
		} catch {
			return { ok: false, ruleId: id, problem: 'match does not compile' };
		}
		if (
			when.quietMs !== undefined &&
			(typeof when.quietMs !== 'number' || when.quietMs < 0 || when.quietMs > 60_000)
		)
			return { ok: false, ruleId: id, problem: 'quietMs is 0–60 000' };
		const then = raw.then;
		if (!isRecord(then)) return { ok: false, ruleId: id, problem: 'then is required' };
		if (then.state === 'done') return { ok: false, ruleId: id, problem: 'no rule may raise done' };
		if (!(FLEET_SESSION_RULE_STATES as readonly string[]).includes(then.state as string))
			return { ok: false, ruleId: id, problem: 'unknown state' };
		if (
			then.state === 'needs_you' &&
			!(FLEET_SESSION_RULE_REASONS as readonly string[]).includes(then.reason as string)
		)
			return { ok: false, ruleId: id, problem: 'needs_you needs a reason' };
		if (then.options !== undefined) {
			if (!Array.isArray(then.options) || then.options.length > 9)
				return { ok: false, ruleId: id, problem: 'options is a list of at most 9' };
			const optionIds = new Set<string>();
			for (const option of then.options) {
				if (
					!isRecord(option) ||
					typeof option.id !== 'string' ||
					!/^[A-Za-z0-9._-]{1,64}$/.test(option.id) ||
					typeof option.label !== 'string' ||
					typeof option.keys !== 'string' ||
					option.keys.length === 0 ||
					option.keys.length > 16
				)
					return { ok: false, ruleId: id, problem: 'an option needs an id, a label and keys' };
				if (optionIds.has(option.id)) return { ok: false, ruleId: id, problem: 'duplicate option id' };
				optionIds.add(option.id);
			}
		}
	}
	return { ok: true, file: value as unknown as FleetSessionRulesFile };
}
