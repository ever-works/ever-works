import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
        vars ? `${key}:${JSON.stringify(vars)}` : key,
}));

// `@/i18n/navigation` pulls the next-intl routing config (and with it the
// Next router) into a jsdom spec. The component only needs an anchor.
vi.mock('@/i18n/navigation', () => ({
    Link: ({ href, children, ...rest }: any) => (
        <a href={typeof href === 'string' ? href : '#'} {...rest}>
            {children}
        </a>
    ),
}));

// recharts measures its container, which jsdom reports as 0×0 — the real
// chart is exercised by the e2e suite. The stub keeps the series contract
// observable (a `data-series` attribute) so the wiring is still asserted.
vi.mock('recharts', () => {
    const Passthrough = ({ children }: any) => <div>{children}</div>;
    return {
        ResponsiveContainer: Passthrough,
        BarChart: ({ children }: any) => <div data-testid="recharts-barchart">{children}</div>,
        Bar: ({ dataKey, name, stackId }: any) => (
            <div
                data-testid="recharts-bar"
                data-key={dataKey}
                data-name={name}
                data-stack={stackId}
            />
        ),
        XAxis: () => null,
        YAxis: () => null,
        Tooltip: () => null,
        Legend: () => null,
    };
});

import { CostsSettings } from './CostsSettings';
import type { CostsSnapshot } from '@/lib/api/costs.shared';

const EMPTY_SNAPSHOT: CostsSnapshot = {
    summary: null,
    daily: null,
    byAgent: null,
    byModel: null,
    topRuns: null,
};

function snapshot(overrides: Partial<CostsSnapshot> = {}): CostsSnapshot {
    return {
        summary: {
            status: 'success',
            windowDays: 30,
            from: '2026-07-16T00:00:00.000Z',
            to: '2026-08-14T15:30:00.000Z',
            totalCostCents: 12345,
            runsCount: 9,
            avgPerRunCents: 1372,
        },
        daily: {
            status: 'success',
            windowDays: 30,
            from: '2026-07-16T00:00:00.000Z',
            to: '2026-08-14T15:30:00.000Z',
            series: [
                { key: 'agent-1', label: 'Researcher', costCents: 10000 },
                { key: 'unattributed', label: null, costCents: 2345 },
            ],
            days: [
                { day: '2026-08-13', totalCostCents: 100, costs: { 'agent-1': 100 } },
                { day: '2026-08-14', totalCostCents: 40, costs: { unattributed: 40 } },
            ],
        },
        byAgent: {
            status: 'success',
            windowDays: 30,
            from: '2026-07-16T00:00:00.000Z',
            to: '2026-08-14T15:30:00.000Z',
            rows: [
                {
                    agentId: 'agent-1',
                    name: 'Researcher',
                    costCents: 10000,
                    runs: 8,
                    avgPerRunCents: 1250,
                },
                {
                    agentId: null,
                    name: null,
                    costCents: 2345,
                    runs: 0,
                    avgPerRunCents: 0,
                },
            ],
        },
        byModel: {
            status: 'success',
            windowDays: 30,
            from: '2026-07-16T00:00:00.000Z',
            to: '2026-08-14T15:30:00.000Z',
            totalCostCents: 12345,
            rows: [
                { modelId: 'claude-opus-5', units: 900, costCents: 10000, sharePercent: 81 },
                { modelId: null, units: 12, costCents: 2345, sharePercent: 19 },
            ],
        },
        topRuns: {
            status: 'success',
            windowDays: 30,
            from: '2026-07-16T00:00:00.000Z',
            to: '2026-08-14T15:30:00.000Z',
            rows: [
                {
                    runId: 'run-1',
                    costCents: 5000,
                    agentId: 'agent-1',
                    agentName: 'Researcher',
                    taskId: 'task-1',
                    taskTitle: 'Refresh the catalog',
                    modelId: 'claude-opus-5',
                    status: 'completed',
                    triggerKind: 'task',
                    startedAt: '2026-08-13T09:00:00.000Z',
                },
                {
                    runId: 'run-2',
                    costCents: 900,
                    agentId: 'agent-2',
                    agentName: null,
                    taskId: null,
                    taskTitle: null,
                    modelId: null,
                    status: 'failed',
                    triggerKind: 'heartbeat',
                    startedAt: null,
                },
            ],
        },
        ...overrides,
    };
}

describe('CostsSettings', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('renders the headline tiles from the server snapshot', () => {
        render(<CostsSettings initialWindowDays={30} initialSnapshot={snapshot()} />);

        expect(screen.getByTestId('costs-tile-total')).toHaveTextContent('$123.45');
        expect(screen.getByTestId('costs-tile-runs')).toHaveTextContent('9');
        expect(screen.getByTestId('costs-tile-avg')).toHaveTextContent('$13.72');
        expect(screen.queryByTestId('costs-load-error')).toBeNull();
    });

    it('stacks one chart series per API series, sharing a stack id', () => {
        render(<CostsSettings initialWindowDays={30} initialSnapshot={snapshot()} />);

        const bars = screen.getAllByTestId('recharts-bar');
        expect(bars).toHaveLength(2);
        expect(bars.map((bar) => bar.getAttribute('data-key'))).toEqual([
            'agent-1',
            'unattributed',
        ]);
        // Same stackId or the bars render side-by-side instead of stacked.
        expect(new Set(bars.map((bar) => bar.getAttribute('data-stack')))).toEqual(
            new Set(['cost']),
        );
        // The sentinel series gets localized copy, not a raw key.
        expect(bars[1].getAttribute('data-name')).toBe('series.unattributed');
    });

    it('renders the per-agent table with runs and average, and no cache-hit column', () => {
        render(<CostsSettings initialWindowDays={30} initialSnapshot={snapshot()} />);

        const table = screen.getByTestId('costs-by-agent-table');
        const headers = within(table)
            .getAllByRole('columnheader')
            .map((cell) => cell.textContent);
        expect(headers).toEqual([
            'byAgent.colAgent',
            'byAgent.colCost',
            'byAgent.colRuns',
            'byAgent.colAvg',
        ]);
        expect(headers).not.toContain('byAgent.colCacheHit');

        const rows = within(table).getAllByTestId('costs-by-agent-row');
        expect(rows[0].textContent).toContain('Researcher');
        expect(rows[0].textContent).toContain('$100.00');
        expect(rows[0].textContent).toContain('$12.50');
        // The unattributed row is labelled, never blank or a raw null.
        expect(rows[1].textContent).toContain('series.unattributed');
    });

    it('links each agent and task row to its detail page', () => {
        render(<CostsSettings initialWindowDays={30} initialSnapshot={snapshot()} />);

        const topRuns = screen.getByTestId('costs-top-runs-table');
        const links = within(topRuns).getAllByRole('link');
        expect(links.map((link) => link.getAttribute('href'))).toEqual(
            expect.arrayContaining(['/agents/agent-1/activity', '/tasks/task-1']),
        );
    });

    it('labels a run with no task and no model honestly instead of leaving cells blank', () => {
        render(<CostsSettings initialWindowDays={30} initialSnapshot={snapshot()} />);

        const rows = within(screen.getByTestId('costs-top-runs-table')).getAllByTestId(
            'costs-top-runs-row',
        );
        expect(rows[1].textContent).toContain('topRuns.noTask:{"trigger":"heartbeat"}');
        expect(rows[1].textContent).toContain('series.noModel');
        expect(rows[1].textContent).toContain('series.unknownAgent');
    });

    it('renders the by-model rows with share, units and the shared denominator', () => {
        render(<CostsSettings initialWindowDays={30} initialSnapshot={snapshot()} />);

        const rows = screen.getAllByTestId('costs-by-model-row');
        expect(rows[0].textContent).toContain('claude-opus-5');
        expect(rows[0].textContent).toContain('81%');
        expect(rows[0].textContent).toContain('byModel.units:{"units":900}');
        // A capability with no model is named, not rendered as `null`.
        expect(rows[1].textContent).toContain('series.noModel');
        // The window total the shares are computed against is stated.
        expect(screen.getByTestId('costs-by-model-total')).toHaveTextContent(
            'byModel.total:{"total":"$123.45"}',
        );
    });

    it('renders each run status, colouring only the failed one', () => {
        render(<CostsSettings initialWindowDays={30} initialSnapshot={snapshot()} />);

        const rows = within(screen.getByTestId('costs-top-runs-table')).getAllByTestId(
            'costs-top-runs-row',
        );
        expect(rows[0].textContent).toContain('topRuns.status.completed');
        expect(rows[1].textContent).toContain('topRuns.status.failed');
        expect(rows[1].querySelector('.text-danger')).not.toBeNull();
        expect(rows[0].querySelector('.text-danger')).toBeNull();
    });

    it('shows the load-error banner when every panel failed server-side', () => {
        render(<CostsSettings initialWindowDays={30} initialSnapshot={EMPTY_SNAPSHOT} />);

        expect(screen.getByTestId('costs-load-error')).toBeInTheDocument();
        expect(screen.getByTestId('costs-daily-chart-empty')).toBeInTheDocument();
        expect(screen.getByTestId('costs-top-runs-empty')).toBeInTheDocument();
    });

    describe('window picker', () => {
        it('refetches every panel through the proxy with the new window', async () => {
            const fetchMock = vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({ status: 'success', rows: [], series: [], days: [] }),
            });
            vi.stubGlobal('fetch', fetchMock);

            render(<CostsSettings initialWindowDays={30} initialSnapshot={snapshot()} />);
            await userEvent.click(screen.getByTestId('costs-window-7'));

            await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5));
            expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
                '/api/usage/costs/summary?windowDays=7',
                '/api/usage/costs/daily?windowDays=7',
                '/api/usage/costs/by-agent?windowDays=7',
                '/api/usage/costs/by-model?windowDays=7',
                '/api/usage/costs/top-runs?windowDays=7',
            ]);
        });

        it('serves a window it has already loaded from cache without refetching', async () => {
            const fetchMock = vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({ status: 'success', rows: [], series: [], days: [] }),
            });
            vi.stubGlobal('fetch', fetchMock);

            render(<CostsSettings initialWindowDays={30} initialSnapshot={snapshot()} />);
            await userEvent.click(screen.getByTestId('costs-window-7'));
            await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5));

            // Back to the server-rendered window — already cached.
            await userEvent.click(screen.getByTestId('costs-window-30'));
            expect(fetchMock).toHaveBeenCalledTimes(5);
            expect(screen.getByTestId('costs-tile-total')).toHaveTextContent('$123.45');
        });

        it('surfaces a failed refetch instead of silently keeping stale numbers', async () => {
            vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));

            render(<CostsSettings initialWindowDays={30} initialSnapshot={snapshot()} />);
            await userEvent.click(screen.getByTestId('costs-window-90'));

            expect(await screen.findByTestId('costs-load-error')).toBeInTheDocument();
        });

        it('marks the active window for assistive tech', async () => {
            render(<CostsSettings initialWindowDays={30} initialSnapshot={snapshot()} />);

            expect(screen.getByTestId('costs-window-30')).toHaveAttribute('aria-pressed', 'true');
            expect(screen.getByTestId('costs-window-7')).toHaveAttribute('aria-pressed', 'false');
        });
    });
});
