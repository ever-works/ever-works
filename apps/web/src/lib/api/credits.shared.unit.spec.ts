// Wave 13 — pure-helper spec for the Billing / Usage & Credits pages.

import { describe, expect, it } from 'vitest';
import {
    buildLedgerQuery,
    buildUsageSummaryQuery,
    CREDIT_LEDGER_KINDS,
    CREDIT_TOPUP_PRESETS_CENTS,
    creditsForTopupCents,
    formatCents,
    formatCreditsAsDollars,
    formatMonthlyPrice,
    formatSignedCredits,
    isFreePlan,
    ledgerKindTone,
} from './credits.shared';

describe('formatCreditsAsDollars / formatCents', () => {
    it('renders credits as USD (1 credit = 1¢)', () => {
        expect(formatCreditsAsDollars(0)).toBe('$0.00');
        expect(formatCreditsAsDollars(150)).toBe('$1.50');
        expect(formatCreditsAsDollars(123456)).toBe('$1,234.56');
        expect(formatCents(2500)).toBe('$25.00');
    });
});

describe('formatSignedCredits', () => {
    it('prefixes credits with + and debits with −', () => {
        expect(formatSignedCredits(500)).toBe('+$5.00');
        expect(formatSignedCredits(-500)).toBe('−$5.00');
        expect(formatSignedCredits(0)).toBe('+$0.00');
    });
});

describe('ledgerKindTone', () => {
    it('buckets every ledger kind into a badge tone', () => {
        expect(ledgerKindTone('purchase')).toBe('positive');
        expect(ledgerKindTone('grant')).toBe('positive');
        expect(ledgerKindTone('daily-free')).toBe('positive');
        expect(ledgerKindTone('consumption')).toBe('negative');
        expect(ledgerKindTone('expiry')).toBe('negative');
        expect(ledgerKindTone('adjustment')).toBe('neutral');
        // Contract completeness: every wire kind has a tone.
        for (const kind of CREDIT_LEDGER_KINDS) {
            expect(['positive', 'negative', 'neutral']).toContain(ledgerKindTone(kind));
        }
    });
});

describe('creditsForTopupCents', () => {
    it('converts $ cents to credits at the default 100/dollar conversion', () => {
        expect(creditsForTopupCents(1000)).toBe(1000);
        expect(creditsForTopupCents(2500)).toBe(2500);
        expect(creditsForTopupCents(10000, 200)).toBe(20000);
    });

    it('returns 0 for non-positive or non-finite amounts', () => {
        expect(creditsForTopupCents(0)).toBe(0);
        expect(creditsForTopupCents(-500)).toBe(0);
        expect(creditsForTopupCents(Number.NaN)).toBe(0);
    });

    it('covers every preset amount', () => {
        for (const preset of CREDIT_TOPUP_PRESETS_CENTS) {
            expect(creditsForTopupCents(preset)).toBeGreaterThan(0);
        }
    });
});

describe('buildLedgerQuery', () => {
    it('returns an empty string when no filters are set', () => {
        expect(buildLedgerQuery({})).toBe('');
        expect(buildLedgerQuery({ page: 1 })).toBe('');
    });

    it('serializes period, kinds (comma-joined), page (>1 only), and pageSize', () => {
        expect(
            buildLedgerQuery({
                period: '2026-07',
                kinds: ['purchase', 'consumption'],
                page: 3,
                pageSize: 10,
            }),
        ).toBe('?period=2026-07&kinds=purchase%2Cconsumption&page=3&pageSize=10');
        expect(buildLedgerQuery({ kinds: [] })).toBe('');
    });
});

describe('buildUsageSummaryQuery', () => {
    it('serializes groupBy and period independently', () => {
        expect(buildUsageSummaryQuery({})).toBe('');
        expect(buildUsageSummaryQuery({ groupBy: 'day' })).toBe('?groupBy=day');
        expect(buildUsageSummaryQuery({ period: '7d' })).toBe('?period=7d');
        expect(buildUsageSummaryQuery({ groupBy: 'model', period: '2026-07' })).toBe(
            '?groupBy=model&period=2026-07',
        );
    });
});

describe('formatMonthlyPrice', () => {
    it('formats whole-dollar prices without decimals and keeps fractions', () => {
        expect(formatMonthlyPrice('29')).toBe('$29');
        expect(formatMonthlyPrice('29.00')).toBe('$29');
        expect(formatMonthlyPrice('9.50')).toBe('$9.50');
        expect(formatMonthlyPrice('0')).toBe('$0');
    });

    it('falls back to the raw string when the price is not numeric', () => {
        expect(formatMonthlyPrice('n/a')).toBe('n/a');
    });
});

describe('isFreePlan', () => {
    it('treats only an explicit ≤ 0 price as free (fail closed)', () => {
        expect(isFreePlan({ monthlyPrice: '0' })).toBe(true);
        expect(isFreePlan({ monthlyPrice: '0.00' })).toBe(true);
        expect(isFreePlan({ monthlyPrice: '29' })).toBe(false);
        expect(isFreePlan({ monthlyPrice: 'oops' })).toBe(false);
    });
});
