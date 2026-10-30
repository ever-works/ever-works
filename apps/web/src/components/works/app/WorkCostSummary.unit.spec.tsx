import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { WorkCostRollup } from '@ever-works/contracts';
import messages from '../../../../messages/en.json';

/**
 * APW-08 T56 (FR-62, FR-73, ACC-08-37) — the App Work overview's Cost summary: the month's cap and
 * what remains of it, the link to each Task's own Cost section (the summary points at that section
 * rather than competing with it), and an unknown amount that reads "Unknown", never `$0.00`.
 */

const { costMock } = vi.hoisted(() => ({ costMock: vi.fn() }));

vi.mock('@/app/actions/dashboard/app-changes', () => ({
    getWorkCostAction: costMock,
}));

vi.mock('@/i18n/navigation', () => ({
    Link: ({ href, children, ...rest }: any) => (
        <a href={typeof href === 'string' ? href : ''} {...rest}>
            {children}
        </a>
    ),
}));

import { WorkCostSummary } from './WorkCostSummary';

const renderWithIntl = (node: React.ReactNode) =>
    render(
        <NextIntlClientProvider locale="en" messages={messages}>
            {node}
        </NextIntlClientProvider>,
    );

afterEach(() => {
    cleanup();
    costMock.mockReset();
});

function rollup(over: Partial<WorkCostRollup> = {}): WorkCostRollup {
    return {
        workId: 'w-1',
        month: '2026-10',
        periodStart: '2026-10-01T00:00:00.000Z',
        periodEnd: '2026-11-01T00:00:00.000Z',
        currency: 'usd',
        spendCents: 6_150,
        capCents: 20_000,
        remainingCents: 13_850,
        percentUsed: 31,
        allowOverage: false,
        alert: 'none',
        ...over,
    };
}

async function ready() {
    await waitFor(() =>
        expect(screen.getByTestId('work-cost-summary').getAttribute('data-state')).toBe('ready'),
    );
}

describe('WorkCostSummary (APW-08 T56)', () => {
    it('shows the month’s cap and the remaining amount', async () => {
        costMock.mockResolvedValue({ success: true, data: rollup() });
        renderWithIntl(<WorkCostSummary workId="w-1" />);
        await ready();

        expect(costMock).toHaveBeenCalledWith('w-1');
        expect(screen.getByTestId('work-cost-spend').textContent).toBe('$61.50');
        expect(screen.getByTestId('work-cost-cap').textContent).toBe('$200.00');
        expect(screen.getByTestId('work-cost-remaining').textContent).toBe('$138.50');
        expect(screen.getByTestId('work-cost-alert').textContent).toBe('Within budget');
    });

    it('links each of the month’s costliest Tasks to that Task’s Cost section', async () => {
        costMock.mockResolvedValue({
            success: true,
            data: rollup({
                tasks: [
                    { taskId: 't-dark', title: 'Add a dark mode toggle', spendCents: 4_200 },
                    { taskId: 't-untitled', title: null, spendCents: 1_950 },
                ],
            }),
        });
        renderWithIntl(<WorkCostSummary workId="w-1" />);
        await ready();

        const links = screen.getAllByTestId('work-cost-task-link');
        expect(links).toHaveLength(2);
        // The Task page, whose last section is the Task's Cost section (runs, receipts, total).
        expect(links[0].getAttribute('href')).toBe('/tasks/t-dark');
        expect(links[0].textContent).toBe('Add a dark mode toggle');
        expect(links[0].getAttribute('aria-label')).toBe(
            'Open the Cost section of Add a dark mode toggle',
        );
        expect(links[1].getAttribute('href')).toBe('/tasks/t-untitled');
        expect(links[1].textContent).toBe('Untitled Task');
        const lines = screen.getAllByTestId('work-cost-task');
        expect(lines[0].textContent).toContain('$42.00');
        expect(lines[1].textContent).toContain('$19.50');
        expect(screen.getByTestId('work-cost-tasks').textContent).toContain(
            "is on its Task's Cost section",
        );
    });

    it('points at the Task Cost section even with no Task lines yet, and links nothing', async () => {
        costMock.mockResolvedValue({ success: true, data: rollup({ tasks: [] }) });
        renderWithIntl(<WorkCostSummary workId="w-1" />);
        await ready();

        expect(screen.getByTestId('work-cost-tasks').textContent).toContain('Cost section');
        expect(screen.queryAllByTestId('work-cost-task-link')).toHaveLength(0);
    });

    it('an unknown spend reads Unknown, and so does the remaining amount — never the whole cap', async () => {
        costMock.mockResolvedValue({
            success: true,
            data: rollup({ spendCents: null, remainingCents: null, percentUsed: null }),
        });
        renderWithIntl(<WorkCostSummary workId="w-1" />);
        await ready();

        expect(screen.getByTestId('work-cost-spend').textContent).toBe('Unknown');
        expect(screen.getByTestId('work-cost-cap').textContent).toBe('$200.00');
        expect(screen.getByTestId('work-cost-remaining').textContent).toBe('Unknown');
        expect(screen.getByTestId('work-cost-summary').textContent).not.toContain('$0.00');
    });

    it('with no budget: the spend and no cap, exactly as any other Work', async () => {
        costMock.mockResolvedValue({
            success: true,
            data: rollup({ capCents: null, remainingCents: null, percentUsed: null }),
        });
        renderWithIntl(<WorkCostSummary workId="w-1" />);
        await ready();

        expect(screen.getByTestId('work-cost-spend').textContent).toBe('$61.50');
        expect(screen.getByTestId('work-cost-no-budget')).toBeTruthy();
        expect(screen.queryByTestId('work-cost-cap')).toBeNull();
        expect(screen.queryByTestId('work-cost-remaining')).toBeNull();
    });
});
