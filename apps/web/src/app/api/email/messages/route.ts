import { NextRequest, NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { getAuthAccessCookie } from '@/lib/auth/cookies';

/**
 * EW-681 / T33 — web BFF proxy for `GET /api/email/messages`.
 *
 * Forwards to the NestJS API with the user's bearer token (decrypted
 * from the encrypted `auth_token` cookie here, NEVER shipped to the
 * browser). Used by the client-side `useAgentInbox()` hook for
 * revalidation. Mirrors the organizations BFF proxy.
 */
export async function GET(request: NextRequest) {
    const token = await getAuthAccessCookie();
    if (!token) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const agentId = request.nextUrl.searchParams.get('agentId') ?? '';
    const limit = request.nextUrl.searchParams.get('limit') ?? '50';
    const offset = request.nextUrl.searchParams.get('offset') ?? '0';
    if (!agentId) {
        return NextResponse.json({ error: 'agentId is required' }, { status: 400 });
    }

    const headers = new Headers();
    headers.set('Authorization', `Bearer ${token}`);

    try {
        const upstream = await fetch(
            `${API_URL}/email/messages?agentId=${encodeURIComponent(agentId)}&limit=${encodeURIComponent(limit)}&offset=${encodeURIComponent(offset)}`,
            { method: 'GET', headers, cache: 'no-store' },
        );
        if (!upstream.ok) {
            return NextResponse.json(
                { error: 'Failed to fetch messages' },
                { status: upstream.status || 500 },
            );
        }
        const body = await upstream.json();
        return NextResponse.json(body, { status: 200 });
    } catch (error) {
        console.error('Failed to proxy /api/email/messages:', error);
        return NextResponse.json({ error: 'Failed to fetch messages' }, { status: 500 });
    }
}
