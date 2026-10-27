import {
    findModelListPriceEntry,
    priceModelTokensCents,
    type FleetUsageTokens,
    type ModelListPriceEntry,
    type ModelListPriceListVersion,
    type ModelListPricing,
} from '@ever-works/contracts';
import { MODEL_LIST_PRICEBOOK_HISTORY, MODEL_LIST_PRICEBOOK_VERSION } from './model-list-pricebook';

/**
 * Usage & cost on the fleet (FL-20, CONTRACTS R-30) — the per-model LIST-price
 * PORT. Modelled on AW-17's `CREDIT_PRICE_LIST` (same shape: versions, `find`)
 * but keyed by model id × token class instead of `capability.operation`; the
 * credit price list is untouched by it.
 *
 * Everything that prices fleet model work reads it through this interface, so
 * the table is replaceable (a future price-source plugin, an operator's own
 * list) without touching a service. The default binding,
 * {@link PublishedModelListPrices} over the published pricebook, is provided
 * by `UsageModule`.
 */
export const MODEL_LIST_PRICES = 'MODEL_LIST_PRICES' as const;

export interface ModelListPrices {
    /** The version new figures are priced at. */
    readonly currentVersion: number;
    /** Every version ever published, ascending. */
    versions(): number[];
    /** One version (the current one when omitted); null when unknown. */
    getVersion(version?: number): ModelListPriceListVersion | null;
    /** The entry a model id matches (longest family match); null when the model is not listed. */
    find(model: string, version?: number): ModelListPriceEntry | null;
    /**
     * Fractional cents for `tokens` of `model` at `version` (the current one
     * when omitted). NULL when the model is not listed — the caller shows
     * tokens only and excludes it from every dollar total. Never 0 for an
     * unknown model (FR-8).
     */
    price(tokens: FleetUsageTokens, model: string, version?: number): ModelListPricing | null;
}

/** The default list: a read-only view over the frozen, versioned history. Stateless. */
export class PublishedModelListPrices implements ModelListPrices {
    constructor(
        private readonly history: Readonly<
            Record<number, Readonly<ModelListPriceListVersion>>
        > = MODEL_LIST_PRICEBOOK_HISTORY,
        readonly currentVersion: number = MODEL_LIST_PRICEBOOK_VERSION,
    ) {
        if (!history[currentVersion]) {
            throw new Error(`Model list-price version ${currentVersion} is not in its history`);
        }
    }

    versions(): number[] {
        return Object.keys(this.history)
            .map(Number)
            .filter((version) => Number.isInteger(version))
            .sort((a, b) => a - b);
    }

    getVersion(version: number = this.currentVersion): ModelListPriceListVersion | null {
        const found = this.history[version];
        if (!found) return null;
        return {
            version: found.version,
            effectiveFrom: found.effectiveFrom,
            entries: found.entries.map((entry) => copyEntry(entry)),
        };
    }

    find(model: string, version: number = this.currentVersion): ModelListPriceEntry | null {
        const found = this.history[version];
        if (!found || typeof model !== 'string') return null;
        const entry = findModelListPriceEntry(found, model);
        return entry ? copyEntry(entry) : null;
    }

    price(
        tokens: FleetUsageTokens,
        model: string,
        version: number = this.currentVersion,
    ): ModelListPricing | null {
        const found = this.history[version];
        if (!found || typeof model !== 'string') return null;
        const entry = findModelListPriceEntry(found, model);
        if (!entry) return null;
        return { cents: priceModelTokensCents(tokens, entry), version: found.version, model: entry.model };
    }
}

function copyEntry(entry: ModelListPriceEntry): ModelListPriceEntry {
    return { ...entry, match: [...entry.match], perMillionUsd: { ...entry.perMillionUsd } };
}
