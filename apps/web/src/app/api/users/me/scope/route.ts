import { NextRequest, NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { bffProxy } from '@/lib/api/bff-proxy';

type ActiveScopeContext = { method: 'GET' | 'POST'; body?: unknown };

/**
 * Active-scope proxy for `GET`/`POST /api/users/me/scope`.
 *
 * The upstream status and body are passed through verbatim — the scope
 * switcher reads both — so nothing here reshapes the response.
 *
 * Auth and workspace scope come from {@link bffProxy}: no auth cookie is
 * `401 Unauthorized`, a missing or malformed per-tab selector is
 * `400 Invalid workspace scope`, and the handler is handed headers that
 * already carry the bearer and the Organization scope.
 *
 * The method and body arrive as the handler's context rather than being read
 * inside it because `POST` must parse its JSON BEFORE entering the wrapper: a
 * malformed body has always answered `400 Invalid JSON body` ahead of the auth
 * check, and that ordering is preserved.
 */
const proxyActiveScope = bffProxy<ActiveScopeContext>(async ({ headers }, { method, body }) => {
    if (method === 'POST') {
        headers.set('Content-Type', 'application/json');
    }

    try {
        const upstream = await fetch(`${API_URL}/users/me/scope`, {
            method,
            headers,
            body: method === 'POST' ? JSON.stringify(body) : undefined,
            cache: 'no-store',
        });
        const text = await upstream.text();

        return new NextResponse(text || null, {
            status: upstream.status,
            headers: {
                'Content-Type': upstream.headers.get('content-type') ?? 'application/json',
            },
        });
    } catch (error) {
        console.error(`Failed to proxy ${method} /api/users/me/scope:`, error);
        return NextResponse.json({ error: 'Failed to access active scope' }, { status: 500 });
    }
});

export async function GET(request: NextRequest) {
    return proxyActiveScope(request, { method: 'GET' });
}

export async function POST(request: NextRequest) {
    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    return proxyActiveScope(request, { method: 'POST', body });
}
