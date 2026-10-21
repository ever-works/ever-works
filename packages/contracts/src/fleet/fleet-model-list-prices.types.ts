import type { FleetUsageProvider, FleetUsageTokens } from './fleet-usage.types.js';

/**
 * Usage & cost on the fleet (FL-20, CONTRACTS R-30) — the shape of the
 * versioned per-model LIST-price table (`MODEL_LIST_PRICES`): what the same
 * tokens would cost on a pay-as-you-go key, per million tokens, for the four
 * token classes. Read-only in the product; the agent package publishes the
 * versions (`model-list-pricebook.ts`).
 *
 * The credit price list of AW-17 (keyed by `capability.operation`) is a
 * different thing and is untouched by this one.
 */

/** The four token classes a list price is quoted for. */
export type ModelTokenClass = keyof FleetUsageTokens;

export const MODEL_TOKEN_CLASSES: readonly ModelTokenClass[] = ['in', 'out', 'cacheRead', 'cacheWrite'];

export interface ModelListPriceEntry {
	/** The family id the surfaces name (`claude-sonnet-4-5`, `gpt-5-codex`). */
	model: string;
	provider: FleetUsageProvider;
	/**
	 * Model ids this entry prices: an id matches when it EQUALS one of these, or
	 * is one of these followed by a RELEASE suffix only — a date (`-20250929`,
	 * `-2025-08-07`), `-latest`, an `@…` pin or a `[…]` context tag. So
	 * `claude-sonnet-4-5-20250929` matches `claude-sonnet-4-5`, while
	 * `claude-opus-4-6` does NOT match `claude-opus-4` (a newer model is never
	 * priced as an older one by guess) and `gpt-50` never matches `gpt-5`.
	 * The LONGEST match across the table wins.
	 */
	match: readonly string[];
	/**
	 * US dollars per million tokens. A zero rate is a real rate (the provider
	 * does not charge that class — e.g. a cache write on a provider that bills
	 * none); a class the provider charges is never zero.
	 */
	perMillionUsd: Readonly<FleetUsageTokens>;
}

export interface ModelListPriceListVersion {
	/** Ascending integer; every stored figure carries the version it used (FR-7). */
	version: number;
	/** When this version took effect (ISO date). */
	effectiveFrom: string;
	entries: readonly ModelListPriceEntry[];
}

/** One priced amount: fractional cents (summed before rounding) and the version that priced it. */
export interface ModelListPricing {
	cents: number;
	version: number;
	model: string;
}

/** What may follow a listed id and still be the same model: a release date, `-latest`, a pin or a context tag. */
const RELEASE_SUFFIX = /^(?:-\d{8}|-\d{4}-\d{2}-\d{2}|-latest|@\S*|\[[^\]]*\])(?:@\S*|\[[^\]]*\])?$/;

/** The entry an id matches in one version (longest match wins), or null — never a guess. */
export function findModelListPriceEntry(
	version: ModelListPriceListVersion,
	modelId: string
): ModelListPriceEntry | null {
	const id = modelId.trim().toLowerCase();
	if (!id) return null;
	let best: ModelListPriceEntry | null = null;
	let bestLength = -1;
	for (const entry of version.entries) {
		for (const candidate of entry.match) {
			const key = candidate.toLowerCase();
			const hit = id === key || (id.startsWith(key) && RELEASE_SUFFIX.test(id.slice(key.length)));
			if (hit && key.length > bestLength) {
				best = entry;
				bestLength = key.length;
			}
		}
	}
	return best;
}

/** Fractional cents for `tokens` at `entry`'s rates (dollars per million → cents). */
export function priceModelTokensCents(tokens: FleetUsageTokens, entry: ModelListPriceEntry): number {
	const rates = entry.perMillionUsd;
	const dollars =
		(tokens.in * rates.in +
			tokens.out * rates.out +
			tokens.cacheRead * rates.cacheRead +
			tokens.cacheWrite * rates.cacheWrite) /
		1_000_000;
	return dollars * 100;
}
