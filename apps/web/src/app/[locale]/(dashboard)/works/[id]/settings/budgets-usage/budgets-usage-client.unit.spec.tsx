import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
        vars ? `${key}:${JSON.stringify(vars)}` : key,
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({
    toast: {
        success: (...args: any[]) => toastSuccess(...args),
        error: (...args: any[]) => toastError(...args),
    },
}));

const createBudget = vi.fn();
const updateBudget = vi.fn();
const deleteBudget = vi.fn();
vi.mock('@/app/actions/dashboard/budgets', () => ({
    createBudget: (...args: any[]) => createBudget(...args),
    updateBudget: (...args: any[]) => updateBudget(...args),
    deleteBudget: (...args: any[]) => deleteBudget(...args),
}));

import { BudgetsUsageClient } from './budgets-usage-client';

/**
 * EW-602 — BudgetsUsageClient is the per-Work settings page that
 * lists existing budgets, lets a MANAGER+ create / edit / delete them,
 * and offers a CSV export. This spec is intentionally narrow: it
 * verifies the high-level rendering branches and a few interaction
 * paths without trying to drive every form variant — those are best
 * exercised end-to-end via Playwright.
 */
describe('BudgetsUsageClient', () => {
    function makeProps(overrides: Partial<any> = {}) {
        return {
            workId: 'work-1',
            initialSummary: {
                periodLabel: 'May 2026',
                periodStart: '2026-05-01T00:00:00.000Z',
                periodEnd: '2026-06-01T00:00:00.000Z',
                currency: 'usd',
                totalSpendCents: 1234,
                perPlugin: [],
                globalBudget: null,
            },
            initialBudgets: [],
            availablePlugins: [],
            ...overrides,
        };
    }

    it('renders the title, description, and current period spend', () => {
        const { container } = render(<BudgetsUsageClient {...(makeProps() as any)} />);
        expect(container.textContent).toContain('title');
        expect(container.textContent).toContain('description');
        expect(container.textContent).toContain('May 2026');
        expect(container.textContent).toContain('$12.34');
    });

    it('shows the empty plugin-budgets message when no plugin budgets exist', () => {
        const { container } = render(<BudgetsUsageClient {...(makeProps() as any)} />);
        // The "empty" key for the pluginCaps namespace
        expect(container.textContent).toContain('empty');
    });

    it('lists existing plugin budgets with their pluginId visible', () => {
        const props = makeProps({
            initialBudgets: [
                {
                    id: 'b1',
                    workId: 'work-1',
                    scope: 'plugin',
                    pluginId: 'openai',
                    monthlyCapCents: 5000,
                    currency: 'usd',
                    allowOverage: false,
                },
            ],
        });
        const { container } = render(<BudgetsUsageClient {...(props as any)} />);
        expect(container.textContent).toContain('openai');
    });

    it('renders the spend-by-plugin breakdown table when perPlugin is non-empty', () => {
        const props = makeProps({
            initialSummary: {
                periodLabel: 'May 2026',
                periodStart: '2026-05-01T00:00:00.000Z',
                periodEnd: '2026-06-01T00:00:00.000Z',
                currency: 'usd',
                totalSpendCents: 2500,
                perPlugin: [
                    { pluginId: 'openai', capability: 'ai', units: 100, costCents: 1500 },
                    { pluginId: 'tavily', capability: 'search', units: 5, costCents: 1000 },
                ],
                globalBudget: null,
            },
        });
        render(<BudgetsUsageClient {...(props as any)} />);
        // Use unique strings to avoid duplicate-text false positives
        expect(screen.getAllByText('openai').length).toBeGreaterThan(0);
        expect(screen.getAllByText('tavily').length).toBeGreaterThan(0);
        expect(screen.getByText('$15.00')).toBeTruthy();
        expect(screen.getByText('$10.00')).toBeTruthy();
    });

    it('exposes an export-CSV button that triggers a fetch to the export endpoint', async () => {
        const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
            new Response('header\n', {
                status: 200,
                headers: { 'content-disposition': 'attachment; filename="usage.csv"' },
            }) as any,
        );
        // jsdom doesn't ship URL.createObjectURL — stub it.
        const createObjectURL = vi.fn(() => 'blob:mock');
        const revokeObjectURL = vi.fn();
        Object.defineProperty(global.URL, 'createObjectURL', {
            writable: true,
            value: createObjectURL,
        });
        Object.defineProperty(global.URL, 'revokeObjectURL', {
            writable: true,
            value: revokeObjectURL,
        });
        try {
            render(<BudgetsUsageClient {...(makeProps() as any)} />);
            // Two buttons: header has download icon + label. Click the first one matching downloadCsv.
            const buttons = screen.getAllByRole('button');
            const exportButton = buttons.find((b) => /downloadCsv/.test(b.textContent ?? ''));
            expect(exportButton).toBeDefined();
            await userEvent.click(exportButton!);
            expect(fetchSpy).toHaveBeenCalledWith(
                '/api/works/work-1/usage/export?format=csv',
                expect.objectContaining({ method: 'GET', cache: 'no-store' }),
            );
            expect(createObjectURL).toHaveBeenCalled();
        } finally {
            fetchSpy.mockRestore();
        }
    });

    it('falls back to "this period" label and currency=usd when initialSummary is null', () => {
        const props = makeProps({ initialSummary: null });
        const { container } = render(<BudgetsUsageClient {...(props as any)} />);
        expect(container.textContent).toContain('this period');
        // formatCents uses 'usd' fallback → renders $0.00 for the totalSpend
        expect(container.textContent).toContain('$0.00');
    });

    it('uses the global budget currency when present (not the summary currency)', () => {
        const props = makeProps({
            initialSummary: {
                periodLabel: 'May 2026',
                periodStart: '2026-05-01T00:00:00.000Z',
                periodEnd: '2026-06-01T00:00:00.000Z',
                currency: 'usd',
                totalSpendCents: 2500,
                perPlugin: [],
                globalBudget: null,
            },
            initialBudgets: [
                {
                    id: 'b-global',
                    workId: 'work-1',
                    scope: 'global',
                    pluginId: null,
                    monthlyCapCents: 10000,
                    currency: 'eur',
                    allowOverage: false,
                },
            ],
        });
        const { container } = render(<BudgetsUsageClient {...(props as any)} />);
        // €25.00 from EUR formatting wins over the 'usd' on the summary
        expect(container.textContent).toMatch(/€25\.00/);
    });
});
