import type { CreditPriceEntry, CreditPriceListVersion } from '@ever-works/contracts';
import {
    CREDIT_PRICEBOOK_HISTORY,
    CREDIT_PRICEBOOK_VERSION,
} from '../subscriptions/billing/credit-pricebook';

/**
 * AW-17 — the credit price list PORT. Everything that prices a call, settles
 * a run or displays a price reads it through this interface, so the list is
 * replaceable without touching a service: bind `CREDIT_PRICE_LIST` to any
 * implementation and the classifier, the pricing view and the receipts follow.
 *
 * The default binding ({@link PublishedCreditPriceList} over the published
 * pricebook) is provided by `UsageModule`.
 */
export const CREDIT_PRICE_LIST = 'CREDIT_PRICE_LIST' as const;

export interface CreditPriceList {
    /** The version new calls are priced at. */
    readonly currentVersion: number;
    /** Every version ever published, ascending. */
    versions(): number[];
    /** One version (the current one when omitted); null when unknown. */
    getVersion(version?: number): CreditPriceListVersion | null;
    /** The entry for a `capability.operation` key; null when the key is not listed. */
    find(key: string, version?: number): CreditPriceEntry | null;
}

/**
 * The default price list: a read-only view over a frozen, versioned history.
 * Stateless — safe to share across every consumer.
 */
export class PublishedCreditPriceList implements CreditPriceList {
    constructor(
        private readonly history: Readonly<
            Record<number, Readonly<CreditPriceListVersion>>
        > = CREDIT_PRICEBOOK_HISTORY,
        readonly currentVersion: number = CREDIT_PRICEBOOK_VERSION,
    ) {
        if (!history[currentVersion]) {
            throw new Error(`Price list version ${currentVersion} is not in its history`);
        }
    }

    versions(): number[] {
        return Object.keys(this.history)
            .map(Number)
            .filter((version) => Number.isInteger(version))
            .sort((a, b) => a - b);
    }

    getVersion(version: number = this.currentVersion): CreditPriceListVersion | null {
        const found = this.history[version];
        if (!found) {
            return null;
        }
        return {
            version: found.version,
            effectiveFrom: found.effectiveFrom,
            entries: found.entries.map((entry) => ({ ...entry })),
        };
    }

    find(key: string, version: number = this.currentVersion): CreditPriceEntry | null {
        const found = this.history[version]?.entries.find((entry) => entry.key === key);
        return found ? { ...found } : null;
    }
}
