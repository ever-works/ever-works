/**
 * APW-01 T20 — the ONE list of work kinds whose chip is HIDDEN while the kind is
 * disabled (Resolution R-6, spec FR-47).
 *
 * This module exists so that two very different places cannot drift apart:
 *
 *  - `lib/feature-flags/work-kinds.ts` (server-side) fails **closed** for these
 *    kinds — an OSS deployment with no PostHog, a timeout or an error means the
 *    chip is ABSENT, unlike every other kind, which fails open.
 *  - the chip surfaces themselves (T20's `HIDDEN_WHEN_DISABLED_WORK_KINDS`,
 *    consumed by T23) remove the chip rather than render a disabled one.
 *
 * ## Why it is NOT `server-only`
 *
 * The flag helper imports `posthog-node` and must never reach a browser bundle.
 * This list must: a client component that renders the kind chips needs to know
 * which kinds are hidden without calling a server action, so the module is
 * deliberately dependency-free and importable from both sides.
 *
 * Membership is a product decision, not a technical one: a kind joins this list
 * only while its surface is unfinished and showing it would be worse than hiding
 * it. `app` is the only member today.
 */

/** Kinds that are hidden — not merely unselectable — while they are disabled. */
export const HIDDEN_WHEN_DISABLED_WORK_KINDS = ['app'] as const;

/** Union of the hidden kinds, for a caller that wants the type. */
export type HiddenWhenDisabledWorkKind = (typeof HIDDEN_WHEN_DISABLED_WORK_KINDS)[number];

const HIDDEN: ReadonlySet<string> = new Set<string>(HIDDEN_WHEN_DISABLED_WORK_KINDS);

/**
 * Whether this kind's chip is hidden while the kind is disabled.
 *
 * Takes a loose string on purpose: the value arrives from a URL, a Work row or a
 * catalog entry, and `work.kind` is modelled as an open union (the server ships
 * a new kind without a coordinated web deploy). An unknown value is NOT hidden —
 * hiding an unfamiliar kind would make a future kind invisible by omission.
 */
export function isHiddenWhenDisabled(value: string): boolean {
    return HIDDEN.has(value);
}
