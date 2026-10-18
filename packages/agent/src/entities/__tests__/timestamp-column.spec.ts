import { timestampToEpochMillis } from '../_types';

/**
 * `TimestampColumn`'s write half (2026-10-18). Rows written through the isolated Trigger
 * worker's RPC proxy arrive as JSON, so a `Date` is an ISO string by then; the old
 * `value.getTime()` threw and 500'd the App runtime-state write of a READY deploy.
 */
describe('timestampToEpochMillis', () => {
    const iso = '2026-10-18T20:06:01.844Z';
    const ms = Date.parse(iso);

    it('keeps a Date exactly as before', () => {
        expect(timestampToEpochMillis(new Date(ms))).toBe(ms);
    });

    it('accepts the ISO string a Date becomes over JSON', () => {
        expect(timestampToEpochMillis(iso)).toBe(ms);
    });

    it('accepts epoch milliseconds as a number or a numeric string', () => {
        expect(timestampToEpochMillis(ms)).toBe(ms);
        expect(timestampToEpochMillis(String(ms))).toBe(ms);
    });

    it('maps absent values to null', () => {
        expect(timestampToEpochMillis(undefined)).toBeNull();
        expect(timestampToEpochMillis(null)).toBeNull();
        expect(timestampToEpochMillis('')).toBeNull();
        expect(timestampToEpochMillis(Number.NaN)).toBeNull();
    });

    it('refuses an unparseable string with a TypeError that names it', () => {
        expect(() => timestampToEpochMillis('not-a-date')).toThrow(TypeError);
        expect(() => timestampToEpochMillis('not-a-date')).toThrow(/not-a-date/);
    });

    it('passes any other object (e.g. a TypeORM FindOperator) through untouched', () => {
        const operator = { _type: 'lessThan', _value: new Date(ms) };
        expect(timestampToEpochMillis(operator)).toBe(operator);
    });
});
