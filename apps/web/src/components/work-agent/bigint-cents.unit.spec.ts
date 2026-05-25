import { describe, expect, it } from 'vitest';
import { DEFAULT_ACCOUNT_MONTHLY_CAP_CENTS, formatCapCents, parseCapCents } from './bigint-cents';

describe('bigint-cents helpers (Phase 4 PR EE)', () => {
    describe('parseCapCents', () => {
        it('returns null for null / undefined / empty / whitespace', () => {
            expect(parseCapCents(null)).toBeNull();
            expect(parseCapCents(undefined)).toBeNull();
            expect(parseCapCents('')).toBeNull();
            expect(parseCapCents('   ')).toBeNull();
        });

        it('parses a normal positive integer string into a number', () => {
            expect(parseCapCents('5000')).toBe(5000);
            expect(parseCapCents('0')).toBe(0);
            expect(parseCapCents('1234567')).toBe(1234567);
        });

        it('strips surrounding whitespace', () => {
            expect(parseCapCents('  9999  ')).toBe(9999);
        });

        it('returns null for negative / NaN / Infinity / non-numeric', () => {
            expect(parseCapCents('-1')).toBeNull();
            expect(parseCapCents('not a number')).toBeNull();
            expect(parseCapCents('Infinity')).toBeNull();
            expect(parseCapCents('NaN')).toBeNull();
        });

        it('clamps values above MAX_SAFE_INTEGER to the safe ceiling', () => {
            // Anything beyond MAX_SAFE_INTEGER would lose precision in JS,
            // and a monthly cap measured in cents that's $90 quadrillion+
            // isn't a realistic user setting. We clamp rather than throw
            // so a corrupt or future-format DB value can still render a
            // sane form for the user to edit down.
            const parsed = parseCapCents('999999999999999999999');
            expect(parsed).toBe(Number.MAX_SAFE_INTEGER);
        });
    });

    describe('formatCapCents', () => {
        it('round-trips an integer through string form', () => {
            expect(formatCapCents(5000)).toBe('5000');
            expect(formatCapCents(0)).toBe('0');
        });

        it('clamps negatives to 0', () => {
            expect(formatCapCents(-100)).toBe('0');
        });

        it('floors fractional cents (server-side bigint is integer-only)', () => {
            expect(formatCapCents(99.7)).toBe('99');
        });

        it('clamps absurd values to the safe ceiling', () => {
            expect(formatCapCents(Number.MAX_VALUE)).toBe(String(Number.MAX_SAFE_INTEGER));
        });

        it('round-trips with parseCapCents for valid values', () => {
            for (const c of [0, 1, 99, 5000, 9_999_999]) {
                expect(parseCapCents(formatCapCents(c))).toBe(c);
            }
        });
    });

    describe('display defaults are stable', () => {
        it('default cap = $50/month = 5000 cents', () => {
            // Keep in sync with the UI's opt-in default; a follow-up
            // would land both the change here and the matching field
            // label in the i18n bundle.
            expect(DEFAULT_ACCOUNT_MONTHLY_CAP_CENTS).toBe(5000);
        });
    });
});
