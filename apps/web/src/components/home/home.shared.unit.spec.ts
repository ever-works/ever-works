import { describe, expect, it } from 'vitest';
import type { HomeSummaryDto } from '@ever-works/contracts';
import {
    canSubmitComposer,
    deriveTaskTitle,
    formatCount,
    formatElapsed,
    formatWaiting,
    glanceForSummary,
    greetingKeyForHour,
    localHour,
} from './home.shared';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

describe('home.shared', () => {
    describe('formatWaiting', () => {
        it.each([
            [59 * MINUTE, { unit: 'minutes', count: 59 }],
            [60 * MINUTE, { unit: 'hours', count: 1 }],
            [23 * HOUR + 59 * MINUTE, { unit: 'hours', count: 23 }],
            [24 * HOUR, { unit: 'days', count: 1 }],
            [72 * HOUR, { unit: 'days', count: 3 }],
        ])('reads %i ms as %o', (ms, expected) => {
            expect(formatWaiting(ms)).toEqual(expected);
        });

        it('never reads a negative or broken duration as negative', () => {
            expect(formatWaiting(-5)).toEqual({ unit: 'minutes', count: 0 });
            expect(formatWaiting(Number.NaN)).toEqual({ unit: 'minutes', count: 0 });
        });
    });

    it('formats elapsed time in minutes, then hours and minutes', () => {
        expect(formatElapsed(14 * MINUTE)).toEqual({ hours: 0, minutes: 14 });
        expect(formatElapsed(2 * HOUR + 5 * MINUTE + 59_000)).toEqual({ hours: 2, minutes: 5 });
    });

    it('keeps counters exact to 999 and renders 999+ beyond', () => {
        expect(formatCount(999)).toBe('999');
        expect(formatCount(1000)).toBe('999+');
        expect(formatCount(-1)).toBe('0');
    });

    it.each([
        [4, 'evening'],
        [5, 'morning'],
        [11, 'morning'],
        [12, 'afternoon'],
        [17, 'afternoon'],
        [18, 'evening'],
        [0, 'evening'],
    ] as const)('greets hour %i with %s', (hour, key) => {
        expect(greetingKeyForHour(hour)).toBe(key);
    });

    it('reads the hour on the wall clock of the timezone, and UTC for an unusable one', () => {
        const instant = new Date('2026-09-14T04:59:00.000Z');
        expect(localHour(instant, 'Europe/Kyiv')).toBe(7);
        expect(localHour(instant, 'UTC')).toBe(4);
        expect(localHour(instant, 'Not/AZone')).toBe(4);
    });

    describe('glanceForSummary', () => {
        it('passes a loaded summary’s own glance block through, failed or not', () => {
            const ok: HomeSummaryDto['glance'] = {
                status: 'ok',
                data: { needsYou: 1, workingNow: 2, doneToday: 3, failedToday: 4 },
            };
            expect(glanceForSummary({ glance: ok } as HomeSummaryDto)).toBe(ok);

            const failed: HomeSummaryDto['glance'] = {
                status: 'failed',
                errorKey: 'timeout',
                data: null,
            };
            expect(glanceForSummary({ glance: failed } as HomeSummaryDto)).toBe(failed);
        });

        it('reports a missing summary as a FAILED block, never as "still loading"', () => {
            // `undefined` is what `GlanceCounters` reads as loading; returning it
            // here would leave a skeleton that never resolves, which is how a
            // broken read passes for a quiet morning.
            for (const missing of [null, undefined]) {
                const block = glanceForSummary(missing);
                expect(block.status).toBe('failed');
                expect(block.data).toBeNull();
                expect(block.errorKey).toBe('error');
            }
        });
    });

    describe('composer length', () => {
        it('needs 3 trimmed characters and allows up to 2000', () => {
            expect(canSubmitComposer('  ab ')).toBe(false);
            expect(canSubmitComposer('abc')).toBe(true);
            expect(canSubmitComposer('a'.repeat(2000))).toBe(true);
            expect(canSubmitComposer('a'.repeat(2001))).toBe(false);
        });
    });

    describe('deriveTaskTitle', () => {
        it('uses the first sentence', () => {
            expect(deriveTaskTitle('Summarise the week. Then flag the duplicates.')).toBe(
                'Summarise the week',
            );
        });

        it('uses the whole text when there is no sentence terminator', () => {
            expect(
                deriveTaskTitle('summarise every item added this week and flag the duplicates'),
            ).toBe('summarise every item added this week and flag the duplicates');
        });

        it('falls back to the whole text when the first sentence is shorter than 3 characters', () => {
            expect(deriveTaskTitle('OK. Summarise the week')).toBe('OK. Summarise the week');
        });

        it('cuts at the last word boundary at or before 80 characters with one ellipsis', () => {
            const text = `${'word '.repeat(30)}end`;
            const title = deriveTaskTitle(text);
            expect(title.length).toBeLessThanOrEqual(80);
            expect(title.endsWith('word…')).toBe(true);
            expect(title.match(/…/g)).toHaveLength(1);
        });

        it('keeps a title of exactly 80 characters untouched', () => {
            const text = 'a'.repeat(80);
            expect(deriveTaskTitle(text)).toBe(text);
        });

        it('hard-cuts a single word longer than 80 characters', () => {
            const title = deriveTaskTitle('x'.repeat(200));
            expect(title).toHaveLength(80);
            expect(title.endsWith('…')).toBe(true);
        });

        it('stops the first sentence at a line break', () => {
            expect(deriveTaskTitle('Draft the notes\nInclude every release')).toBe(
                'Draft the notes',
            );
        });
    });
});
