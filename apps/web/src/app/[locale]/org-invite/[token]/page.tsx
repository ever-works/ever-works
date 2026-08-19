import type { Metadata } from 'next';
import {
    classifyOrgInviteError,
    orgInviteAPI,
    type OrgInviteError,
    type OrgInvitePreview,
} from '@/lib/api/org-invite';
import { OrgInviteForm } from '@/components/org-invite/OrgInviteForm';

export const metadata: Metadata = { title: 'Organization invitation' };

type Params = { params: Promise<{ token: string }> };

type LoadOutcome = { ok: true; preview: OrgInvitePreview } | { ok: false; error: OrgInviteError };

/**
 * `/org-invite/[token]` — where an invited person lands, straight from an
 * email, usually with no account at all.
 *
 * Modelled on the sibling `/claim/[token]` page. Two things differ, both
 * because this route serves outsiders rather than existing users:
 *
 *  - It renders the REASON a link failed instead of a generic error. A
 *    visitor with no account cannot debug anything; "this invitation expired"
 *    and "this link was cancelled" lead to completely different next actions,
 *    and only one of them is "ask for a new one".
 *  - The address shown is the API's MASKED form. The page is public to
 *    anyone holding the token, so it must not turn a forwarded link into an
 *    address disclosure — but it still has to say which account to sign in
 *    as, because the token is email-bound.
 *
 * 🛑 This route is in PUBLIC_ROUTES. Without that, proxy.ts bounces the
 * request to /login and CLEARS the auth cookie, destroying the invitation
 * silently. Pinned by `lib/__tests__/public-routes.unit.spec.ts`.
 */
async function loadPreview(token: string): Promise<LoadOutcome> {
    try {
        return { ok: true, preview: await orgInviteAPI.preview(token) };
    } catch (err) {
        return { ok: false, error: classifyOrgInviteError(err) };
    }
}

/** Every failure a visitor can actually land on, in words they can act on. */
function explain(error: OrgInviteError): { title: string; body: string } {
    switch (error) {
        case 'invitation_expired':
            return {
                title: 'This invitation has expired',
                body: 'Invitations are valid for a limited time. Ask whoever invited you to send a new one.',
            };
        case 'invitation_revoked':
            return {
                title: 'This invitation was cancelled',
                body: 'The organization withdrew this invitation. If you think that is a mistake, contact them directly.',
            };
        case 'invitation_already_accepted':
            return {
                title: 'This invitation has already been used',
                body: 'Each invitation can be accepted once. If you already joined, simply sign in.',
            };
        case 'invitation_not_found':
            return {
                title: 'We could not find this invitation',
                body: 'The link may be incomplete. Copy it from your email again, making sure you got the whole address.',
            };
        default:
            return {
                title: 'This invitation is unavailable',
                body: 'Something went wrong loading it. Try the link again in a moment.',
            };
    }
}

export default async function OrgInvitePage({ params }: Params) {
    const { token } = await params;
    const outcome = await loadPreview(token);

    if (!outcome.ok) {
        const { title, body } = explain(outcome.error);
        return (
            <div className="min-h-screen flex items-center justify-center p-6">
                <div
                    className="max-w-md w-full rounded-lg border border-border bg-card p-6 text-center"
                    data-testid="org-invite-error"
                >
                    <h1 className="text-2xl font-semibold mb-2">{title}</h1>
                    <p className="text-sm text-text-secondary">{body}</p>
                </div>
            </div>
        );
    }

    const { preview } = outcome;

    return (
        <div className="min-h-screen flex items-center justify-center p-6">
            <div
                className="max-w-md w-full rounded-lg border border-border bg-card p-6 space-y-4"
                data-testid="org-invite-card"
            >
                <div className="text-center space-y-2">
                    <h1 className="text-2xl font-semibold">
                        You&apos;ve been invited to {preview.organizationName}
                    </h1>
                    <p className="text-sm text-text-secondary">
                        This invitation was sent to{' '}
                        <span className="font-medium">{preview.invitedEmailMasked}</span>. Sign in
                        with that address to accept it.
                    </p>
                </div>

                <OrgInviteForm
                    token={token}
                    organizationName={preview.organizationName}
                    invitedEmailMasked={preview.invitedEmailMasked}
                />

                <p className="text-xs text-text-secondary text-center">
                    Expires {new Date(preview.expiresAt).toLocaleDateString()}
                </p>
            </div>
        </div>
    );
}
