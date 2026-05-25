import { matchesCron, parseCron } from '../cron-matcher';

/**
 * UTC date constructor shorthand. Cron matching is UTC-only by
 * design (see comment on matchesCron) so tests stay deterministic
 * regardless of host timezone.
 */
function utc(iso: string): Date {
    return new Date(iso + 'Z');
}

describe('cron-matcher', () => {
    describe('parseCron — validation', () => {
        it('rejects expressions with the wrong field count', () => {
            expect(() => parseCron('* * * *')).toThrow(/5 space-separated fields/);
            expect(() => parseCron('* * * * * *')).toThrow(/5 space-separated fields/);
        });

        it('rejects out-of-range values', () => {
            expect(() => parseCron('60 * * * *')).toThrow(/Invalid cron value/);
            expect(() => parseCron('* 24 * * *')).toThrow(/Invalid cron value/);
            expect(() => parseCron('* * 0 * *')).toThrow(/Invalid cron value/);
        });

        it('rejects step values that are not positive integers', () => {
            expect(() => parseCron('*/0 * * * *')).toThrow(/positive integer/);
            expect(() => parseCron('*/-1 * * * *')).toThrow(/positive integer/);
        });

        it('rejects inverted ranges', () => {
            expect(() => parseCron('10-5 * * * *')).toThrow(/start > end/);
        });
    });

    describe('matchesCron — common patterns', () => {
        it('* * * * * matches every minute', () => {
            expect(matchesCron('* * * * *', utc('2026-05-24T00:00:00'))).toBe(true);
            expect(matchesCron('* * * * *', utc('2026-05-24T17:42:00'))).toBe(true);
        });

        it('0 9 * * MON fires at 9:00 UTC on Mondays only', () => {
            // 2026-05-25 is a Monday.
            expect(matchesCron('0 9 * * MON', utc('2026-05-25T09:00:00'))).toBe(true);
            // 9:01 same day — minute mismatch.
            expect(matchesCron('0 9 * * MON', utc('2026-05-25T09:01:00'))).toBe(false);
            // Sunday at 9 — dow mismatch.
            expect(matchesCron('0 9 * * MON', utc('2026-05-24T09:00:00'))).toBe(false);
            // Tuesday at 9 — dow mismatch.
            expect(matchesCron('0 9 * * MON', utc('2026-05-26T09:00:00'))).toBe(false);
        });

        it('*/15 * * * * fires every 15 minutes', () => {
            expect(matchesCron('*/15 * * * *', utc('2026-05-24T10:00:00'))).toBe(true);
            expect(matchesCron('*/15 * * * *', utc('2026-05-24T10:15:00'))).toBe(true);
            expect(matchesCron('*/15 * * * *', utc('2026-05-24T10:30:00'))).toBe(true);
            expect(matchesCron('*/15 * * * *', utc('2026-05-24T10:45:00'))).toBe(true);
            expect(matchesCron('*/15 * * * *', utc('2026-05-24T10:14:00'))).toBe(false);
        });

        it('0 */2 * * * fires every 2 hours on the hour', () => {
            expect(matchesCron('0 */2 * * *', utc('2026-05-24T00:00:00'))).toBe(true);
            expect(matchesCron('0 */2 * * *', utc('2026-05-24T02:00:00'))).toBe(true);
            expect(matchesCron('0 */2 * * *', utc('2026-05-24T01:00:00'))).toBe(false);
            expect(matchesCron('0 */2 * * *', utc('2026-05-24T02:30:00'))).toBe(false);
        });

        it('0 0 1 * * fires only at midnight on the 1st of each month', () => {
            expect(matchesCron('0 0 1 * *', utc('2026-05-01T00:00:00'))).toBe(true);
            expect(matchesCron('0 0 1 * *', utc('2026-06-01T00:00:00'))).toBe(true);
            expect(matchesCron('0 0 1 * *', utc('2026-05-02T00:00:00'))).toBe(false);
        });

        it('supports comma-separated lists', () => {
            expect(matchesCron('0,30 * * * *', utc('2026-05-24T10:00:00'))).toBe(true);
            expect(matchesCron('0,30 * * * *', utc('2026-05-24T10:30:00'))).toBe(true);
            expect(matchesCron('0,30 * * * *', utc('2026-05-24T10:15:00'))).toBe(false);
        });

        it('supports inclusive ranges', () => {
            expect(matchesCron('0 9-17 * * *', utc('2026-05-24T09:00:00'))).toBe(true);
            expect(matchesCron('0 9-17 * * *', utc('2026-05-24T17:00:00'))).toBe(true);
            expect(matchesCron('0 9-17 * * *', utc('2026-05-24T08:00:00'))).toBe(false);
            expect(matchesCron('0 9-17 * * *', utc('2026-05-24T18:00:00'))).toBe(false);
        });

        it('supports stepped ranges', () => {
            expect(matchesCron('0 8-18/2 * * *', utc('2026-05-24T08:00:00'))).toBe(true);
            expect(matchesCron('0 8-18/2 * * *', utc('2026-05-24T10:00:00'))).toBe(true);
            expect(matchesCron('0 8-18/2 * * *', utc('2026-05-24T09:00:00'))).toBe(false);
        });

        it('day aliases (SUN..SAT) are case-insensitive', () => {
            // 2026-05-24 is Sunday.
            expect(matchesCron('0 9 * * sun', utc('2026-05-24T09:00:00'))).toBe(true);
            expect(matchesCron('0 9 * * Sun', utc('2026-05-24T09:00:00'))).toBe(true);
            // 7 also = Sunday (Unix cron quirk).
            expect(matchesCron('0 9 * * 7', utc('2026-05-24T09:00:00'))).toBe(true);
        });

        it('month aliases (JAN..DEC) are case-insensitive', () => {
            expect(matchesCron('0 0 1 jan *', utc('2026-01-01T00:00:00'))).toBe(true);
            expect(matchesCron('0 0 1 JAN *', utc('2026-01-01T00:00:00'))).toBe(true);
            expect(matchesCron('0 0 1 feb *', utc('2026-01-01T00:00:00'))).toBe(false);
        });
    });

    describe('day-of-month + day-of-week OR semantics (Vixie cron)', () => {
        // When BOTH dom and dow are restricted, cron fires if EITHER
        // matches. This mirrors crontab(5) behavior — surprising but
        // standard.
        it('"0 9 1 * MON" fires on the 1st OR on any Monday', () => {
            // 2026-06-01 is a Monday — both match.
            expect(matchesCron('0 9 1 * MON', utc('2026-06-01T09:00:00'))).toBe(true);
            // 2026-05-25 is a Monday but not the 1st — still fires.
            expect(matchesCron('0 9 1 * MON', utc('2026-05-25T09:00:00'))).toBe(true);
            // 2026-05-01 is the 1st but a Friday — still fires.
            expect(matchesCron('0 9 1 * MON', utc('2026-05-01T09:00:00'))).toBe(true);
            // 2026-05-02 is neither — does not fire.
            expect(matchesCron('0 9 1 * MON', utc('2026-05-02T09:00:00'))).toBe(false);
        });

        it('when only dow is restricted, dom must be * (trivially true)', () => {
            // Friday — fires regardless of date.
            expect(matchesCron('0 9 * * FRI', utc('2026-05-01T09:00:00'))).toBe(true);
            expect(matchesCron('0 9 * * FRI', utc('2026-05-08T09:00:00'))).toBe(true);
            // Saturday — does not fire.
            expect(matchesCron('0 9 * * FRI', utc('2026-05-02T09:00:00'))).toBe(false);
        });
    });
});
