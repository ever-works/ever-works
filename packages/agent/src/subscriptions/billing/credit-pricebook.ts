import type {
    CreditPriceEntry,
    CreditPriceListVersion,
    UsageOutcomeId,
} from '@ever-works/contracts';

/**
 * The published credit price list (AW-17) — what one kind of platform-paid
 * call costs, readable before the call is made.
 *
 * Same posture as the neighbouring `credit-packs.ts`: this is a code table
 * on purpose. A price change is a code change that ships with a test, not an
 * environment variable an operator can drift. It is DATA only — services
 * read it through the `CREDIT_PRICE_LIST` port
 * (`packages/agent/src/usage/credit-price-list.ts`), whose default binding is
 * built from this file and which a deployment can bind to another list.
 *
 * ## Keys
 *
 * Every key is `capability.operation` and NEVER a Plugin id, so swapping the
 * Plugin behind a capability can never change what an owner pays. The spec
 * for this file fails CI if a key ever equals a registered plugin id.
 *
 * ## Two bases
 *
 *  - `per-unit`      a fixed number of credits per unit — the research calls
 *                    an Agent makes (a web search, a page extraction, a
 *                    screenshot). Cached and failed calls cost nothing.
 *  - `provider-cost` the provider's own metered cost converted at the
 *                    published credits-per-dollar rate — managed model access
 *                    (priced from the model's own list price in its metadata),
 *                    metrics reads and tool calls, whose cost varies by call.
 *
 * ## Charged, or for reference
 *
 * Every row is stamped with its list price either way. Whether a `per-unit`
 * price is what a run is DEBITED is the deployment's settlement mode
 * (`CREDITS_SETTLEMENT_MODE`): the default `provider_cost` debits every run
 * from its provider cost at the conversion and margin, exactly as before this
 * list existed; `price_list` debits the listed credits. The pricing view
 * publishes the active mode beside the list.
 *
 * Only kinds of call a capability in this codebase actually makes are
 * listed. A kind is added here in the same change that adds the capability
 * that produces it — a published price for a call nothing can make would be
 * a promise with nothing behind it.
 *
 * ## Versions
 *
 * Every usage row priced from a fixed entry stores the version that priced
 * it; historical rows are never re-priced. Earlier versions stay in
 * {@link CREDIT_PRICEBOOK_HISTORY}, frozen, so a receipt for an old run can
 * show the price that applied without a database read.
 */

/** The version in force for new calls. */
export const CREDIT_PRICEBOOK_VERSION = 1;

/** `YYYY-MM-DD` the current version took effect. */
export const CREDIT_PRICEBOOK_EFFECTIVE_FROM = '2026-09-14';

function freezeEntries(entries: CreditPriceEntry[]): readonly CreditPriceEntry[] {
    return Object.freeze(entries.map((entry) => Object.freeze({ ...entry })));
}

/** Version 1 — the first published list. */
const VERSION_1: readonly CreditPriceEntry[] = freezeEntries([
    { key: 'search.query', group: 'research', basis: 'per-unit', credits: 2, unit: 'query' },
    { key: 'extractor.page', group: 'research', basis: 'per-unit', credits: 3, unit: 'page' },
    {
        key: 'screenshot.capture',
        group: 'research',
        basis: 'per-unit',
        credits: 4,
        unit: 'capture',
    },
    { key: 'metrics.read', group: 'data', basis: 'provider-cost', credits: null, unit: 'call' },
    { key: 'mcp.toolCall', group: 'tools', basis: 'provider-cost', credits: null, unit: 'call' },
    { key: 'ai.managed', group: 'models', basis: 'provider-cost', credits: null, unit: 'usage' },
]);

/** The entries of the current version. */
export const CREDIT_PRICEBOOK: readonly CreditPriceEntry[] = VERSION_1;

/** Every version ever published, keyed by version number. Frozen. */
export const CREDIT_PRICEBOOK_HISTORY: Readonly<Record<number, Readonly<CreditPriceListVersion>>> =
    Object.freeze({
        1: Object.freeze({
            version: 1,
            effectiveFrom: CREDIT_PRICEBOOK_EFFECTIVE_FROM,
            entries: VERSION_1 as CreditPriceEntry[],
        }),
    });

/**
 * Credits one call costs under a `per-unit` entry. Pure.
 *
 * Returns `0` for `cached` and `failed` outcomes (they did no new work) and
 * `null` for a `provider-cost` entry, whose price is the provider's own cost
 * rather than a fixed number.
 */
export function priceFor(
    entry: Pick<CreditPriceEntry, 'basis' | 'credits'>,
    units: number,
    outcome: UsageOutcomeId = 'ok',
): number | null {
    if (entry.basis !== 'per-unit' || entry.credits === null) {
        return null;
    }
    if (outcome === 'cached' || outcome === 'failed') {
        return 0;
    }
    const wholeUnits = Number.isFinite(units) ? Math.max(0, Math.round(units)) : 0;
    return entry.credits * wholeUnits;
}

/**
 * A provider's metered cost → whole credits at a credits-per-dollar rate and
 * a margin percent, rounded UP so fractional cost never converts to zero.
 * Pure. The single definition of the conversion: the run settlement
 * (`CreditLedgerService.creditsForCostCents`) and the `provider-cost` price
 * of a usage row both call it with the configured values.
 */
export function creditsForProviderCostCents(
    costCents: number,
    creditsPerDollar: number,
    marginPercent: number,
): number {
    if (!Number.isFinite(costCents) || costCents <= 0) {
        return 0;
    }
    const creditsPerCent = creditsPerDollar / 100;
    const margin = 1 + marginPercent / 100;
    return Math.ceil(costCents * creditsPerCent * margin);
}
