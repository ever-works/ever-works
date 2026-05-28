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

/**
 * EW-661 (Tenants & Organizations Phase 9) — web BFF proxy for
 * `POST /api/organizations`.
 *
 * Forwards the JSON body (`{ name, slug? }`) verbatim to the NestJS API
 * with the user's bearer token attached. Returns the new
 * `OrganizationResponse` payload as-is so the client-side
 * `CreateOrganizationModal` can read `slug` to navigate, and `id` to
 * call the follow-up `upgrade-from-account` endpoint.
 *
 * Error status codes from the upstream are passed through (e.g. 409
 * slug-conflict, 400 validation failure) so the modal can render the
 * right copy.
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
        const upstream = await fetch(`${API_URL}/organizations`, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            cache: 'no-store',
        });
        const text = await upstream.text();
        const payload = text ? safeParse(text) : null;
        if (!upstream.ok) {
            return NextResponse.json(payload ?? { error: 'Failed to create organization' }, {
                status: upstream.status || 500,
            });
        }
        return NextResponse.json(payload, { status: 201 });
    } catch (error) {
        console.error('Failed to proxy POST /api/organizations:', error);
        return NextResponse.json({ error: 'Failed to create organization' }, { status: 500 });
    }
}

function safeParse(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}
