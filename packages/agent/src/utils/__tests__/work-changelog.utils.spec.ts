import { buildWorkChangelog } from '../work-changelog.utils';
import type {
    WorkHistoryChangeEntityType,
    WorkHistoryChangeEntry,
} from '@ever-works/contracts/api';

const entry = (overrides: Partial<WorkHistoryChangeEntry> = {}): WorkHistoryChangeEntry => ({
    entityType: 'item',
    action: 'added',
    name: 'Sample',
    ...overrides,
});

describe('buildWorkChangelog', () => {
    describe('empty input', () => {
        it('returns null for an empty entries array (the only "no changes" signal)', () => {
            expect(buildWorkChangelog([])).toBeNull();
        });

        it('returns null even when an explicit summary is supplied (length-zero gate runs first)', () => {
            // Pinned so a future "build envelope but keep summary" refactor breaks loudly.
            expect(buildWorkChangelog([], 'Caller-supplied summary')).toBeNull();
        });
    });

    describe('counts', () => {
        it('partitions entries by action into added/updated/removed', () => {
            const result = buildWorkChangelog([
                entry({ action: 'added', name: 'A1' }),
                entry({ action: 'added', name: 'A2' }),
                entry({ action: 'updated', name: 'U1' }),
                entry({ action: 'removed', name: 'R1' }),
                entry({ action: 'removed', name: 'R2' }),
                entry({ action: 'removed', name: 'R3' }),
            ]);

            expect(result).not.toBeNull();
            expect(result?.addedCount).toBe(2);
            expect(result?.updatedCount).toBe(1);
            expect(result?.removedCount).toBe(3);
        });

        it('zero counts on dimensions that have no entries', () => {
            const result = buildWorkChangelog([entry({ action: 'added', name: 'A' })]);

            expect(result?.addedCount).toBe(1);
            expect(result?.updatedCount).toBe(0);
            expect(result?.removedCount).toBe(0);
        });
    });

    describe('entries passthrough', () => {
        it('forwards the entries array verbatim (same reference) — caller controls ordering and shape', () => {
            const entries: WorkHistoryChangeEntry[] = [
                entry({ name: 'first' }),
                entry({ name: 'second' }),
            ];

            const result = buildWorkChangelog(entries);

            expect(result?.entries).toBe(entries);
        });
    });

    describe('summary override (caller-supplied)', () => {
        it('uses the explicit summary verbatim when non-null', () => {
            const result = buildWorkChangelog([entry({ action: 'added' })], 'Custom summary text');

            expect(result?.summary).toBe('Custom summary text');
        });

        it('preserves an empty-string summary as-is (?? operator only short-circuits null/undefined)', () => {
            // Empty-string is a documented "I want a blank summary" signal; the
            // ?? fallback must NOT replace it with the default-built string.
            const result = buildWorkChangelog([entry({ action: 'added' })], '');

            expect(result?.summary).toBe('');
        });

        it('falls back to the default builder when summary is undefined', () => {
            const result = buildWorkChangelog([entry({ action: 'added' })]);

            expect(result?.summary).toBe('1 item added');
        });

        it('falls back to the default builder when summary is null', () => {
            const result = buildWorkChangelog([entry({ action: 'added' })], null);

            expect(result?.summary).toBe('1 item added');
        });
    });

    describe('default summary — pluralisation', () => {
        it('singular form for count of 1', () => {
            const result = buildWorkChangelog([entry({ action: 'added', name: 'A' })]);

            expect(result?.summary).toBe('1 item added');
        });

        it('plural form for count > 1 (suffixed "s")', () => {
            const result = buildWorkChangelog([
                entry({ action: 'added', name: 'A' }),
                entry({ action: 'added', name: 'B' }),
            ]);

            expect(result?.summary).toBe('2 items added');
        });

        it('joins all three non-zero parts with ", " in fixed order: added, updated, removed', () => {
            const result = buildWorkChangelog([
                entry({ action: 'added', name: 'A' }),
                entry({ action: 'updated', name: 'U' }),
                entry({ action: 'removed', name: 'R' }),
            ]);

            expect(result?.summary).toBe('1 item added, 1 item updated, 1 item removed');
        });

        it('omits zero-count parts entirely (no "0 items …" segments)', () => {
            const result = buildWorkChangelog([
                entry({ action: 'updated', name: 'U' }),
                entry({ action: 'removed', name: 'R' }),
            ]);

            expect(result?.summary).toBe('1 item updated, 1 item removed');
        });

        it('mixed pluralisation across the three parts', () => {
            const result = buildWorkChangelog([
                entry({ action: 'added', name: 'A1' }),
                entry({ action: 'added', name: 'A2' }),
                entry({ action: 'added', name: 'A3' }),
                entry({ action: 'updated', name: 'U' }),
                entry({ action: 'removed', name: 'R1' }),
                entry({ action: 'removed', name: 'R2' }),
            ]);

            expect(result?.summary).toBe('3 items added, 1 item updated, 2 items removed');
        });
    });

    describe('default summary — entityType label resolution', () => {
        it.each<[WorkHistoryChangeEntityType, string]>([
            ['item', 'item'],
            ['comparison', 'comparison'],
            ['category', 'category'],
            ['tag', 'tag'],
            ['collection', 'collection'],
        ])('uses "%s" label for entityType=%s', (entityType, label) => {
            const result = buildWorkChangelog([entry({ entityType, action: 'added' })]);

            expect(result?.summary).toBe(`1 ${label} added`);
        });

        it("reads entityType from the FIRST entry only (mixed entries are summarised under entries[0]'s label)", () => {
            // Pin the documented behaviour: the function does NOT scan every
            // entry to pick a label — it takes entries[0].entityType. A future
            // refactor that switches to "most-common label" or "use the per-entry
            // type for each part" should break this test deliberately.
            const result = buildWorkChangelog([
                entry({ entityType: 'comparison', action: 'added', name: 'C' }),
                entry({ entityType: 'item', action: 'updated', name: 'I' }),
                entry({ entityType: 'tag', action: 'removed', name: 'T' }),
            ]);

            expect(result?.summary).toBe(
                '1 comparison added, 1 comparison updated, 1 comparison removed',
            );
        });

        it('falls back to "item" label when entries[0].entityType is missing (?? "item" guard)', () => {
            // Caller-built entries can omit entityType in JS-land even though
            // TS forbids it; pin the runtime fallback so the function stays
            // robust to legacy/lenient callers.
            const malformed = {
                action: 'added',
                name: 'Legacy',
            } as unknown as WorkHistoryChangeEntry;

            const result = buildWorkChangelog([malformed]);

            expect(result?.summary).toBe('1 item added');
        });

        it('uses "item" label when entityType is an unknown literal (default branch in switch)', () => {
            // The switch has a `case 'item'` AND a `default` falling through
            // to 'item'. Pin the unknown-literal path so a future enum
            // expansion has to update the switch deliberately.
            const futureType = {
                entityType: 'unknown-future-type',
                action: 'added',
                name: 'Future',
            } as unknown as WorkHistoryChangeEntry;

            const result = buildWorkChangelog([futureType]);

            expect(result?.summary).toBe('1 item added');
        });
    });

    describe('envelope shape', () => {
        it('returns the documented 5-field shape (summary, addedCount, updatedCount, removedCount, entries)', () => {
            const entries: WorkHistoryChangeEntry[] = [entry({ action: 'added', name: 'A' })];

            const result = buildWorkChangelog(entries);

            expect(result).toEqual({
                summary: '1 item added',
                addedCount: 1,
                updatedCount: 0,
                removedCount: 0,
                entries,
            });
            // Pin: no extra keys leak into the envelope (so a future refactor
            // that adds a "totalCount" field has to update the contract too).
            expect(Object.keys(result ?? {}).sort()).toEqual([
                'addedCount',
                'entries',
                'removedCount',
                'summary',
                'updatedCount',
            ]);
        });
    });
});
