/**
 * Safety rails (AW-24) — the four-rung trust ladder, as a value type.
 *
 * A rung answers one question about one kind of work: what happens when an
 * Agent tries to do it?
 *
 *   off   — refused. Nothing is prepared and nothing is queued.
 *   draft — prepared, held verbatim, and carried on a decision for a person.
 *   ask   — held. A decision states what will happen, with its parameters.
 *   auto  — proceeds, subject to every other rail.
 *
 * Everything here is pure and dependency-free so the same comparison runs in
 * the API, the agent tool loop, the worker and the web UI — the ladder must
 * mean the same thing on every surface or it is not a safety property.
 *
 * The ORDER is the whole type. `TRUST_RUNG_ORDER` is ascending in autonomy,
 * so "a lower scope may only narrow" is `minRung`, "one rung at a time" is a
 * ±1 index step, and a ceiling is an upper bound on the index. No code
 * anywhere re-derives that ordering from an `if` ladder.
 */

/** One of exactly four rungs. The list is closed; adding to it is a spec change. */
export type TrustRung = 'off' | 'draft' | 'ask' | 'auto';

/**
 * Ascending in autonomy: index 0 grants the least, index 3 the most.
 *
 * Every rule in the epic is expressed against this array rather than against
 * control flow, so the product, the API and the docs cannot drift (NFR-10).
 */
export const TRUST_RUNG_ORDER: readonly TrustRung[] = Object.freeze([
	'off',
	'draft',
	'ask',
	'auto'
] as readonly TrustRung[]);

/** Narrowing type guard for unknown input (DTO bodies, stored rows, imports). */
export function isTrustRung(value: unknown): value is TrustRung {
	return typeof value === 'string' && (TRUST_RUNG_ORDER as readonly string[]).includes(value);
}

/**
 * Position in {@link TRUST_RUNG_ORDER}. An unknown value answers `-1` rather
 * than throwing: a row carrying a rung this build does not know about must
 * not be able to crash a read path, and `-1` sorts below `off`, which is the
 * fail-closed reading.
 */
export function rungIndex(rung: TrustRung): number {
	return TRUST_RUNG_ORDER.indexOf(rung);
}

/**
 * Standard comparator semantics: negative when `a` grants less than `b`,
 * zero when equal, positive when `a` grants more.
 */
export function compareRung(a: TrustRung, b: TrustRung): number {
	return rungIndex(a) - rungIndex(b);
}

/** The stricter of two rungs — the narrow-only merge, in one function. */
export function minRung(a: TrustRung, b: TrustRung): TrustRung {
	return compareRung(a, b) <= 0 ? a : b;
}

/** The more permissive of two rungs. Used only to describe, never to grant. */
export function maxRung(a: TrustRung, b: TrustRung): TrustRung {
	return compareRung(a, b) >= 0 ? a : b;
}

/**
 * The single rung a promotion from `current` is allowed to reach (FR-32),
 * or `null` when `current` is already the top of the ladder.
 *
 * `draftable` is the category's own answer to "is Draft offered here?"
 * (FR-8). Where it is not, the ladder is `off → ask → auto` and Draft is
 * skipped — which is why this takes the flag rather than assuming the
 * four-step walk.
 */
export function nextRungUp(current: TrustRung, draftable: boolean): TrustRung | null {
	const offered = draftable ? TRUST_RUNG_ORDER : TRUST_RUNG_ORDER.filter((r) => r !== 'draft');
	const at = offered.indexOf(current);
	if (at < 0 || at >= offered.length - 1) return null;
	return offered[at + 1];
}

/**
 * The rungs a category actually offers, in ladder order. A non-draftable
 * category never offers Draft — the cell renders as "not offered for this
 * kind of work" rather than as an available choice.
 */
export function offeredRungs(draftable: boolean): readonly TrustRung[] {
	return draftable ? TRUST_RUNG_ORDER : TRUST_RUNG_ORDER.filter((r) => r !== 'draft');
}
