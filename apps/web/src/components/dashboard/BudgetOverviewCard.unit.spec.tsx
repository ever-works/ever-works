import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
        vars ? `${key}:${JSON.stringify(vars)}` : key,
}));

import { BudgetOverviewCard } from './BudgetOverviewCard';

/**
 * EW-602 — BudgetOverviewCard renders current-period spend, the
 * progress bar against the configured cap, and an "overage allowed"
 * suffix. Empty-budget state shows the "no cap configured" message.
 *
 * Note: this repo's vitest setup does not extend jest-dom matchers
 * (a known pre-existing bug — several other *.unit.spec.tsx files in
 * apps/web fail with "Invalid Chai property: toBeInTheDocument"). We
 * use plain truthiness + textContent assertions instead, which is the
 * pattern the working FeedFilterChips spec uses.
 */
describe('BudgetOverviewCard', () => {
    it('renders the formatted spend amount', () => {
        render(
            <BudgetOverviewCard
                totalSpendCents={2575}
                currency="usd"
                periodLabel="May 2026"
                globalBudget={null}
            />,
        );
        expect(screen.getByText('$25.75')).toBeTruthy();
    });

    it('shows "no cap configured" empty state when globalBudget is null', () => {
        render(
            <BudgetOverviewCard
                totalSpendCents={0}
                currency="usd"
                periodLabel="May 2026"
                globalBudget={null}
            />,
        );
        expect(screen.getByText('overviewEmpty')).toBeTruthy();
    });

    it('renders the progress label with percent + cap when a budget is set', () => {
        render(
            <BudgetOverviewCard
                totalSpendCents={5000}
                currency="usd"
                periodLabel="May 2026"
                globalBudget={{
                    id: 'b1',
                    monthlyCapCents: 10_000,
                    allowOverage: false,
                    currency: 'usd',
                    percentUsed: 50,
                }}
            />,
        );
        const label = screen.getByText(/overviewProgressLabel/);
        expect(label.textContent).toContain('"percent":50');
        expect(label.textContent).toContain('$100.00');
    });

    it('appends "overage allowed" suffix when allowOverage = true', () => {
        const { container } = render(
            <BudgetOverviewCard
                totalSpendCents={11_000}
                currency="usd"
                periodLabel="May 2026"
                globalBudget={{
                    id: 'b1',
                    monthlyCapCents: 10_000,
                    allowOverage: true,
                    currency: 'usd',
                    percentUsed: 110,
                }}
            />,
        );
        expect(container.textContent).toContain('overviewOverageSuffix');
    });

    it('caps visible progress bar width at 100% even when spend is over (110% → bar at 100%)', () => {
        const { container } = render(
            <BudgetOverviewCard
                totalSpendCents={11_000}
                currency="usd"
                periodLabel="May 2026"
                globalBudget={{
                    id: 'b1',
                    monthlyCapCents: 10_000,
                    allowOverage: true,
                    currency: 'usd',
                    percentUsed: 110,
                }}
            />,
        );
        const bar = container.querySelector('[style*="width"]');
        expect(bar?.getAttribute('style')).toContain('width: 100%');
    });

    it('falls back to percent=0 when monthlyCapCents is 0 (no division by zero)', () => {
        render(
            <BudgetOverviewCard
                totalSpendCents={500}
                currency="usd"
                periodLabel="May 2026"
                globalBudget={{
                    id: 'b1',
                    monthlyCapCents: 0,
                    allowOverage: true,
                    currency: 'usd',
                    percentUsed: 0,
                }}
            />,
        );
        const label = screen.getByText(/overviewProgressLabel/);
        expect(label.textContent).toContain('"percent":0');
    });

    it('respects non-USD currency on the formatted amount', () => {
        const { container } = render(
            <BudgetOverviewCard
                totalSpendCents={1500}
                currency="eur"
                periodLabel="May 2026"
                globalBudget={null}
            />,
        );
        expect(container.textContent).toMatch(/€15\.00/);
    });
});
