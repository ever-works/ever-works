import { BREAKDOWN_EVERYTHING_ELSE_KEY } from '@ever-works/contracts';
import { foldBreakdown, foldMeterTotals, foldRunMeters } from './spend-breakdown';

/** AW-17 — the pure folds behind the meter cards, breakdowns and receipt meters. */
describe('foldBreakdown', () => {
    const row = (key: string | null, credits: number, costCents = 0, calls = 1) => ({
        key,
        capability: 'search',
        calls,
        credits,
        costCents,
    });

    it('keeps the top 10, folds the rest into an exact "Everything else" remainder', () => {
        const groups = Array.from({ length: 13 }, (_, i) => row(`k-${i}`, 100 - i, 10, 2));
        const folded = foldBreakdown(groups);

        expect(folded.rows).toHaveLength(11);
        expect(folded.foldedCount).toBe(3);
        const tail = folded.rows[10];
        expect(tail.key).toBe(BREAKDOWN_EVERYTHING_ELSE_KEY);
        expect(tail.credits).toBe(90 + 89 + 88);
        expect(tail.costCents).toBe(30);
        expect(tail.calls).toBe(6);
        const sum = folded.rows.reduce((total, r) => total + r.credits, 0);
        expect(sum).toBe(folded.totalCredits);
    });

    it('ranks by credits, then cost, then key, deterministically', () => {
        const folded = foldBreakdown([row('b', 5, 1), row('a', 5, 1), row('c', 5, 9), row('d', 7)]);
        expect(folded.rows.map((r) => r.key)).toEqual(['d', 'c', 'a', 'b']);
    });

    it('keeps the NULL row last and never folds it', () => {
        const groups = [
            ...Array.from({ length: 11 }, (_, i) => row(`m-${i}`, 50 - i)),
            row(null, 1),
        ];
        const folded = foldBreakdown(groups);
        const last = folded.rows[folded.rows.length - 1];
        expect(last.key).toBeNull();
        expect(last.credits).toBe(1);
        expect(folded.rows[folded.rows.length - 2].key).toBe(BREAKDOWN_EVERYTHING_ELSE_KEY);
    });

    it('returns every row unfolded on request', () => {
        const groups = Array.from({ length: 13 }, (_, i) => row(`k-${i}`, 20 - i));
        const folded = foldBreakdown(groups, { full: true });
        expect(folded.rows).toHaveLength(13);
        expect(folded.foldedCount).toBe(0);
    });

    it('shares by cost when nothing drew credits (own-key spend), and never divides by zero', () => {
        const byCost = foldBreakdown([row('a', 0, 75), row('b', 0, 25)]);
        expect(byCost.rows.map((r) => r.sharePercent)).toEqual([75, 25]);
        const empty = foldBreakdown([row('a', 0, 0)]);
        expect(empty.rows[0].sharePercent).toBe(0);
    });
});

describe('foldMeterTotals', () => {
    it('always reports the three meters in order, with null cost for a meter with no rows', () => {
        const { meters, preMeterResidual } = foldMeterTotals([]);
        expect(meters.map((m) => m.meter)).toEqual(['model', 'credits', 'addon']);
        for (const meter of meters) {
            expect(meter.calls).toBe(0);
            expect(meter.costCents).toBeNull();
            expect(meter.credits).toBe(0);
        }
        expect(preMeterResidual).toBeNull();
    });

    it('sums each meter and counts cached, failed and unconfirmed calls', () => {
        const { meters } = foldMeterTotals([
            {
                meter: 'credits',
                outcome: 'ok',
                payer: 'platform',
                calls: 4,
                costCents: 4,
                credits: 8,
            },
            {
                meter: 'credits',
                outcome: 'cached',
                payer: 'platform',
                calls: 2,
                costCents: 0,
                credits: 0,
            },
            {
                meter: 'credits',
                outcome: 'failed',
                payer: 'unconfirmed',
                calls: 1,
                costCents: 0,
                credits: 0,
            },
            {
                meter: 'model',
                outcome: 'ok',
                payer: 'workspace',
                calls: 3,
                costCents: 120,
                credits: 0,
            },
        ]);
        const credits = meters.find((m) => m.meter === 'credits');
        expect(credits).toEqual({
            meter: 'credits',
            calls: 7,
            costCents: 4,
            credits: 8,
            cachedCalls: 2,
            failedCalls: 1,
            unconfirmedCalls: 1,
        });
        expect(meters.find((m) => m.meter === 'model')).toMatchObject({
            calls: 3,
            costCents: 120,
            credits: 0,
        });
        expect(meters.find((m) => m.meter === 'addon')).toMatchObject({
            calls: 0,
            costCents: null,
        });
    });

    it('never folds rows recorded before meters into a named meter', () => {
        const { meters, preMeterResidual } = foldMeterTotals([
            { meter: null, outcome: null, payer: null, calls: 9, costCents: 84, credits: 0 },
        ]);
        expect(meters.every((m) => m.calls === 0)).toBe(true);
        expect(preMeterResidual).toEqual({ calls: 9, costCents: 84 });
    });
});

describe('foldRunMeters', () => {
    const line = (overrides: Record<string, unknown>) => ({
        meter: 'credits',
        priceKey: 'search.query',
        priceVersion: 1,
        capability: 'search',
        outcome: 'ok',
        payer: 'platform',
        calls: 1,
        costCents: 0,
        creditsCharged: 0,
        ...overrides,
    });

    it('is null for a run with no retained rows', () => {
        expect(foldRunMeters([])).toBeNull();
    });

    it('echoes the settlement mode only when one is given', () => {
        expect(foldRunMeters([line({ calls: 1, creditsCharged: 2 })])).not.toHaveProperty(
            'settlementMode',
        );
        expect(
            foldRunMeters([line({ calls: 1, creditsCharged: 2 })], 'provider_cost')?.settlementMode,
        ).toBe('provider_cost');
        expect(foldRunMeters([line({})], 'price_list')?.settlementMode).toBe('price_list');
        expect(foldRunMeters([], 'price_list')).toBeNull();
    });

    it('itemises credits per kind of call with charged, cached and failed counts', () => {
        const meters = foldRunMeters([
            line({ calls: 4, creditsCharged: 8 }),
            line({ outcome: 'cached', calls: 2 }),
            line({
                priceKey: 'extractor.page',
                capability: 'extractor',
                outcome: 'failed',
                priceVersion: 1,
            }),
            line({
                priceKey: 'extractor.page',
                capability: 'extractor',
                calls: 1,
                creditsCharged: 3,
            }),
        ]);
        expect(meters?.credits.credits).toBe(11);
        expect(meters?.credits.calls).toBe(8);
        expect(meters?.credits.lines).toEqual([
            {
                priceKey: 'search.query',
                capability: 'search',
                calls: 6,
                chargedCalls: 4,
                cachedCalls: 2,
                failedCalls: 0,
                unconfirmedCalls: 0,
                credits: 8,
                costCents: 0,
            },
            {
                priceKey: 'extractor.page',
                capability: 'extractor',
                calls: 2,
                chargedCalls: 1,
                cachedCalls: 0,
                failedCalls: 1,
                unconfirmedCalls: 0,
                credits: 3,
                costCents: 0,
            },
        ]);
        expect(meters?.priceVersions).toEqual([1]);
    });

    it('keeps own-account model usage, add-ons and pre-meter rows apart from credits', () => {
        const meters = foldRunMeters([
            line({
                meter: 'model',
                payer: 'workspace',
                priceVersion: null,
                calls: 3,
                costCents: 31,
            }),
            line({ meter: 'addon', priceKey: 'email.send', priceVersion: null, calls: 1 }),
            line({
                meter: null,
                priceKey: null,
                priceVersion: null,
                payer: null,
                calls: 5,
                costCents: 9,
            }),
            line({ payer: 'unconfirmed', calls: 1, creditsCharged: 2 }),
        ]);
        expect(meters?.model).toEqual({ calls: 3, costCents: 31 });
        expect(meters?.addon).toEqual({ calls: 1 });
        expect(meters?.preMeterCalls).toBe(5);
        expect(meters?.credits.lines[0].unconfirmedCalls).toBe(1);
    });
});
