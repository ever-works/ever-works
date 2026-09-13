import {
    addCalendarDays,
    addCalendarMonths,
    calendarDateInTimezone,
    isValidTimezone,
    parseCalendarDate,
    resolveRunWindow,
    startOfCalendarDate,
    startOfIsoWeek,
} from '../run-window';

/**
 * Runs ledger (AW-09) — calendar window resolution.
 *
 * The window is what every ledger number is scoped to, so its edges are
 * pinned exactly: half-open, Monday weeks, calendar months, the viewer's
 * timezone, a DST night that is 23 or 25 hours long, and the reach clamp.
 */
describe('run-window', () => {
    // A fixed "now": Sunday 13 September 2026, 10:00 UTC.
    const NOW = new Date('2026-09-13T10:00:00.000Z');

    describe('calendar helpers', () => {
        it('rejects dates that do not exist', () => {
            expect(parseCalendarDate('2026-02-30')).toBeNull();
            expect(parseCalendarDate('2026-13-01')).toBeNull();
            expect(parseCalendarDate('26-01-01')).toBeNull();
            expect(parseCalendarDate(undefined)).toBeNull();
            expect(parseCalendarDate('2024-02-29')).toEqual({ y: 2024, m: 2, d: 29 });
        });

        it('adds days across month and year edges', () => {
            expect(addCalendarDays('2026-12-31', 1)).toBe('2027-01-01');
            expect(addCalendarDays('2026-03-01', -1)).toBe('2026-02-28');
        });

        it('adds months and clamps to the shorter month', () => {
            expect(addCalendarMonths('2026-03-31', -1)).toBe('2026-02-28');
            expect(addCalendarMonths('2025-09-13', 12)).toBe('2026-09-13');
            expect(addCalendarMonths('2026-01-15', -12)).toBe('2025-01-15');
        });

        it('finds the Monday that starts an ISO week, including from a Sunday', () => {
            expect(startOfIsoWeek('2026-09-13')).toBe('2026-09-07'); // Sunday
            expect(startOfIsoWeek('2026-09-07')).toBe('2026-09-07'); // Monday
            expect(startOfIsoWeek('2026-01-01')).toBe('2025-12-29'); // Thursday
        });

        it('reads the calendar date of an instant in a timezone', () => {
            const instant = new Date('2026-09-13T20:30:00.000Z');
            expect(calendarDateInTimezone(instant, 'UTC')).toBe('2026-09-13');
            expect(calendarDateInTimezone(instant, 'Asia/Tokyo')).toBe('2026-09-14');
            expect(calendarDateInTimezone(instant, 'America/Los_Angeles')).toBe('2026-09-13');
        });

        it('recognises real IANA zones and refuses anything else', () => {
            expect(isValidTimezone('Europe/Kyiv')).toBe(true);
            expect(isValidTimezone('UTC')).toBe(true);
            expect(isValidTimezone('Mars/Olympus')).toBe(false);
            expect(isValidTimezone('')).toBe(false);
            expect(isValidTimezone(42)).toBe(false);
        });
    });

    describe('startOfCalendarDate', () => {
        it('is local midnight in the zone, as a UTC instant', () => {
            expect(startOfCalendarDate('2026-09-08', 'Asia/Tokyo').toISOString()).toBe(
                '2026-09-07T15:00:00.000Z',
            );
            expect(startOfCalendarDate('2026-09-08', 'UTC').toISOString()).toBe(
                '2026-09-08T00:00:00.000Z',
            );
        });

        it('lands on the right side of a DST change in a non-UTC zone', () => {
            // Europe/Berlin leaves summer time on 25 Oct 2026 at 03:00 local.
            expect(startOfCalendarDate('2026-10-25', 'Europe/Berlin').toISOString()).toBe(
                '2026-10-24T22:00:00.000Z',
            );
            expect(startOfCalendarDate('2026-10-26', 'Europe/Berlin').toISOString()).toBe(
                '2026-10-25T23:00:00.000Z',
            );
        });
    });

    describe('resolveRunWindow', () => {
        it('defaults to Day / today in UTC', () => {
            expect(resolveRunWindow({ now: NOW })).toEqual({
                granularity: 'day',
                anchorDate: '2026-09-13',
                from: '2026-09-13T00:00:00.000Z',
                to: '2026-09-14T00:00:00.000Z',
                timezone: 'UTC',
                clamped: false,
            });
        });

        it('resolves "today" in the viewer timezone, not the server clock', () => {
            const window = resolveRunWindow({
                timezone: 'Asia/Tokyo',
                now: new Date('2026-09-13T20:30:00.000Z'),
            });
            expect(window.anchorDate).toBe('2026-09-14');
            expect(window.from).toBe('2026-09-13T15:00:00.000Z');
            expect(window.to).toBe('2026-09-14T15:00:00.000Z');
        });

        it('makes a week run Monday to Monday', () => {
            const window = resolveRunWindow({ granularity: 'week', date: '2026-09-10', now: NOW });
            expect(window.from).toBe('2026-09-07T00:00:00.000Z');
            expect(window.to).toBe('2026-09-14T00:00:00.000Z');
            expect(window.anchorDate).toBe('2026-09-10');
        });

        it('makes a month the calendar month', () => {
            const window = resolveRunWindow({ granularity: 'month', date: '2026-02-17', now: NOW });
            expect(window.from).toBe('2026-02-01T00:00:00.000Z');
            expect(window.to).toBe('2026-03-01T00:00:00.000Z');
        });

        it('gives a DST day its real 25-hour length', () => {
            const window = resolveRunWindow({
                date: '2026-10-25',
                timezone: 'Europe/Berlin',
                // Inside the reach: the DST night is five days after "now".
                now: new Date('2026-10-20T10:00:00.000Z'),
            });
            expect(window.clamped).toBe(false);
            const hours =
                (new Date(window.to).getTime() - new Date(window.from).getTime()) / 3_600_000;
            expect(hours).toBe(25);
        });

        it('clamps an anchor more than 12 months back and says so', () => {
            const window = resolveRunWindow({ date: '2025-08-01', now: NOW });
            expect(window.clamped).toBe(true);
            expect(window.anchorDate).toBe('2025-09-13');
        });

        it('keeps an anchor exactly 12 months back unclamped', () => {
            const window = resolveRunWindow({ date: '2025-09-13', now: NOW });
            expect(window.clamped).toBe(false);
        });

        it('clamps an anchor more than 7 days forward', () => {
            const window = resolveRunWindow({ date: '2026-09-21', now: NOW });
            expect(window.clamped).toBe(true);
            expect(window.anchorDate).toBe('2026-09-20');
        });

        it('falls back to UTC for an unknown timezone and to Day for an unknown granularity', () => {
            const window = resolveRunWindow({
                timezone: 'Not/AZone',
                granularity: 'decade',
                now: NOW,
            });
            expect(window.timezone).toBe('UTC');
            expect(window.granularity).toBe('day');
        });

        it('clamps a real date far in the past, even one with a two-digit-era year', () => {
            // `Date.UTC(50, …)` means 1950; the year 0050 must still read as a
            // real (and long unreachable) date the API accepts, not as "no anchor".
            expect(parseCalendarDate('0050-01-01')).toEqual({ y: 50, m: 1, d: 1 });
            const window = resolveRunWindow({ date: '0050-01-01', now: NOW });
            expect(window.clamped).toBe(true);
            expect(window.anchorDate).toBe('2025-09-13');
        });

        it('anchors on today when the date is not a real date', () => {
            expect(resolveRunWindow({ date: '2026-02-31', now: NOW }).anchorDate).toBe(
                '2026-09-13',
            );
        });
    });
});
