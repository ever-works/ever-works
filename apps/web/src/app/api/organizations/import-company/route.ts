import { NextRequest, NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { getAuthAccessCookie } from '@/lib/auth/cookies';

/**
 * Teams & Prebuilt Companies (spec §6.2) — web BFF proxy for
 * `POST /api/organizations/import-company`.
 *
 * Forwards `{ templateSlug, name? }` verbatim with the user's bearer
 * token. Upstream statuses pass through (404 unknown slug, 503 catalog
 * unavailable, 409 slug conflict) so the modal renders the right copy.
 */
export async function POST(request: NextRequest) {
    const token = await getAuthAccessCookie();
    if (!token) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const headers = new Headers();
    headers.set('Authorization', `Bearer ${token}`);
    headers.set('Content-Type', 'application/json');

    try {
        // Generous deadline: an import materializes up to ~100 files + rows.
        const upstream = await fetch(`${API_URL}/organizations/import-company`, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            cache: 'no-store',
            signal: AbortSignal.timeout(120_000),
        });
        const payload = await upstream.json().catch(() => ({}));
        return NextResponse.json(payload, { status: upstream.status });
    } catch (error) {
        console.error('Failed to proxy /api/organizations/import-company:', error);
        return NextResponse.json({ error: 'Failed to import company template' }, { status: 500 });
    }
}
