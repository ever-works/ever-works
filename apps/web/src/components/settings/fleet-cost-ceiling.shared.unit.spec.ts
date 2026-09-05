import { describe, expect, it } from 'vitest';
import { centsToUsdInput, formatCeilingCents, usdInputToCents } from './fleet-cost-ceiling.shared';

/**
 * Fleet cost accounting (EW-777) — the ceiling editors' dollar ⇄ cent
 * conversions. The API refuses fractional, zero and oversize cents, so
 * the form must turn a typed figure into exactly what the API accepts —
 * or say why it cannot — before sending anything.
 */
describe('usdInputToCents', () => {
    it('turns a dollar figure into whole cents, tolerating a leading $', () => {
        expect(usdInputToCents('12.50')).toBe(1250);
        expect(usdInputToCents('$25')).toBe(2500);
        expect(usdInputToCents(' 0.01 ')).toBe(1);
        // Half a cent rounds to the nearest whole cent.
        expect(usdInputToCents('0.125')).toBe(13);
    });

    it('reads an empty field as "clear the ceiling" (null)', () => {
        expect(usdInputToCents('')).toBeNull();
        expect(usdInputToCents('   ')).toBeNull();
    });

    it('refuses what the API would refuse (undefined), never clamping', () => {
        expect(usdInputToCents('abc')).toBeUndefined();
        expect(usdInputToCents('0')).toBeUndefined();
        expect(usdInputToCents('-5')).toBeUndefined();
        expect(usdInputToCents('0.001')).toBeUndefined();
        expect(usdInputToCents('100001')).toBeUndefined();
    });
});

describe('centsToUsdInput / formatCeilingCents', () => {
    it('round-trips cents through the input representation', () => {
        expect(centsToUsdInput(1250)).toBe('12.50');
        expect(usdInputToCents(centsToUsdInput(1250))).toBe(1250);
        expect(centsToUsdInput(null)).toBe('');
        expect(centsToUsdInput(undefined)).toBe('');
    });

    it('formats a ceiling for display and answers null for none', () => {
        expect(formatCeilingCents(1250)).toBe('$12.50');
        expect(formatCeilingCents(5)).toBe('$0.05');
        expect(formatCeilingCents(null)).toBeNull();
    });
});
