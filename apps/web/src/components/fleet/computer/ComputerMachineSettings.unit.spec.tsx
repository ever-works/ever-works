import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { FleetNodeView } from '@ever-works/contracts';

/**
 * Fleet hub (FL-01, T-24, spec §5.10) — the machine's own settings on a
 * computer's Settings tab: the SAME node panel as the Computers tab's Details
 * (capabilities, limits, cost ceiling, lifecycle, credential), wired to the
 * same server actions; a rotated credential's one-time token is shown at once.
 */

const actions = vi.hoisted(() => ({
    getFleetNodeDetailAction: vi.fn(),
    updateFleetNodeAction: vi.fn(),
    setFleetNodeLimitCeilingAction: vi.fn(),
    clearFleetNodeModelThrottleAction: vi.fn(),
    drainFleetNodeAction: vi.fn(),
    rotateFleetNodeCredentialAction: vi.fn(),
}));
const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
const drawer = vi.hoisted(() => ({ props: null as null | Record<string, unknown> }));

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));
vi.mock('@/i18n/navigation', () => ({
    useRouter: () => router,
    Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
        <a href={href}>{children}</a>
    ),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/app/actions/settings/fleet', () => actions);
vi.mock('../computers/FleetNodeDrawer', () => ({
    FleetNodeDrawer: (props: Record<string, unknown>) => {
        drawer.props = props;
        return props.node ? (
            <div data-testid="stub-drawer" data-loading={String(props.loading)} />
        ) : null;
    },
}));
vi.mock('../computers/FleetEnrollHandoff', () => ({
    FleetEnrollHandoff: ({ issued }: { issued: { token: string } }) => (
        <div data-testid="stub-handoff">{issued.token}</div>
    ),
}));

import { ComputerMachineSettings } from './ComputerMachineSettings';

const node: FleetNodeView = {
    id: 'n1',
    name: 'build-01',
    kind: 'node',
    status: 'online',
    platform: 'linux/x64',
    version: '1.0.0',
    capabilities: [],
    lastHeartbeatAt: null,
    createdAt: null,
    persisted: true,
};

const ok = <T,>(data: T) => ({ success: true, data, error: null });

function renderIt() {
    return render(
        <ComputerMachineSettings
            node={node}
            apiBaseUrl="http://localhost:3100"
            desktopDownloadUrl="https://example.test/d"
            nodeDownloadUrl="https://example.test/n"
        />,
    );
}

beforeEach(() => {
    for (const fn of Object.values(actions)) fn.mockReset();
    router.refresh.mockReset();
    drawer.props = null;
});

describe('ComputerMachineSettings', () => {
    it('opens the Computers tab’s node panel for this computer, with its detail', async () => {
        actions.getFleetNodeDetailAction.mockResolvedValue(
            ok({ node, recentJobs: [], failures: [], historyUnavailable: false }),
        );
        renderIt();
        expect(screen.queryByTestId('stub-drawer')).toBeNull();
        await userEvent.click(screen.getByTestId('fleet-computer-machine-open'));
        await waitFor(() =>
            expect(screen.getByTestId('stub-drawer')).toHaveAttribute('data-loading', 'false'),
        );
        expect(actions.getFleetNodeDetailAction).toHaveBeenCalledWith('n1');
        expect(drawer.props?.detail).toMatchObject({ node: { id: 'n1' } });
    });

    it('saves through the same server actions and refreshes the page', async () => {
        actions.getFleetNodeDetailAction.mockResolvedValue(
            ok({ node, recentJobs: [], failures: [], historyUnavailable: false }),
        );
        actions.updateFleetNodeAction.mockResolvedValue(ok({ ...node, capabilities: ['gpu'] }));
        renderIt();
        await userEvent.click(screen.getByTestId('fleet-computer-machine-open'));
        await waitFor(() => expect(drawer.props?.detail).toBeTruthy());
        (drawer.props?.onSaveCapabilities as (c: string[], p: boolean) => void)(['gpu'], true);
        await waitFor(() =>
            expect(actions.updateFleetNodeAction).toHaveBeenCalledWith('n1', {
                capabilities: ['gpu'],
                capabilitiesPinned: true,
            }),
        );
        await waitFor(() => expect(router.refresh).toHaveBeenCalled());
    });

    it('shows a rotated credential’s one-time token at once and closes the panel', async () => {
        actions.getFleetNodeDetailAction.mockResolvedValue(
            ok({ node, recentJobs: [], failures: [], historyUnavailable: false }),
        );
        actions.rotateFleetNodeCredentialAction.mockResolvedValue(
            ok({ token: 'one-time-token', node }),
        );
        renderIt();
        await userEvent.click(screen.getByTestId('fleet-computer-machine-open'));
        await waitFor(() => expect(drawer.props?.detail).toBeTruthy());
        (drawer.props?.onRotate as () => void)();
        await waitFor(() =>
            expect(screen.getByTestId('stub-handoff')).toHaveTextContent('one-time-token'),
        );
        expect(screen.queryByTestId('stub-drawer')).toBeNull();
    });

    it('says the detail could not be read instead of an empty panel', async () => {
        actions.getFleetNodeDetailAction.mockResolvedValue({
            success: false,
            data: null,
            error: 'boom',
        });
        renderIt();
        await userEvent.click(screen.getByTestId('fleet-computer-machine-open'));
        await waitFor(() => expect(drawer.props?.error).toBe('boom'));
    });
});
