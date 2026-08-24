import { CREDIT_PACKS } from './credit-packs';
import {
    allCatalogLookupKeys,
    billableSeats,
    catalog,
    catalogCreditsMarginPercent,
    creditPackLookupKey,
    estimatePaygCents,
    findPlan,
    getPaygCatalog,
    paygLookupKey,
    planLookupKey,
    planProductName,
    resolveCatalogSku,
    seatAmountCents,
    seatLookupKey,
    seatProductName,
    type CatalogPlan,
} from './stripe-catalog';

/**
 * The catalog is the only place a price can be changed, and it is read by two independent
 * consumers — the checkout provider at runtime and `scripts/stripe-sync-catalog.mjs` at deploy
 * time. These tests pin the things that would go wrong QUIETLY:
 *
 *  - a lookup_key drifting away from the account-wide convention, which would strand a price in
 *    the shared Stripe account under a name nothing resolves;
 *  - the mode/seat derivation getting it wrong for a one-time licence, which would try to sell a
 *    perpetual licence as a subscription;
 *  - the annual amount being stored as the per-month figure the marketing site displays, which is
 *    the single easiest mistake to make here and would undercharge by 12x;
 *  - the credit-pack prices drifting from `credit-packs.ts`, which grants the credits.
 */
describe('stripe-catalog', () => {
    const plan = (
        hosting: 'cloud' | 'selfhosted',
        tier: 'free' | 'pro' | 'enterprise',
    ): CatalogPlan => {
        const found = findPlan(hosting, tier);
        if (!found) throw new Error(`missing plan ${hosting}/${tier}`);
        return found;
    };

    describe('shape', () => {
        it('defines exactly three tiers on each of the two hostings', () => {
            expect(catalog.plans).toHaveLength(6);
            for (const hosting of ['cloud', 'selfhosted'] as const) {
                const tiers = catalog.plans.filter((p) => p.hosting === hosting).map((p) => p.tier);
                expect(tiers.sort()).toEqual(['enterprise', 'free', 'pro']);
            }
        });

        it('prices everything in USD even though the shared account defaults to EUR', () => {
            expect(catalog.currency).toBe('usd');
        });

        it('claims the "works" key in the shared account-wide namespace', () => {
            expect(catalog.product).toBe('works');
            for (const key of allCatalogLookupKeys()) {
                expect(key.startsWith('ever_works_')).toBe(true);
            }
        });

        it('emits no duplicate lookup keys', () => {
            const keys = allCatalogLookupKeys();
            expect(new Set(keys).size).toBe(keys.length);
        });
    });

    describe('lookup keys', () => {
        it('follows ever_<product>_<hosting>_<tier>_<interval> for plans', () => {
            expect(planLookupKey('cloud', 'pro', 'monthly')).toBe('ever_works_cloud_pro_monthly');
            expect(planLookupKey('selfhosted', 'pro', 'lifetime')).toBe(
                'ever_works_selfhosted_pro_lifetime',
            );
            expect(planLookupKey('cloud', 'enterprise', 'annual')).toBe(
                'ever_works_cloud_enterprise_annual',
            );
        });

        it('infixes _seat_ for the per-additional-seat add-on', () => {
            expect(seatLookupKey('cloud', 'pro', 'monthly')).toBe(
                'ever_works_cloud_pro_seat_monthly',
            );
            expect(seatLookupKey('selfhosted', 'enterprise', 'annual')).toBe(
                'ever_works_selfhosted_enterprise_seat_annual',
            );
        });

        it('keeps credit packs free of hosting and tier — a pack is the same purchase for everyone', () => {
            expect(creditPackLookupKey('credits-5500')).toBe('ever_works_credits_5500');
            expect(creditPackLookupKey('credits-25000')).toBe('ever_works_credits_25000');
        });
    });

    describe('prices agree with Ever Gauzy / Ever Teams', () => {
        // Owner directive 2026-08-22. Amounts are CENTS; an annual amount is the yearly charge,
        // NOT the per-month figure the marketing site displays.
        it.each`
            hosting         | tier            | interval      | cents     | displays
            ${'cloud'}      | ${'free'}       | ${'monthly'}  | ${0}      | ${'$0'}
            ${'cloud'}      | ${'free'}       | ${'annual'}   | ${0}      | ${'$0'}
            ${'cloud'}      | ${'pro'}        | ${'monthly'}  | ${2500}   | ${'$25/mo'}
            ${'cloud'}      | ${'pro'}        | ${'annual'}   | ${20400}  | ${'$17/mo'}
            ${'cloud'}      | ${'enterprise'} | ${'monthly'}  | ${19900}  | ${'$199/mo'}
            ${'cloud'}      | ${'enterprise'} | ${'annual'}   | ${166800} | ${'$139/mo'}
            ${'selfhosted'} | ${'pro'}        | ${'monthly'}  | ${4900}   | ${'$49/mo'}
            ${'selfhosted'} | ${'pro'}        | ${'annual'}   | ${40800}  | ${'$34/mo'}
            ${'selfhosted'} | ${'pro'}        | ${'lifetime'} | ${9900}   | ${'$99 one-time'}
            ${'selfhosted'} | ${'enterprise'} | ${'monthly'}  | ${19900}  | ${'$199/mo'}
            ${'selfhosted'} | ${'enterprise'} | ${'annual'}   | ${166800} | ${'$139/mo'}
        `(
            '$hosting $tier $interval is $cents cents (displays $displays)',
            ({ hosting, tier, interval, cents }) => {
                const sku = resolveCatalogSku({ hosting, tier, interval });
                expect(sku).not.toBeNull();
                expect(sku!.price.amountCents).toBe(cents);
            },
        );

        it('stores annual as the YEARLY charge, twelve times the displayed monthly figure', () => {
            // The trap this guards: writing 1700 (the "$17/mo" the site shows) instead of 20400.
            expect(
                resolveCatalogSku({ hosting: 'cloud', tier: 'pro', interval: 'annual' })!.price
                    .amountCents,
            ).toBe(1700 * 12);
            expect(
                resolveCatalogSku({ hosting: 'cloud', tier: 'enterprise', interval: 'annual' })!
                    .price.amountCents,
            ).toBe(13900 * 12);
        });
    });

    describe('mode derivation', () => {
        it('sells a lifetime licence as a one-off payment, never a subscription', () => {
            const sku = resolveCatalogSku({
                hosting: 'selfhosted',
                tier: 'pro',
                interval: 'lifetime',
            })!;
            expect(sku.mode).toBe('payment');
            // A one-off purchase cannot carry a recurring seat line.
            expect(sku.seatLookupKey).toBeNull();
        });

        it('sells every other interval as a subscription', () => {
            for (const interval of ['monthly', 'annual'] as const) {
                expect(resolveCatalogSku({ hosting: 'cloud', tier: 'pro', interval })!.mode).toBe(
                    'subscription',
                );
                expect(
                    resolveCatalogSku({ hosting: 'selfhosted', tier: 'enterprise', interval })!
                        .mode,
                ).toBe('subscription');
            }
        });

        it('matches the seat interval to the plan interval', () => {
            expect(
                resolveCatalogSku({ hosting: 'cloud', tier: 'pro', interval: 'monthly' })!
                    .seatLookupKey,
            ).toBe('ever_works_cloud_pro_seat_monthly');
            expect(
                resolveCatalogSku({ hosting: 'cloud', tier: 'pro', interval: 'annual' })!
                    .seatLookupKey,
            ).toBe('ever_works_cloud_pro_seat_annual');
        });

        it('returns null for a combination the catalog does not have, never a fallback', () => {
            // The free download has no Stripe object at all.
            expect(
                resolveCatalogSku({ hosting: 'selfhosted', tier: 'free', interval: 'monthly' }),
            ).toBeNull();
            // Only self-hosted Pro sells a lifetime licence.
            expect(
                resolveCatalogSku({ hosting: 'cloud', tier: 'pro', interval: 'lifetime' }),
            ).toBeNull();
            expect(
                resolveCatalogSku({
                    hosting: 'selfhosted',
                    tier: 'enterprise',
                    interval: 'lifetime',
                }),
            ).toBeNull();
        });
    });

    describe('seats', () => {
        it('includes ten seats on every paid tier, matching Gauzy', () => {
            expect(plan('cloud', 'pro').seatsIncluded).toBe(10);
            expect(plan('cloud', 'enterprise').seatsIncluded).toBe(10);
            expect(plan('selfhosted', 'pro').seatsIncluded).toBe(10);
            expect(plan('selfhosted', 'enterprise').seatsIncluded).toBe(10);
        });

        it('charges Gauzy’s $5 on Pro and $10 on Enterprise', () => {
            expect(plan('cloud', 'pro').seatCentsPerMonth).toBe(500);
            expect(plan('selfhosted', 'pro').seatCentsPerMonth).toBe(500);
            expect(plan('cloud', 'enterprise').seatCentsPerMonth).toBe(1000);
            expect(plan('selfhosted', 'enterprise').seatCentsPerMonth).toBe(1000);
        });

        it('gives additional seats no annual discount — the yearly rate is exactly 12x', () => {
            expect(seatAmountCents(plan('cloud', 'pro'), 'annual')).toBe(6000);
            expect(seatAmountCents(plan('cloud', 'enterprise'), 'annual')).toBe(12000);
        });

        it('bills only the seats beyond the allowance, and never a negative quantity', () => {
            const pro = plan('cloud', 'pro');
            expect(billableSeats(pro, 0)).toBe(0);
            expect(billableSeats(pro, 10)).toBe(0);
            expect(billableSeats(pro, 11)).toBe(1);
            expect(billableSeats(pro, 37)).toBe(27);
            // Nonsense input must not produce a charge.
            expect(billableSeats(pro, -5)).toBe(0);
            expect(billableSeats(pro, Number.NaN)).toBe(0);
            expect(billableSeats(pro, Number.POSITIVE_INFINITY)).toBe(0);
            expect(billableSeats(pro, 10.9)).toBe(0);
        });

        it('never bills a seat on an unbounded plan — that is Enterprise Option 1', () => {
            const community = plan('selfhosted', 'free');
            expect(community.seatsIncluded).toBeNull();
            expect(billableSeats(community, 5000)).toBe(0);
            expect(seatAmountCents(community, 'monthly')).toBeNull();
        });

        it('emits no seat lookup keys for plans that cannot meter seats', () => {
            const keys = allCatalogLookupKeys();
            expect(keys).not.toContain('ever_works_cloud_free_seat_monthly');
            expect(keys).not.toContain('ever_works_selfhosted_free_seat_monthly');
        });
    });

    describe('credits', () => {
        it('grants the published monthly allowances', () => {
            expect(plan('cloud', 'free').monthlyCredits).toBe(0);
            expect(plan('cloud', 'pro').monthlyCredits).toBe(3000);
            expect(plan('cloud', 'enterprise').monthlyCredits).toBe(25000);
        });

        it('grants self-hosted paid editions the same allowance as their cloud twin', () => {
            expect(plan('selfhosted', 'pro').monthlyCredits).toBe(
                plan('cloud', 'pro').monthlyCredits,
            );
            expect(plan('selfhosted', 'enterprise').monthlyCredits).toBe(
                plan('cloud', 'enterprise').monthlyCredits,
            );
        });

        it('keeps the universal daily grant on the catalog, not on a plan', () => {
            expect(catalog.dailyFreeCredits).toBe(50);
        });

        it('prices every pack exactly as credit-packs.ts does — that file grants the credits', () => {
            // A drift here would charge one amount and grant a different pack's credits.
            expect(catalog.creditPacks).toHaveLength(CREDIT_PACKS.length);
            for (const pack of catalog.creditPacks) {
                const source = CREDIT_PACKS.find((p) => p.id === pack.packId);
                expect(source).toBeDefined();
                expect(pack.amountCents).toBe(source!.priceCents);
                expect(pack.credits).toBe(source!.credits);
                expect(pack.label).toBe(source!.label);
            }
        });
    });

    /**
     * Billing spec §3.4 — the margin is the one number that decides whether a credit pack is
     * sold at a loss, so it lives in the catalog and is pinned here WITH the arithmetic.
     *
     * Inputs: metered cost = provider list price (OpenRouter) × 1.055 (OpenRouter's purchase
     * fee); Stripe ≈ 2.9% + 30¢ per charge. With margin m, N credits buy N/(1+m) cents of list.
     *
     *   | pack     | price | credits | list AI at m=35% | provider cost (×1.055) | net of Stripe | result |
     *   |----------|-------|---------|------------------|------------------------|---------------|--------|
     *   | 1,000    |  $10  |  1,000  |   $7.41          |  $7.81                 |  $9.41        | +$1.60 |
     *   | 5,500    |  $50  |  5,500  |  $40.74          | $42.98                 | $48.25        | +$5.27 |
     *   | 25,000   | $200  | 25,000  | $185.19          | $195.37                | $193.90       | −$1.47 |
     *   | PAYG 1¢  |  —    |      1  |  0.741¢          |  0.781¢                |  ~0.97¢       | +0.19¢ |
     *
     * The largest pack sits at break-even by design (acquisition SKU); everything else is
     * positive. Change the number in `stripe-catalog.data.json` and this test tells you what
     * happens to the table.
     */
    describe('margin (billing spec §3.4)', () => {
        const OPENROUTER_FEE = 1.055;
        const stripeFeeCents = (priceCents: number) => Math.round(priceCents * 0.029) + 30;
        const providerCostCents = (credits: number) =>
            (credits / (1 + catalogCreditsMarginPercent() / 100)) * OPENROUTER_FEE;

        it('is 35% in the catalog and is what config falls back to', () => {
            expect(catalog.creditsMarginPercent).toBe(35);
            expect(catalogCreditsMarginPercent()).toBe(35);
        });

        it('keeps every pack at or above break-even after provider and Stripe fees (largest pack ≈ 0)', () => {
            for (const pack of catalog.creditPacks) {
                const net = pack.amountCents - stripeFeeCents(pack.amountCents);
                const cost = providerCostCents(pack.credits);
                const marginCents = net - cost;
                // The 25,000 pack is the deliberate break-even SKU: allow it to sit within
                // one percent of zero; the smaller packs must be clearly positive.
                if (pack.packId === 'credits-25000') {
                    expect(Math.abs(marginCents)).toBeLessThan(pack.amountCents * 0.01);
                } else {
                    expect(marginCents).toBeGreaterThan(pack.amountCents * 0.1);
                }
            }
        });

        it('prices the PAYG base tier above provider cost', () => {
            const baseCentsPerCredit = Number(getPaygCatalog().tiers[0].centsPerCredit);
            expect(baseCentsPerCredit).toBeGreaterThan(providerCostCents(1));
        });
    });

    describe('pay-as-you-go (billing spec §3.5)', () => {
        it('declares one meter and one graduated monthly price inside the works namespace', () => {
            const payg = getPaygCatalog();
            expect(payg.meterEventName).toBe('ever_works_credits');
            expect(paygLookupKey()).toBe('ever_works_payg_credits_monthly');
            expect(allCatalogLookupKeys()).toContain(paygLookupKey());
            expect(payg.tiers.map((t) => t.upTo)).toEqual([5000, 25000, null]);
            // Stripe's monetary-threshold floor is 50 currency units.
            expect(payg.invoiceThresholdCents).toBeGreaterThanOrEqual(5000);
            expect(payg.defaultMonthlyCapCredits).toBeLessThanOrEqual(payg.maxMonthlyCapCredits);
        });

        it('never undercuts the prepaid packs at the same volume — packs are the commitment discount', () => {
            for (const pack of catalog.creditPacks) {
                expect(estimatePaygCents(pack.credits)).toBeGreaterThanOrEqual(pack.amountCents);
            }
        });

        it('estimatePaygCents applies the tiers graduated (each span at its own rate)', () => {
            expect(estimatePaygCents(0)).toBe(0);
            expect(estimatePaygCents(5000)).toBe(5000); // 5,000 × 1.00¢
            expect(estimatePaygCents(6000)).toBe(5000 + 910); // + 1,000 × 0.91¢
            expect(estimatePaygCents(30000)).toBe(5000 + 18200 + 4000); // + 20,000 × 0.91¢ + 5,000 × 0.80¢
            expect(estimatePaygCents(-5)).toBe(0);
        });
    });

    describe('Stripe product names', () => {
        it('names a plan so an invoice line identifies the product and the tier', () => {
            expect(planProductName(plan('cloud', 'pro'))).toBe('Ever Works Cloud — Pro');
            expect(planProductName(plan('selfhosted', 'enterprise'))).toBe(
                'Ever Works Self-Hosted — Enterprise Edition',
            );
        });

        it('distinguishes the seat add-on from the plan it belongs to', () => {
            expect(seatProductName(plan('cloud', 'pro'))).toBe(
                'Ever Works Cloud — Pro — Additional Seat',
            );
        });
    });
});
