import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    confirmEverIdConnect: vi.fn(),
    cancelEverIdConnect: vi.fn(),
    readEverIdPending: vi.fn(),
}));

vi.mock('next-intl', async () => {
    const { enUseTranslations } = await import('@/lib/auth/__tests__/en-messages');
    return { useTranslations: enUseTranslations };
});
vi.mock('next-intl/server', async () => {
    const { enUseTranslations } = await import('@/lib/auth/__tests__/en-messages');
    return { getTranslations: async (namespace: string) => enUseTranslations(namespace) };
});
vi.mock('@/app/actions/ever-id', () => ({
    confirmEverIdConnect: mocks.confirmEverIdConnect,
    cancelEverIdConnect: mocks.cancelEverIdConnect,
}));
vi.mock('@/lib/auth/ever-id-cookies', () => ({ readEverIdPending: mocks.readEverIdPending }));
vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
        <a href={href}>{children}</a>
    ),
}));

import ConnectEverIdPage from './page';
import { ConnectEverIdClient } from './connect-ever-id-client';

/**
 * APW-12 T26 — "Connect Ever ID to this account?" (S4, spec §6.4, FR-25).
 */
describe('ConnectEverIdClient', () => {
    beforeEach(() => {
        for (const fn of Object.values(mocks)) fn.mockReset();
    });

    afterEach(() => cleanup());

    it('shows both addresses, and no warning when they are the same address', () => {
        render(
            <ConnectEverIdClient
                everIdEmail="Alice@Example.com"
                accountEmail="alice@example.com"
            />,
        );

        expect(
            screen.getByRole('heading', { name: 'Connect Ever ID to this account?' }),
        ).toBeInTheDocument();
        expect(screen.getByTestId('ever-id-connect-ever-id-email')).toHaveTextContent(
            'Alice@Example.com',
        );
        expect(screen.getByTestId('ever-id-connect-account-email')).toHaveTextContent(
            'alice@example.com',
        );
        expect(screen.queryByTestId('ever-id-emails-differ')).not.toBeInTheDocument();
        expect(
            screen.getByText("You'll be able to sign in to this account with Ever ID."),
        ).toBeInTheDocument();
    });

    it('warns, announced, when the addresses differ (FR-25)', () => {
        render(
            <ConnectEverIdClient everIdEmail="alice@example.com" accountEmail="bob@example.com" />,
        );

        const warning = screen.getByTestId('ever-id-emails-differ');
        expect(warning).toHaveAttribute('role', 'alert');
        expect(warning).toHaveTextContent(
            'These e-mail addresses are different. Connect only if both are yours.',
        );
    });

    it('"Connect" confirms', async () => {
        mocks.confirmEverIdConnect.mockReturnValue(new Promise(() => {}));
        render(<ConnectEverIdClient everIdEmail="a@example.com" accountEmail="a@example.com" />);

        fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

        await waitFor(() => expect(mocks.confirmEverIdConnect).toHaveBeenCalledTimes(1));
        expect(mocks.cancelEverIdConnect).not.toHaveBeenCalled();
    });

    it('a conflict is announced without naming the other account (S12)', async () => {
        mocks.confirmEverIdConnect.mockResolvedValue({
            success: false,
            error: 'This Ever ID is already connected to a different Ever Works account. Disconnect it there first.',
            code: 'subject_linked',
        });
        render(<ConnectEverIdClient everIdEmail="a@example.com" accountEmail="a@example.com" />);

        fireEvent.submit(screen.getByTestId('ever-id-connect-confirm-form'));

        const alert = await screen.findByTestId('ever-id-connect-confirm-error');
        expect(alert).toHaveAttribute('role', 'alert');
        expect(alert).toHaveTextContent('different Ever Works account');
    });

    it('an expired pending value becomes "That took too long. Start again."', async () => {
        mocks.confirmEverIdConnect.mockResolvedValue({
            success: false,
            error: 'That took too long. Start again.',
            code: 'pending_expired',
        });
        render(<ConnectEverIdClient everIdEmail="a@example.com" accountEmail="a@example.com" />);

        fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

        expect(await screen.findByTestId('ever-id-connect-expired')).toHaveTextContent(
            'That took too long. Start again.',
        );
        expect(screen.getByRole('link', { name: 'Back to Security' })).toHaveAttribute(
            'href',
            '/settings/security',
        );
    });

    it('"Cancel" connects nothing', async () => {
        render(<ConnectEverIdClient everIdEmail="a@example.com" accountEmail="a@example.com" />);

        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

        await waitFor(() => expect(mocks.cancelEverIdConnect).toHaveBeenCalledTimes(1));
        expect(mocks.confirmEverIdConnect).not.toHaveBeenCalled();
    });

    it('without a pending value it says so and offers the way back', () => {
        render(<ConnectEverIdClient everIdEmail={null} accountEmail={null} />);

        expect(screen.getByTestId('ever-id-connect-expired')).toHaveAttribute('role', 'alert');
        expect(screen.queryByRole('button', { name: 'Connect' })).not.toBeInTheDocument();
    });
});

describe('ConnectEverIdPage', () => {
    beforeEach(() => {
        for (const fn of Object.values(mocks)) fn.mockReset();
    });

    afterEach(() => cleanup());

    it('reads both addresses from the connect pending cookie, never the address bar', async () => {
        mocks.readEverIdPending.mockResolvedValue({
            kind: 'connect',
            pending: 'sealed',
            email: 'alice@example.com',
            name: null,
            accountEmail: 'bob@example.com',
        });

        render(await ConnectEverIdPage());

        expect(mocks.readEverIdPending).toHaveBeenCalledWith('connect');
        expect(screen.getByTestId('ever-id-connect-ever-id-email')).toHaveTextContent(
            'alice@example.com',
        );
        expect(screen.getByTestId('ever-id-connect-account-email')).toHaveTextContent(
            'bob@example.com',
        );
    });

    it('renders the expired state without one', async () => {
        mocks.readEverIdPending.mockResolvedValue(null);

        render(await ConnectEverIdPage());

        expect(screen.getByTestId('ever-id-connect-expired')).toBeInTheDocument();
    });
});
