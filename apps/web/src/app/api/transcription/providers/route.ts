import { NextRequest, NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { getAuthAccessCookie } from '@/lib/auth/cookies';

/**
 * Proxy for `GET /api/transcription/providers`.
 *
 * Lists the AI-provider plugins that implement speech-to-text in this
 * scope, so the composer can offer a choice instead of assuming a
 * vendor. `isActive` marks the one the scope resolves to on its own —
 * i.e. what happens if the user never picks.
 */
export async function GET(_request: NextRequest) {
    const token = await getAuthAccessCookie();
    if (!token) {
        return new Response('Unauthorized', { status: 401 });
    }

    const upstream = await fetch(`${API_URL}/transcription/providers`, {
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
        cache: 'no-store',
    });

    if (!upstream.ok) {
        const text = await upstream.text().catch(() => '');
        return new Response(text, {
            status: upstream.status,
            headers: {
                'Content-Type': upstream.headers.get('content-type') ?? 'application/json',
                'Cache-Control': 'no-store',
            },
        });
    }

    const body = await upstream.json().catch(() => null);
    return NextResponse.json(body ?? { providers: [] }, { status: 200 });
}
