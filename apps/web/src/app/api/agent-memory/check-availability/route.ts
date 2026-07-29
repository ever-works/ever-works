import { NextRequest, NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { getAuthAccessCookie } from '@/lib/auth/cookies';

/**
 * Proxy for `GET /api/agent-memory/check-availability`.
 *
 * Agent memory is plugin-backed and frequently NOT configured — it needs
 * an agent-memory provider enabled (e.g. `@ever-works/agentmemory-plugin`
 * pointing at an agentmemory server). The upstream answers 200 with
 * `available: false` plus an operator-facing `message` rather than an
 * error, so the Memory page can explain what to enable instead of
 * rendering a broken panel.
 */
export async function GET(_request: NextRequest) {
    const token = await getAuthAccessCookie();
    if (!token) {
        return new Response('Unauthorized', { status: 401 });
    }

    const upstream = await fetch(`${API_URL}/agent-memory/check-availability`, {
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
    return NextResponse.json(body ?? { available: false }, { status: 200 });
}
