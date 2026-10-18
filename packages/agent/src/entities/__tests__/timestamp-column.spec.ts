import { getMetadataArgsStorage } from 'typeorm';

import { timestampToEpochMillis } from '../_types';
import { WorkAppRuntimeState } from '../work-app-runtime-state.entity';

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

    it('maps absent values and non-finite numbers to null', () => {
        expect(timestampToEpochMillis(undefined)).toBeNull();
        expect(timestampToEpochMillis(null)).toBeNull();
        expect(timestampToEpochMillis('')).toBeNull();
        expect(timestampToEpochMillis(Number.NaN)).toBeNull();
        expect(timestampToEpochMillis(Number.POSITIVE_INFINITY)).toBeNull();
    });

    it('refuses an unparseable string with a TypeError that names it', () => {
        expect(() => timestampToEpochMillis('not-a-date')).toThrow(TypeError);
        expect(() => timestampToEpochMillis('not-a-date')).toThrow(/not-a-date/);
    });

    it('refuses an Invalid Date and epochs outside the Date range (the read half would answer Invalid Date)', () => {
        expect(() => timestampToEpochMillis(new Date(Number.NaN))).toThrow(/Invalid Date/);
        expect(() => timestampToEpochMillis(8.64e15 + 1)).toThrow(/range/);
        expect(() => timestampToEpochMillis(String(-8.64e15 - 1))).toThrow(/range/);
        expect(timestampToEpochMillis(8.64e15)).toBe(8.64e15);
    });

    it('passes any other object (e.g. a TypeORM FindOperator) through untouched', () => {
        const operator = { _type: 'lessThan', _value: new Date(ms) };
        expect(timestampToEpochMillis(operator)).toBe(operator);
    });
});

describe('the registered TimestampColumn transformer (WorkAppRuntimeState)', () => {
    const transformer = getMetadataArgsStorage().columns.find(
        (column) =>
            column.target === WorkAppRuntimeState &&
            column.propertyName === 'firstDeployJobsCompletedAt',
    )?.options.transformer as {
        to: (value: unknown) => unknown;
        from: (value: unknown) => unknown;
    };

    it('writes the ISO string the RPC proxy delivers, and reads it back as the same instant', () => {
        const iso = '2026-10-18T20:06:01.844Z';
        const stored = transformer.to(iso);

        expect(stored).toBe(Date.parse(iso));
        expect((transformer.from(String(stored)) as Date).toISOString()).toBe(iso);
    });

    it('still writes a Date and nullish values as before', () => {
        const at = new Date('2026-10-18T20:06:01.844Z');

        expect(transformer.to(at)).toBe(at.getTime());
        expect(transformer.to(undefined)).toBeNull();
        expect(transformer.to(null)).toBeNull();
    });
});
