import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { FleetKillSwitchState } from '@ever-works/contracts';
import { FleetKillSwitchBanner } from './FleetKillSwitchBanner';

/**
 * Panic controls (EW-778) — the stop-flag banner.
 *
 * Pins the three variants (stopped / unverified / unknown), that a clear
 * flag renders nothing, and the polling contract that matters: an
 * operator throwing the switch shows up WITHOUT a reload, and a failed
 * poll keeps the last-known state instead of blanking the warning.
 */

const getFleetKillSwitchAction = vi.fn();

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, values?: Record<string, unknown>) =>
        values ? `${key}:${Object.values(values).join(',')}` : key,
}));
vi.mock('@/app/actions/settings/fleet', () => ({
    getFleetKillSwitchAction: (...args: unknown[]) => getFleetKillSwitchAction(...args),
}));

function state(over: Partial<FleetKillSwitchState> = {}): FleetKillSwitchState {
    return {
        stopped: false,
        reason: null,
        since: null,
        unverified: false,
        ...over,
    };
}

beforeEach(() => {
    getFleetKillSwitchAction.mockReset();
    getFleetKillSwitchAction.mockResolvedValue({ success: true, data: state(), error: null });
});

describe('FleetKillSwitchBanner', () => {
    it('renders nothing while the flag is clear', async () => {
        render(<FleetKillSwitchBanner initial={state()} initialError={null} />);
        await waitFor(() => expect(getFleetKillSwitchAction).toHaveBeenCalled());
        expect(screen.queryByTestId('fleet-kill-switch-banner')).toBeNull();
    });

    it('renders the STOPPED variant with the reason and the time', async () => {
        const stopped = state({
            stopped: true,
            reason: 'incident on prod',
            since: '2026-09-05T02:00:00.000Z',
        });
        getFleetKillSwitchAction.mockResolvedValue({ success: true, data: stopped, error: null });
        render(<FleetKillSwitchBanner initial={stopped} initialError={null} />);

        const banner = screen.getByTestId('fleet-kill-switch-banner');
        expect(banner).toHaveAttribute('data-variant', 'stopped');
        expect(banner).toHaveAttribute('role', 'alert');
        expect(screen.getByText('stoppedTitle')).toBeInTheDocument();
        expect(screen.getByTestId('fleet-kill-switch-reason')).toHaveTextContent(
            'reason:incident on prod',
        );
        expect(screen.getByTestId('fleet-kill-switch-since')).toBeInTheDocument();
    });

    it('renders the UNVERIFIED variant (dispatch refusing because the flag could not be read)', async () => {
        const unverified = state({ stopped: true, unverified: true });
        getFleetKillSwitchAction.mockResolvedValue({
            success: true,
            data: unverified,
            error: null,
        });
        render(<FleetKillSwitchBanner initial={unverified} initialError={null} />);

        const banner = screen.getByTestId('fleet-kill-switch-banner');
        expect(banner).toHaveAttribute('data-variant', 'unverified');
        expect(screen.getByText('unverifiedTitle')).toBeInTheDocument();
        expect(screen.getByText('unverifiedBody')).toBeInTheDocument();
        // No reason / since lines: nobody threw the switch.
        expect(screen.queryByTestId('fleet-kill-switch-reason')).toBeNull();
        expect(screen.queryByTestId('fleet-kill-switch-since')).toBeNull();
    });

    it('appears WITHOUT a reload when a poll reports the switch was thrown', async () => {
        getFleetKillSwitchAction.mockResolvedValue({
            success: true,
            data: state({ stopped: true, reason: 'thrown later' }),
            error: null,
        });
        render(<FleetKillSwitchBanner initial={state()} initialError={null} />);

        expect(screen.queryByTestId('fleet-kill-switch-banner')).toBeNull();
        expect(await screen.findByTestId('fleet-kill-switch-banner')).toHaveAttribute(
            'data-variant',
            'stopped',
        );
    });

    it('keeps the last-known STOPPED state when a poll fails', async () => {
        getFleetKillSwitchAction.mockResolvedValue({
            success: false,
            data: null,
            error: 'network blip',
        });
        render(
            <FleetKillSwitchBanner
                initial={state({ stopped: true, reason: 'incident' })}
                initialError={null}
            />,
        );
        await waitFor(() => expect(getFleetKillSwitchAction).toHaveBeenCalled());
        expect(screen.getByTestId('fleet-kill-switch-banner')).toHaveAttribute(
            'data-variant',
            'stopped',
        );
    });

    it('renders the muted UNKNOWN variant when the page has no state and only an error', async () => {
        getFleetKillSwitchAction.mockResolvedValue({
            success: false,
            data: null,
            error: 'api unreachable',
        });
        render(<FleetKillSwitchBanner initial={null} initialError="api unreachable" />);

        const banner = screen.getByTestId('fleet-kill-switch-banner');
        expect(banner).toHaveAttribute('data-variant', 'unknown');
        expect(screen.getByText('unknownBody:api unreachable')).toBeInTheDocument();
    });
});
