import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { startEverIdSignInMock } = vi.hoisted(() => ({ startEverIdSignInMock: vi.fn() }));

vi.mock('next-intl', async () => {
    const { enUseTranslations } = await import('@/lib/auth/__tests__/en-messages');
    return { useTranslations: enUseTranslations };
});
vi.mock('@/app/actions/ever-id', () => ({ startEverIdSignIn: startEverIdSignInMock }));
// `Button` reaches @/i18n/navigation, whose next-intl client entry does not
// resolve under vitest's ESM loader — the same stub the other component specs use.
vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
        <a href={href}>{children}</a>
    ),
}));

import { EverIdButton } from './ever-id-button';

/**
 * APW-12 T24 — "Sign in with Ever ID" / "Sign up with Ever ID" (spec §6.1).
 *
 * The visibility rule itself (administrator switch AND flag) lives in
 * `isEverIdOffered` and the pages; this pins what the button does once a page
 * renders it: the copy per page, "Opening Ever ID…" while the browser is sent to
 * Ever ID, the registration consent gate, and an announced failure.
 */
describe('EverIdButton', () => {
    beforeEach(() => {
        startEverIdSignInMock.mockReset();
    });

    it('reads "Sign in with Ever ID" on the sign-in page', () => {
        render(<EverIdButton mode="signIn" />);
        expect(screen.getByRole('button', { name: 'Sign in with Ever ID' })).toBeEnabled();
    });

    it('reads "Sign up with Ever ID" on the registration page', () => {
        render(<EverIdButton mode="signUp" />);
        expect(screen.getByRole('button', { name: 'Sign up with Ever ID' })).toBeEnabled();
    });

    it('starts the sign-in with the return path and reads "Opening Ever ID…" meanwhile', async () => {
        let finish: (value: unknown) => void = () => {};
        startEverIdSignInMock.mockReturnValue(new Promise((resolve) => (finish = resolve)));
        render(<EverIdButton mode="signIn" returnTo="/works/42" />);

        fireEvent.click(screen.getByRole('button', { name: 'Sign in with Ever ID' }));

        expect(await screen.findByText('Opening Ever ID…')).toBeInTheDocument();
        expect(screen.getByTestId('ever-id-button')).toBeDisabled();
        expect(startEverIdSignInMock).toHaveBeenCalledWith('/works/42');

        // The action never resolves on success (the browser navigates away).
        await act(async () => finish(undefined));
    });

    it('announces a failure in an alert and lets the person try again', async () => {
        startEverIdSignInMock.mockResolvedValue({
            success: false,
            error: "Ever ID isn't responding. Try again in a minute, or sign in another way.",
            code: 'provider_unavailable',
        });
        render(<EverIdButton mode="signIn" />);

        fireEvent.click(screen.getByRole('button', { name: 'Sign in with Ever ID' }));

        expect(await screen.findByRole('alert')).toHaveTextContent(
            "Ever ID isn't responding. Try again in a minute, or sign in another way.",
        );
        await waitFor(() =>
            expect(screen.getByRole('button', { name: 'Sign in with Ever ID' })).toBeEnabled(),
        );
    });

    it('is disabled with its reason shown while the consent gate is closed', () => {
        render(
            <EverIdButton
                mode="signUp"
                disabled
                disabledReason="Accept the terms above to continue."
            />,
        );

        const button = screen.getByRole('button', { name: 'Sign up with Ever ID' });
        expect(button).toBeDisabled();
        expect(button).toHaveAttribute('aria-disabled', 'true');
        const reason = screen.getByTestId('ever-id-button-reason');
        expect(reason).toHaveTextContent('Accept the terms above to continue.');
        expect(button).toHaveAttribute('aria-describedby', reason.id);

        fireEvent.click(button);
        expect(startEverIdSignInMock).not.toHaveBeenCalled();
    });

    it('passes null when no return path is given', async () => {
        startEverIdSignInMock.mockResolvedValue({ success: false, error: 'x', code: 'x' });
        render(<EverIdButton mode="signIn" />);

        fireEvent.click(screen.getByRole('button', { name: 'Sign in with Ever ID' }));

        await waitFor(() => expect(startEverIdSignInMock).toHaveBeenCalledWith(null));
    });
});
