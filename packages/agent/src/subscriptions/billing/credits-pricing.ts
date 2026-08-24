import { config } from '@src/config';
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
}

export function creditsPricingView(): CreditsPricingView {
    const payg = getPaygCatalog();
    return {
        creditsPerDollar: config.billing.credits.getCreditsPerDollar(),
        marginPercent: config.billing.credits.getMarginPercent(),
        dailyFreeCredits: config.billing.credits.getDailyFreeCredits(),
        packs: CREDIT_PACKS,
        payg: {
            tiers: payg.tiers,
            invoiceThresholdCents: payg.invoiceThresholdCents,
            defaultMonthlyCapCredits: payg.defaultMonthlyCapCredits,
            maxMonthlyCapCredits: config.billing.payg.getMaxMonthlyCapCredits(),
        },
    };
}

/** Catalog daily allowance — exposed for callers that must not import the catalog module. */
export function catalogDailyFreeCredits(): number {
    return catalog.dailyFreeCredits;
}
