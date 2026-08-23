import { NextRequest, NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { getAuthAccessCookie } from '@/lib/auth/cookies';
import { applyBffWorkspaceScope } from '@/lib/api/bff-scope';

/**
 * Teams & Prebuilt Companies (spec §6) — web BFF proxy for
 * `GET /api/org-templates` (prebuilt-company catalog).
 *
 * The `CreateOrganizationModal` fetches this client-side when it opens;
 * ANY failure returns `[]` so the modal simply skips its template step
 * (guaranteed no-regression fallback, same posture as agent templates).
 */
export async function GET(request: NextRequest) {
    const token = await getAuthAccessCookie();
    if (!token) {
        return NextResponse.json([], { status: 200 });
    }

    let headers: Headers;
    try {
        headers = applyBffWorkspaceScope(request, {
            Authorization: `Bearer ${token}`,
        });
    } catch {
        return NextResponse.json({ error: 'Invalid workspace scope' }, { status: 400 });
    }

    try {
        const upstream = await fetch(`${API_URL}/org-templates`, {
            method: 'GET',
            headers,
            cache: 'no-store',
            signal: AbortSignal.timeout(10_000),
        });
        if (!upstream.ok) {
            return NextResponse.json([], { status: 200 });
        }
        const body = await upstream.json();
        return NextResponse.json(Array.isArray(body) ? body : [], { status: 200 });
    } catch (error) {
        console.error('Failed to proxy /api/org-templates:', error);
        return NextResponse.json([], { status: 200 });
    }
}
