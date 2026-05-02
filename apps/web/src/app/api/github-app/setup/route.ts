import { API_URL } from '@/lib/constants';
import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
    const setupUrl = new URL(`${API_URL}/github-app/setup`);

    request.nextUrl.searchParams.forEach((value, key) => {
        setupUrl.searchParams.set(key, value);
    });

    const response = await fetch(setupUrl.toString(), {
        method: 'GET',
        headers: {
            Accept: 'application/json',
        },
        cache: 'no-store',
    });

    if (!response.ok) {
        return NextResponse.redirect(new URL('/auth/error?error=oauth_callback', request.url));
    }

    const data = (await response.json()) as { url?: string };
    if (!data.url) {
        return NextResponse.redirect(new URL('/auth/error?error=oauth_callback', request.url));
    }

    let redirectUrl: URL;
    try {
        redirectUrl = new URL(data.url);
    } catch {
        return NextResponse.redirect(new URL('/auth/error?error=oauth_callback', request.url));
    }

    if (redirectUrl.protocol !== 'https:' || redirectUrl.hostname !== 'github.com') {
        return NextResponse.redirect(new URL('/auth/error?error=oauth_callback', request.url));
    }

    return NextResponse.redirect(redirectUrl);
}
