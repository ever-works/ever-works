import type { ModelListPriceListVersion } from '@ever-works/contracts';
import { MODEL_LIST_PRICEBOOK_HISTORY, MODEL_LIST_PRICEBOOK_VERSION } from '../model-list-pricebook';
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
                if (entry.provider === 'claude-code') expect(entry.perMillionUsd.cacheWrite).toBeGreaterThan(0);
            }
        }
    });

    it('lists every family once', () => {
        const models = MODEL_LIST_PRICEBOOK_HISTORY[MODEL_LIST_PRICEBOOK_VERSION].entries.map((e) => e.model);
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

    it('answers null for an unknown model — never zero', () => {
        expect(prices.price({ in: 10, out: 10, cacheRead: 0, cacheWrite: 0 }, 'local-7b')).toBeNull();
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
            entries: [{ ...v1.entries[0], perMillionUsd: { in: 2, out: 2, cacheRead: 2, cacheWrite: 0 } }],
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
