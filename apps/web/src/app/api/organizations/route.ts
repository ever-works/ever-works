import { NextRequest, NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { getAuthAccessCookie } from '@/lib/auth/cookies';

/**
 * EW-660 (Tenants & Organizations Phase 8) — web BFF proxy for
 * `GET /api/organizations`.
 *
 * Forwards to the NestJS API at `${API_URL}/organizations` with the
 * user's auth token attached as a Bearer header (the encrypted
 * `auth_token` cookie is decrypted here, NEVER shipped to the browser).
 *
 * Returns the upstream `OrganizationResponse[]` payload as-is. On 401
 * or upstream error we fall through to `{ status }` so the client-side
 * `useOrganizations()` hook can surface a sensible `error` value without
 * mistaking the auth-failure for an empty-orgs list.
 */
export async function GET(_request: NextRequest) {
    const token = await getAuthAccessCookie();
    if (!token) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const headers = new Headers();
    headers.set('Authorization', `Bearer ${token}`);

    try {
        const upstream = await fetch(`${API_URL}/organizations`, {
            method: 'GET',
            headers,
            cache: 'no-store',
        });
        if (!upstream.ok) {
            return NextResponse.json(
                { error: 'Failed to fetch organizations' },
                { status: upstream.status || 500 },
            );
        }
        const body = await upstream.json();
        return NextResponse.json(body, { status: 200 });
    } catch (error) {
        console.error('Failed to proxy /api/organizations:', error);
        return NextResponse.json({ error: 'Failed to fetch organizations' }, { status: 500 });
    }
}
