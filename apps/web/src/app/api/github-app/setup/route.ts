import { API_URL, ROUTES } from '@/lib/constants';
import { publicUrl } from '@/lib/public-origin';
import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
    const setupUrl = new URL(`${API_URL}/github-app/setup`);

    request.nextUrl.searchParams.forEach((value, key) => {
        setupUrl.searchParams.set(key, value);
    });

    // Every local redirect goes to the browser-facing origin. `request.url` is
    // the pod's own bind address inside the Next server (prod 2026-10-09: the
    // browser landed on `https://<pod-name>:3000/auth/error`), see
    // `lib/public-origin.ts`.
    const errorRedirect = () =>
        NextResponse.redirect(publicUrl(`${ROUTES.AUTH_ERROR}?error=oauth_callback`, request));

    const response = await fetch(setupUrl.toString(), {
        method: 'GET',
        headers: {
            Accept: 'application/json',
        },
        cache: 'no-store',
    });

    if (!response.ok) {
        console.error(`GitHub App setup was refused by the API (status ${response.status})`);
        return errorRedirect();
    }

    const data = (await response.json()) as { url?: string };
    if (!data.url) {
        return errorRedirect();
    }

    let redirectUrl: URL;
    try {
        redirectUrl = new URL(data.url);
    } catch {
        return errorRedirect();
    }

    if (redirectUrl.protocol !== 'https:' || redirectUrl.hostname !== 'github.com') {
        return errorRedirect();
    }

    return NextResponse.redirect(redirectUrl);
}
