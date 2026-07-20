import { NextRequest, NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { getAuthAccessCookie } from '@/lib/auth/cookies';

/**
 * PR-6 (domain-model evolution) — web BFF proxy for
 * `PATCH /api/organizations/:id`.
 *
 * Forwards the JSON body (`UpdateOrganizationRequest` — `displayName`,
 * `legalName`, `countryCode`, and the PR-6 `vision` field) verbatim to
 * the NestJS API with the user's bearer token attached. The upstream
 * service enforces that the caller belongs to the Organization's
 * Tenant; error statuses (400 validation, 403/404 scope) pass through
 * so the settings form can render the right copy.
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const token = await getAuthAccessCookie();
    if (!token) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;
    if (!id) {
        return NextResponse.json({ error: 'Missing organization id' }, { status: 400 });
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
        const upstream = await fetch(`${API_URL}/organizations/${encodeURIComponent(id)}`, {
            method: 'PATCH',
            headers,
            body: JSON.stringify(body),
            cache: 'no-store',
        });
        const text = await upstream.text();
        const payload = text ? safeParse(text) : null;
        if (!upstream.ok) {
            return NextResponse.json(payload ?? { error: 'Failed to update organization' }, {
                status: upstream.status || 500,
            });
        }
        return NextResponse.json(payload, { status: 200 });
    } catch (error) {
        console.error('Failed to proxy PATCH /api/organizations/:id:', error);
        return NextResponse.json({ error: 'Failed to update organization' }, { status: 500 });
    }
}

function safeParse(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}
