import type { ModelListPriceEntry, ModelListPriceListVersion } from '@ever-works/contracts';

/**
 * Usage & cost on the fleet (FL-20, CONTRACTS R-30) — the PUBLISHED, versioned
 * per-model list-price table: what the same tokens would cost on a
 * pay-as-you-go key, in US dollars per million tokens, for the four token
 * classes (uncached input, output, cache read, cache write).
 *
 * Rules (spec FR-7, FR-8, U8):
 *
 *  - a version is FROZEN once published — a change is a new version with a
 *    later `effectiveFrom`; every stored figure keeps the version it used and
 *    is never re-priced silently;
 *  - only models whose list price is published are here. A model this table
 *    does not know is counted in tokens only and never priced at $0;
 *  - a zero rate is a real rate: the OpenAI families bill no cache WRITE (the
 *    Codex CLI never reports one), so theirs is 0; every class a provider
 *    charges is positive.
 *
 * v1 (2026-10-26) carries the Claude and OpenAI families the Claude Code and
 * Codex CLIs run, at the providers' published pay-as-you-go rates as of that
 * date (cache write = the 5-minute cache tier). Owner question 1 in the FL-20
 * lane log asks for a check before the flag is switched on anywhere.
 */

const claude = (
    model: string,
    match: readonly string[],
    rates: [number, number, number, number],
): ModelListPriceEntry => ({
    model,
    provider: 'claude-code',
    match,
    perMillionUsd: { in: rates[0], out: rates[1], cacheRead: rates[2], cacheWrite: rates[3] },
});

const openai = (
    model: string,
    match: readonly string[],
    rates: [number, number, number],
): ModelListPriceEntry => ({
    model,
    provider: 'codex',
    match,
    // Input, output, cached input; OpenAI bills no cache write.
    perMillionUsd: { in: rates[0], out: rates[1], cacheRead: rates[2], cacheWrite: 0 },
});

const V1: ModelListPriceListVersion = Object.freeze({
    version: 1,
    effectiveFrom: '2026-10-26',
    entries: Object.freeze([
        // ── Claude (input, output, cache read, cache write 5 min) ──
        // Current families (published first-party API rates; the 5-minute cache
        // write is the standard 1.25 x input, the cache read as published).
        claude('claude-fable-5-1', ['claude-fable-5-1', 'claude-mythos-5-1'], [10, 50, 0.25, 12.5]),
        claude('claude-fable-5', ['claude-fable-5', 'claude-mythos-5'], [10, 50, 1, 12.5]),
        claude('claude-opus-5-5', ['claude-opus-5-5'], [4, 20, 0.2, 5]),
        claude('claude-opus-5', ['claude-opus-5'], [5, 25, 0.5, 6.25]),
        claude('claude-opus-4-8', ['claude-opus-4-8'], [5, 25, 0.5, 6.25]),
        claude('claude-opus-4-7', ['claude-opus-4-7'], [5, 25, 0.5, 6.25]),
        claude('claude-opus-4-6', ['claude-opus-4-6'], [5, 25, 0.5, 6.25]),
        claude('claude-sonnet-5-5', ['claude-sonnet-5-5'], [2, 10, 0.2, 2.5]),
        claude('claude-sonnet-5', ['claude-sonnet-5'], [2, 10, 0.2, 2.5]),
        claude('claude-sonnet-4-6', ['claude-sonnet-4-6'], [3, 15, 0.3, 3.75]),
        // Haiku 5.5's rates for prompts up to 100 K tokens; the long-prompt tier
        // ($0.50 / $2.50) is not modelled per request in v1 (owner question 1).
        claude('claude-haiku-5-5', ['claude-haiku-5-5'], [0.1, 0.5, 0.01, 0.125]),
        claude('claude-haiku-4-5', ['claude-haiku-4-5'], [1, 5, 0.1, 1.25]),
        // Earlier families the CLIs may still record.
        claude('claude-opus-4-5', ['claude-opus-4-5'], [5, 25, 0.5, 6.25]),
        claude('claude-opus-4-1', ['claude-opus-4-1'], [15, 75, 1.5, 18.75]),
        claude('claude-opus-4', ['claude-opus-4'], [15, 75, 1.5, 18.75]),
        claude('claude-sonnet-4-5', ['claude-sonnet-4-5'], [3, 15, 0.3, 3.75]),
        claude('claude-sonnet-4', ['claude-sonnet-4'], [3, 15, 0.3, 3.75]),
        claude('claude-3-7-sonnet', ['claude-3-7-sonnet'], [3, 15, 0.3, 3.75]),
        claude('claude-3-5-sonnet', ['claude-3-5-sonnet'], [3, 15, 0.3, 3.75]),
        claude('claude-3-5-haiku', ['claude-3-5-haiku'], [0.8, 4, 0.08, 1]),
        claude('claude-3-haiku', ['claude-3-haiku'], [0.25, 1.25, 0.03, 0.3]),
        claude('claude-3-opus', ['claude-3-opus'], [15, 75, 1.5, 18.75]),
        // ── OpenAI (input, output, cached input) ──
        openai('gpt-5', ['gpt-5'], [1.25, 10, 0.125]),
        openai('gpt-5-codex', ['gpt-5-codex'], [1.25, 10, 0.125]),
        openai('gpt-5-mini', ['gpt-5-mini'], [0.25, 2, 0.025]),
        openai('gpt-5-nano', ['gpt-5-nano'], [0.05, 0.4, 0.005]),
        openai('gpt-5.1', ['gpt-5.1'], [1.25, 10, 0.125]),
        openai('gpt-5.1-codex', ['gpt-5.1-codex'], [1.25, 10, 0.125]),
        openai('gpt-5.1-codex-mini', ['gpt-5.1-codex-mini'], [0.25, 2, 0.025]),
        openai('codex-mini', ['codex-mini'], [1.5, 6, 0.375]),
        openai('o3', ['o3'], [2, 8, 0.5]),
        openai('o4-mini', ['o4-mini'], [1.1, 4.4, 0.275]),
        openai('gpt-4.1', ['gpt-4.1'], [2, 8, 0.5]),
        openai('gpt-4o', ['gpt-4o'], [2.5, 10, 1.25]),
    ]) as readonly ModelListPriceEntry[],
});

/** Every published version, by number. Append-only. */
export const MODEL_LIST_PRICEBOOK_HISTORY: Readonly<
    Record<number, Readonly<ModelListPriceListVersion>>
> = Object.freeze({ 1: V1 });

/** The version new figures are priced at. */
export const MODEL_LIST_PRICEBOOK_VERSION = 1;
