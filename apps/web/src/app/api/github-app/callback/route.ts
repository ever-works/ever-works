import { setAuthCookies } from '@/lib/auth';
import { API_URL, ROUTES } from '@/lib/constants';
import { NextRequest, NextResponse } from 'next/server';

type GitHubAppCallbackResponse = {
    access_token: string;
    installationId?: string;
    redirectTo?: string;
};

export async function GET(request: NextRequest) {
    const callbackUrl = new URL(`${API_URL}/github-app/callback`);
    request.nextUrl.searchParams.forEach((value, key) => {
        callbackUrl.searchParams.set(key, value);
    });

    const response = await fetch(callbackUrl.toString(), {
        method: 'GET',
        headers: {
            Accept: 'application/json',
        },
        cache: 'no-store',
    });

    if (!response.ok) {
        return NextResponse.redirect(
            new URL(`${ROUTES.AUTH_ERROR}?error=oauth_callback`, request.url),
        );
    }

    const data = (await response.json()) as GitHubAppCallbackResponse;
    if (!data.access_token) {
        return NextResponse.redirect(
            new URL(`${ROUTES.AUTH_ERROR}?error=oauth_callback`, request.url),
        );
    }

    await setAuthCookies(data.access_token);

    // Security (open-redirect): the backend-supplied redirectTo must be a
    // same-origin path. `startsWith('/')` alone still accepts protocol-relative
    // targets like `//evil.com` (and the `/\evil.com` backslash variant that
    // browsers normalize to `//`), which `new URL(target, request.url)` would
    // resolve to a foreign origin — sending the just-set auth cookie offsite.
    // Reject anything that doesn't start with a single '/' followed by a
    // non-slash/backslash char, then defensively confirm the resolved origin
    // matches this request's origin before trusting it.
    const isSafeRelativePath =
        typeof data.redirectTo === 'string' &&
        /^\/(?![/\\])/.test(data.redirectTo) &&
        (() => {
            try {
                return new URL(data.redirectTo!, request.url).origin === new URL(request.url).origin;
            } catch {
                return false;
            }
        })();
    const safeRedirectTarget = isSafeRelativePath
        ? (data.redirectTo as string)
        : ROUTES.DASHBOARD_SETTINGS;
    const redirectUrl = new URL(safeRedirectTarget, request.url);
    if (data.installationId) {
        redirectUrl.searchParams.set('github_app_connected', 'true');
        redirectUrl.searchParams.set('installation_id', data.installationId);
    }

    return NextResponse.redirect(redirectUrl);
}
