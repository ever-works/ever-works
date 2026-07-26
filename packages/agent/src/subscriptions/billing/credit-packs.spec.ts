import {
    CREDIT_PACKS,
    CREDIT_PACK_IDS,
    defaultAutoRechargePack,
    findCreditPack,
} from './credit-packs';

/**
 * The pack table is the server's answer to "what does this cost". It is
 * deliberately a code constant, not config, so a pricing change ships
 * with these assertions.
 */
describe('credit packs (server-side price table)', () => {
    it('publishes exactly the three packs the website advertises', () => {
        expect(CREDIT_PACKS.map((pack) => [pack.credits, pack.priceCents])).toEqual([
            [1000, 1000], // 1,000 credits — $10
            [5500, 5000], // 5,500 credits — $50
            [25000, 20000], // 25,000 credits — $200
        ]);
    });

    it('exposes stable pack ids', () => {
        expect(CREDIT_PACK_IDS).toEqual(['credits-1000', 'credits-5500', 'credits-25000']);
    });

    it('prices every pack in a single currency with positive integers', () => {
        for (const pack of CREDIT_PACKS) {
            expect(pack.currency).toBe('usd');
            expect(Number.isInteger(pack.priceCents)).toBe(true);
            expect(Number.isInteger(pack.credits)).toBe(true);
            expect(pack.priceCents).toBeGreaterThan(0);
            expect(pack.credits).toBeGreaterThan(0);
        }
    });

    it('gives larger packs a strictly better credits-per-dollar rate', () => {
        const rates = CREDIT_PACKS.map((pack) => pack.credits / pack.priceCents);
        expect(rates[1]).toBeGreaterThan(rates[0]);
        expect(rates[2]).toBeGreaterThan(rates[1]);
    });

    it('resolves a known pack by id', () => {
        expect(findCreditPack('credits-5500')).toEqual(
            expect.objectContaining({ credits: 5500, priceCents: 5000 }),
        );
    });

    it('returns undefined for unknown / degenerate ids — never a default', () => {
        expect(findCreditPack('credits-999999')).toBeUndefined();
        expect(findCreditPack('')).toBeUndefined();
        expect(findCreditPack(null)).toBeUndefined();
        expect(findCreditPack(undefined)).toBeUndefined();
        // A price-shaped string must not resolve to anything either.
        expect(findCreditPack('1000')).toBeUndefined();
    });

    it('defaults auto-recharge to the SMALLEST pack (least surprising charge)', () => {
        const smallest = [...CREDIT_PACKS].sort((a, b) => a.priceCents - b.priceCents)[0];
        expect(defaultAutoRechargePack()).toBe(smallest);
    });
});
