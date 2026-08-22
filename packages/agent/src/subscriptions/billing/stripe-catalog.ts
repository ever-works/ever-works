import catalogJson from './stripe-catalog.data.json';

/**
 * Typed view over {@link ./stripe-catalog.data.json}, Ever Works' catalog in the SHARED Stripe account
 * (`acct_1IDnd6DdBrwbGEir`, "Ever Tech").
 *
 * ## Why this file exists
 *
 * Every Ever product now sells through ONE Stripe account, so a price has to be identifiable from
 * an invoice line and resolvable without knowing which product created it. The account-wide plan
 * convention — set by `ever-co/ever-website` `packages/web/lib/billing/catalog.json` — is:
 *
 *     lookup_key = ever_<product>_<hosting>_<tier>_<interval>
 *
 * Ever Works keeps its OWN end-to-end checkout (`apps/api/src/billing/*`) rather than redirecting
 * to `ever.co/checkout`; this table is what lets it do that against the shared account instead of
 * minting ad-hoc `price_data` on every request. Pricing a checkout from a server-side catalog is
 * also what makes a charge auditable after the fact: the invoice line carries a `lookup_key` that
 * maps back to a reviewed commit, not to a number a request body happened to contain.
 *
 * Both this module and `scripts/stripe-sync-catalog.mjs` read the same JSON, so a SKU the checkout
 * can reach is by construction a SKU the sync script created.
 *
 * ## The three things Ever Works sells
 *
 * 1. **A plan** — flat, recurring (or a one-time perpetual licence on self-hosted). Carries a seat
 *    allowance and a monthly AI-credit allowance.
 * 2. **Additional seats** — a per-unit recurring price, quantity `max(0, seats - seatsIncluded)`.
 *    Mirrors Ever Gauzy / Ever Teams, which include 10 employees and bill $5 (Small Business) or
 *    $10 (Enterprise) per additional employee per month. In Ever Works a seat is an employee OR an
 *    agent — the two are interchangeable, which is the point of the product.
 * 3. **Credit packs** — one-time top-ups for platform-billed AI usage. Credits are a SEPARATE axis
 *    from seats and apply on every hosting mode: self-hosting the open-source platform is free, but
 *    using Ever's own model access still spends credits. Runs on the customer's own model keys
 *    spend nothing, on any plan. {@link ./credit-packs.ts} stays the authority on how many credits
 *    a pack grants; this table only mirrors its PRICE into Stripe.
 */

export type CatalogHosting = 'cloud' | 'selfhosted';
export type CatalogTier = 'free' | 'pro' | 'enterprise';
export type CatalogInterval = 'monthly' | 'annual' | 'lifetime';
export type SeatInterval = 'monthly' | 'annual';

export interface CatalogPrice {
    readonly interval: CatalogInterval;
    /** Integer minor units (cents) in {@link Catalog.currency}. */
    readonly amountCents: number;
}

export interface CatalogPlan {
    readonly hosting: CatalogHosting;
    readonly tier: CatalogTier;
    /** Name as shown on ever.works and on the Stripe invoice line. */
    readonly tierName: string;
    /**
     * Seats (employees OR agents) included before per-seat billing starts.
     * `null` means unbounded — nothing to meter, so no seat price exists.
     */
    readonly seatsIncluded: number | null;
    /**
     * Per-additional-seat price in cents per seat per MONTH, or `null` where seats are unbounded.
     * The annual seat price is exactly 12x this: additional seats carry no annual discount, which
     * matches Gauzy's flat "$5 per month" wording.
     */
    readonly seatCentsPerMonth: number | null;
    /**
     * Platform-billed AI credits granted per month, or `null` on the free download (no plan row).
     * The universal daily grant is {@link Catalog.dailyFreeCredits} and is not expressed per plan.
     */
    readonly monthlyCredits: number | null;
    /** Empty when the tier is a free download with no Stripe object at all. */
    readonly prices: readonly CatalogPrice[];
    readonly note?: string;
}

export interface CatalogCreditPack {
    /** Joins back to `CREDIT_PACKS` in {@link ./credit-packs.ts}. */
    readonly packId: string;
    readonly amountCents: number;
    readonly credits: number;
    readonly label: string;
}

export interface Catalog {
    readonly version: number;
    /** Ever Works' key inside the shared, account-wide lookup-key namespace. */
    readonly product: string;
    readonly name: string;
    readonly site: string;
    /** Every Ever price is USD, regardless of the account's EUR default. */
    readonly currency: string;
    readonly dailyFreeCredits: number;
    readonly plans: readonly CatalogPlan[];
    readonly creditPacks: readonly CatalogCreditPack[];
}

export const catalog = catalogJson as unknown as Catalog;

export const CATALOG_PRODUCT_KEY = catalog.product;
export const CATALOG_CURRENCY = catalog.currency;

export const HOSTINGS: readonly CatalogHosting[] = ['cloud', 'selfhosted'];
export const TIERS: readonly CatalogTier[] = ['free', 'pro', 'enterprise'];
export const INTERVALS: readonly CatalogInterval[] = ['monthly', 'annual', 'lifetime'];

/* -------------------------------------------------------------------------- */
/*  Lookup keys                                                                */
/* -------------------------------------------------------------------------- */

/**
 * `ever_works_<hosting>_<tier>_<interval>` — the account-wide plan convention, unchanged, so an
 * Ever Works plan price resolves by exactly the same rule as a Gauzy or Teams one.
 */
export function planLookupKey(
    hosting: CatalogHosting,
    tier: CatalogTier,
    interval: CatalogInterval,
): string {
    return `ever_${CATALOG_PRODUCT_KEY}_${hosting}_${tier}_${interval}`;
}

/**
 * `ever_works_<hosting>_<tier>_seat_<interval>` — an Ever Works EXTENSION of the shared convention.
 *
 * The shared `catalog.json` schema has no seat concept: no other Ever product sells seats through
 * Stripe yet (Gauzy quotes "$5 per additional employee" but bills it outside Stripe). The `_seat_`
 * infix keeps these keys unambiguous while remaining inert to the shared 5-part reader, which
 * simply will not match them. If seats are ever lifted into the shared catalog, standardise here.
 */
export function seatLookupKey(
    hosting: CatalogHosting,
    tier: CatalogTier,
    interval: SeatInterval,
): string {
    return `ever_${CATALOG_PRODUCT_KEY}_${hosting}_${tier}_seat_${interval}`;
}

/**
 * `ever_works_credits_<n>` — one-time credit packs. Deliberately carries no hosting or tier: a pack
 * is the same purchase for a cloud Pro customer and for a self-hoster.
 */
export function creditPackLookupKey(packId: string): string {
    return `ever_${CATALOG_PRODUCT_KEY}_${packId.replace(/-/g, '_')}`;
}

/** Stripe product name, e.g. "Ever Works Cloud — Pro". Shown on the invoice. */
export function planProductName(plan: CatalogPlan): string {
    const hosting = plan.hosting === 'cloud' ? 'Cloud' : 'Self-Hosted';
    return `${catalog.name} ${hosting} — ${plan.tierName}`;
}

/** e.g. "Ever Works Cloud — Pro — Additional Seat". */
export function seatProductName(plan: CatalogPlan): string {
    return `${planProductName(plan)} — Additional Seat`;
}

/** e.g. "Ever Works — 5,500 credits". */
export function creditPackProductName(pack: CatalogCreditPack): string {
    return `${catalog.name} — ${pack.label}`;
}

/* -------------------------------------------------------------------------- */
/*  Resolution                                                                 */
/* -------------------------------------------------------------------------- */

export interface ResolvedCatalogSku {
    readonly plan: CatalogPlan;
    readonly price: CatalogPrice;
    readonly lookupKey: string;
    /** Stripe Checkout mode. A lifetime licence is a one-off purchase; everything else recurs. */
    readonly mode: 'payment' | 'subscription';
    /** Per-seat lookup key to add as a second line item, or `null` when there are no meterable seats. */
    readonly seatLookupKey: string | null;
}

export function findPlan(hosting: CatalogHosting, tier: CatalogTier): CatalogPlan | undefined {
    return catalog.plans.find((p) => p.hosting === hosting && p.tier === tier);
}

/**
 * Resolve a plan purchase to a concrete SKU, or `null` when the combination does not exist.
 *
 * 🛑 Callers must treat `null` as "reject the request", never as "fall back to something". A
 * fallback here would silently sell the wrong plan.
 */
export function resolveCatalogSku(params: {
    hosting: CatalogHosting;
    tier: CatalogTier;
    interval: CatalogInterval;
}): ResolvedCatalogSku | null {
    const plan = findPlan(params.hosting, params.tier);
    if (!plan) return null;

    const price = plan.prices.find((p) => p.interval === params.interval);
    if (!price) return null;

    const isLifetime = price.interval === 'lifetime';
    const hasMeterableSeats = plan.seatsIncluded !== null && plan.seatCentsPerMonth !== null;

    return {
        plan,
        price,
        lookupKey: planLookupKey(plan.hosting, plan.tier, price.interval),
        mode: isLifetime ? 'payment' : 'subscription',
        // A one-off licence cannot carry a recurring seat line, and an unbounded plan has nothing
        // to meter. Both collapse to "no seat line item".
        seatLookupKey:
            !isLifetime && hasMeterableSeats
                ? seatLookupKey(
                      plan.hosting,
                      plan.tier,
                      price.interval === 'annual' ? 'annual' : 'monthly',
                  )
                : null,
    };
}

/**
 * Billable extra seats for a requested headcount. Never negative, never fractional.
 *
 * A plan with unbounded seats always bills zero extras — that is Enterprise "Option 1" (one
 * organization, unlimited employees and agents).
 */
export function billableSeats(plan: CatalogPlan, requestedSeats: number): number {
    if (plan.seatsIncluded === null) return 0;
    if (!Number.isFinite(requestedSeats)) return 0;
    return Math.max(0, Math.floor(requestedSeats) - plan.seatsIncluded);
}

/** The annual per-seat amount: 12x the monthly rate, with no annual discount. */
export function seatAmountCents(plan: CatalogPlan, interval: SeatInterval): number | null {
    if (plan.seatCentsPerMonth === null) return null;
    return interval === 'annual' ? plan.seatCentsPerMonth * 12 : plan.seatCentsPerMonth;
}

/**
 * `subscription_plans.code` → the catalog tier it sells.
 *
 * The two vocabularies are deliberately separate. A plan CODE is an identity that is stored on
 * every `user_subscriptions` row and in Stripe metadata on every subscription ever created, so it
 * can never be renamed. A catalog TIER is what the price is called in the shared account. `standard`
 * has always been sold as "Pro" and `premium` as "Enterprise"; this map is where those two facts
 * meet, instead of the string being parsed out of the code at each call site.
 *
 * Returns `null` for a code this catalog does not sell, which callers must treat as "bill from the
 * plan row instead" — never as a reason to fail a purchase.
 */
const TIER_BY_PLAN_CODE: Readonly<Record<string, CatalogTier>> = {
    free: 'free',
    standard: 'pro',
    premium: 'enterprise',
    selfhosted_community: 'free',
    selfhosted_pro: 'pro',
    selfhosted_enterprise: 'enterprise',
};

export function catalogTierForPlanCode(code: string): CatalogTier | null {
    return TIER_BY_PLAN_CODE[code] ?? null;
}

/**
 * Resolve a stored plan row to its catalog SKU.
 *
 * This is the join between the database (which owns quotas, display names and the plan's identity)
 * and the catalog (which owns what Stripe charges). A row whose code or hosting the catalog does
 * not recognise returns `null`, and the provider then bills the row's own amount — the pre-catalog
 * behaviour, preserved so an unsynced deployment keeps working.
 */
export function resolveSkuForPlanRow(params: {
    code: string;
    hosting: CatalogHosting | string | null | undefined;
    interval: CatalogInterval;
}): ResolvedCatalogSku | null {
    const tier = catalogTierForPlanCode(params.code);
    if (!tier) return null;

    const hosting = params.hosting === 'selfhosted' ? 'selfhosted' : 'cloud';
    return resolveCatalogSku({ hosting, tier, interval: params.interval });
}

/** Every plan/seat/credit lookup_key this catalog defines — used by the sync script and by tests. */
export function allCatalogLookupKeys(): string[] {
    const keys: string[] = [];
    for (const plan of catalog.plans) {
        for (const price of plan.prices) {
            keys.push(planLookupKey(plan.hosting, plan.tier, price.interval));
        }
        if (plan.seatsIncluded !== null && plan.seatCentsPerMonth !== null) {
            keys.push(seatLookupKey(plan.hosting, plan.tier, 'monthly'));
            keys.push(seatLookupKey(plan.hosting, plan.tier, 'annual'));
        }
    }
    for (const pack of catalog.creditPacks) {
        keys.push(creditPackLookupKey(pack.packId));
    }
    return keys;
}
