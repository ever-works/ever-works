import {
    APP_LAUNCHER_MAX_ITEMS_RESPONSE,
    APP_LAUNCHER_PANEL_PLATFORMS_MAX,
    APP_LAUNCHER_PANEL_WORKS_MAX,
    APP_LAUNCHER_PIN_LIMIT,
} from '@ever-works/contracts';
import {
    LAUNCHER_GLOBAL_SCOPE_KEY,
    LAUNCHER_PERSONAL_SCOPE_KEY,
    countMergedPins,
    isMergedPinLimitExceeded,
    mergeLauncherPreferences,
    mergedPinnedKeys,
    orderLauncherItems,
    reorderSection,
    type LauncherOrderPreference,
    type LauncherOrderableItem,
} from '../launcher-order';

/**
 * APW-11 T4 — spec FR-4 (`spec.md:192-193`), FR-24/FR-25 (`spec.md:285-288`),
 * FR-26 (`spec.md:289-290`), FR-27 (`spec.md:291-293`), FR-56
 * (`spec.md:245-247`), FR-62 (`spec.md:298-302`) and FR-63 (`spec.md:303-305`);
 * ACC-11-14, ACC-11-47; plan §10.1's `launcher-order.spec.ts` row
 * (plan.md:939).
 *
 * Every cap is imported from `@ever-works/contracts` rather than written as a
 * literal, so this file cannot pass while the panel and the save path disagree
 * about what the limit is.
 */

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

const T1 = new Date('2026-01-01T00:00:00.000Z');
const T2 = new Date('2026-02-01T00:00:00.000Z');
const T3 = new Date('2026-03-01T00:00:00.000Z');

function platform(key: string, catalogOrder: number, name = key): LauncherOrderableItem {
    return { key: `platform:${key}`, kind: 'platform', catalogOrder, name };
}

function work(key: string, readyAt: Date | null, name = key): LauncherOrderableItem {
    return { key: `work:${key}`, kind: 'work', readyAt, name };
}

describe('mergeLauncherPreferences', () => {
    it('defaults a key with no stored row to shown and not pinned', () => {
        const merged = mergeLauncherPreferences([], ['global']);
        expect(merged.size).toBe(0);
    });

    it('ignores rows in scopes the request did not ask for', () => {
        const rows: LauncherOrderPreference[] = [
            { key: 'work:a', scopeKey: ORG_A, pinned: true },
            { key: 'work:b', scopeKey: ORG_B, pinned: true },
        ];
        const merged = mergeLauncherPreferences(rows, [LAUNCHER_GLOBAL_SCOPE_KEY, ORG_A]);

        expect([...merged.keys()]).toEqual(['work:a']);
    });

    it('lets the more specific scope win when a key exists in both', () => {
        const rows: LauncherOrderPreference[] = [
            {
                key: 'platform:ever-gauzy',
                scopeKey: LAUNCHER_GLOBAL_SCOPE_KEY,
                visible: true,
                pinned: true,
            },
            { key: 'platform:ever-gauzy', scopeKey: ORG_A, visible: false, pinned: false },
        ];
        const merged = mergeLauncherPreferences(rows, [LAUNCHER_GLOBAL_SCOPE_KEY, ORG_A]);

        expect(merged.get('platform:ever-gauzy')).toMatchObject({ visible: false, pinned: false });
    });
});

describe('the merged global ∪ scope pinned view (FR-62, ACC-11-47)', () => {
    const rows: LauncherOrderPreference[] = [
        {
            key: 'platform:ever-gauzy',
            scopeKey: LAUNCHER_GLOBAL_SCOPE_KEY,
            pinned: true,
            pinOrder: 1,
            updatedAt: T1,
        },
        { key: 'work:in-a', scopeKey: ORG_A, pinned: true, pinOrder: 0, updatedAt: T1 },
        { key: 'work:in-b', scopeKey: ORG_B, pinned: true, pinOrder: 0, updatedAt: T1 },
    ];

    it("counts Ever app pins together with the active Organization's pins", () => {
        expect(mergedPinnedKeys(rows, [LAUNCHER_GLOBAL_SCOPE_KEY, ORG_A])).toEqual([
            'work:in-a',
            'platform:ever-gauzy',
        ]);
        expect(mergedPinnedKeys(rows, [LAUNCHER_GLOBAL_SCOPE_KEY, ORG_B])).toEqual([
            'work:in-b',
            'platform:ever-gauzy',
        ]);
    });

    it("never counts another Organization's pin — a pin in B does not renumber A", () => {
        expect(mergedPinnedKeys(rows, [LAUNCHER_GLOBAL_SCOPE_KEY, ORG_A])).not.toContain(
            'work:in-b',
        );
        expect(countMergedPins(rows, [LAUNCHER_GLOBAL_SCOPE_KEY, ORG_A])).toBe(2);
    });

    it('lets A keep six while B is at six — each read shows its own first six', () => {
        const sixFor = (scope: string): LauncherOrderPreference[] =>
            Array.from({ length: APP_LAUNCHER_PIN_LIMIT }, (_, index) => ({
                key: `work:${scope}-${index}`,
                scopeKey: scope,
                pinned: true,
                pinOrder: index,
                updatedAt: new Date(T1.getTime() + index * 1000),
            }));
        const both = [...sixFor(ORG_A), ...sixFor(ORG_B)];

        expect(countMergedPins(both, [LAUNCHER_GLOBAL_SCOPE_KEY, ORG_A])).toBe(
            APP_LAUNCHER_PIN_LIMIT,
        );
        expect(countMergedPins(both, [LAUNCHER_GLOBAL_SCOPE_KEY, ORG_B])).toBe(
            APP_LAUNCHER_PIN_LIMIT,
        );
        expect(isMergedPinLimitExceeded(both, [LAUNCHER_GLOBAL_SCOPE_KEY, ORG_A])).toBe(false);
    });

    it("evaluates the pin limit over the merged view, not over one scope's rows", () => {
        const fourGlobal: LauncherOrderPreference[] = Array.from({ length: 4 }, (_, index) => ({
            key: `platform:p${index}`,
            scopeKey: LAUNCHER_GLOBAL_SCOPE_KEY,
            pinned: true,
            pinOrder: index,
            updatedAt: T1,
        }));
        const twoOrg: LauncherOrderPreference[] = Array.from({ length: 2 }, (_, index) => ({
            key: `work:w${index}`,
            scopeKey: ORG_A,
            pinned: true,
            pinOrder: index,
            updatedAt: T1,
        }));

        // 4 + 2 = 6 → room for one more.
        expect(
            isMergedPinLimitExceeded(
                [...fourGlobal, ...twoOrg],
                [LAUNCHER_GLOBAL_SCOPE_KEY, ORG_A],
            ),
        ).toBe(false);
        // 4 + 3 = 7 → the whole save must be refused (FR-25).
        expect(
            isMergedPinLimitExceeded(
                [
                    ...fourGlobal,
                    ...twoOrg,
                    { key: 'work:w2', scopeKey: ORG_A, pinned: true, updatedAt: T1 },
                ],
                [LAUNCHER_GLOBAL_SCOPE_KEY, ORG_A],
            ),
        ).toBe(true);
    });

    it('orders pins by pinOrder, then by pin time, then by key', () => {
        const pins: LauncherOrderPreference[] = [
            { key: 'work:late', scopeKey: ORG_A, pinned: true, updatedAt: T3 },
            { key: 'work:early', scopeKey: ORG_A, pinned: true, updatedAt: T1 },
            { key: 'work:first', scopeKey: ORG_A, pinned: true, pinOrder: 0, updatedAt: T3 },
        ];

        expect(mergedPinnedKeys(pins, [LAUNCHER_GLOBAL_SCOPE_KEY, ORG_A])).toEqual([
            'work:first',
            'work:early',
            'work:late',
        ]);
    });
});

describe('orderLauncherItems — FR-26', () => {
    it('renders Pinned, then Ever apps, then Your apps (FR-2)', () => {
        const result = orderLauncherItems(
            [work('w1', T1), platform('ever-gauzy', 20), work('w2', T2)],
            [
                {
                    key: 'work:w2',
                    scopeKey: LAUNCHER_PERSONAL_SCOPE_KEY,
                    pinned: true,
                    pinOrder: 0,
                    updatedAt: T1,
                },
            ],
            { scopeKey: LAUNCHER_PERSONAL_SCOPE_KEY },
        );

        expect(result.items.map((entry) => [entry.section, entry.key])).toEqual([
            ['pinned', 'work:w2'],
            ['platforms', 'platform:ever-gauzy'],
            ['works', 'work:w1'],
        ]);
    });

    it('numbers order inside each section from zero (plan.md:171)', () => {
        const result = orderLauncherItems(
            [work('w1', T1), platform('a', 1), platform('b', 2), work('w2', T2)],
            [],
            { scopeKey: LAUNCHER_PERSONAL_SCOPE_KEY },
        );

        expect(result.items.map((entry) => [entry.key, entry.order])).toEqual([
            ['platform:a', 0],
            ['platform:b', 1],
            ['work:w2', 0],
            ['work:w1', 1],
        ]);
    });

    it('orders Ever apps by catalog order when nobody has ordered them (FR-26, ACC-11-05)', () => {
        const result = orderLauncherItems(
            [platform('third', 30), platform('first', 10), platform('second', 20)],
            [],
            { scopeKey: LAUNCHER_PERSONAL_SCOPE_KEY },
        );

        expect(result.items.map((entry) => entry.key)).toEqual([
            'platform:first',
            'platform:second',
            'platform:third',
        ]);
    });

    it("lets the person's order beat the catalog order, and only for the items they ordered", () => {
        const result = orderLauncherItems(
            [platform('a', 10), platform('b', 20), platform('c', 30)],
            [{ key: 'platform:c', scopeKey: LAUNCHER_GLOBAL_SCOPE_KEY, sortOrder: 0 }],
            { scopeKey: LAUNCHER_PERSONAL_SCOPE_KEY },
        );

        expect(result.items.map((entry) => entry.key)).toEqual([
            'platform:c',
            'platform:a',
            'platform:b',
        ]);
    });

    it('orders Works by the newest successful production deployment, newest first (FR-26)', () => {
        const result = orderLauncherItems(
            [
                work('oldest', T1),
                work('newest', T3),
                work('never-deployed', null),
                work('middle', T2),
            ],
            [],
            { scopeKey: LAUNCHER_PERSONAL_SCOPE_KEY },
        );

        expect(result.items.map((entry) => entry.key)).toEqual([
            'work:newest',
            'work:middle',
            'work:oldest',
            'work:never-deployed',
        ]);
    });

    it('falls back to the name and then the key when two items tie', () => {
        const result = orderLauncherItems(
            [
                { key: 'work:zzz', kind: 'work', readyAt: T1, name: 'Umami' },
                { key: 'work:aaa', kind: 'work', readyAt: T1, name: 'Umami' },
                { key: 'work:mmm', kind: 'work', readyAt: T1, name: 'Analytics' },
            ],
            [],
            { scopeKey: LAUNCHER_PERSONAL_SCOPE_KEY },
        );

        expect(result.items.map((entry) => entry.key)).toEqual([
            'work:mmm',
            'work:aaa',
            'work:zzz',
        ]);
    });

    it('is a total order — shuffling the input cannot change the rendering (stable-order rule)', () => {
        const items = [
            work('w1', T1, 'Umami'),
            work('w2', null, 'Sourdough'),
            platform('a', 10, 'Ever Gauzy'),
            platform('b', 10, 'Ever Teams'),
            work('w3', T2, 'Umami'),
        ];
        const preferences: LauncherOrderPreference[] = [
            {
                key: 'work:w2',
                scopeKey: LAUNCHER_PERSONAL_SCOPE_KEY,
                pinned: true,
                pinOrder: 0,
                updatedAt: T1,
            },
            { key: 'platform:b', scopeKey: LAUNCHER_GLOBAL_SCOPE_KEY, sortOrder: 0 },
        ];

        const expected = orderLauncherItems(items, preferences, {
            scopeKey: LAUNCHER_PERSONAL_SCOPE_KEY,
        }).items.map((entry) => entry.key);

        const shuffles = [
            [...items].reverse(),
            [items[2], items[0], items[4], items[1], items[3]],
            [items[4], items[3], items[2], items[1], items[0]],
        ];
        for (const shuffled of shuffles) {
            expect(
                orderLauncherItems(shuffled, preferences, {
                    scopeKey: LAUNCHER_PERSONAL_SCOPE_KEY,
                }).items.map((entry) => entry.key),
            ).toEqual(expected);
        }

        // And the order is the documented one, not an accident of the input.
        expect(expected).toEqual(['work:w2', 'platform:b', 'platform:a', 'work:w3', 'work:w1']);
    });
});

describe('orderLauncherItems — FR-4 panel maxima vs FR-34 response cap', () => {
    it('renders 24 Work tiles and reports worksTotal 140 (ACC-11-14)', () => {
        const works = Array.from({ length: 140 }, (_, index) =>
            work(`w${String(index).padStart(3, '0')}`, new Date(T1.getTime() + index * 1000)),
        );

        const result = orderLauncherItems(works, [], { scopeKey: LAUNCHER_PERSONAL_SCOPE_KEY });

        expect(result.items).toHaveLength(APP_LAUNCHER_PANEL_WORKS_MAX);
        expect(result.worksTotal).toBe(140);
        expect(result.truncated).toBe(true);
        // "newest first": the 24 newest are the 24 rendered.
        expect(result.items[0].key).toBe('work:w139');
        expect(result.items[APP_LAUNCHER_PANEL_WORKS_MAX - 1].key).toBe(
            `work:w${140 - APP_LAUNCHER_PANEL_WORKS_MAX}`,
        );
    });

    it('renders at most 12 Ever app tiles', () => {
        const platforms = Array.from({ length: 20 }, (_, index) => platform(`p${index}`, index));
        const result = orderLauncherItems(platforms, [], { scopeKey: LAUNCHER_PERSONAL_SCOPE_KEY });

        expect(result.items).toHaveLength(APP_LAUNCHER_PANEL_PLATFORMS_MAX);
        expect(result.worksTotal).toBe(0);
        expect(result.truncated).toBe(true);
    });

    it('renders at most 6 pinned tiles even when the merged view holds more', () => {
        const items = Array.from({ length: 8 }, (_, index) => platform(`p${index}`, index));
        const preferences: LauncherOrderPreference[] = items.map((item, index) => ({
            key: item.key,
            scopeKey: LAUNCHER_GLOBAL_SCOPE_KEY,
            pinned: true,
            pinOrder: index,
            updatedAt: new Date(T1.getTime() + index * 1000),
        }));

        const result = orderLauncherItems(items, preferences, {
            scopeKey: LAUNCHER_PERSONAL_SCOPE_KEY,
        });

        const pinned = result.items.filter((entry) => entry.section === 'pinned');
        expect(pinned).toHaveLength(APP_LAUNCHER_PIN_LIMIT);
        expect(pinned.map((entry) => entry.key)).toEqual([
            'platform:p0',
            'platform:p1',
            'platform:p2',
            'platform:p3',
            'platform:p4',
            'platform:p5',
        ]);

        // The overflow stays pinned and stays listed — never silently unpinned
        // (FR-62), never dropped from the panel.
        const overflow = result.items.filter(
            (entry) => entry.key === 'platform:p6' || entry.key === 'platform:p7',
        );
        expect(overflow.map((entry) => [entry.section, entry.pinned, entry.pinOrder])).toEqual([
            ['platforms', true, APP_LAUNCHER_PIN_LIMIT],
            ['platforms', true, APP_LAUNCHER_PIN_LIMIT + 1],
        ]);
        expect(result.pinnedTotal).toBe(8);
    });

    it('applies no section maxima to a Manage apps read and pages at the response cap', () => {
        const works = Array.from({ length: 260 }, (_, index) =>
            work(`w${String(index).padStart(3, '0')}`, new Date(T1.getTime() + index * 1000)),
        );

        const result = orderLauncherItems(works, [], {
            scopeKey: LAUNCHER_PERSONAL_SCOPE_KEY,
            includeHidden: true,
        });

        expect(result.items).toHaveLength(APP_LAUNCHER_MAX_ITEMS_RESPONSE);
        expect(result.worksTotal).toBe(260);
        expect(result.truncated).toBe(true);
    });

    it('never raises the response cap above APP_LAUNCHER_MAX_ITEMS_RESPONSE', () => {
        const works = Array.from({ length: 220 }, (_, index) =>
            work(`w${String(index).padStart(3, '0')}`, new Date(T1.getTime() + index * 1000)),
        );

        const result = orderLauncherItems(works, [], {
            scopeKey: LAUNCHER_PERSONAL_SCOPE_KEY,
            includeHidden: true,
            limit: 10_000,
        });

        expect(result.items).toHaveLength(APP_LAUNCHER_MAX_ITEMS_RESPONSE);
    });

    it('honours a smaller limit and reports truncated', () => {
        const works = Array.from({ length: 30 }, (_, index) =>
            work(`w${String(index).padStart(2, '0')}`, new Date(T1.getTime() + index * 1000)),
        );

        const result = orderLauncherItems(works, [], {
            scopeKey: LAUNCHER_PERSONAL_SCOPE_KEY,
            includeHidden: true,
            limit: 5,
        });

        expect(result.items).toHaveLength(5);
        expect(result.worksTotal).toBe(30);
        expect(result.truncated).toBe(true);
    });

    it('is not truncated when nothing was dropped', () => {
        const result = orderLauncherItems([work('w1', T1)], [], {
            scopeKey: LAUNCHER_PERSONAL_SCOPE_KEY,
        });

        expect(result.truncated).toBe(false);
        expect(result.worksTotal).toBe(1);
    });

    it('counts worksTotal before the cap but after the visibility filter', () => {
        const items = [
            work('visible', T1),
            { ...work('hidden', T1), visible: false },
            { ...work('not-live', T1), manageState: 'notLive' as const },
        ];

        const panel = orderLauncherItems(items, [], { scopeKey: LAUNCHER_PERSONAL_SCOPE_KEY });
        expect(panel.worksTotal).toBe(1);

        const manage = orderLauncherItems(items, [], {
            scopeKey: LAUNCHER_PERSONAL_SCOPE_KEY,
            includeHidden: true,
        });
        expect(manage.worksTotal).toBe(3);
    });
});

describe('orderLauncherItems — the Manage apps filter (FR-63)', () => {
    /** 250 eligible Works, named so the name order is the numeric order. */
    function bulk(count: number): LauncherOrderableItem[] {
        return Array.from({ length: count }, (_, index) =>
            work(
                `w${String(index + 1).padStart(3, '0')}`,
                null,
                `Bulk ${String(index + 1).padStart(3, '0')}`,
            ),
        );
    }

    const manage = (items: LauncherOrderableItem[], filter?: string) =>
        orderLauncherItems(items, [], {
            scopeKey: LAUNCHER_PERSONAL_SCOPE_KEY,
            includeHidden: true,
            filter,
        });

    it('reaches an item the response cap left out — the filter runs BEFORE the cap', () => {
        const items = bulk(250);

        const page = manage(items);
        expect(page.items).toHaveLength(APP_LAUNCHER_MAX_ITEMS_RESPONSE);
        // The whole point of FR-63: this item is beyond the cap…
        expect(page.items.map((entry) => entry.key)).not.toContain('work:w240');

        // …and a filter naming only it reaches it, because the filter narrows the
        // eligible set and the cap is applied to what is left.
        const filtered = manage(items, 'Bulk 240');
        expect(filtered.items.map((entry) => entry.key)).toEqual(['work:w240']);
    });

    it('counts total before the filter and before the cap, and never as items.length', () => {
        const items = bulk(250);

        const page = manage(items);
        expect(page.total).toBe(250);
        // `total` is the eligible count, never the length of a capped answer.
        expect(page.total).not.toBe(page.items.length);

        const filtered = manage(items, 'Bulk 240');
        // A filter never moves the eligible count…
        expect(filtered.total).toBe(250);

        const narrowed = orderLauncherItems(items, [], {
            scopeKey: LAUNCHER_PERSONAL_SCOPE_KEY,
            includeHidden: true,
            limit: 1,
        });
        // …and neither does a smaller limit.
        expect(narrowed.total).toBe(250);
        expect(narrowed.items).toHaveLength(1);
    });

    it('counts only the eligible set — a panel read counts what the panel may show', () => {
        const items = [
            work('visible', T1, 'Visible'),
            { ...work('hidden', T1, 'Hidden'), visible: false },
            { ...work('not-live', T1, 'Not live'), manageState: 'notLive' as const },
        ];

        expect(orderLauncherItems(items, [], { scopeKey: LAUNCHER_PERSONAL_SCOPE_KEY }).total).toBe(
            1,
        );
        expect(
            orderLauncherItems(items, [], {
                scopeKey: LAUNCHER_PERSONAL_SCOPE_KEY,
                includeHidden: true,
            }).total,
        ).toBe(3);
    });

    it('treats a blank filter as no filter at all', () => {
        const items = bulk(30);
        const unfiltered = manage(items).items.map((entry) => entry.key);

        for (const blank of ['', '   ', '\t\n ']) {
            const result = manage(items, blank);
            expect(result.items.map((entry) => entry.key)).toEqual(unfiltered);
            expect(result.total).toBe(30);
        }
    });

    it('matches case- and accent-insensitively, and matches a substring only', () => {
        const items = [work('cafe', null, 'Café Central'), work('other', null, 'Workshop')];

        for (const needle of ['CAFE CENTRAL', 'café', 'afe cen', 'Cafe']) {
            expect(manage(items, needle).items.map((entry) => entry.key)).toEqual(['work:cafe']);
        }

        // A control, so "everything matches" cannot pass for a matcher: a needle
        // no name contains returns nothing while the count stays put.
        const missing = manage(items, 'zzz');
        expect(missing.items).toEqual([]);
        expect(missing.total).toBe(2);
    });

    it('leaves the FR-26 order of what it returns alone', () => {
        const items = [
            work('newest', T3, 'Shared newest'),
            work('middle', T2, 'Shared middle'),
            work('oldest', T1, 'Shared oldest'),
            work('unrelated', null, 'Nothing in common'),
        ];

        const all = manage(items).items;
        const filtered = manage(items, 'shared').items;

        expect(all.map((entry) => entry.key)).toEqual([
            'work:newest',
            'work:middle',
            'work:oldest',
            'work:unrelated',
        ]);
        // The filter removes whole items; it never re-ranks the ones it keeps.
        expect(filtered.map((entry) => entry.key)).toEqual([
            'work:newest',
            'work:middle',
            'work:oldest',
        ]);
        // …and the section is renumbered over what is left (plan.md:171).
        expect(filtered.map((entry) => entry.order)).toEqual([0, 1, 2]);
    });

    it('reports truncated off a filtered set: nothing the filter kept was dropped', () => {
        const items = bulk(250);

        const filtered = manage(items, 'Bulk 240');
        expect(filtered.truncated).toBe(false);
        expect(manage(items).truncated).toBe(true);
    });
});

describe('orderLauncherItems — a Work with no address (FR-56)', () => {
    const items: LauncherOrderableItem[] = [
        work('live', T1),
        { ...work('not-live', T1), manageState: 'notLive' },
        { ...work('exposure-off', T1), manageState: 'exposureOff' },
    ];

    it('drops a not-live Work from the panel list', () => {
        const result = orderLauncherItems(items, [], { scopeKey: LAUNCHER_PERSONAL_SCOPE_KEY });
        expect(result.items.map((entry) => entry.key)).toEqual(['work:live']);
    });

    it('keeps it in Manage apps, so its stored arrangement is never lost', () => {
        const preferences: LauncherOrderPreference[] = [
            {
                key: 'work:not-live',
                scopeKey: LAUNCHER_PERSONAL_SCOPE_KEY,
                pinned: true,
                pinOrder: 0,
                updatedAt: T1,
            },
        ];

        const result = orderLauncherItems(items, preferences, {
            scopeKey: LAUNCHER_PERSONAL_SCOPE_KEY,
            includeHidden: true,
        });

        expect(result.items.map((entry) => entry.key)).toContain('work:not-live');
        expect(result.pinnedTotal).toBe(1);
    });

    it('keeps a hidden item out of the panel but in Manage apps (FR-27)', () => {
        const hidden: LauncherOrderableItem[] = [{ ...work('hidden', T1), visible: false }];

        expect(
            orderLauncherItems(hidden, [], { scopeKey: LAUNCHER_PERSONAL_SCOPE_KEY }).items,
        ).toHaveLength(0);
        expect(
            orderLauncherItems(hidden, [], {
                scopeKey: LAUNCHER_PERSONAL_SCOPE_KEY,
                includeHidden: true,
            }).items.map((entry) => [entry.key, entry.visible]),
        ).toEqual([['work:hidden', false]]);
    });
});

describe('reorderSection — FR-62 / ACC-11-47', () => {
    const section = ['work:a', 'work:b', 'work:c', 'work:d'];

    it('writes an explicit order for every item of the section, not only the moved one', () => {
        const changes = reorderSection(section, 3, 0);

        expect(changes).toEqual([
            { key: 'work:d', order: 0 },
            { key: 'work:a', order: 1 },
            { key: 'work:b', order: 2 },
            { key: 'work:c', order: 3 },
        ]);
        expect(changes).toHaveLength(section.length);
    });

    it('moves down as well as up', () => {
        expect(reorderSection(section, 0, 2)).toEqual([
            { key: 'work:b', order: 0 },
            { key: 'work:c', order: 1 },
            { key: 'work:a', order: 2 },
            { key: 'work:d', order: 3 },
        ]);
    });

    it('still writes the whole section when the move is off the end of the list', () => {
        // "Move up" on the first row, "Move down" on the last: a no-op the client
        // does not have to know about, and the section is written anyway.
        expect(reorderSection(section, 0, -1)).toEqual([
            { key: 'work:a', order: 0 },
            { key: 'work:b', order: 1 },
            { key: 'work:c', order: 2 },
            { key: 'work:d', order: 3 },
        ]);
        expect(reorderSection(section, 3, 99)).toEqual(reorderSection(section, 0, 0));
    });

    it('returns nothing for an empty section', () => {
        expect(reorderSection([], 0, 1)).toEqual([]);
    });

    it("does not mutate the caller's array", () => {
        const original = [...section];
        reorderSection(section, 0, 3);
        expect(section).toEqual(original);
    });
});
