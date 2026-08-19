import { beforeEach, describe, expect, it, vi } from 'vitest';

const { acceptMock, setRedirectCookieMock } = vi.hoisted(() => ({
    acceptMock: vi.fn(),
    setRedirectCookieMock: vi.fn(),
}));

vi.mock('@/lib/api/org-invite', async (importOriginal) => {
    // Keep the REAL classifyOrgInviteError — the point of these tests is that
    // an API rejection reaches the page as a specific, actionable code, and
    // mocking the classifier would assert nothing.
    const actual = await importOriginal<typeof import('@/lib/api/org-invite')>();
    return { ...actual, orgInviteAPI: { accept: acceptMock, preview: vi.fn() } };
});
vi.mock('@/lib/auth/cookies', () => ({ setRedirectCookie: setRedirectCookieMock }));

import { acceptOrgInviteAction, rememberOrgInviteAndGetAuthHref } from './org-invite';

/**
 * The server actions behind the invitation landing page.
 *
 * These exist as their own spec because `OrgInviteForm.unit.spec.tsx` MOCKS
 * this module — so it proves the component calls the action, and can prove
 * nothing about what the action does. Deleting the `setRedirectCookie` call
 * left that suite fully green, which is exactly the gap this file closes.
 */
const TOKEN = 'a'.repeat(64);

describe('acceptOrgInviteAction', () => {
    beforeEach(() => {
        acceptMock.mockReset();
        setRedirectCookieMock.mockReset();
    });

    it('reports a fresh join', async () => {
        acceptMock.mockResolvedValue({ organizationSlug: 'acme', joined: true });
        await expect(acceptOrgInviteAction(TOKEN)).resolves.toEqual({
            status: 'joined',
            organizationSlug: 'acme',
        });
    });

    it('distinguishes an already-redeemed invitation from a fresh join', async () => {
        acceptMock.mockResolvedValue({ organizationSlug: 'acme', joined: false });
        await expect(acceptOrgInviteAction(TOKEN)).resolves.toEqual({
            status: 'already_member',
            organizationSlug: 'acme',
        });
    });

    it('returns a specific code rather than throwing', async () => {
        // The page turns each code into its own sentence; a thrown error would
        // surface as an unhandled server-action failure with no explanation
        // for a visitor who has no account and cannot debug anything.
        acceptMock.mockRejectedValue(new Error('403: invitation_email_mismatch'));
        await expect(acceptOrgInviteAction(TOKEN)).resolves.toEqual({
            status: 'error',
            error: 'invitation_email_mismatch',
        });
    });

    it('classifies each distinct failure the API can return', async () => {
        const cases = [
            'invitation_expired',
            'invitation_revoked',
            'invitation_already_accepted',
            'invitation_not_found',
            'user_already_in_another_tenant',
            'account_has_no_email',
        ] as const;

        for (const code of cases) {
            acceptMock.mockRejectedValue(new Error(`api said: ${code}`));
            const result = await acceptOrgInviteAction(TOKEN);
            expect(result).toEqual({ status: 'error', error: code });
        }
    });

    it('falls back to `unknown` rather than mislabelling an unrecognised error', async () => {
        acceptMock.mockRejectedValue(new Error('ECONNRESET'));
        await expect(acceptOrgInviteAction(TOKEN)).resolves.toEqual({
            status: 'error',
            error: 'unknown',
        });
    });
});

describe('rememberOrgInviteAndGetAuthHref', () => {
    beforeEach(() => {
        setRedirectCookieMock.mockReset();
    });

    it('🛑 STASHES the invitation before handing back the sign-in href', async () => {
        // Without this, a brand-new person registers and lands on the
        // dashboard with their invitation silently spent — the precise
        // failure the entire signed-out path exists to prevent.
        const href = await rememberOrgInviteAndGetAuthHref(TOKEN, 'login');

        expect(setRedirectCookieMock).toHaveBeenCalledWith(`/org-invite/${TOKEN}`);
        expect(href).toBe('/login');
    });

    it('stashes it on the register path too — the newcomer route', async () => {
        const href = await rememberOrgInviteAndGetAuthHref(TOKEN, 'register');

        expect(setRedirectCookieMock).toHaveBeenCalledWith(`/org-invite/${TOKEN}`);
        expect(href).toBe('/register');
    });

    it('stores a RELATIVE path, so it cannot become an open redirect', async () => {
        await rememberOrgInviteAndGetAuthHref(TOKEN, 'login');
        const stored: string = setRedirectCookieMock.mock.calls[0][0];

        expect(stored.startsWith('/')).toBe(true);
        expect(stored).not.toMatch(/^https?:/i);
        expect(stored).not.toMatch(/^\/\//);
    });
});
