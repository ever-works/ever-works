import { NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { getAuthAccessCookie } from '@/lib/auth/cookies';

/**
 * Client-side proxy for `GET /api/skills/invocable` — the composer's
 * slash-command autocomplete fetches this from the browser, so the
 * session cookie is translated to a Bearer here (same pattern as the
 * activity-log proxy routes).
 */
export async function GET() {
    const token = await getAuthAccessCookie();
    const headers = new Headers();
    if (token) headers.set('Authorization', `Bearer ${token}`);

    const response = await fetch(`${API_URL}/skills/invocable`, {
        method: 'GET',
        headers,
        cache: 'no-store',
    });

    if (!response.ok) {
        return NextResponse.json(
            { error: 'Failed to fetch invocable skills' },
            { status: response.status || 500 },
        );
    }

    return NextResponse.json(await response.json());
}
