import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

/**
 * Fleet hub (FL-01, FR-14, spec U9, T-15) — the frame every hub tab renders
 * in: the kill-switch banner (from the server's first read of the switch), the
 * note that the hub's own acts still work while the fleet is stopped, and the
 * tab strip naming the panel it controls.
 */

const { killSwitchState } = vi.hoisted(() => ({ killSwitchState: vi.fn() }));

vi.mock('@/lib/api/fleet', () => ({ fleetAPI: { killSwitchState } }));
vi.mock('next-intl/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
        <a href={href} {...rest}>
            {children}
        </a>
    ),
}));
vi.mock('@/lib/fleet-flags', () => ({ readFleetFeatureFlags: () => ({}) }));
vi.mock('@/components/common/PageHeader', () => ({
    PageHeader: ({ title, actions }: { title: string; actions: React.ReactNode }) => (
        <header>
            <h1>{title}</h1>
            {actions}
        </header>
    ),
}));
vi.mock('@/components/settings/FleetKillSwitchBanner', () => ({
    FleetKillSwitchBanner: ({
        initial,
        initialError,
    }: {
        initial: { stopped: boolean } | null;
        initialError: string | null;
    }) => (
        <div
            data-testid="stub-kill-switch"
            data-stopped={String(Boolean(initial?.stopped))}
            data-error={initialError ?? ''}
        />
    ),
}));
vi.mock('./FleetAddComputerMenu', () => ({
    FleetAddComputerMenu: () => <div data-testid="stub-add" />,
}));
vi.mock('./FleetHubTabs', () => ({
    FleetHubTabs: ({ active }: { active: string }) => (
        <div data-testid="stub-tabs" data-active={active} />
    ),
}));

import { FleetHubFrame } from './FleetHubFrame';

// A block body: an arrow that RETURNS the mock would hand Vitest a teardown to call.
beforeEach(() => {
    killSwitchState.mockReset();
});

describe('FleetHubFrame', () => {
    it('shows the stop banner and says the hub’s own acts still work while the fleet is stopped', async () => {
        killSwitchState.mockResolvedValue({ stopped: true });
        render(await FleetHubFrame({ active: 'overview', children: <p>panel</p> }));
        expect(screen.getByTestId('stub-kill-switch')).toHaveAttribute('data-stopped', 'true');
        expect(screen.getByTestId('fleet-hub-kill-switch-note')).toHaveTextContent(
            'killSwitchNote',
        );
    });

    it('carries no note while the fleet runs', async () => {
        killSwitchState.mockResolvedValue({ stopped: false });
        render(await FleetHubFrame({ active: 'overview', children: <p>panel</p> }));
        expect(screen.getByTestId('stub-kill-switch')).toHaveAttribute('data-stopped', 'false');
        expect(screen.queryByTestId('fleet-hub-kill-switch-note')).toBeNull();
    });

    it('renders the banner’s could-not-verify variant when the read fails, never a broken page', async () => {
        killSwitchState.mockRejectedValue(new Error('api down'));
        render(await FleetHubFrame({ active: 'computers', children: <p>panel</p> }));
        expect(screen.getByTestId('stub-kill-switch')).toHaveAttribute('data-error', 'api down');
        expect(screen.getByText('panel')).toBeInTheDocument();
    });

    it('puts the tab’s content in the panel the active tab names', async () => {
        killSwitchState.mockResolvedValue({ stopped: false });
        render(await FleetHubFrame({ active: 'computers', children: <p>panel</p> }));
        const panel = screen.getByRole('tabpanel');
        expect(panel).toHaveAttribute('id', 'fleet-hub-panel');
        expect(panel).toHaveAttribute('aria-labelledby', 'fleet-hub-tab-computers');
        expect(panel).toHaveTextContent('panel');
    });
});
