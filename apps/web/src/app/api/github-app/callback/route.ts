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

    const safeRedirectTarget =
        data.redirectTo && data.redirectTo.startsWith('/')
            ? data.redirectTo
            : ROUTES.DASHBOARD_SETTINGS;
    const redirectUrl = new URL(safeRedirectTarget, request.url);
    if (data.installationId) {
        redirectUrl.searchParams.set('github_app_connected', 'true');
        redirectUrl.searchParams.set('installation_id', data.installationId);
    }

    return NextResponse.redirect(redirectUrl);
}
