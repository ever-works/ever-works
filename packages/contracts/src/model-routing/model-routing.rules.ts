import {
	DEFAULT_REASONING_EFFORT,
	MODEL_ROUTING_LIMITS,
	type ModelAccountHealth,
	type ModelChainEntry,
	type ModelPolicyFieldSource,
	type ModelSelection,
	type ReasoningEffort,
	type ResolvedModelPolicy
} from './model-routing.types.js';

/**
 * Model accounts and the model ladder (AW-16) — the pure rules, shared so the
 * server that enforces them and the screen that explains them cannot disagree.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** The stored fields health is derived from. */
export interface ModelAccountHealthInput {
	health: ModelAccountHealth;
	enabled: boolean;
	credentialExpiresAt: Date | string | null | undefined;
}

function toTime(value: Date | string | null | undefined): number | null {
	if (value === null || value === undefined) return null;
	const time = value instanceof Date ? value.getTime() : Date.parse(value);
	return Number.isFinite(time) ? time : null;
}

/**
 * The health an account should be shown and routed with right now.
 *
 * - A paused account is `paused`, whatever it was before.
 * - A known expiry that has passed is `expired`.
 * - A rejection (`invalid`) is kept until someone reconnects.
 * - A known expiry within 14 days turns a usable account `expiring` — still
 *   fully usable, just announced.
 */
export function effectiveModelAccountHealth(
	input: ModelAccountHealthInput,
	now: Date = new Date()
): ModelAccountHealth {
	if (!input.enabled) return 'paused';
	if (input.health === 'invalid') return 'invalid';
	const expiresAt = toTime(input.credentialExpiresAt);
	if (expiresAt !== null) {
		if (expiresAt <= now.getTime()) return 'expired';
		if (expiresAt - now.getTime() <= MODEL_ROUTING_LIMITS.expiringWithinDays * DAY_MS) {
			return 'expiring';
		}
	}
	if (input.health === 'paused' || input.health === 'expiring' || input.health === 'expired') {
		// A stored state the current inputs no longer justify (resumed, or the
		// expiry was cleared by a reconnect) reads as unknown until the next check.
		return 'unknown';
	}
	return input.health;
}

/** True when an account may be used for a call. */
export function isModelAccountUsable(input: ModelAccountHealthInput, now: Date = new Date()): boolean {
	const health = effectiveModelAccountHealth(input, now);
	return health === 'working' || health === 'expiring' || health === 'unknown';
}

/** Whole days until a known expiry (0 on the day, negative once past), or null. */
export function daysUntilModelAccountExpiry(
	credentialExpiresAt: Date | string | null | undefined,
	now: Date = new Date()
): number | null {
	const expiresAt = toTime(credentialExpiresAt);
	if (expiresAt === null) return null;
	return Math.floor((expiresAt - now.getTime()) / DAY_MS);
}

/**
 * True when an account belongs on the dashboard banner: rejected, expired, or
 * expiring within three days.
 */
export function modelAccountNeedsBanner(input: ModelAccountHealthInput, now: Date = new Date()): boolean {
	const health = effectiveModelAccountHealth(input, now);
	if (health === 'invalid' || health === 'expired') return true;
	if (health !== 'expiring') return false;
	const days = daysUntilModelAccountExpiry(input.credentialExpiresAt, now);
	return days !== null && days < MODEL_ROUTING_LIMITS.bannerWithinDays;
}

function sameEntry(
	a: Pick<ModelChainEntry, 'providerPluginId' | 'modelId'>,
	b: ModelSelection | ModelChainEntry
): boolean {
	return a.providerPluginId === b.providerPluginId && a.modelId === b.modelId;
}

export interface SanitizedFallbackChain {
	chain: ModelChainEntry[];
	/** Entries removed because they were the primary itself. */
	removedPrimary: ModelChainEntry[];
	/** Entries removed because they repeated an earlier entry. */
	removedDuplicates: ModelChainEntry[];
	/** Entries dropped because the chain exceeded its length limit. */
	removedOverflow: ModelChainEntry[];
}

/**
 * A fallback list never offers the primary as its own fallback, never names the
 * same model twice, and never exceeds three entries. Order is kept.
 */
export function sanitizeFallbackChain(
	primary: ModelSelection | null | undefined,
	fallbacks: readonly ModelChainEntry[] | null | undefined
): SanitizedFallbackChain {
	const result: SanitizedFallbackChain = {
		chain: [],
		removedPrimary: [],
		removedDuplicates: [],
		removedOverflow: []
	};
	for (const entry of fallbacks ?? []) {
		if (primary && primary.providerPluginId && primary.modelId && sameEntry(entry, primary)) {
			result.removedPrimary.push(entry);
			continue;
		}
		if (result.chain.some((kept) => sameEntry(kept, entry))) {
			result.removedDuplicates.push(entry);
			continue;
		}
		if (result.chain.length >= MODEL_ROUTING_LIMITS.fallbackEntriesPerPolicy) {
			result.removedOverflow.push(entry);
			continue;
		}
		result.chain.push(entry);
	}
	return result;
}

/** One scope's contribution to the ladder. `null`/`undefined` = inherit. */
export interface ModelPolicyLevel {
	primaryModel?: ModelSelection | null;
	fallbackModels?: ModelChainEntry[] | null;
	reasoningEffort?: ReasoningEffort | null;
	runTimeoutSeconds?: number | null;
	attemptTimeoutSeconds?: number | null;
}

export interface ModelPolicyLadder {
	schedule?: ModelPolicyLevel | null;
	agent?: ModelPolicyLevel | null;
	workspace?: ModelPolicyLevel | null;
}

function hasSelection(selection: ModelSelection | null | undefined): selection is ModelSelection {
	return !!selection && (!!selection.providerPluginId || !!selection.modelId);
}

function pick<T>(
	ladder: ModelPolicyLadder,
	read: (level: ModelPolicyLevel) => T | null | undefined,
	accept: (value: T | null | undefined) => value is T,
	fallback: T,
	levels: ReadonlyArray<Exclude<ModelPolicyFieldSource, 'default'>>
): { value: T; source: ModelPolicyFieldSource } {
	for (const source of levels) {
		const level = ladder[source];
		if (!level) continue;
		const value = read(level);
		if (accept(value)) return { value, source };
	}
	return { value: fallback, source: 'default' };
}

const isNumber = (value: number | null | undefined): value is number => typeof value === 'number';
const isEffort = (value: ReasoningEffort | null | undefined): value is ReasoningEffort => typeof value === 'string';
const isChain = (value: ModelChainEntry[] | null | undefined): value is ModelChainEntry[] => Array.isArray(value);

/**
 * Narrowest wins, field by field: schedule, then Agent, then workspace, then
 * the default. A schedule that sets only the model still inherits the effort
 * and the timeout. The run timeout has no Agent level.
 */
export function resolveModelPolicyLadder(ladder: ModelPolicyLadder): ResolvedModelPolicy {
	const all = ['schedule', 'agent', 'workspace'] as const;
	const primary = pick<ModelSelection | null>(
		ladder,
		(level) => level.primaryModel,
		(value): value is ModelSelection => hasSelection(value),
		null,
		all
	);
	const fallbacks = pick<ModelChainEntry[]>(ladder, (level) => level.fallbackModels, isChain, [], all);
	return {
		primaryModel: primary,
		fallbackModels: {
			value: sanitizeFallbackChain(primary.value, fallbacks.value).chain,
			source: fallbacks.source
		},
		reasoningEffort: pick(ladder, (level) => level.reasoningEffort, isEffort, DEFAULT_REASONING_EFFORT, all),
		runTimeoutSeconds: pick(
			ladder,
			(level) => level.runTimeoutSeconds,
			isNumber,
			MODEL_ROUTING_LIMITS.runTimeoutSeconds.default,
			['schedule', 'workspace']
		),
		attemptTimeoutSeconds: pick(
			ladder,
			(level) => level.attemptTimeoutSeconds,
			isNumber,
			MODEL_ROUTING_LIMITS.attemptTimeoutSeconds.default,
			all
		)
	};
}

/** The synthetic key a schedule row carries: `${source}:${ownerId}`. */
export function parseModelPolicyScheduleKey(
	key: string | null | undefined
): { source: string; ownerId: string } | null {
	if (!key) return null;
	const separator = key.indexOf(':');
	if (separator <= 0 || separator === key.length - 1) return null;
	return { source: key.slice(0, separator), ownerId: key.slice(separator + 1) };
}
