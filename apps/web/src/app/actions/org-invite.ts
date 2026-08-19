'use server';

import { classifyOrgInviteError, orgInviteAPI, type OrgInviteError } from '@/lib/api/org-invite';
import { setRedirectCookie } from '@/lib/auth/cookies';
import { ROUTES } from '@/lib/constants';

export type AcceptOrgInviteState =
    | { status: 'joined'; organizationSlug: string }
    | { status: 'already_member'; organizationSlug: string }
    | { status: 'error'; error: OrgInviteError };

/**
 * Redeem an organization invitation for the signed-in user.
 *
 * Returns a discriminated result rather than throwing, because every failure
 * here is something the visitor needs explained, not a stack trace: the wrong
 * account, an expired link, or an account that already belongs to a different
 * organization. The page turns each code into a sentence.
 */
export async function acceptOrgInviteAction(token: string): Promise<AcceptOrgInviteState> {
    try {
        const result = await orgInviteAPI.accept(token);
        return {
            status: result.joined ? 'joined' : 'already_member',
            organizationSlug: result.organizationSlug,
        };
    } catch (error) {
        return { status: 'error', error: classifyOrgInviteError(error) };
    }
}

/**
 * Remember this invitation, then send the visitor to sign in or register.
 *
 * The whole point of the feature is people who have NO account yet, so the
 * detour through registration must not lose the invitation. `redirect_url` is
 * the app's existing mechanism and it is already validated on the way out —
 * `getRedirectUrl` rejects anything that is not relative or an allowed host,
 * so writing a path here cannot become an open redirect.
 *
 * Returns the destination instead of redirecting so the caller keeps control
 * of navigation (and so this is testable without a router).
 */
export async function rememberOrgInviteAndGetAuthHref(
    token: string,
    destination: 'login' | 'register',
): Promise<string> {
    await setRedirectCookie(ROUTES.orgInvite(token));
    return destination === 'register' ? ROUTES.AUTH_REGISTER : ROUTES.AUTH_LOGIN;
}
