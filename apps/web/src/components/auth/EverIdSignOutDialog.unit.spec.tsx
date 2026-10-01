import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    logout: vi.fn(),
    getEverIdLogoutUrl: vi.fn(),
    logoutWithEverId: vi.fn(),
}));

vi.mock('next-intl', async () => {
    const { enUseTranslations } = await import('@/lib/auth/__tests__/en-messages');
    return { useTranslations: enUseTranslations };
});
vi.mock('@/app/actions/auth', () => ({ logout: mocks.logout }));
vi.mock('@/app/actions/ever-id', () => ({
    getEverIdLogoutUrl: mocks.getEverIdLogoutUrl,
    logoutWithEverId: mocks.logoutWithEverId,
}));
// Deliberately no `@/i18n/navigation` mock: the dialog is mounted by the command
// palette, whose spec does not provide `Link`, so the dialog must not need it.

import { logout } from '@/app/actions/auth';
import { EverIdSignOutDialog, useEverIdSignOut } from './EverIdSignOutDialog';

/**
 * APW-12 T26 — the sign-out question for sessions opened with Ever ID (S7,
 * FR-36; ACC-12-26 web half).
 *
 * The harness below calls the hook exactly as `DashboardSidebar` and
 * `CommandPalette` do: `if (await offerEverIdSignOut()) return; await logout();`.
 */
function SignOutHarness() {
    const { offerEverIdSignOut, dialogProps } = useEverIdSignOut();
    return (
        <>
            <button
                type="button"
                onClick={() => {
                    void (async () => {
                        if (await offerEverIdSignOut()) return;
                        await logout();
                    })();
                }}
            >
                menu: sign out
            </button>
            <EverIdSignOutDialog {...dialogProps} />
        </>
    );
}

describe('useEverIdSignOut — the decision every sign-out entry point makes', () => {
    beforeEach(() => {
        for (const fn of Object.values(mocks)) fn.mockReset();
    });

    afterEach(() => cleanup());

    it('a session NOT opened with Ever ID signs out exactly as before — no dialog', async () => {
        mocks.getEverIdLogoutUrl.mockResolvedValue(null);
        render(<SignOutHarness />);

        fireEvent.click(screen.getByText('menu: sign out'));

        await waitFor(() => expect(mocks.logout).toHaveBeenCalledTimes(1));
        expect(screen.queryByTestId('ever-id-sign-out-dialog')).not.toBeInTheDocument();
        expect(mocks.logoutWithEverId).not.toHaveBeenCalled();
    });

    it('a failed check also signs out exactly as before', async () => {
        mocks.getEverIdLogoutUrl.mockRejectedValue(new Error('fetch failed'));
        render(<SignOutHarness />);

        fireEvent.click(screen.getByText('menu: sign out'));

        await waitFor(() => expect(mocks.logout).toHaveBeenCalledTimes(1));
        expect(screen.queryByTestId('ever-id-sign-out-dialog')).not.toBeInTheDocument();
    });

    it('a session opened with Ever ID gets the question, with the checkbox unticked', async () => {
        mocks.getEverIdLogoutUrl.mockResolvedValue('https://id.example/end?state=s');
        render(<SignOutHarness />);

        fireEvent.click(screen.getByText('menu: sign out'));

        expect(await screen.findByTestId('ever-id-sign-out-dialog')).toBeInTheDocument();
        expect(screen.getByText('Sign out of Ever Works?')).toBeInTheDocument();
        const checkbox = screen.getByRole('checkbox', { name: 'Also sign out of Ever ID' });
        expect(checkbox).not.toBeChecked();
        expect(mocks.logout).not.toHaveBeenCalled();
    });
});

describe('EverIdSignOutDialog', () => {
    beforeEach(() => {
        for (const fn of Object.values(mocks)) fn.mockReset();
    });

    afterEach(() => cleanup());

    function renderOpen() {
        const onOpenChange = vi.fn();
        render(<EverIdSignOutDialog open onOpenChange={onOpenChange} />);
        return { onOpenChange };
    }

    it('unticked: "Sign out" calls logout() exactly as the menu item does', async () => {
        renderOpen();

        fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

        await waitFor(() => expect(mocks.logout).toHaveBeenCalledTimes(1));
        expect(mocks.logoutWithEverId).not.toHaveBeenCalled();
    });

    it('ticked: "Sign out" also signs out of Ever ID', async () => {
        renderOpen();

        fireEvent.click(screen.getByRole('checkbox', { name: 'Also sign out of Ever ID' }));
        fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

        await waitFor(() => expect(mocks.logoutWithEverId).toHaveBeenCalledTimes(1));
        expect(mocks.logout).not.toHaveBeenCalled();
    });

    it('"Cancel" closes and signs nobody out', () => {
        const { onOpenChange } = renderOpen();

        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

        expect(onOpenChange).toHaveBeenCalledWith(false);
        expect(mocks.logout).not.toHaveBeenCalled();
        expect(mocks.logoutWithEverId).not.toHaveBeenCalled();
    });

    it('is unticked again every time it opens', async () => {
        function Toggle() {
            const { offerEverIdSignOut, dialogProps } = useEverIdSignOut();
            return (
                <>
                    <button type="button" onClick={() => void offerEverIdSignOut()}>
                        open
                    </button>
                    <EverIdSignOutDialog {...dialogProps} />
                </>
            );
        }
        mocks.getEverIdLogoutUrl.mockResolvedValue('https://id.example/end');
        render(<Toggle />);

        fireEvent.click(screen.getByText('open'));
        const first = await screen.findByRole('checkbox', { name: 'Also sign out of Ever ID' });
        fireEvent.click(first);
        expect(first).toBeChecked();
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        await waitFor(() =>
            expect(screen.queryByTestId('ever-id-sign-out-dialog')).not.toBeInTheDocument(),
        );

        fireEvent.click(screen.getByText('open'));
        const second = await screen.findByRole('checkbox', { name: 'Also sign out of Ever ID' });
        expect(second).not.toBeChecked();
    });

    it('Enter on the checkbox does not sign out (spec §6.7)', async () => {
        renderOpen();

        const checkbox = screen.getByRole('checkbox', { name: 'Also sign out of Ever ID' });
        const event = new KeyboardEvent('keydown', {
            key: 'Enter',
            bubbles: true,
            cancelable: true,
        });
        await act(async () => {
            checkbox.dispatchEvent(event);
        });

        expect(event.defaultPrevented).toBe(true);
        expect(mocks.logout).not.toHaveBeenCalled();
        expect(mocks.logoutWithEverId).not.toHaveBeenCalled();
    });

    it('submitting the form (Enter elsewhere) signs out', async () => {
        renderOpen();

        fireEvent.submit(screen.getByTestId('ever-id-sign-out-dialog'));

        await waitFor(() => expect(mocks.logout).toHaveBeenCalledTimes(1));
    });
});
