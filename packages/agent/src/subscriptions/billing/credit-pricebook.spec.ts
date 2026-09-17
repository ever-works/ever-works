import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { CREDIT_PRICE_BASES, CREDIT_PRICE_GROUPS } from '@ever-works/contracts';
import { PluginUsageCapability } from '@src/entities/plugin-usage-event.entity';
import {
    CREDIT_PRICEBOOK,
    CREDIT_PRICEBOOK_EFFECTIVE_FROM,
    CREDIT_PRICEBOOK_HISTORY,
    CREDIT_PRICEBOOK_VERSION,
    creditsForProviderCostCents,
    priceFor,
} from './credit-pricebook';
import { PublishedCreditPriceList } from '../../usage/credit-price-list';

/**
 * AW-17 — the published credit price list. A code table on purpose, like the
 * credit-pack table beside it: a price change ships with these assertions.
 */

/** Every plugin id registered in the monorepo, read from the plugin manifests. */
function registeredPluginIds(): string[] {
    const pluginsDir = join(__dirname, '..', '..', '..', '..', 'plugins');
    if (!existsSync(pluginsDir)) {
        return [];
    }
    const ids: string[] = [];
    for (const entry of readdirSync(pluginsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const manifestPath = join(pluginsDir, entry.name, 'package.json');
        if (!existsSync(manifestPath)) continue;
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
            everworks?: { plugin?: { id?: string } };
        };
        const id = manifest.everworks?.plugin?.id;
        if (typeof id === 'string' && id.length > 0) {
            ids.push(id);
        }
        ids.push(entry.name);
    }
    return ids;
}

describe('credit pricebook (published price list)', () => {
    it('gives every per-unit entry a positive whole price and a unit', () => {
        const perUnit = CREDIT_PRICEBOOK.filter((entry) => entry.basis === 'per-unit');
        expect(perUnit.length).toBeGreaterThan(0);
        for (const entry of perUnit) {
            expect(Number.isInteger(entry.credits)).toBe(true);
            expect(entry.credits as number).toBeGreaterThan(0);
            expect(entry.unit.length).toBeGreaterThan(0);
        }
    });

    it('gives provider-cost entries no fixed number — their price is the provider cost', () => {
        for (const entry of CREDIT_PRICEBOOK.filter((e) => e.basis === 'provider-cost')) {
            expect(entry.credits).toBeNull();
            expect(entry.unit.length).toBeGreaterThan(0);
        }
    });

    it('uses only the published bases and groups, with unique keys', () => {
        const keys = CREDIT_PRICEBOOK.map((entry) => entry.key);
        expect(new Set(keys).size).toBe(keys.length);
        for (const entry of CREDIT_PRICEBOOK) {
            expect(CREDIT_PRICE_BASES).toContain(entry.basis);
            expect(CREDIT_PRICE_GROUPS).toContain(entry.group);
        }
    });

    it('publishes the research prices an owner can read before a call', () => {
        const price = (key: string) => CREDIT_PRICEBOOK.find((entry) => entry.key === key);
        expect(price('search.query')).toMatchObject({ basis: 'per-unit', credits: 2 });
        expect(price('extractor.page')).toMatchObject({ basis: 'per-unit', credits: 3 });
        expect(price('screenshot.capture')).toMatchObject({ basis: 'per-unit', credits: 4 });
        expect(price('ai.managed')).toMatchObject({ basis: 'provider-cost', credits: null });
    });

    it('keys every entry on a capability the platform records — capability.operation', () => {
        const capabilities = new Set<string>(Object.values(PluginUsageCapability));
        for (const entry of CREDIT_PRICEBOOK) {
            const [capability, operation] = entry.key.split('.');
            expect(operation).toBeTruthy();
            expect(capabilities.has(capability)).toBe(true);
        }
    });

    it('never names a price key after a registered plugin (Constitution II)', () => {
        const pluginIds = registeredPluginIds();
        expect(pluginIds.length).toBeGreaterThan(0);
        for (const entry of CREDIT_PRICEBOOK) {
            expect(pluginIds).not.toContain(entry.key);
            // Neither half of the key may be a plugin id either: a key like
            // `tavily.query` would tie the price to one provider.
            for (const part of entry.key.split('.')) {
                expect(pluginIds).not.toContain(part);
            }
        }
    });

    it('keeps every version from 1 to the current in a frozen history', () => {
        for (let version = 1; version <= CREDIT_PRICEBOOK_VERSION; version++) {
            expect(CREDIT_PRICEBOOK_HISTORY[version]).toBeDefined();
            expect(CREDIT_PRICEBOOK_HISTORY[version].version).toBe(version);
        }
        expect(Object.isFrozen(CREDIT_PRICEBOOK_HISTORY)).toBe(true);
        const current = CREDIT_PRICEBOOK_HISTORY[CREDIT_PRICEBOOK_VERSION];
        expect(Object.isFrozen(current)).toBe(true);
        expect(Object.isFrozen(current.entries)).toBe(true);
        expect(current.effectiveFrom).toBe(CREDIT_PRICEBOOK_EFFECTIVE_FROM);
        expect(current.entries).toBe(CREDIT_PRICEBOOK);
        expect(() => {
            (current.entries[0] as { credits: number | null }).credits = 999;
        }).toThrow();
    });

    describe('priceFor', () => {
        const search = { basis: 'per-unit' as const, credits: 2 };

        it('prices ok calls per unit', () => {
            expect(priceFor(search, 1)).toBe(2);
            expect(priceFor(search, 3, 'ok')).toBe(6);
        });

        it('zero-rates cached and failed calls', () => {
            expect(priceFor(search, 5, 'cached')).toBe(0);
            expect(priceFor(search, 5, 'failed')).toBe(0);
        });

        it('never charges for a negative or non-finite unit count', () => {
            expect(priceFor(search, -4)).toBe(0);
            expect(priceFor(search, Number.NaN)).toBe(0);
        });

        it('returns null for a provider-cost entry', () => {
            expect(priceFor({ basis: 'provider-cost', credits: null }, 10)).toBeNull();
        });
    });

    describe('creditsForProviderCostCents', () => {
        it('converts at the rate and margin and rounds up', () => {
            expect(creditsForProviderCostCents(10, 100, 0)).toBe(10);
            expect(creditsForProviderCostCents(10, 100, 35)).toBe(14); // 13.5 → 14
            expect(creditsForProviderCostCents(0.2, 100, 0)).toBe(1);
        });

        it('converts nothing for zero, negative or non-finite cost', () => {
            expect(creditsForProviderCostCents(0, 100, 35)).toBe(0);
            expect(creditsForProviderCostCents(-3, 100, 35)).toBe(0);
            expect(creditsForProviderCostCents(Number.POSITIVE_INFINITY, 100, 35)).toBe(0);
        });
    });
});

describe('PublishedCreditPriceList (the default price-list port)', () => {
    it('serves the current version and every published version', () => {
        const list = new PublishedCreditPriceList();
        expect(list.currentVersion).toBe(CREDIT_PRICEBOOK_VERSION);
        expect(list.versions()).toEqual(
            Array.from({ length: CREDIT_PRICEBOOK_VERSION }, (_, i) => i + 1),
        );
        expect(list.getVersion()?.entries.map((e) => e.key)).toEqual(
            CREDIT_PRICEBOOK.map((e) => e.key),
        );
    });

    it('finds entries by key and returns null for an unlisted key or version', () => {
        const list = new PublishedCreditPriceList();
        expect(list.find('search.query')?.credits).toBe(2);
        expect(list.find('search.unknown')).toBeNull();
        expect(list.getVersion(999)).toBeNull();
        expect(list.find('search.query', 999)).toBeNull();
    });

    it('hands out copies — a caller cannot re-price the published list', () => {
        const list = new PublishedCreditPriceList();
        const entry = list.find('search.query');
        (entry as { credits: number | null }).credits = 0;
        expect(list.find('search.query')?.credits).toBe(2);
    });

    it('is replaceable: any history and current version can be bound', () => {
        const list = new PublishedCreditPriceList(
            {
                1: { version: 1, effectiveFrom: '2026-01-01', entries: [] },
                2: {
                    version: 2,
                    effectiveFrom: '2026-02-01',
                    entries: [
                        {
                            key: 'search.query',
                            group: 'research',
                            basis: 'per-unit',
                            credits: 5,
                            unit: 'query',
                        },
                    ],
                },
            },
            2,
        );
        expect(list.versions()).toEqual([1, 2]);
        expect(list.find('search.query')?.credits).toBe(5);
        expect(list.find('search.query', 1)).toBeNull();
    });

    it('refuses a current version missing from its own history', () => {
        expect(() => new PublishedCreditPriceList({}, 1)).toThrow(/not in its history/);
    });
});
