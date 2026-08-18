import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

/**
 * EW-081 — after a magic link fails, the page header still read "Signing you
 * in" / "Verifying your magic link...".
 *
 * The heading is the largest text on a page whose entire job is to report the
 * outcome of one action, and it was the one part hardcoded to the in-progress
 * copy. The body said the link could not be used while the header above it
 * claimed a sign-in was under way.
 *
 * These assert on the RENDERED HEADER, not on the error box — the error box
 * was already correct before the fix, so a test that only looked there would
 * have passed against the bug.
 */

const { redeemMagicLinkMock, searchParamsMock } = vi.hoisted(() => ({
    redeemMagicLinkMock: vi.fn(),
    searchParamsMock: { current: new URLSearchParams() },
}));

vi.mock('next-intl', () => ({
    // Return the key path so the assertions name the message being rendered.
    useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}));

vi.mock('next/navigation', () => ({
    useSearchParams: () => searchParamsMock.current,
}));

vi.mock('@/app/actions/auth', () => ({ redeemMagicLink: redeemMagicLinkMock }));

vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
        <a href={href}>{children}</a>
    ),
    useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

// AuthLayout renders the title/subtitle inside a lot of marketing chrome that
// pulls in the next-intl client entry. Stub it down to just the two strings
// under test, tagged so the assertions cannot accidentally match body copy.
vi.mock('@/components/layout/AuthLayout', () => ({
    AuthLayout: ({
        title,
        subtitle,
        children,
    }: {
        title: string;
        subtitle: string;
        children: React.ReactNode;
    }) => (
        <div>
            <h1 data-testid="page-title">{title}</h1>
            <p data-testid="page-subtitle">{subtitle}</p>
            {children}
        </div>
    ),
}));

vi.mock('@/components/theme-toggle', () => ({ ThemeToggle: () => null }));

import { MagicLinkRedeemClient } from './magic-link-redeem-client';

const NS = 'auth.login.magicLink.redeem';
const title = () => screen.getByTestId('page-title').textContent;
const subtitle = () => screen.getByTestId('page-subtitle').textContent;

describe('MagicLinkRedeemClient — page header tracks the outcome (EW-081)', () => {
    beforeEach(() => {
        redeemMagicLinkMock.mockReset();
        searchParamsMock.current = new URLSearchParams({ token: 'a'.repeat(64) });
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('control: while the redemption is in flight the header DOES say "signing you in"', async () => {
        // Without this, "the header changed" below could be satisfied by a
        // component that never shows the in-progress copy at all.
        redeemMagicLinkMock.mockReturnValue(new Promise(() => {}));

        render(<MagicLinkRedeemClient />);

        expect(title()).toBe(`${NS}.title`);
        expect(subtitle()).toBe(`${NS}.loading`);
        expect(screen.getByTestId('magic-link-loading')).toBeTruthy();
    });

    it('switches the header to the failure copy once the redemption fails', async () => {
        redeemMagicLinkMock.mockResolvedValue({ success: false, error: 'Invalid magic link' });

        render(<MagicLinkRedeemClient />);

        await waitFor(() => expect(screen.getByTestId('magic-link-error')).toBeTruthy());

        expect(title()).toBe(`${NS}.errorTitle`);
        expect(subtitle()).toBe(`${NS}.errorSubtitle`);

        // The exact strings the bug left on screen must be gone.
        expect(title()).not.toBe(`${NS}.title`);
        expect(subtitle()).not.toBe(`${NS}.loading`);
    });

    it('switches the header to the failure copy when the link carries no token', async () => {
        searchParamsMock.current = new URLSearchParams();

        render(<MagicLinkRedeemClient />);

        await waitFor(() => expect(screen.getByTestId('magic-link-error')).toBeTruthy());

        expect(title()).toBe(`${NS}.errorTitle`);
        expect(subtitle()).toBe(`${NS}.errorSubtitle`);
        expect(redeemMagicLinkMock).not.toHaveBeenCalled();
    });

    it('still explains WHY the link failed and offers a new one', async () => {
        // The header now carries the headline, so the body must still carry
        // the specific reason and the recovery path — otherwise this "fix"
        // would have traded one missing message for another.
        redeemMagicLinkMock.mockResolvedValue({
            success: false,
            error: 'Your magic link is invalid or has expired.',
        });

        render(<MagicLinkRedeemClient />);

        await waitFor(() => expect(screen.getByTestId('magic-link-error')).toBeTruthy());

        expect(screen.getByText('Your magic link is invalid or has expired.')).toBeTruthy();
        expect(screen.getByTestId('magic-link-request-new')).toBeTruthy();
    });
});
