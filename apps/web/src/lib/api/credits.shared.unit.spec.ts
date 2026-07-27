// Wave 13 — pure-helper spec for the Billing / Usage & Credits pages.

import { describe, expect, it } from 'vitest';
import {
    buildLedgerQuery,
    buildUsageExportQuery,
    buildUsageSummaryQuery,
    CREDIT_LEDGER_KINDS,
    CREDIT_TOPUP_PRESETS_CENTS,
    creditsForTopupCents,
    currentUsageMonth,
    formatCents,
    formatCreditsAsDollars,
    formatMonthlyPrice,
    formatSignedCredits,
    formatUsageMonthLabel,
    isFreePlan,
    isUsageMonthPeriod,
    isUsagePeriod,
    ledgerKindTone,
    parseUsagePeriod,
    recentUsageMonths,
    USAGE_ROLLING_PERIODS,
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

describe('B20 — usage period grammar (7d / 30d / YYYY-MM)', () => {
    it('recognises both rolling ranges AND calendar months', () => {
        for (const rolling of USAGE_ROLLING_PERIODS) {
            expect(isUsagePeriod(rolling)).toBe(true);
            expect(isUsageMonthPeriod(rolling)).toBe(false);
        }
        for (const month of ['2026-01', '2026-07', '2026-12', '1999-09']) {
            expect(isUsageMonthPeriod(month)).toBe(true);
            expect(isUsagePeriod(month)).toBe(true);
        }
    });

    it('rejects everything the API would 400 on', () => {
        for (const bad of ['2026-13', '2026-00', '2026-7', '90d', '7D', 'last-month', '']) {
            expect(isUsagePeriod(bad)).toBe(false);
        }
    });

    it('parseUsagePeriod normalizes untrusted input instead of throwing', () => {
        expect(parseUsagePeriod('2026-06')).toBe('2026-06');
        expect(parseUsagePeriod('7d')).toBe('7d');
        // Next.js hands repeated query params through as an array.
        expect(parseUsagePeriod(['30d', '7d'])).toBe('30d');
        expect(parseUsagePeriod('nonsense')).toBeUndefined();
        expect(parseUsagePeriod(undefined)).toBeUndefined();
        expect(parseUsagePeriod(42)).toBeUndefined();
    });
});

describe('currentUsageMonth / recentUsageMonths', () => {
    it('formats the current UTC month zero-padded', () => {
        expect(currentUsageMonth(new Date('2026-07-25T12:00:00.000Z'))).toBe('2026-07');
        expect(currentUsageMonth(new Date('2026-01-01T00:00:00.000Z'))).toBe('2026-01');
        // Late-UTC-day instants must not roll into the next month.
        expect(currentUsageMonth(new Date('2026-11-30T23:59:59.000Z'))).toBe('2026-11');
    });

    it('lists the N most recent months newest-first, crossing the year boundary', () => {
        const months = recentUsageMonths(4, new Date('2026-02-10T00:00:00.000Z'));
        expect(months).toEqual(['2026-02', '2026-01', '2025-12', '2025-11']);
        // Every generated option is a period the API accepts.
        for (const month of months) {
            expect(isUsagePeriod(month)).toBe(true);
        }
        expect(recentUsageMonths(0, new Date('2026-02-10T00:00:00.000Z'))).toEqual([]);
    });
});

describe('formatUsageMonthLabel', () => {
    it('renders a human month label in UTC', () => {
        expect(formatUsageMonthLabel('2026-07')).toBe('July 2026');
        expect(formatUsageMonthLabel('2025-12')).toBe('December 2025');
    });

    it('passes non-month values (7d / 30d) through untouched', () => {
        expect(formatUsageMonthLabel('7d')).toBe('7d');
        expect(formatUsageMonthLabel('30d')).toBe('30d');
    });
});

describe('buildUsageExportQuery', () => {
    it('serializes the period only, and omits it when absent', () => {
        expect(buildUsageExportQuery()).toBe('');
        expect(buildUsageExportQuery({})).toBe('');
        expect(buildUsageExportQuery({ period: '2026-06' })).toBe('?period=2026-06');
        expect(buildUsageExportQuery({ period: '7d' })).toBe('?period=7d');
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
