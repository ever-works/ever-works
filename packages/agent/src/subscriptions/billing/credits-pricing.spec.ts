import { CREDIT_PACKS } from './credit-packs';
import {
    CREDIT_PRICEBOOK,
    CREDIT_PRICEBOOK_EFFECTIVE_FROM,
    CREDIT_PRICEBOOK_VERSION,
} from './credit-pricebook';
import { creditsPricingView } from './credits-pricing';
import { PublishedCreditPriceList } from '../../usage/credit-price-list';

/**
 * `GET /api/credits/pricing` is a projection of this view. AW-17 adds the
 * published price list to it — readable with no payment provider configured,
 * and read from the SAME port the write path prices with.
 */
describe('creditsPricingView', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        process.env = { ...originalEnv };
        delete process.env.CREDITS_PER_DOLLAR;
        delete process.env.STRIPE_SECRET_KEY;
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    it('keeps every pre-existing field, margin included', () => {
        const view = creditsPricingView();
        expect(view.creditsPerDollar).toBe(100);
        expect(typeof view.marginPercent).toBe('number');
        expect(typeof view.dailyFreeCredits).toBe('number');
        expect(view.packs).toBe(CREDIT_PACKS);
        expect(view.payg).toEqual(
            expect.objectContaining({
                tiers: expect.any(Array),
                invoiceThresholdCents: expect.any(Number),
                defaultMonthlyCapCredits: expect.any(Number),
                maxMonthlyCapCredits: expect.any(Number),
            }),
        );
    });

    it('publishes the price-list version, its effective date and the entries', () => {
        const view = creditsPricingView();
        expect(view.pricebookVersion).toBe(CREDIT_PRICEBOOK_VERSION);
        expect(view.pricebookEffectiveFrom).toBe(CREDIT_PRICEBOOK_EFFECTIVE_FROM);
        expect(view.priceList.version).toBe(CREDIT_PRICEBOOK_VERSION);
        expect(view.priceList.creditsPerDollar).toBe(100);
        expect(view.priceList.entries.map((entry) => entry.key)).toEqual(
            CREDIT_PRICEBOOK.map((entry) => entry.key),
        );
        expect(view.priceList.versions).toContain(CREDIT_PRICEBOOK_VERSION);
    });

    it('renders on a deployment with no payment provider configured', () => {
        expect(() => creditsPricingView()).not.toThrow();
        expect(creditsPricingView().priceList.entries.length).toBeGreaterThan(0);
    });

    it('reads the bound price-list port rather than a table of its own', () => {
        const bound = new PublishedCreditPriceList(
            {
                7: {
                    version: 7,
                    effectiveFrom: '2027-01-01',
                    entries: [
                        {
                            key: 'search.query',
                            group: 'research',
                            basis: 'per-unit',
                            credits: 9,
                            unit: 'query',
                        },
                    ],
                },
            },
            7,
        );
        const view = creditsPricingView(bound);
        expect(view.pricebookVersion).toBe(7);
        expect(view.pricebookEffectiveFrom).toBe('2027-01-01');
        expect(view.priceList.entries).toEqual([
            {
                key: 'search.query',
                group: 'research',
                basis: 'per-unit',
                credits: 9,
                unit: 'query',
            },
        ]);
        expect(view.priceList.versions).toEqual([7]);
    });

    it('follows the configured credits-per-dollar rate', () => {
        process.env.CREDITS_PER_DOLLAR = '200';
        const view = creditsPricingView();
        expect(view.creditsPerDollar).toBe(200);
        expect(view.priceList.creditsPerDollar).toBe(200);
    });
});
