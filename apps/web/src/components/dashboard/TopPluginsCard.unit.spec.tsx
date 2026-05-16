import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));

import { TopPluginsCard } from './TopPluginsCard';

/**
 * EW-602 — TopPluginsCard renders up to 5 plugins by spend, with a
 * capability badge + formatted cost. Empty list shows the empty state.
 *
 * (Uses plain truthiness assertions instead of jest-dom matchers — see
 * the comment in BudgetOverviewCard.unit.spec.tsx for the reason.)
 */
describe('TopPluginsCard', () => {
    it('shows empty state when perPlugin is empty', () => {
        render(<TopPluginsCard perPlugin={[]} currency="usd" />);
        expect(screen.getByText('topPluginsEmpty')).toBeTruthy();
    });

    it('renders one row per plugin with capability badge + cost', () => {
        render(
            <TopPluginsCard
                perPlugin={[
                    { pluginId: 'openai', capability: 'ai', units: 100, costCents: 1500 },
                    { pluginId: 'tavily', capability: 'search', units: 5, costCents: 800 },
                ]}
                currency="usd"
            />,
        );
        expect(screen.getByText('openai')).toBeTruthy();
        expect(screen.getByText('tavily')).toBeTruthy();
        expect(screen.getByText('ai')).toBeTruthy();
        expect(screen.getByText('search')).toBeTruthy();
        expect(screen.getByText('$15.00')).toBeTruthy();
        expect(screen.getByText('$8.00')).toBeTruthy();
    });

    it('caps the visible list at 5 plugins (top-N by spend, input pre-sorted)', () => {
        const many = Array.from({ length: 8 }, (_, i) => ({
            pluginId: `plugin-${i}`,
            capability: 'ai' as const,
            units: 1,
            costCents: 1000 - i,
        }));
        render(<TopPluginsCard perPlugin={many} currency="usd" />);
        // First 5 visible
        expect(screen.getByText('plugin-0')).toBeTruthy();
        expect(screen.getByText('plugin-4')).toBeTruthy();
        // 6th onwards is dropped
        expect(screen.queryByText('plugin-5')).toBeNull();
        expect(screen.queryByText('plugin-7')).toBeNull();
    });

    it('renders all 4 capability badge variants without throwing', () => {
        render(
            <TopPluginsCard
                perPlugin={[
                    { pluginId: 'a', capability: 'ai', units: 1, costCents: 100 },
                    { pluginId: 'b', capability: 'search', units: 1, costCents: 200 },
                    { pluginId: 'c', capability: 'screenshot', units: 1, costCents: 300 },
                    { pluginId: 'd', capability: 'extractor', units: 1, costCents: 400 },
                ]}
                currency="usd"
            />,
        );
        expect(screen.getByText('ai')).toBeTruthy();
        expect(screen.getByText('search')).toBeTruthy();
        expect(screen.getByText('screenshot')).toBeTruthy();
        expect(screen.getByText('extractor')).toBeTruthy();
    });

    it('respects non-USD currency in cost formatting', () => {
        const { container } = render(
            <TopPluginsCard
                perPlugin={[{ pluginId: 'openai', capability: 'ai', units: 1, costCents: 1234 }]}
                currency="eur"
            />,
        );
        expect(container.textContent).toMatch(/€12\.34/);
    });
});
