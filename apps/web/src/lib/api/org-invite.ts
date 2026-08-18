import 'server-only';
import { serverFetch, serverMutation } from './server-api';

/** What the signed-out landing page renders. The address is masked by the API. */
export interface OrgInvitePreview {
    organizationName: string;
    invitedEmailMasked: string;
    expiresAt: string;
}

export interface OrgInviteAcceptResult {
    organizationId: string;
    organizationSlug: string;
    /** False when this same user had already redeemed it (a double-click). */
    joined: boolean;
}

/**
 * Why the invitation preview cannot fail closed the way the other clients do:
 * a visitor here has no account, so "swallow the error and render an empty
 * page" would show them a blank screen with no way to tell whether the link
 * was expired, revoked, or simply mistyped. The reason IS the content, so
 * these deliberately surface it.
 */
export type OrgInviteError =
    | 'invitation_expired'
    | 'invitation_revoked'
    | 'invitation_already_accepted'
    | 'invitation_not_found'
    | 'invitation_email_mismatch'
    | 'user_already_in_another_tenant'
    | 'account_has_no_email'
    | 'unknown';

/** Map an API rejection onto one of the codes the page knows how to explain. */
export function classifyOrgInviteError(error: unknown): OrgInviteError {
    const message = error instanceof Error ? error.message : String(error ?? '');
    const known: OrgInviteError[] = [
        'invitation_expired',
        'invitation_revoked',
        'invitation_already_accepted',
        'invitation_not_found',
        'invitation_email_mismatch',
        'user_already_in_another_tenant',
        'account_has_no_email',
    ];
    // Substring rather than equality: the API wraps these in an exception
    // whose message may carry a prefix, and a stricter match would silently
    // collapse every distinct case into `unknown`.
    return known.find((code) => message.includes(code)) ?? 'unknown';
}

export const orgInviteAPI = {
    /**
     * Read an invitation without consuming it. Public — no session needed;
     * `serverFetch` simply omits the Authorization header when there is no
     * cookie.
     */
    async preview(token: string): Promise<OrgInvitePreview> {
        // POST for a read, deliberately: a GET would put the token in the URL,
        // where the API's request logger and Sentry both capture it.
        return serverMutation<OrgInvitePreview>({
            endpoint: '/org-invite/preview',
            method: 'POST',
            data: { token },
            wrapInData: false,
        });
    },

    /** Redeem as the signed-in user. Requires a session. */
    async accept(token: string): Promise<OrgInviteAcceptResult> {
        return serverMutation<OrgInviteAcceptResult>({
            endpoint: '/org-invite/accept',
            method: 'POST',
            // `data` is the body and `wrapInData` decides whether it is
            // nested under a `data` key; this endpoint takes { token } flat.
            data: { token },
            wrapInData: false,
        });
    },
};
