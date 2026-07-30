import { NextRequest, NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { getAuthAccessCookie } from '@/lib/auth/cookies';

/**
 * Proxy for the scheduled Memory Consolidation settings.
 *
 * `GET` reads the current cadence/mode/enabled flags (defaults when the
 * Organization has never configured it); `PUT` writes them.
 *
 * The write matters more than it looks: the scheduler only selects
 * organizations whose settings column is non-null, and nothing used to
 * write that column, so the scheduled pass could never run for anyone.
 */

async function forward(method: 'GET' | 'PUT', body?: string) {
    const token = await getAuthAccessCookie();
    if (!token) return new Response('Unauthorized', { status: 401 });

    const headers = new Headers({ Accept: 'application/json' });
    headers.set('Authorization', `Bearer ${token}`);
    if (body !== undefined) headers.set('Content-Type', 'application/json');

    const upstream = await fetch(`${API_URL}/memory/consolidation/settings`, {
        method,
        headers,
        body,
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

    const json = await upstream.json().catch(() => null);
    return NextResponse.json(json ?? {}, { status: 200 });
}

export async function GET(_request: NextRequest) {
    return forward('GET');
}

export async function PUT(request: NextRequest) {
    // Read and re-serialize rather than streaming: this is a small JSON
    // body, and buffering keeps the upstream Content-Length honest.
    const raw = await request.text().catch(() => '{}');
    return forward('PUT', raw || '{}');
}
