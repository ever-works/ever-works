import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { FleetNodeView } from '@ever-works/contracts';

vi.mock('next-intl', async () => {
    const { testTranslations } = await import('./fleet-test-intl');
    return { useLocale: () => 'en-GB', useTranslations: testTranslations };
});
vi.mock('@/app/actions/settings/fleet', () => ({ clearFleetNodeModelThrottleAction: vi.fn() }));
vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
        <a href={href}>{children}</a>
    ),
}));
const fetchHealth = vi.fn();
vi.mock('@/app/actions/fleet-health', () => ({
    fetchFleetNodeHealthAction: (id: string) => fetchHealth(id),
}));

import HealthMetricsBlock from './overview/HealthMetricsBlock';

const node: FleetNodeView = {
    id: 'n1',
    name: 'build-01',
    kind: 'node',
    status: 'online',
    platform: 'linux/x64',
    version: '0.3.0',
    capabilities: [],
    lastHeartbeatAt: new Date().toISOString(),
    createdAt: null,
    persisted: true,
    health: null,
};

/** Computer health (FL-03) — the registry block reads the health view once and offers Try again. */
describe('HealthMetricsBlock', () => {
    // A block body, not an expression: a function returned from beforeEach is
    // run as its cleanup, and this one is the mock itself.
    beforeEach(() => {
        fetchHealth.mockReset();
    });

    it('loads, then shows the fresh snapshot and the history footprint', async () => {
        fetchHealth.mockResolvedValue({
            success: true,
            data: {
                nodeId: 'n1',
                snapshot: { at: new Date().toISOString(), cpuPercent: 12 },
                stale: false,
                state: { state: 'online', params: {}, action: null },
                historyEnabled: true,
            },
            error: null,
        });
        render(<HealthMetricsBlock nodes={[node]} flags={{}} />);
        expect(screen.getByTestId('fleet-health-loading')).toBeTruthy();
        await waitFor(() =>
            expect(screen.getAllByTestId('fleet-health-card')[0].textContent).toBe('CPU12%'),
        );
        expect(screen.getByTestId('fleet-health-footprint').textContent).toContain(
            '7 days by the minute',
        );
        expect(fetchHealth).toHaveBeenCalledWith('n1');
    });

    it('a failed read says so and Try again reads once more', async () => {
        fetchHealth.mockResolvedValueOnce({ success: false, data: null, error: 'down' });
        render(<HealthMetricsBlock nodes={[node]} flags={{}} />);
        await waitFor(() => expect(screen.getByTestId('fleet-health-error')).toBeTruthy());
        fetchHealth.mockResolvedValueOnce({
            success: true,
            data: {
                nodeId: 'n1',
                snapshot: null,
                stale: true,
                state: { state: 'online', params: {}, action: null },
                historyEnabled: false,
            },
            error: null,
        });
        fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
        await waitFor(() => expect(screen.getByTestId('fleet-health-no-snapshot')).toBeTruthy());
        expect(fetchHealth).toHaveBeenCalledTimes(2);
    });

    it('never lays one computer’s snapshot over another when the page swaps computers', async () => {
        let resolveSecond: (value: unknown) => void = () => undefined;
        fetchHealth.mockImplementation((id: string) =>
            id === 'n1'
                ? Promise.resolve({
                      success: true,
                      data: {
                          nodeId: 'n1',
                          snapshot: { at: new Date().toISOString(), cpuPercent: 12 },
                          stale: false,
                          state: { state: 'online', params: {}, action: null },
                          historyEnabled: false,
                      },
                      error: null,
                  })
                : new Promise((resolve) => {
                      resolveSecond = resolve;
                  }),
        );
        const { rerender } = render(<HealthMetricsBlock nodes={[node]} flags={{}} />);
        await waitFor(() =>
            expect(screen.getAllByTestId('fleet-health-card')[0].textContent).toBe('CPU12%'),
        );
        // Same block instance, another computer: until its own answer lands
        // the block is loading — never build-01's 12 % under build-02's name.
        rerender(
            <HealthMetricsBlock nodes={[{ ...node, id: 'n2', name: 'build-02' }]} flags={{}} />,
        );
        expect(screen.getByTestId('fleet-health-loading')).toBeTruthy();
        expect(screen.queryByText('CPU12%')).toBeNull();
        resolveSecond({
            success: true,
            data: {
                nodeId: 'n2',
                snapshot: { at: new Date().toISOString(), cpuPercent: 77 },
                stale: false,
                state: { state: 'online', params: {}, action: null },
                historyEnabled: false,
            },
            error: null,
        });
        await waitFor(() =>
            expect(screen.getAllByTestId('fleet-health-card')[0].textContent).toBe('CPU77%'),
        );
        expect(fetchHealth).toHaveBeenLastCalledWith('n2');
    });

    it('the server’s stale verdict dims a snapshot the local clock would call fresh', async () => {
        fetchHealth.mockResolvedValue({
            success: true,
            data: {
                nodeId: 'n1',
                snapshot: { at: new Date().toISOString(), cpuPercent: 12 },
                stale: true,
                state: { state: 'online', params: {}, action: null },
                historyEnabled: false,
            },
            error: null,
        });
        render(<HealthMetricsBlock nodes={[node]} flags={{}} />);
        await waitFor(() =>
            expect(
                screen
                    .getByTestId('fleet-health-metrics')
                    .querySelector('[data-stale]')
                    ?.getAttribute('data-stale'),
            ).toBe('true'),
        );
    });

    it('falls back to the page flags for the history line until the read answers', () => {
        fetchHealth.mockReturnValue(new Promise(() => undefined));
        render(
            <HealthMetricsBlock nodes={[node]} flags={{ FLEET_HEALTH_HISTORY_ENABLED: true }} />,
        );
        expect(screen.getByTestId('fleet-health-loading')).toBeTruthy();
    });

    it('shows the server’s state, not the row’s: a computer the server judged offline reads Offline', async () => {
        fetchHealth.mockResolvedValue({
            success: true,
            data: {
                nodeId: 'n1',
                snapshot: { at: new Date().toISOString(), cpuPercent: 12 },
                stale: true,
                state: { state: 'offline', params: { lastSeenAt: null }, action: null },
                historyEnabled: false,
            },
            error: null,
        });
        // The row says online; the server’s offline window says otherwise.
        render(<HealthMetricsBlock nodes={[node]} flags={{}} />);
        await waitFor(() =>
            expect(screen.getByTestId('fleet-computer-state').getAttribute('data-state')).toBe(
                'offline',
            ),
        );
    });

    it('renders nothing without a computer', () => {
        const { container } = render(<HealthMetricsBlock nodes={[]} flags={{}} />);
        expect(container.innerHTML).toBe('');
    });
});
