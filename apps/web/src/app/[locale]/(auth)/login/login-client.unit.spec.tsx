import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    search: new URLSearchParams(),
    startEverIdSignIn: vi.fn(),
}));

vi.mock('next-intl', async () => {
    const { enUseTranslations } = await import('@/lib/auth/__tests__/en-messages');
    return { useTranslations: enUseTranslations };
});
vi.mock('next/navigation', () => ({ useSearchParams: () => mocks.search }));
vi.mock('@/app/actions/auth', () => ({
    login: vi.fn(),
    issueMagicLink: vi.fn(),
    connectProvider: vi.fn(),
}));
vi.mock('@/app/actions/ever-id', () => ({ startEverIdSignIn: mocks.startEverIdSignIn }));
vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
        <a href={href}>{children}</a>
    ),
}));
vi.mock('@/components/theme-toggle', () => ({ ThemeToggle: () => null }));
vi.mock('@/components/layout/AuthLayout', () => ({
    AuthLayout: ({ title, children }: { title: string; children: React.ReactNode }) => (
        <main>
            <h1>{title}</h1>
            {children}
        </main>
    ),
}));

import { LoginClient } from './login-client';
import { OAuthProvider } from '@/lib/api/enums';

/**
 * APW-12 T24 — the sign-in page with and without Ever ID (ACC-12-01 web half).
 *
 * Off (the default, and whenever the administrator's switch or the flag says
 * no) the page is exactly what it was: no Ever ID button, the divider only with
 * social providers. On, "Sign in with Ever ID" sits full width above the social
 * buttons in both tabs. The S6 and S7 notices show only with their markers.
 */
describe('LoginClient — Sign in with Ever ID', () => {
    beforeEach(() => {
        mocks.search = new URLSearchParams();
        mocks.startEverIdSignIn.mockReset();
    });

    afterEach(() => cleanup());

    it('renders no Ever ID button by default — the page is unchanged', () => {
        render(<LoginClient availableSocialProviders={[OAuthProvider.GITHUB]} magicLinkEnabled />);

        expect(screen.queryByTestId('ever-id-button')).not.toBeInTheDocument();
        expect(screen.getByText('Or continue with')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /GitHub/ })).toBeInTheDocument();
    });

    it('keeps the divider hidden with no social providers and Ever ID off', () => {
        render(<LoginClient availableSocialProviders={[]} magicLinkEnabled={false} />);

        expect(screen.queryByText('Or continue with')).not.toBeInTheDocument();
        expect(screen.queryByTestId('ever-id-button')).not.toBeInTheDocument();
    });

    it('renders the button above the social buttons when enabled', () => {
        render(
            <LoginClient
                availableSocialProviders={[OAuthProvider.GOOGLE]}
                magicLinkEnabled={false}
                everIdEnabled
            />,
        );

        const everId = screen.getByRole('button', { name: 'Sign in with Ever ID' });
        const google = screen.getByRole('button', { name: /Google/ });
        // DOCUMENT_POSITION_FOLLOWING (4): the social button comes after Ever ID.
        expect(everId.compareDocumentPosition(google) & 4).toBeTruthy();
    });

    it('shows the divider and the button even without social providers', () => {
        render(
            <LoginClient availableSocialProviders={[]} magicLinkEnabled={false} everIdEnabled />,
        );

        expect(screen.getByText('Or continue with')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Sign in with Ever ID' })).toBeInTheDocument();
    });

    it('passes the page’s return path to the sign-in', () => {
        mocks.search = new URLSearchParams({ redirect_uri: '/works/42' });
        mocks.startEverIdSignIn.mockReturnValue(new Promise(() => {}));
        render(
            <LoginClient availableSocialProviders={[]} magicLinkEnabled={false} everIdEnabled />,
        );

        fireEvent.click(screen.getByRole('button', { name: 'Sign in with Ever ID' }));

        expect(mocks.startEverIdSignIn).toHaveBeenCalledWith('/works/42');
    });

    it('offers Ever ID on the magic-link tab too', () => {
        render(<LoginClient availableSocialProviders={[]} magicLinkEnabled everIdEnabled />);

        fireEvent.click(screen.getByTestId('login-tab-magic-link'));

        expect(screen.getByRole('button', { name: 'Sign in with Ever ID' })).toBeInTheDocument();
    });
});

describe('LoginClient — signed-out notices (S6, S7)', () => {
    beforeEach(() => {
        mocks.search = new URLSearchParams();
    });

    afterEach(() => cleanup());

    it('shows no notice without a marker', () => {
        render(<LoginClient availableSocialProviders={[]} magicLinkEnabled={false} />);

        expect(screen.queryByTestId('ever-id-signed-out-notice')).not.toBeInTheDocument();
    });

    it('S6: "You were signed out of Ever ID." when the session was ended by Ever ID', () => {
        render(
            <LoginClient
                availableSocialProviders={[]}
                magicLinkEnabled={false}
                signedOutByEverId
            />,
        );

        const notice = screen.getByTestId('ever-id-signed-out-notice');
        expect(notice).toHaveAttribute('role', 'status');
        expect(notice).toHaveTextContent('You were signed out of Ever ID.');
    });

    it('S7: "You\'re signed out of Ever Works and Ever ID." after the provider sign-out returns', () => {
        mocks.search = new URLSearchParams({ signedOut: 'ever-id' });
        render(
            <LoginClient
                availableSocialProviders={[]}
                magicLinkEnabled={false}
                signedOutByEverId
            />,
        );

        expect(screen.getByTestId('ever-id-signed-out-notice')).toHaveTextContent(
            "You're signed out of Ever Works and Ever ID.",
        );
    });

    it('ignores any other value of the marker', () => {
        mocks.search = new URLSearchParams({ signedOut: 'alice@example.com' });
        render(<LoginClient availableSocialProviders={[]} magicLinkEnabled={false} />);

        expect(screen.queryByTestId('ever-id-signed-out-notice')).not.toBeInTheDocument();
    });
});
