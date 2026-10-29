import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { TaskCostView } from '@ever-works/contracts';
import messages from '../../../messages/en.json';

/**
 * APW-08 T27 (ACC-08-28) — the Task page's **Cost** section from `GET /api/tasks/:id/cost`,
 * through the REAL English catalogue: runs with their receipts, the total, the Builds line when
 * there are Builds, and — the point — an unpriced amount reads **unknown**, never `$0.00`.
 */

const { getCost } = vi.hoisted(() => ({ getCost: vi.fn() }));

vi.mock('@/app/actions/tasks', () => ({ getTaskCostAction: getCost }));
// `formatCents` lives beside the Work cost summary, whose module imports its own action.
vi.mock('@/app/actions/dashboard/app-changes', () => ({ getWorkCostAction: vi.fn() }));
vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) =>
        React.createElement('a', { href, ...rest }, children),
}));

import { TaskCostSection, sumRunCents } from './TaskCostSection';

const copy = messages.dashboard.tasksPage.cost;

function cost(overrides: Partial<TaskCostView> = {}): TaskCostView {
    return {
        taskId: 'task-1',
        runs: [
            {
                runId: 'run-aaaaaaaa-1',
                costCents: 120,
                receiptUrl: '/agents/sessions/run-aaaaaaaa-1',
                status: 'completed',
                startedAt: '2026-10-29T10:00:00.000Z',
            },
            {
                runId: 'run-bbbbbbbb-2',
                costCents: 64,
                receiptUrl: '/agents/sessions/run-bbbbbbbb-2',
                status: 'completed',
                startedAt: '2026-10-29T11:00:00.000Z',
            },
        ],
        builds: [],
        totalCents: 184,
        currency: 'usd',
        runsLimit: 50,
        runsTruncated: false,
        ...overrides,
    };
}

function renderSection() {
    return render(
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
            <TaskCostSection taskId="task-1" />
        </NextIntlClientProvider>,
    );
}

afterEach(() => {
    cleanup();
    getCost.mockReset();
});

describe('TaskCostSection (APW-08 T27)', () => {
    it('shows the runs, each with its amount and receipt, and the total', async () => {
        getCost.mockResolvedValue({ ok: true, cost: cost() });
        renderSection();

        await waitFor(() => expect(screen.getByTestId('task-cost-total')).toBeTruthy());
        expect(getCost).toHaveBeenCalledWith('task-1');
        expect(screen.getByTestId('task-cost-runs').textContent).toBe('Runs 2 · $1.84');
        expect(screen.getByTestId('task-cost-total').textContent).toBe('Total $1.84');
        const amounts = screen
            .getAllByTestId('task-cost-run-amount')
            .map((cell) => cell.textContent);
        expect(amounts).toEqual(['$1.20', '$0.64']);
        const receipts = screen.getAllByText(copy.receipt).map((link) => link.getAttribute('href'));
        expect(receipts).toEqual([
            '/agents/sessions/run-aaaaaaaa-1',
            '/agents/sessions/run-bbbbbbbb-2',
        ]);
        expect(screen.queryByTestId('task-cost-builds')).toBeNull();
    });

    it('an unknown cost reads unknown — never $0.00 — for a run and for the total', async () => {
        getCost.mockResolvedValue({
            ok: true,
            cost: cost({
                runs: [{ ...cost().runs[0] }, { ...cost().runs[1], costCents: null }],
                totalCents: null,
            }),
        });
        renderSection();

        await waitFor(() => expect(screen.getByTestId('task-cost-total')).toBeTruthy());
        expect(copy.unknown).toBe('unknown');
        expect(screen.getByTestId('task-cost-total').textContent).toBe('Total unknown');
        // One unpriced run makes the runs' sum unknown: a partial sum would read as the whole.
        expect(screen.getByTestId('task-cost-runs').textContent).toBe('Runs 2 · unknown');
        const amounts = screen
            .getAllByTestId('task-cost-run-amount')
            .map((cell) => cell.textContent);
        expect(amounts).toEqual(['$1.20', 'unknown']);
        expect(screen.getByTestId('task-cost-section').textContent).not.toContain('$0.00');
    });

    it('a Task with no runs costs a known zero', async () => {
        getCost.mockResolvedValue({ ok: true, cost: cost({ runs: [], totalCents: 0 }) });
        renderSection();
        await waitFor(() => expect(screen.getByText(copy.noRuns)).toBeTruthy());
        expect(screen.getByTestId('task-cost-runs').textContent).toBe('Runs 0 · $0.00');
        expect(screen.getByTestId('task-cost-total').textContent).toBe('Total $0.00');
    });

    it('lists Builds with their payer once per-Task Build accounting reports any', async () => {
        getCost.mockResolvedValue({
            ok: true,
            cost: cost({
                builds: [
                    { buildId: 'b-1', runnerMinutes: 11, payer: 'github', costCents: null },
                    { buildId: 'b-2', runnerMinutes: 12, payer: 'github', costCents: null },
                ],
            }),
        });
        renderSection();
        await waitFor(() => expect(screen.getByTestId('task-cost-builds')).toBeTruthy());
        expect(screen.getByTestId('task-cost-builds').textContent).toBe(
            'Builds 2 · 23 runner minutes (Paid by your GitHub account)',
        );
    });

    it('says when only the newest runs are listed, and when the read failed', async () => {
        getCost.mockResolvedValueOnce({ ok: true, cost: cost({ runsTruncated: true }) });
        renderSection();
        await waitFor(() => expect(screen.getByTestId('task-cost-truncated')).toBeTruthy());
        expect(screen.getByTestId('task-cost-truncated').textContent).toBe(
            'Showing the newest 50 runs.',
        );
        cleanup();

        getCost.mockResolvedValueOnce({ ok: false, code: 'COST_READ_FAILED' });
        renderSection();
        await waitFor(() => expect(screen.getByTestId('task-cost-unavailable')).toBeTruthy());
        expect(screen.getByTestId('task-cost-section').getAttribute('data-state')).toBe(
            'unavailable',
        );
    });

    it('sumRunCents is unknown as soon as one run is', () => {
        expect(sumRunCents([])).toBe(0);
        expect(sumRunCents(cost().runs)).toBe(184);
        expect(sumRunCents([{ ...cost().runs[0], costCents: null }])).toBeNull();
    });
});
