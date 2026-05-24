import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: () =>
        (key: string, vars?: Record<string, unknown>) =>
            vars ? `${key}:${JSON.stringify(vars)}` : key,
}));

import { BudgetSummaryCard } from './BudgetSummaryCard';
import type { OwnerBudgetSummary } from '@/lib/api/missions';

function mkSummary(overrides: Partial<OwnerBudgetSummary> = {}): OwnerBudgetSummary {
    return {
        ownerType: 'mission',
        ownerId: 'm1',
        periodStart: '2026-05-01T00:00:00.000Z',
        periodEnd: '2026-06-01T00:00:00.000Z',
        currentSpendCents: 1500,
        capCents: 5000,
        currency: 'usd',
        percentUsed: 30,
        allowOverage: true,
        blocked: false,
        ...overrides,
    };
}

describe('BudgetSummaryCard (Phase 7 PR V)', () => {
    it('renders the period header derived from periodStart', () => {
        const { container } = render(<BudgetSummaryCard summary={mkSummary()} />);
        // The mock surfaces the t-key with the interpolation payload
        // inline. With jsdom's en-US locale defaults, periodStart
        // 2026-05-01 formats as "May 2026".
        expect(container.textContent).toContain('period');
        expect(container.textContent).toContain('"period":"May 2026"');
    });

    it('formats currentSpend as a USD money string', () => {
        const { container } = render(
            <BudgetSummaryCard summary={mkSummary({ currentSpendCents: 1234 })} />,
        );
        expect(container.textContent).toContain('$12.34');
    });

    it('formats the cap line when capCents is set', () => {
        const { container } = render(
            <BudgetSummaryCard summary={mkSummary({ capCents: 9999 })} />,
        );
        expect(container.textContent).toContain('$99.99');
        expect(container.textContent).toContain('percentUsed');
        expect(container.textContent).toContain('"percent":"30.0"');
    });

    it('renders the "No cap set" hint when capCents is null', () => {
        const { container } = render(
            <BudgetSummaryCard summary={mkSummary({ capCents: null, percentUsed: null })} />,
        );
        expect(container.textContent).toContain('noCap');
        expect(container.textContent).not.toContain('percentUsed');
    });

    it('shows the "blocked" badge when summary.blocked is true', () => {
        const { container } = render(
            <BudgetSummaryCard
                summary={mkSummary({
                    capCents: 5000,
                    currentSpendCents: 5000,
                    percentUsed: 100,
                    allowOverage: false,
                    blocked: true,
                })}
            />,
        );
        expect(container.textContent).toContain('blocked');
        // Bar tone is danger — assertable via the bar's class.
        const bar = document.querySelector('.bg-danger');
        expect(bar).toBeTruthy();
    });

    it('shows the "over cap" badge when percent > 100 but not blocked (allowOverage)', () => {
        const { container } = render(
            <BudgetSummaryCard
                summary={mkSummary({
                    capCents: 5000,
                    currentSpendCents: 7500,
                    percentUsed: 150,
                    allowOverage: true,
                    blocked: false,
                })}
            />,
        );
        expect(container.textContent).toContain('overCap');
        expect(container.textContent).not.toContain('blocked');
    });

    it('uses warning bar tone at >= 90% (not yet blocked)', () => {
        render(
            <BudgetSummaryCard
                summary={mkSummary({
                    capCents: 5000,
                    currentSpendCents: 4500,
                    percentUsed: 90,
                    blocked: false,
                })}
            />,
        );
        expect(document.querySelector('.bg-warning')).toBeTruthy();
    });

    it('clamps the progress bar at 100% even when percent > 100', () => {
        render(
            <BudgetSummaryCard
                summary={mkSummary({
                    capCents: 5000,
                    currentSpendCents: 15000,
                    percentUsed: 300,
                })}
            />,
        );
        const bar = document.querySelector('div.h-full');
        expect((bar as HTMLElement | null)?.style.width).toBe('100%');
    });

    it('falls back to plain dollars for unrecognized currency codes', () => {
        render(
            <BudgetSummaryCard
                summary={mkSummary({
                    currency: '!!not-a-currency!!' as unknown as string,
                    currentSpendCents: 2500,
                })}
            />,
        );
        // Intl.NumberFormat throws on a bad currency code; the
        // helper falls back to the plain `$X.YY` shape.
        expect(screen.getByText('$25.00')).toBeTruthy();
    });
});
