import { setAuthCookies } from '@/lib/auth';
import { GITHUB_APP_SETUP_COOKIE_NAME, githubAppSetupCookieOptions } from '@/lib/auth/cookies';
import { API_URL, ROUTES } from '@/lib/constants';
import { publicOriginFor } from '@/lib/public-origin';
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

    // Every redirect — and the same-origin check below — uses the
    // browser-facing origin. `request.url` is the pod's own bind address inside
    // the Next server (prod 2026-10-09: after installing the GitHub App the
    // browser landed on `https://<pod-name>:3000/auth/error`), see
    // `lib/public-origin.ts`.
    const publicOrigin = publicOriginFor(request);
    // Item 13: the binding cookie is single-use — cleared on every outcome.
    const clearBinding = (res: NextResponse): NextResponse => {
        res.cookies.set(GITHUB_APP_SETUP_COOKIE_NAME, '', {
            ...githubAppSetupCookieOptions(60),
            maxAge: 0,
        });
        return res;
    };
    const errorRedirect = () =>
        clearBinding(
            NextResponse.redirect(
                new URL(`${ROUTES.AUTH_ERROR}?error=oauth_callback`, publicOrigin),
            ),
        );

    const binding = request.cookies.get(GITHUB_APP_SETUP_COOKIE_NAME)?.value;
    const response = await fetch(callbackUrl.toString(), {
        method: 'GET',
        headers: {
            Accept: 'application/json',
            // Server-to-server only; the API compares it with the state's hash.
            ...(binding ? { 'X-Ever-Works-Setup-Binding': binding } : {}),
        },
        cache: 'no-store',
    });

    if (!response.ok) {
        // Status only: the body may echo the provider's answer. Without this
        // line a refused callback left no trace on the web tier.
        console.error(`GitHub App callback was refused by the API (status ${response.status})`);
        return errorRedirect();
    }

    const data = (await response.json()) as GitHubAppCallbackResponse;
    if (!data.access_token) {
        return errorRedirect();
    }

    await setAuthCookies(data.access_token);

    // Security (open-redirect): the backend-supplied redirectTo must be a
    // same-origin path. `startsWith('/')` alone still accepts protocol-relative
    // targets like `//evil.com` (and the `/\evil.com` backslash variant that
    // browsers normalize to `//`), which `new URL(target, base)` would resolve
    // to a foreign origin — sending the just-set auth cookie offsite. Reject
    // anything that doesn't start with a single '/' followed by a
    // non-slash/backslash char, then defensively confirm the resolved origin
    // matches the PUBLIC origin before trusting it.
    const isSafeRelativePath =
        typeof data.redirectTo === 'string' &&
        /^\/(?![/\\])/.test(data.redirectTo) &&
        (() => {
            try {
                return new URL(data.redirectTo!, publicOrigin).origin === publicOrigin;
            } catch {
                return false;
            }
        })();
    const safeRedirectTarget = isSafeRelativePath
        ? (data.redirectTo as string)
        : ROUTES.DASHBOARD_SETTINGS;
    const redirectUrl = new URL(safeRedirectTarget, publicOrigin);
    if (data.installationId) {
        redirectUrl.searchParams.set('github_app_connected', 'true');
        redirectUrl.searchParams.set('installation_id', data.installationId);
    }

    return clearBinding(NextResponse.redirect(redirectUrl));
}
