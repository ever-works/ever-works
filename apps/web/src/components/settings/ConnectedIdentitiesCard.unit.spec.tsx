import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EverIdIdentity, EverIdIdentityList } from '@/lib/api/ever-id';

const mocks = vi.hoisted(() => ({
    startEverIdConnect: vi.fn(),
    disconnectEverId: vi.fn(),
    signInAgainToConnectEverId: vi.fn(),
    toastSuccess: vi.fn(),
    toastError: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
}));

vi.mock('next-intl', async () => {
    const { enUseTranslations } = await import('@/lib/auth/__tests__/en-messages');
    return {
        useTranslations: enUseTranslations,
        useFormatter: () => ({
            dateTime: () => '3 Sep 2026',
            relativeTime: (date: Date) =>
                date.toISOString().startsWith('2026-09-30') ? '5 minutes ago' : '2 hours ago',
        }),
    };
});
vi.mock('sonner', () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }));
vi.mock('@/app/actions/ever-id', () => ({
    startEverIdConnect: mocks.startEverIdConnect,
    disconnectEverId: mocks.disconnectEverId,
    signInAgainToConnectEverId: mocks.signInAgainToConnectEverId,
}));
vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
        <a href={href} {...rest}>
            {children}
        </a>
    ),
    useRouter: () => ({ replace: mocks.replace, refresh: mocks.refresh, push: vi.fn() }),
}));

import {
    ConnectedIdentitiesCard,
    type ConnectedIdentitiesCardProps,
} from './ConnectedIdentitiesCard';

/**
 * APW-12 T26 — Settings → Security → Connected identities (spec §6.3, §6.4).
 *
 * Every variant of the card, rendered from API-shaped data with the real
 * English copy: connected, not connected, cannot disconnect (S14), turned off by
 * an administrator (S18), the delegated apps list with display name and last
 * use (ACC-12-36), the disconnect confirmation, and the notices a connect
 * attempt carries back.
 */

const CONNECTED: EverIdIdentity = {
    id: 'identity-1',
    displayName: 'Ever ID',
    email: 'alice@example.com',
    linkedAt: '2026-09-03T10:00:00.000Z',
    linkedVia: 'settings',
    lastLoginAt: '2026-10-01T10:00:00.000Z',
    delegatedClients: [],
};

function list(overrides: Partial<EverIdIdentityList> = {}): EverIdIdentityList {
    return { items: [CONNECTED], canDisconnect: true, ...overrides };
}

function renderCard(props: Partial<ConnectedIdentitiesCardProps> = {}) {
    return render(
        <ConnectedIdentitiesCard
            identities={list()}
            canConnect={false}
            turnedOff={false}
            {...props}
        />,
    );
}

describe('ConnectedIdentitiesCard — variants', () => {
    beforeEach(() => {
        for (const fn of Object.values(mocks)) fn.mockReset();
    });

    afterEach(() => cleanup());

    it('connected: the identity, when it was connected and last used, and Disconnect', () => {
        renderCard();

        expect(screen.getByRole('heading', { name: 'Connected identities' })).toBeInTheDocument();
        expect(
            screen.getByText('Sign in to Ever Works with an identity you already use.'),
        ).toBeInTheDocument();
        const row = screen.getByTestId('ever-id-identity');
        expect(within(row).getByText('Ever ID')).toBeInTheDocument();
        expect(
            within(row).getByText('alice@example.com · connected 3 Sep 2026'),
        ).toBeInTheDocument();
        expect(within(row).getByText('Last used to sign in 2 hours ago')).toBeInTheDocument();
        expect(within(row).getByRole('button', { name: 'Disconnect' })).toBeEnabled();
        expect(screen.queryByRole('button', { name: 'Connect Ever ID' })).not.toBeInTheDocument();
        expect(screen.queryByTestId('ever-id-turned-off')).not.toBeInTheDocument();
    });

    it('omits "last used" for an identity that has not signed in yet', () => {
        renderCard({ identities: list({ items: [{ ...CONNECTED, lastLoginAt: null }] }) });

        expect(screen.queryByText(/Last used to sign in/)).not.toBeInTheDocument();
    });

    it('not connected: "Not connected" and "Connect Ever ID" when connecting is offered', () => {
        renderCard({ identities: list({ items: [] }), canConnect: true });

        expect(screen.getByTestId('ever-id-not-connected')).toHaveTextContent('Not connected');
        expect(screen.getByRole('button', { name: 'Connect Ever ID' })).toBeEnabled();
    });

    it('renders nothing when there is nothing to show (no identity, nothing offered)', () => {
        const { container } = renderCard({ identities: list({ items: [] }), canConnect: false });
        expect(container).toBeEmptyDOMElement();
    });

    it('renders nothing when the identities could not be read and nothing is offered', () => {
        const { container } = renderCard({ identities: null, canConnect: false });
        expect(container).toBeEmptyDOMElement();
    });

    it('cannot disconnect (S14): Disconnect disabled, the reason beside it and "Set a password"', () => {
        renderCard({
            identities: list({
                canDisconnect: false,
                disconnectBlockedReason: 'last_sign_in_method',
            }),
        });

        const button = screen.getByRole('button', { name: 'Disconnect' });
        expect(button).toBeDisabled();
        const reason = screen.getByTestId('ever-id-cannot-disconnect');
        expect(reason).toHaveTextContent(
            'Add another way to sign in first — Ever ID is the only one this account has.',
        );
        expect(button).toHaveAttribute('aria-describedby', reason.id);
        expect(within(reason).getByRole('link', { name: 'Set a password' })).toHaveAttribute(
            'href',
            '/forgot-password',
        );
    });

    it('turned off by an administrator (S18): rows and Disconnect stay, the line shows, no Connect', () => {
        renderCard({ turnedOff: true, canConnect: false });

        expect(screen.getByTestId('ever-id-identity')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Disconnect' })).toBeEnabled();
        expect(screen.getByTestId('ever-id-turned-off')).toHaveTextContent(
            'Signing in with Ever ID is turned off on this installation.',
        );
        expect(screen.queryByRole('button', { name: 'Connect Ever ID' })).not.toBeInTheDocument();
    });
});

describe('ConnectedIdentitiesCard — apps that can see your App Works (FR-48, ACC-12-36)', () => {
    beforeEach(() => {
        for (const fn of Object.values(mocks)) fn.mockReset();
    });

    afterEach(() => cleanup());

    const WITH_APPS = list({
        items: [
            {
                ...CONNECTED,
                delegatedClients: [
                    {
                        clientId: 'ever-teams',
                        displayName: 'Ever Teams',
                        lastSeenAt: '2026-09-30T09:55:00.000Z',
                    },
                ],
            },
        ],
        manageUrl: 'https://id.example/apps',
    });

    it('lists each app by display name with its last use, and links to Ever ID to manage them', () => {
        renderCard({ identities: WITH_APPS });

        const apps = screen.getByTestId('ever-id-delegated-apps');
        expect(within(apps).getByText('Apps that can see your App Works')).toBeInTheDocument();
        expect(within(apps).getByText('Ever Teams — last used 5 minutes ago')).toBeInTheDocument();
        const manage = within(apps).getByTestId('ever-id-manage');
        expect(manage).toHaveAttribute('href', 'https://id.example/apps');
        expect(manage).toHaveAttribute('target', '_blank');
        expect(manage).toHaveAttribute('rel', expect.stringContaining('noopener'));
        expect(manage).toHaveTextContent('Manage in Ever ID');
        expect(manage).toHaveTextContent('(opens in a new tab)');
    });

    it('offers no "Manage in Ever ID" link without a manage address', () => {
        renderCard({ identities: { ...WITH_APPS, manageUrl: undefined } });

        expect(screen.getByText('Ever Teams — last used 5 minutes ago')).toBeInTheDocument();
        expect(screen.queryByTestId('ever-id-manage')).not.toBeInTheDocument();
    });

    it('never renders a manage address that is not http(s)', () => {
        renderCard({ identities: { ...WITH_APPS, manageUrl: 'javascript:alert(1)' } });

        expect(screen.queryByTestId('ever-id-manage')).not.toBeInTheDocument();
    });

    it('shows no apps section when no app read anything in the last 30 days', () => {
        renderCard();

        expect(screen.queryByTestId('ever-id-delegated-apps')).not.toBeInTheDocument();
    });
});

describe('ConnectedIdentitiesCard — connect', () => {
    beforeEach(() => {
        for (const fn of Object.values(mocks)) fn.mockReset();
    });

    afterEach(() => cleanup());

    it('"Connect Ever ID" starts the connection', async () => {
        mocks.startEverIdConnect.mockReturnValue(new Promise(() => {}));
        renderCard({ identities: list({ items: [] }), canConnect: true });

        fireEvent.click(screen.getByRole('button', { name: 'Connect Ever ID' }));

        await waitFor(() => expect(mocks.startEverIdConnect).toHaveBeenCalledTimes(1));
        expect(await screen.findByText('Opening Ever ID…')).toBeInTheDocument();
    });

    it('a session too old to connect (S15) offers "Sign in again"', async () => {
        mocks.startEverIdConnect.mockResolvedValue({
            success: false,
            error: 'For your security, sign in again before connecting Ever ID.',
            code: 'reauth_required',
        });
        renderCard({ identities: list({ items: [] }), canConnect: true });

        fireEvent.click(screen.getByRole('button', { name: 'Connect Ever ID' }));

        const alert = await screen.findByTestId('ever-id-reauth');
        expect(alert).toHaveAttribute('role', 'alert');
        expect(alert).toHaveTextContent(
            'For your security, sign in again before connecting Ever ID.',
        );
        fireEvent.click(within(alert).getByRole('button', { name: 'Sign in again' }));
        await waitFor(() => expect(mocks.signInAgainToConnectEverId).toHaveBeenCalledTimes(1));
    });

    it('any other refusal is announced as it was translated', async () => {
        mocks.startEverIdConnect.mockResolvedValue({
            success: false,
            error: 'This account already has an Ever ID connected. Disconnect it first.',
            code: 'user_has_issuer',
        });
        renderCard({ identities: list({ items: [] }), canConnect: true });

        fireEvent.click(screen.getByRole('button', { name: 'Connect Ever ID' }));

        expect(await screen.findByTestId('ever-id-connect-error')).toHaveTextContent(
            'This account already has an Ever ID connected. Disconnect it first.',
        );
    });
});

describe('ConnectedIdentitiesCard — disconnect (spec §6.4)', () => {
    beforeEach(() => {
        for (const fn of Object.values(mocks)) fn.mockReset();
    });

    afterEach(() => cleanup());

    const BODY =
        "Disconnect Ever ID? You won't be able to sign in with it any more, and other devices signed in with Ever ID will be signed out. This device stays signed in.";

    it('asks first; "Keep it" closes without disconnecting', async () => {
        renderCard();

        fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
        const dialog = await screen.findByTestId('ever-id-disconnect-dialog');
        expect(dialog).toHaveTextContent(BODY);

        fireEvent.click(within(dialog).getByRole('button', { name: 'Keep it' }));

        await waitFor(() =>
            expect(screen.queryByTestId('ever-id-disconnect-dialog')).not.toBeInTheDocument(),
        );
        expect(mocks.disconnectEverId).not.toHaveBeenCalled();
    });

    it('"Disconnect" disconnects, says so and refreshes the page', async () => {
        mocks.disconnectEverId.mockResolvedValue({ success: true });
        renderCard();

        fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
        const dialog = await screen.findByTestId('ever-id-disconnect-dialog');
        fireEvent.click(within(dialog).getByRole('button', { name: 'Disconnect' }));

        await waitFor(() => expect(mocks.disconnectEverId).toHaveBeenCalledWith('identity-1'));
        await waitFor(() =>
            expect(mocks.toastSuccess).toHaveBeenCalledWith('Ever ID disconnected.'),
        );
        expect(mocks.refresh).toHaveBeenCalled();
    });

    it('a refusal stays in the dialog, announced', async () => {
        mocks.disconnectEverId.mockResolvedValue({
            success: false,
            error: 'Add another way to sign in first — Ever ID is the only one this account has.',
            code: 'last_sign_in_method',
        });
        renderCard();

        fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
        const dialog = await screen.findByTestId('ever-id-disconnect-dialog');
        fireEvent.click(within(dialog).getByRole('button', { name: 'Disconnect' }));

        const alert = await screen.findByTestId('ever-id-disconnect-error');
        expect(alert).toHaveAttribute('role', 'alert');
        expect(screen.getByTestId('ever-id-disconnect-dialog')).toBeInTheDocument();
        expect(mocks.toastSuccess).not.toHaveBeenCalled();
    });
});

describe('ConnectedIdentitiesCard — notices carried back in ?everId=', () => {
    beforeEach(() => {
        for (const fn of Object.values(mocks)) fn.mockReset();
    });

    afterEach(() => cleanup());

    it('"connected" toasts "Ever ID connected." once and drops the marker from the address', async () => {
        const { rerender } = renderCard({ notice: 'connected' });

        await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith('Ever ID connected.'));
        expect(mocks.replace).toHaveBeenCalledWith('/settings/security', { scroll: false });

        rerender(
            <ConnectedIdentitiesCard
                identities={list()}
                canConnect={false}
                turnedOff={false}
                notice="connected"
            />,
        );
        expect(mocks.toastSuccess).toHaveBeenCalledTimes(1);
    });

    it('an error code is shown on the card (it arrives on a full page load) and drops the marker', async () => {
        renderCard({ notice: 'subject_linked', identities: list({ items: [] }), canConnect: true });

        const alert = await screen.findByTestId('ever-id-connect-error');
        expect(alert).toHaveAttribute('role', 'alert');
        expect(alert).toHaveTextContent(
            'This Ever ID is already connected to a different Ever Works account. Disconnect it there first.',
        );
        expect(mocks.toastError).not.toHaveBeenCalled();
        await waitFor(() =>
            expect(mocks.replace).toHaveBeenCalledWith('/settings/security', { scroll: false }),
        );
    });

    it('a rate limit shows its wait on the card', async () => {
        renderCard({
            notice: 'rate_limited',
            noticeRetryAfter: 30,
            identities: list({ items: [] }),
            canConnect: true,
        });

        expect(await screen.findByTestId('ever-id-connect-error')).toHaveTextContent(
            'Too many attempts. Try again in 30 seconds.',
        );
    });

    it('reauth_required from the round trip also offers "Sign in again"', async () => {
        renderCard({
            notice: 'reauth_required',
            identities: list({ items: [] }),
            canConnect: true,
        });

        expect(await screen.findByTestId('ever-id-reauth')).toBeInTheDocument();
    });
});
