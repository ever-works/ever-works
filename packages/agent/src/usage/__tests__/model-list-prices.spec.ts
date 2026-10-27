import type { ModelListPriceListVersion } from '@ever-works/contracts';
import {
    MODEL_LIST_PRICEBOOK_HISTORY,
    MODEL_LIST_PRICEBOOK_VERSION,
    MODEL_LIST_PRICEBOOK_V2_CORRECTIONS,
} from '../model-list-pricebook';
import { PublishedModelListPrices } from '../model-list-prices';

/** FL-20 (CONTRACTS R-30) — the published model list prices and the port over them. */
describe('model list pricebook', () => {
    it('publishes ascending versions, the current one included', () => {
        const versions = Object.keys(MODEL_LIST_PRICEBOOK_HISTORY).map(Number);
        expect(versions).toEqual([...versions].sort((a, b) => a - b));
        expect(MODEL_LIST_PRICEBOOK_HISTORY[MODEL_LIST_PRICEBOOK_VERSION]).toBeDefined();
    });

    it('charges a positive input and output rate for every entry, and never a negative one', () => {
        for (const version of Object.values(MODEL_LIST_PRICEBOOK_HISTORY)) {
            for (const entry of version.entries) {
                expect(entry.perMillionUsd.in).toBeGreaterThan(0);
                expect(entry.perMillionUsd.out).toBeGreaterThan(0);
                expect(entry.perMillionUsd.cacheRead).toBeGreaterThan(0);
                expect(entry.perMillionUsd.cacheWrite).toBeGreaterThanOrEqual(0);
                // Only the Codex (OpenAI) families bill no cache write.
                if (entry.provider === 'claude-code')
                    expect(entry.perMillionUsd.cacheWrite).toBeGreaterThan(0);
            }
        }
    });

    it('lists every family once', () => {
        const models = MODEL_LIST_PRICEBOOK_HISTORY[MODEL_LIST_PRICEBOOK_VERSION].entries.map(
            (e) => e.model,
        );
        expect(new Set(models).size).toBe(models.length);
    });
});

describe('PublishedModelListPrices', () => {
    const prices = new PublishedModelListPrices();

    it('prices the four classes separately at the current version', () => {
        const priced = prices.price(
            { in: 1_000_000, out: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 },
            'claude-sonnet-4-5-20250929',
        );
        // $3 + $15 + $0.30 + $3.75 = $22.05
        expect(priced?.cents).toBeCloseTo(2205, 6);
        expect(priced?.version).toBe(MODEL_LIST_PRICEBOOK_VERSION);
        expect(priced?.model).toBe('claude-sonnet-4-5');
    });

    it('matches a family exactly or with a release suffix — a newer model is never priced as an older one', () => {
        expect(prices.find('claude-opus-5-5')?.model).toBe('claude-opus-5-5');
        expect(prices.find('claude-opus-5')?.model).toBe('claude-opus-5');
        expect(prices.find('claude-sonnet-4-6[1m]')?.model).toBe('claude-sonnet-4-6');
        expect(prices.find('claude-haiku-4-5-20251001')?.model).toBe('claude-haiku-4-5');
        expect(prices.find('claude-mythos-5-1')?.model).toBe('claude-fable-5-1');
        expect(prices.find('claude-opus-5-6')).toBeNull();
    });

    it('answers null for an unknown model — never zero', () => {
        expect(
            prices.price({ in: 10, out: 10, cacheRead: 0, cacheWrite: 0 }, 'local-7b'),
        ).toBeNull();
        expect(prices.find('claude-opus-9')).toBeNull();
    });

    it('keeps old versions for figures priced at them, and refuses a version it never published', () => {
        const v1: ModelListPriceListVersion = {
            version: 1,
            effectiveFrom: '2026-01-01',
            entries: [
                {
                    model: 'm',
                    provider: 'codex',
                    match: ['m'],
                    perMillionUsd: { in: 1, out: 1, cacheRead: 1, cacheWrite: 0 },
                },
            ],
        };
        const v2: ModelListPriceListVersion = {
            ...v1,
            version: 2,
            effectiveFrom: '2026-10-12',
            entries: [
                { ...v1.entries[0], perMillionUsd: { in: 2, out: 2, cacheRead: 2, cacheWrite: 0 } },
            ],
        };
        const book = new PublishedModelListPrices({ 1: v1, 2: v2 }, 2);
        const tokens = { in: 1_000_000, out: 0, cacheRead: 0, cacheWrite: 0 };
        expect(book.versions()).toEqual([1, 2]);
        expect(book.price(tokens, 'm', 1)?.cents).toBeCloseTo(100, 6);
        expect(book.price(tokens, 'm')?.cents).toBeCloseTo(200, 6);
        expect(book.price(tokens, 'm', 3)).toBeNull();
        expect(() => new PublishedModelListPrices({ 1: v1 }, 2)).toThrow();
    });

    it('hands out copies, never the frozen table', () => {
        const entry = prices.find('gpt-5-codex')!;
        (entry.perMillionUsd as { in: number }).in = 999;
        expect(prices.find('gpt-5-codex')!.perMillionUsd.in).toBe(1.25);
    });
});

/**
 * FL-20 owner decision (2026-10-27) — the price list is checked against the vendors' live
 * pricing pages before the flag goes on. v2 = v1 with the corrections the pages showed.
 */
describe('model list pricebook v2 (verified 2026-10-27)', () => {
    const v1 = MODEL_LIST_PRICEBOOK_HISTORY[1];
    const v2 = MODEL_LIST_PRICEBOOK_HISTORY[2];
    const rates = (version: typeof v1, model: string) =>
        version.entries.find((entry) => entry.model === model)!.perMillionUsd;

    it('is the current version, effective 2026-10-27, and keeps v1 published for figures priced at it', () => {
        expect(MODEL_LIST_PRICEBOOK_VERSION).toBe(2);
        expect(v2.version).toBe(2);
        expect(v2.effectiveFrom).toBe('2026-10-27');
        expect(v1.version).toBe(1);
        expect(v1.effectiveFrom).toBe('2026-10-26');
    });

    it('corrects Claude Sonnet 5.5’s cache read to $0.10 and leaves v1’s $0.20 untouched', () => {
        expect(rates(v2, 'claude-sonnet-5-5')).toEqual({
            in: 2,
            out: 10,
            cacheRead: 0.1,
            cacheWrite: 2.5,
        });
        expect(rates(v1, 'claude-sonnet-5-5')).toEqual({
            in: 2,
            out: 10,
            cacheRead: 0.2,
            cacheWrite: 2.5,
        });
    });

    it('differs from v1 only by the recorded corrections — same families, same ids, same order', () => {
        expect(v2.entries.map((entry) => entry.model)).toEqual(
            v1.entries.map((entry) => entry.model),
        );
        for (const [index, entry] of v2.entries.entries()) {
            const before = v1.entries[index];
            expect(entry.match).toEqual(before.match);
            expect(entry.provider).toBe(before.provider);
            expect(entry.perMillionUsd).toEqual({
                ...before.perMillionUsd,
                ...MODEL_LIST_PRICEBOOK_V2_CORRECTIONS[entry.model],
            });
        }
        expect(Object.keys(MODEL_LIST_PRICEBOOK_V2_CORRECTIONS)).toEqual(['claude-sonnet-5-5']);
    });

    it('pins the verified rates of the current families (vendor pages, 2026-10-27)', () => {
        expect(rates(v2, 'claude-fable-5-1')).toEqual({
            in: 10,
            out: 50,
            cacheRead: 0.25,
            cacheWrite: 12.5,
        });
        expect(rates(v2, 'claude-fable-5')).toEqual({
            in: 10,
            out: 50,
            cacheRead: 1,
            cacheWrite: 12.5,
        });
        expect(rates(v2, 'claude-opus-5-5')).toEqual({
            in: 4,
            out: 20,
            cacheRead: 0.2,
            cacheWrite: 5,
        });
        expect(rates(v2, 'claude-opus-5')).toEqual({
            in: 5,
            out: 25,
            cacheRead: 0.5,
            cacheWrite: 6.25,
        });
        expect(rates(v2, 'claude-sonnet-5')).toEqual({
            in: 2,
            out: 10,
            cacheRead: 0.2,
            cacheWrite: 2.5,
        });
        expect(rates(v2, 'claude-sonnet-4-6')).toEqual({
            in: 3,
            out: 15,
            cacheRead: 0.3,
            cacheWrite: 3.75,
        });
        expect(rates(v2, 'claude-haiku-5-5')).toEqual({
            in: 0.1,
            out: 0.5,
            cacheRead: 0.01,
            cacheWrite: 0.125,
        });
        expect(rates(v2, 'claude-haiku-4-5')).toEqual({
            in: 1,
            out: 5,
            cacheRead: 0.1,
            cacheWrite: 1.25,
        });
        expect(rates(v2, 'gpt-5')).toEqual({ in: 1.25, out: 10, cacheRead: 0.125, cacheWrite: 0 });
        expect(rates(v2, 'o4-mini')).toEqual({
            in: 1.1,
            out: 4.4,
            cacheRead: 0.275,
            cacheWrite: 0,
        });
    });

    it('takes every listed Claude 5-minute cache write as 1.25 x input, as the vendor page states for every model', () => {
        // Retired and absent from the page: kept at v1's rates, marked unverified in the lane log.
        const unlisted = new Set([
            'claude-3-7-sonnet',
            'claude-3-5-sonnet',
            'claude-3-haiku',
            'claude-3-opus',
        ]);
        for (const entry of v2.entries) {
            if (entry.provider !== 'claude-code' || unlisted.has(entry.model)) continue;
            expect(entry.perMillionUsd.cacheWrite).toBeCloseTo(entry.perMillionUsd.in * 1.25, 9);
        }
    });

    it('prices new figures at v2: Sonnet 5.5 cache reads at the corrected rate', () => {
        const priced = new PublishedModelListPrices().price(
            { in: 0, out: 0, cacheRead: 1_000_000, cacheWrite: 0 },
            'claude-sonnet-5-5',
        );
        expect(priced?.cents).toBeCloseTo(10, 9);
        expect(priced?.version).toBe(2);
        expect(priced?.model).toBe('claude-sonnet-5-5');
    });
});
