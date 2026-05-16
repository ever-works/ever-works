import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
        vars ? `${key}:${JSON.stringify(vars)}` : key,
}));

// Recharts depends on ResizeObserver / DOM measurement. Stub the chart
// pieces so we can verify the empty state and the chart-vs-empty
// branch without booting full render layout.
vi.mock('recharts', () => ({
    Bar: () => null,
    BarChart: ({ children }: any) => <div data-testid="bar-chart">{children}</div>,
    ResponsiveContainer: ({ children }: any) => <div>{children}</div>,
    Tooltip: () => null,
    XAxis: () => null,
    YAxis: () => null,
}));

import { SpendTrendCard } from './SpendTrendCard';

/**
 * EW-602 — SpendTrendCard renders a daily-spend bar chart for the
 * current period, falling back to an empty-state message when there
 * are no buckets. (Plain truthiness matchers — see BudgetOverviewCard
 * spec for the jest-dom matcher caveat.)
 */
describe('SpendTrendCard', () => {
    it('shows empty state when buckets is empty', () => {
        render(<SpendTrendCard buckets={[]} currency="usd" periodLabel="May 2026" />);
        expect(screen.getByText('trendEmpty')).toBeTruthy();
        expect(screen.queryByTestId('bar-chart')).toBeNull();
    });

    it('renders the bar chart container when at least one bucket exists', () => {
        render(
            <SpendTrendCard
                buckets={[
                    { day: '2026-05-01', costCents: 100 },
                    { day: '2026-05-02', costCents: 250 },
                ]}
                currency="usd"
                periodLabel="May 2026"
            />,
        );
        expect(screen.getByTestId('bar-chart')).toBeTruthy();
        expect(screen.queryByText('trendEmpty')).toBeNull();
    });

    it('passes the period label into the title translation key', () => {
        const { container } = render(
            <SpendTrendCard
                buckets={[{ day: '2026-05-01', costCents: 100 }]}
                currency="usd"
                periodLabel="May 2026"
            />,
        );
        expect(container.textContent).toContain('trendTitle');
        expect(container.textContent).toContain('May 2026');
    });
});
