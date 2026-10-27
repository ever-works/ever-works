import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
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

import { HealthMetrics, secondsToNextCheck } from './overview/HealthMetrics';

/**
 * Computer health, second phase (FL-03, spec S8, §5.6, U1, U2, U3, U5,
 * FR-27) — Refresh now on the metrics block.
 */

const NOW = Date.parse('2026-10-21T09:41:00.000Z');
const BEAT = '2026-10-21T09:40:18.000Z'; // 42 s ago → next check in 18 s

function node(overrides: Partial<FleetNodeView> = {}): FleetNodeView {
    return {
        id: 'n1',
        name: 'build-01',
        kind: 'node',
        status: 'online',
        platform: 'linux/x64',
        version: '0.4.0',
        capabilities: [],
        lastHeartbeatAt: BEAT,
        createdAt: null,
        persisted: true,
        health: { at: BEAT, cpuPercent: 31 },
        ...overrides,
    };
}

describe('HealthMetrics — Refresh now', () => {
    it('is enabled when the link can reach the computer, and presses with a click', () => {
        const onRefresh = vi.fn();
        render(
            <HealthMetrics
                node={node()}
                now={NOW}
                refresh={{ available: true, reason: null }}
                onRefresh={onRefresh}
            />,
        );
        const button = screen.getByTestId('fleet-health-refresh');
        expect(button).not.toBeDisabled();
        expect(button).toHaveAttribute('aria-keyshortcuts', 'R');
        fireEvent.click(button);
        expect(onRefresh).toHaveBeenCalledTimes(1);
    });

    it('presses with R, never while typing', () => {
        const onRefresh = vi.fn();
        render(
            <HealthMetrics
                node={node()}
                now={NOW}
                refresh={{ available: true, reason: null }}
                onRefresh={onRefresh}
            />,
        );
        fireEvent.keyDown(document, { key: 'r' });
        expect(onRefresh).toHaveBeenCalledTimes(1);
    });

    it('shows the spinner state while asking, then "Checked just now"', () => {
        const { rerender } = render(
            <HealthMetrics
                node={node()}
                now={NOW}
                refresh={{ available: true, reason: null }}
                onRefresh={vi.fn()}
                refreshState="refreshing"
            />,
        );
        expect(screen.getByTestId('fleet-health-refresh')).toBeDisabled();
        expect(screen.getByTestId('fleet-health-refresh-reason')).toHaveTextContent('Refreshing…');
        rerender(
            <HealthMetrics
                node={node()}
                now={NOW}
                refresh={{ available: true, reason: null }}
                onRefresh={vi.fn()}
                refreshState="done"
            />,
        );
        expect(screen.getByTestId('fleet-health-refresh-reason')).toHaveTextContent(
            'Checked just now',
        );
    });

    it('keeps the cards and offers Try again with the hint when the link dropped (U3)', () => {
        render(
            <HealthMetrics
                node={node()}
                now={NOW}
                refresh={{ available: true, reason: null }}
                onRefresh={vi.fn()}
                refreshState="failed"
                refreshError="build-01 is not connected; last seen 2 min ago"
            />,
        );
        expect(screen.getByTestId('fleet-health-refresh')).toHaveTextContent('Try again');
        expect(screen.getByRole('alert')).toHaveTextContent(
            'Could not refresh: build-01 is not connected; last seen 2 min ago',
        );
        expect(screen.getAllByTestId('fleet-health-card').length).toBeGreaterThan(0);
    });

    it.each([
        ['offline', 'build-01 is offline'],
        [
            'no-link',
            'Refresh needs a link — start build-01 with --work, --attend or --manage · next automatic check in 18 s',
        ],
        ['not-connected', 'build-01 is not connected right now · next automatic check in 18 s'],
        ['kill-switch', 'Live actions are paused while all computers are stopped'],
        ['link-disabled', 'This deployment does not accept node links yet.'],
    ] as const)('is disabled with its reason for %s', (reason, text) => {
        render(
            <HealthMetrics
                node={node()}
                now={NOW}
                refresh={{ available: false, reason }}
                onRefresh={vi.fn()}
            />,
        );
        const button = screen.getByTestId('fleet-health-refresh');
        expect(button).toBeDisabled();
        expect(screen.getByTestId('fleet-health-refresh-reason')).toHaveTextContent(text);
        expect(button).toHaveAttribute(
            'aria-describedby',
            screen.getByTestId('fleet-health-refresh-reason').id,
        );
    });

    it('shows the start command next to a no-link reason (U2)', () => {
        render(
            <HealthMetrics
                node={node()}
                now={NOW}
                refresh={{ available: false, reason: 'no-link' }}
                onRefresh={vi.fn()}
            />,
        );
        expect(screen.getByText('ever-works-node start --work')).toBeInTheDocument();
    });

    it('keeps the old reason against an API older than Refresh now', () => {
        render(<HealthMetrics node={node()} now={NOW} />);
        expect(screen.getByTestId('fleet-health-refresh')).toBeDisabled();
        expect(screen.getByTestId('fleet-health-refresh-reason')).toHaveTextContent(
            'Refresh now arrives with the node link',
        );
    });
});

describe('secondsToNextCheck', () => {
    it('counts down to the next minute beat, and is null once due', () => {
        expect(secondsToNextCheck(BEAT, NOW)).toBe(18);
        expect(secondsToNextCheck(BEAT, NOW + 30_000)).toBeNull();
        expect(secondsToNextCheck(null, NOW)).toBeNull();
    });
});
