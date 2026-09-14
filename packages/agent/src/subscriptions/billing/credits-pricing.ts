import type { CreditPriceListView } from '@ever-works/contracts';
import { config } from '@src/config';
import { PublishedCreditPriceList, type CreditPriceList } from '../../usage/credit-price-list';
import { CREDIT_PACKS, type CreditPack } from './credit-packs';
import { catalog, getPaygCatalog, type CatalogPaygTier } from './stripe-catalog';

/**
 * Everything a client needs to explain a credit (billing spec FR-13) —
 * read-only, server-authored, one shape for the API, the Billing page
 * and the Usage page. Nothing here is a secret and nothing here is
 * writable over HTTP.
 */
export interface CreditsPricingView {
    /** Credits per $1 of platform-billed usage (default 100 → 1 credit = 1¢). */
    creditsPerDollar: number;
    /** Platform margin over metered provider list cost, in percent (catalog default, env override). */
    marginPercent: number;
    /** Daily allowance on every plan. */
    dailyFreeCredits: number;
    /** Server-side pack table — the only source of pack prices. */
    packs: readonly CreditPack[];
    payg: {
        tiers: readonly CatalogPaygTier[];
        invoiceThresholdCents: number;
        defaultMonthlyCapCredits: number;
        /** Effective ceiling for a self-service cap (catalog, or `PAYG_MAX_MONTHLY_CAP_CREDITS`). */
        maxMonthlyCapCredits: number;
    };
    /**
     * AW-17 — the credit price-list version new calls are priced at. The
     * margin above stays: it still describes how a `provider-cost` entry
     * converts a provider's own cost into credits.
     */
    pricebookVersion: number;
    /** AW-17 — `YYYY-MM-DD` that version took effect. */
    pricebookEffectiveFrom: string;
    /** AW-17 — the published price list itself: what each kind of call costs. */
    priceList: CreditPriceListView;
}

/**
 * @param priceList the bound `CREDIT_PRICE_LIST` port. Callers with no DI
 *   container (scripts, tests) get the published default.
 */
export function creditsPricingView(
    priceList: CreditPriceList = new PublishedCreditPriceList(),
): CreditsPricingView {
    const payg = getPaygCatalog();
    const creditsPerDollar = config.billing.credits.getCreditsPerDollar();
    const current = priceList.getVersion();
    return {
        creditsPerDollar,
        marginPercent: config.billing.credits.getMarginPercent(),
        dailyFreeCredits: config.billing.credits.getDailyFreeCredits(),
        packs: CREDIT_PACKS,
        payg: {
            tiers: payg.tiers,
            invoiceThresholdCents: payg.invoiceThresholdCents,
            defaultMonthlyCapCredits: payg.defaultMonthlyCapCredits,
            maxMonthlyCapCredits: config.billing.payg.getMaxMonthlyCapCredits(),
        },
        pricebookVersion: priceList.currentVersion,
        pricebookEffectiveFrom: current?.effectiveFrom ?? '',
        priceList: {
            version: priceList.currentVersion,
            effectiveFrom: current?.effectiveFrom ?? '',
            entries: current?.entries ?? [],
            creditsPerDollar,
            versions: priceList.versions(),
        },
    };
}

/** Catalog daily allowance — exposed for callers that must not import the catalog module. */
export function catalogDailyFreeCredits(): number {
    return catalog.dailyFreeCredits;
}
