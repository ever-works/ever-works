import { FLEET_MAX_DAILY_COST_CEILING_CENTS } from '@ever-works/contracts';

/**
 * Fleet cost accounting (EW-777) — the dollars ⇄ cents helpers the
 * ceiling editors share. Pure, so they are unit-tested without React.
 */

/** Cents → `"12.50"`; null → empty (the input's "no ceiling" state). */
export function centsToUsdInput(cents: number | null | undefined): string {
    if (cents === null || cents === undefined || !Number.isFinite(cents)) return '';
    return (cents / 100).toFixed(2);
}

/**
 * `"12.50"` → 1250 cents. Returns null for an EMPTY field (clear the
 * ceiling) and `undefined` for a value the API would refuse (not a
 * number, zero, negative, or above the contract cap), so the form can
 * say so instead of sending it.
 */
export function usdInputToCents(value: string): number | null | undefined {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const usd = Number(trimmed.replace(/^\$/, ''));
    if (!Number.isFinite(usd) || usd <= 0) return undefined;
    const cents = Math.round(usd * 100);
    if (cents < 1 || cents > FLEET_MAX_DAILY_COST_CEILING_CENTS) return undefined;
    return cents;
}

/** Cents → `"$12.50"` for display. */
export function formatCeilingCents(cents: number | null | undefined): string | null {
    if (cents === null || cents === undefined || !Number.isFinite(cents)) return null;
    return `$${(cents / 100).toFixed(2)}`;
}
