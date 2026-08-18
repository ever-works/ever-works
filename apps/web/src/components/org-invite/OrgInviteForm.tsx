'use client';

import { useState, useTransition } from 'react';
import { useRouter } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import {
    acceptOrgInviteAction,
    rememberOrgInviteAndGetAuthHref,
    type AcceptOrgInviteState,
} from '@/app/actions/org-invite';
import type { OrgInviteError } from '@/lib/api/org-invite';

interface OrgInviteFormProps {
    token: string;
    organizationName: string;
    invitedEmailMasked: string;
}

/**
 * The accept control on the invitation landing page.
 *
 * Offers three routes at once — accept, sign in, create an account — because
 * the person holding this link may be in any of those states and the page
 * cannot tell which from the server (it is public, so there may be no
 * session). Trying to accept is the cheapest way to find out: the API answers
 * definitively, and the failure code says which of the other two to take.
 *
 * Both auth links first stash the invitation in `redirect_url`, so the detour
 * through registration returns here rather than dumping a brand-new user on
 * the dashboard with their invitation silently spent.
 */
export function OrgInviteForm({ token, organizationName, invitedEmailMasked }: OrgInviteFormProps) {
    const router = useRouter();
    const [pending, startTransition] = useTransition();
    const [state, setState] = useState<AcceptOrgInviteState | null>(null);

    const handleAccept = () => {
        startTransition(async () => {
            setState(await acceptOrgInviteAction(token));
        });
    };

    const goToAuth = (destination: 'login' | 'register') => {
        startTransition(async () => {
            router.push(await rememberOrgInviteAndGetAuthHref(token, destination));
        });
    };

    if (state?.status === 'joined' || state?.status === 'already_member') {
        return (
            <div
                className="rounded-md border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950 p-4 space-y-3 text-sm"
                data-testid="org-invite-success"
            >
                <p className="font-medium">
                    {state.status === 'joined'
                        ? `You've joined ${organizationName}`
                        : `You're already a member of ${organizationName}`}
                </p>
                <Button size="sm" onClick={() => router.push('/dashboard')}>
                    Go to dashboard
                </Button>
            </div>
        );
    }

    const failure = state?.status === 'error' ? state.error : null;

    return (
        <div className="space-y-3">
            {failure ? (
                <div
                    className="rounded-md border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950 p-3 text-sm"
                    data-testid="org-invite-accept-error"
                >
                    {explainFailure(failure, invitedEmailMasked)}
                </div>
            ) : null}

            <Button
                onClick={handleAccept}
                disabled={pending}
                loading={pending}
                className="w-full"
                data-testid="org-invite-accept"
            >
                Accept invitation
            </Button>

            <div className="flex items-center gap-2 text-sm">
                <button
                    type="button"
                    onClick={() => goToAuth('login')}
                    disabled={pending}
                    className="underline disabled:opacity-50"
                    data-testid="org-invite-signin"
                >
                    Sign in
                </button>
                <span className="text-text-secondary">or</span>
                <button
                    type="button"
                    onClick={() => goToAuth('register')}
                    disabled={pending}
                    className="underline disabled:opacity-50"
                    data-testid="org-invite-register"
                >
                    create an account
                </button>
            </div>
        </div>
    );
}

/**
 * Each failure gets its own next action. Collapsing these into one message is
 * what makes an invitation flow feel broken: "wrong account" and "expired"
 * need opposite responses, and only one of them is worth emailing anyone about.
 */
function explainFailure(error: OrgInviteError, invitedEmailMasked: string): string {
    switch (error) {
        case 'invitation_email_mismatch':
            return `This invitation is for ${invitedEmailMasked}. You're signed in as a different account — sign out and back in with that address.`;
        case 'user_already_in_another_tenant':
            return 'Your account already belongs to another organization. Accounts cannot be moved between organizations; ask the sender to invite an address that is not in use yet.';
        case 'account_has_no_email':
            return 'Your account has no email address, so an email-bound invitation cannot be matched to it.';
        case 'invitation_expired':
            return 'This invitation has expired. Ask whoever invited you to send a new one.';
        case 'invitation_revoked':
            return 'This invitation was cancelled by the organization.';
        case 'invitation_already_accepted':
            return 'This invitation has already been used. If that was you, just sign in.';
        case 'invitation_not_found':
            return 'We could not find this invitation. Copy the link from your email again.';
        default:
            // The most common cause of an unclassified failure here is simply
            // not being signed in, so point at the two buttons below.
            return 'We could not accept this invitation. If you are not signed in yet, use one of the options below.';
    }
}
