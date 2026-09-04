import { NextRequest, NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { getAuthAccessCookie } from '@/lib/auth/cookies';
import { applyBffWorkspaceScope } from '@/lib/api/bff-scope';

type RouteContext = { params: Promise<{ docId: string }> };

/**
 * Proxy for `POST /api/memory/review/:docId/reject`.
 *
 * Rejecting ARCHIVES the document — it is not a delete, and the upstream
 * refuses ids outside the caller's Organization with a 404 rather than a
 * 403 so the endpoint cannot be used to probe which ids exist elsewhere.
 * None of that is decided here; this only forwards the caller's bearer
 * and the caller's scope.
 *
 * EW-786: the scope half was missing, exactly as on the accept twin, and
 * with the same consequence — `rejectMemoryDocument` answers 422 with no
 * Organization on the request scope. Both verbs are fixed together
 * because the panel disables neither independently: a user who can see a
 * row can click either button.
 */
export async function POST(request: NextRequest, { params }: RouteContext) {
    const { docId } = await params;
    const token = await getAuthAccessCookie();
    if (!token) {
        return new Response('Unauthorized', { status: 401 });
    }

    let headers: Headers;
    try {
        headers = applyBffWorkspaceScope(request, {
            Accept: 'application/json',
            Authorization: `Bearer ${token}`,
        });
    } catch {
        return NextResponse.json({ error: 'Invalid workspace scope' }, { status: 400 });
    }

    const upstream = await fetch(`${API_URL}/memory/review/${encodeURIComponent(docId)}/reject`, {
        method: 'POST',
        headers,
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
    return NextResponse.json(body ?? {}, { status: 200 });
}
