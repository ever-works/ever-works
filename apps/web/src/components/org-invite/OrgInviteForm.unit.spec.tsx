import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { acceptMock, rememberMock, pushMock } = vi.hoisted(() => ({
    acceptMock: vi.fn(),
    rememberMock: vi.fn(),
    pushMock: vi.fn(),
}));

vi.mock('@/i18n/navigation', () => ({
    useRouter: () => ({ push: pushMock }),
    // The Button tree pulls Link from this module; without it the whole
    // mock is rejected and the suite reports "no tests" rather than a
    // missing-export error on the line that needs it.
    Link: ({ href, children, ...rest }: any) => (
        <a href={typeof href === 'string' ? href : ''} {...rest}>
            {children}
        </a>
    ),
}));
vi.mock('@/app/actions/org-invite', () => ({
    acceptOrgInviteAction: acceptMock,
    rememberOrgInviteAndGetAuthHref: rememberMock,
}));

import { OrgInviteForm } from './OrgInviteForm';

/**
 * The accept control on the public invitation page.
 *
 * The person holding this link may have no account, an account under a
 * different address, or an account already tied to another organization —
 * and the page cannot tell which, because it renders signed-out. So the
 * behaviour that matters is: try, then explain the specific failure and offer
 * the right way forward. A single generic error is what makes an invitation
 * flow feel broken.
 *
 * The other load-bearing property is that BOTH auth links stash the
 * invitation before navigating. Without that, a brand-new user registers and
 * lands on the dashboard with their invitation silently spent — the exact
 * failure the whole signed-out path exists to avoid.
 */
const TOKEN = 'a'.repeat(64);

function renderForm() {
    return render(
        <OrgInviteForm
            token={TOKEN}
            organizationName="Acme Inc"
            invitedEmailMasked="n***@example.com"
        />,
    );
}

describe('OrgInviteForm', () => {
    beforeEach(() => {
        acceptMock.mockReset();
        rememberMock.mockReset().mockResolvedValue('/login');
        pushMock.mockReset();
    });

    it('control: renders all three routes forward', () => {
        // If this failed, every assertion below would be vacuous against a
        // component that rendered nothing.
        renderForm();
        expect(screen.getByTestId('org-invite-accept')).toBeInTheDocument();
        expect(screen.getByTestId('org-invite-signin')).toBeInTheDocument();
        expect(screen.getByTestId('org-invite-register')).toBeInTheDocument();
    });

    it('accepts with the token it was given', async () => {
        acceptMock.mockResolvedValue({ status: 'joined', organizationSlug: 'acme' });
        renderForm();

        await userEvent.click(screen.getByTestId('org-invite-accept'));

        expect(acceptMock).toHaveBeenCalledWith(TOKEN);
        expect(await screen.findByTestId('org-invite-success')).toHaveTextContent(
            "You've joined Acme Inc",
        );
    });

    it('reports an already-redeemed invitation as success, not as an error', async () => {
        // A double-clicked accept must not look like a failure to someone who
        // is, in fact, now a member.
        acceptMock.mockResolvedValue({ status: 'already_member', organizationSlug: 'acme' });
        renderForm();

        await userEvent.click(screen.getByTestId('org-invite-accept'));

        expect(await screen.findByTestId('org-invite-success')).toHaveTextContent(
            "You're already a member of Acme Inc",
        );
    });

    it('names the invited address on an email mismatch', async () => {
        // The single most likely real-world failure: clicking the link while
        // signed in as a different account. Telling them WHICH address is the
        // difference between a 10-second fix and giving up.
        acceptMock.mockResolvedValue({ status: 'error', error: 'invitation_email_mismatch' });
        renderForm();

        await userEvent.click(screen.getByTestId('org-invite-accept'));

        const box = await screen.findByTestId('org-invite-accept-error');
        expect(box).toHaveTextContent('n***@example.com');
        expect(box).toHaveTextContent(/sign out/i);
    });

    it('explains the already-in-another-organization case distinctly', async () => {
        // This one is NOT retryable and no amount of re-sending helps, so it
        // must not share wording with the expiry case.
        acceptMock.mockResolvedValue({
            status: 'error',
            error: 'user_already_in_another_tenant',
        });
        renderForm();

        await userEvent.click(screen.getByTestId('org-invite-accept'));

        const box = await screen.findByTestId('org-invite-accept-error');
        expect(box).toHaveTextContent(/already belongs to another organization/i);
        expect(box).not.toHaveTextContent(/expired/i);
    });

    it('gives expiry and revocation different messages', async () => {
        acceptMock.mockResolvedValue({ status: 'error', error: 'invitation_expired' });
        const { unmount } = renderForm();
        await userEvent.click(screen.getByTestId('org-invite-accept'));
        expect(await screen.findByTestId('org-invite-accept-error')).toHaveTextContent(/expired/i);
        unmount();

        acceptMock.mockResolvedValue({ status: 'error', error: 'invitation_revoked' });
        renderForm();
        await userEvent.click(screen.getByTestId('org-invite-accept'));
        expect(await screen.findByTestId('org-invite-accept-error')).toHaveTextContent(
            /cancelled/i,
        );
    });

    it('stashes the invitation before sending anyone to sign in', async () => {
        rememberMock.mockResolvedValue('/login');
        renderForm();

        await userEvent.click(screen.getByTestId('org-invite-signin'));

        expect(rememberMock).toHaveBeenCalledWith(TOKEN, 'login');
        expect(pushMock).toHaveBeenCalledWith('/login');
    });

    it('stashes it before sending anyone to register — the newcomer path', async () => {
        rememberMock.mockResolvedValue('/register');
        renderForm();

        await userEvent.click(screen.getByTestId('org-invite-register'));

        expect(rememberMock).toHaveBeenCalledWith(TOKEN, 'register');
        expect(pushMock).toHaveBeenCalledWith('/register');
    });
});
