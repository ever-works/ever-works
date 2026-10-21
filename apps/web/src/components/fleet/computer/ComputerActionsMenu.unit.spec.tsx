import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { FleetNodeView } from '@ever-works/contracts';

/**
 * Fleet hub (FL-01, FR-22, FR-23, ACC-FL01-12, T-23) — the computer page's ⋯
 * menu: rename and favourite apply with no dialog, pause says so in a toast,
 * drain confirms once naming the jobs it releases, remove needs the typed
 * name, and an act the viewer is outside of is disabled with the reason.
 */

const actions = vi.hoisted(() => ({
    updateFleetNodeAction: vi.fn(),
    setFleetNodeFavoriteAction: vi.fn(),
    drainFleetNodeAction: vi.fn(),
    deleteFleetNodeAction: vi.fn(),
    fetchFleetComputerInFlightAction: vi.fn(),
}));
const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, values?: Record<string, unknown>) =>
        values ? `${key}:${Object.values(values).join(',')}` : key,
}));
vi.mock('@/i18n/navigation', () => ({
    useRouter: () => router,
    Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
        <a href={href}>{children}</a>
    ),
}));
vi.mock('sonner', () => ({ toast }));
vi.mock('@/app/actions/settings/fleet', () => actions);
vi.mock('../fleet-telemetry', () => ({ captureFleetEvent: vi.fn() }));

import { ComputerActionsMenu } from './ComputerActionsMenu';

const node = (over: Partial<FleetNodeView> = {}): FleetNodeView =>
    ({
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
        viewerRole: 'owner',
        isFavorite: false,
        controlPolicy: 'owner',
        controlPolicyFamilies: null,
        ...over,
    }) as FleetNodeView;

const ok = <T,>(data: T) => ({ success: true, data, error: null });

async function openMenu() {
    await userEvent.click(screen.getByTestId('fleet-computer-menu-trigger'));
}

beforeEach(() => {
    for (const fn of Object.values(actions)) fn.mockReset();
    router.push.mockReset();
    router.refresh.mockReset();
    toast.success.mockReset();
    toast.error.mockReset();
});

describe('ComputerActionsMenu — the owner', () => {
    it('offers every act, in the spec’s order', async () => {
        render(<ComputerActionsMenu node={node()} />);
        await openMenu();
        const ids = screen
            .getAllByTestId(/^fleet-computer-menu-(rename|favourite|pause|drain|copy-link|remove)$/)
            .map((element) => element.getAttribute('data-testid'));
        expect(ids).toEqual([
            'fleet-computer-menu-rename',
            'fleet-computer-menu-favourite',
            'fleet-computer-menu-pause',
            'fleet-computer-menu-drain',
            'fleet-computer-menu-copy-link',
            'fleet-computer-menu-remove',
        ]);
        expect(screen.queryByTestId(/-denied$/)).toBeNull();
    });

    it('renames inline, with no dialog, and refreshes the page', async () => {
        actions.updateFleetNodeAction.mockResolvedValue(ok(node({ name: 'build-02' })));
        render(<ComputerActionsMenu node={node()} />);
        await openMenu();
        await userEvent.click(screen.getByTestId('fleet-computer-menu-rename'));
        expect(screen.queryByRole('dialog')).toBeNull();
        const input = screen.getByTestId('fleet-computer-rename-input');
        await userEvent.clear(input);
        await userEvent.type(input, 'build-02{Enter}');
        await waitFor(() =>
            expect(actions.updateFleetNodeAction).toHaveBeenCalledWith('n1', { name: 'build-02' }),
        );
        await waitFor(() => expect(router.refresh).toHaveBeenCalled());
        expect(screen.queryByTestId('fleet-computer-rename-form')).toBeNull();
    });

    it('keeps the inline field and says why when the rename is refused', async () => {
        actions.updateFleetNodeAction.mockResolvedValue({
            success: false,
            data: null,
            error: 'Node name must be 1-64 characters',
        });
        render(<ComputerActionsMenu node={node()} />);
        await openMenu();
        await userEvent.click(screen.getByTestId('fleet-computer-menu-rename'));
        const input = screen.getByTestId('fleet-computer-rename-input');
        await userEvent.type(input, 'x{Enter}');
        await waitFor(() =>
            expect(screen.getByRole('alert')).toHaveTextContent(
                'Node name must be 1-64 characters',
            ),
        );
        expect(screen.getByTestId('fleet-computer-rename-form')).toBeInTheDocument();
    });

    it('stars with no dialog', async () => {
        actions.setFleetNodeFavoriteAction.mockResolvedValue(ok(node({ isFavorite: true })));
        render(<ComputerActionsMenu node={node()} />);
        await openMenu();
        await userEvent.click(screen.getByTestId('fleet-computer-menu-favourite'));
        expect(screen.queryByRole('dialog')).toBeNull();
        await waitFor(() =>
            expect(actions.setFleetNodeFavoriteAction).toHaveBeenCalledWith('n1', true),
        );
    });

    it('pauses with a toast and no dialog', async () => {
        actions.updateFleetNodeAction.mockResolvedValue(ok(node({ status: 'paused' })));
        render(<ComputerActionsMenu node={node()} />);
        await openMenu();
        await userEvent.click(screen.getByTestId('fleet-computer-menu-pause'));
        await waitFor(() =>
            expect(actions.updateFleetNodeAction).toHaveBeenCalledWith('n1', { paused: true }),
        );
        expect(toast.success).toHaveBeenCalledWith('paused:build-01');
    });

    it('drains only after one confirmation that names the jobs in flight', async () => {
        actions.fetchFleetComputerInFlightAction.mockResolvedValue(ok(2));
        actions.drainFleetNodeAction.mockResolvedValue(
            ok({ node: node({ status: 'disabled' }), releasedJobs: 2 }),
        );
        render(<ComputerActionsMenu node={node()} />);
        await openMenu();
        await userEvent.click(screen.getByTestId('fleet-computer-menu-drain'));
        await waitFor(() =>
            expect(screen.getByTestId('fleet-computer-drain-body')).toHaveTextContent(
                'drainBody:2',
            ),
        );
        expect(actions.drainFleetNodeAction).not.toHaveBeenCalled();
        await userEvent.click(screen.getByTestId('fleet-computer-drain-confirm'));
        await waitFor(() => expect(actions.drainFleetNodeAction).toHaveBeenCalledWith('n1', true));
        expect(toast.success).toHaveBeenCalledWith('drained:build-01,2');
    });

    it('says the jobs are uncounted rather than inventing a number', async () => {
        actions.fetchFleetComputerInFlightAction.mockResolvedValue(ok(null));
        render(<ComputerActionsMenu node={node()} />);
        await openMenu();
        await userEvent.click(screen.getByTestId('fleet-computer-menu-drain'));
        await waitFor(() =>
            expect(screen.getByTestId('fleet-computer-drain-body')).toHaveTextContent(
                'drainBodyUnknown',
            ),
        );
    });

    it('returns a drained computer to the fleet with no dialog', async () => {
        actions.drainFleetNodeAction.mockResolvedValue(
            ok({ node: node({ status: 'offline' }), releasedJobs: 0 }),
        );
        render(<ComputerActionsMenu node={node({ status: 'disabled' })} />);
        await openMenu();
        expect(screen.getByTestId('fleet-computer-menu-drain')).toHaveTextContent('returnToFleet');
        await userEvent.click(screen.getByTestId('fleet-computer-menu-drain'));
        await waitFor(() => expect(actions.drainFleetNodeAction).toHaveBeenCalledWith('n1', false));
        expect(screen.queryByTestId('fleet-computer-drain-dialog')).toBeNull();
    });

    it('never removes when the dialog is closed, even with the name typed', async () => {
        actions.deleteFleetNodeAction.mockResolvedValue(ok({ deleted: true }));
        render(<ComputerActionsMenu node={node()} />);
        await openMenu();
        await userEvent.click(screen.getByTestId('fleet-computer-menu-remove'));
        await userEvent.type(screen.getByTestId('fleet-computer-remove-name'), 'build-01');
        await userEvent.click(screen.getByRole('button', { name: 'close' }));
        await waitFor(() =>
            expect(screen.queryByTestId('fleet-computer-remove-dialog')).toBeNull(),
        );
        expect(actions.deleteFleetNodeAction).not.toHaveBeenCalled();
    });

    it('puts the focus back on the ⋯ button when the inline rename ends', async () => {
        render(<ComputerActionsMenu node={node()} />);
        await openMenu();
        await userEvent.click(screen.getByTestId('fleet-computer-menu-rename'));
        await userEvent.keyboard('{Escape}');
        await waitFor(() =>
            expect(screen.getByTestId('fleet-computer-menu-trigger')).toHaveFocus(),
        );
    });

    it('accepts a name as long as the server does (FLEET_MAX_NODE_NAME_LENGTH)', async () => {
        render(<ComputerActionsMenu node={node()} />);
        await openMenu();
        await userEvent.click(screen.getByTestId('fleet-computer-menu-rename'));
        expect(screen.getByTestId('fleet-computer-rename-input')).toHaveAttribute(
            'maxLength',
            '200',
        );
    });

    it('removes only once the typed name matches, then leaves the page', async () => {
        actions.deleteFleetNodeAction.mockResolvedValue(ok({ deleted: true }));
        render(<ComputerActionsMenu node={node()} />);
        await openMenu();
        await userEvent.click(screen.getByTestId('fleet-computer-menu-remove'));
        const confirm = screen.getByTestId('fleet-computer-remove-confirm');
        expect(confirm).toBeDisabled();
        await userEvent.type(screen.getByTestId('fleet-computer-remove-name'), 'build-0');
        expect(confirm).toBeDisabled();
        await userEvent.type(screen.getByTestId('fleet-computer-remove-name'), '1');
        expect(confirm).not.toBeDisabled();
        await userEvent.click(confirm);
        await waitFor(() =>
            expect(actions.deleteFleetNodeAction).toHaveBeenCalledWith('n1', 'build-01'),
        );
        await waitFor(() => expect(router.push).toHaveBeenCalledWith('/fleet/computers'));
    });
});

describe('ComputerActionsMenu — organisation roles (mirrors the server)', () => {
    it('disables every lifecycle act for a member outside the machines family, saying why', async () => {
        render(<ComputerActionsMenu node={node({ viewerRole: 'org-member' })} />);
        await openMenu();
        for (const act of ['rename', 'pause', 'drain', 'remove']) {
            expect(screen.getByTestId(`fleet-computer-menu-${act}-denied`)).toHaveTextContent(
                'deniedAskMembers:build-01',
            );
        }
        expect(screen.getByTestId('fleet-computer-menu-favourite-denied')).toHaveTextContent(
            'deniedOwnerOnly:build-01',
        );
        // Copying the link is not an act on the computer.
        expect(screen.queryByTestId('fleet-computer-menu-copy-link-denied')).toBeNull();
        // Disabled, not just captioned: a click does nothing.
        for (const act of ['rename', 'favourite', 'pause', 'drain', 'remove']) {
            expect(
                screen.getByTestId(`fleet-computer-menu-${act}`).closest('button'),
            ).toBeDisabled();
        }
        expect(
            screen.getByTestId('fleet-computer-menu-copy-link').closest('button'),
        ).not.toBeDisabled();
        await userEvent.click(screen.getByTestId('fleet-computer-menu-remove'));
        expect(screen.queryByTestId('fleet-computer-remove-dialog')).toBeNull();
        expect(actions.deleteFleetNodeAction).not.toHaveBeenCalled();
    });

    it('names the admin audience for an org admin', async () => {
        render(<ComputerActionsMenu node={node({ viewerRole: 'org-admin' })} />);
        await openMenu();
        expect(screen.getByTestId('fleet-computer-menu-rename-denied')).toHaveTextContent(
            'deniedAskAdmins:build-01',
        );
    });

    it('enables the lifecycle acts when the family admits the role; the star stays the owner’s', async () => {
        render(
            <ComputerActionsMenu
                node={node({
                    viewerRole: 'org-admin',
                    controlPolicyFamilies: {
                        view: 'org-members',
                        machines: 'org-admins',
                    } as FleetNodeView['controlPolicyFamilies'],
                })}
            />,
        );
        await openMenu();
        expect(screen.queryByTestId('fleet-computer-menu-rename-denied')).toBeNull();
        expect(screen.queryByTestId('fleet-computer-menu-remove-denied')).toBeNull();
        expect(screen.getByTestId('fleet-computer-menu-favourite-denied')).toBeInTheDocument();
    });
});
