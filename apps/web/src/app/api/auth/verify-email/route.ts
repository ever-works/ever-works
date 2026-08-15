import { redirect } from '@/i18n/navigation';
import { authAPI, AuthResponse } from '@/lib/api';
import { setAuthCookies } from '@/lib/auth';
import { getRedirectUrl } from '@/lib/auth/redirect';
import { ROUTES } from '@/lib/constants';
import { getLocale } from 'next-intl/server';
import { NextRequest } from 'next/server';
import { verifyEmailErrorCode } from './verify-email-error';

export async function GET(request: NextRequest) {
    const token = request.nextUrl.searchParams.get('token');
    const locale = await getLocale();

    if (!token) {
        return redirect({
            locale,
            href: ROUTES.AUTH_ERROR + '?error=verify_email_missing_token',
        });
    }

    let authResponse: AuthResponse | null = null;

    try {
        authResponse = await authAPI.verifyEmail({ token });

        await setAuthCookies(authResponse.access_token);
    } catch (error) {
        console.error('Email verification failed', error);

        // EW-078: report what actually went wrong. See `verify-email-error.ts`
        // — every rejection used to collapse into "invalid or already used".
        //
        // EW-079: and go STRAIGHT to the error page. This return is the fix.
        // The failure path used to fall through to the shared
        // `getRedirectUrl(...)` call below, which reads the `redirect_url`
        // cookie and, when one is set, returns it in place of whatever href it
        // was given. So a user whose verification had just failed was sent to
        // the page they were originally headed for and shown nothing at all:
        // no error, no "resend" button, no hint that the link they clicked did
        // not work. The error page was computed and then thrown away.
        //
        // The cookie is deliberately left in place. It is consumed
        // (`removeRedirectCookie`) by the success path only, so the
        // destination survives until a verification actually succeeds — the
        // user requests a new link, clicks it, and still lands where they were
        // originally going.
        return redirect({
            locale,
            href: ROUTES.AUTH_ERROR + `?error=${verifyEmailErrorCode(error)}`,
        });
    }

    // Success only. `authResponse` is non-null here, so the stored redirect
    // gets the session token stitched into it as intended.
    const href = await getRedirectUrl(authResponse, ROUTES.DASHBOARD + '?verified=true');

    return redirect({ locale, href });
}
