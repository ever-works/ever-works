import { calculateDurationSeconds } from '../time.utils';

describe('calculateDurationSeconds', () => {
    it('returns 0 when start === end', () => {
        const t = new Date('2026-01-01T00:00:00.000Z');
        expect(calculateDurationSeconds(t, t)).toBe(0);
    });

    it('returns the rounded difference in seconds for a sub-second delta', () => {
        const start = new Date('2026-01-01T00:00:00.000Z');
        const end = new Date('2026-01-01T00:00:00.499Z');
        // 499 ms → 0.499 s → rounds to 0
        expect(calculateDurationSeconds(start, end)).toBe(0);
    });

    it('rounds half-second up (banker-rounding does NOT apply — Math.round)', () => {
        const start = new Date('2026-01-01T00:00:00.000Z');
        const end = new Date('2026-01-01T00:00:00.500Z');
        // 500 ms → 0.5 s → Math.round → 1
        expect(calculateDurationSeconds(start, end)).toBe(1);
    });

    it('handles whole-second deltas verbatim', () => {
        const start = new Date('2026-01-01T00:00:00.000Z');
        const end = new Date('2026-01-01T00:01:30.000Z');
        // 90 s
        expect(calculateDurationSeconds(start, end)).toBe(90);
    });

    it('handles a one-hour delta', () => {
        const start = new Date('2026-01-01T00:00:00.000Z');
        const end = new Date('2026-01-01T01:00:00.000Z');
        expect(calculateDurationSeconds(start, end)).toBe(3600);
    });

    it('returns a NEGATIVE value when end < start (no defensive abs)', () => {
        // Pinned so a future "use Math.abs" refactor breaks loudly — the contract
        // is "duration", and a caller passing reversed args should see the negative
        // number rather than have it silently absorbed.
        const start = new Date('2026-01-01T00:01:00.000Z');
        const end = new Date('2026-01-01T00:00:00.000Z');
        expect(calculateDurationSeconds(start, end)).toBe(-60);
    });

    it('rounds towards positive infinity at +0.5 boundaries (Math.round semantics)', () => {
        const start = new Date('2026-01-01T00:00:00.000Z');
        const end = new Date('2026-01-01T00:00:01.500Z');
        expect(calculateDurationSeconds(start, end)).toBe(2);
    });

    it('rounds .499 down to floor', () => {
        const start = new Date('2026-01-01T00:00:00.000Z');
        const end = new Date('2026-01-01T00:00:01.499Z');
        expect(calculateDurationSeconds(start, end)).toBe(1);
    });

    it('returns an integer (not a float) on every invocation', () => {
        const start = new Date('2026-01-01T00:00:00.000Z');
        const end = new Date('2026-01-01T00:00:00.123Z');
        expect(Number.isInteger(calculateDurationSeconds(start, end))).toBe(true);
    });
});
