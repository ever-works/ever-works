import { NextRequest, NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { getAuthAccessCookie } from '@/lib/auth/cookies';

/**
 * EW-662 (Tenants & Organizations Phase 10) — web BFF proxy for
 * `POST /api/organizations/register-company`.
 *
 * Triggered by the Register-Company dialog (Company chip → form
 * submit). Forwards the JSON body verbatim to the NestJS API with the
 * user's bearer token attached. On success returns the new
 * `OrganizationResponse` so the dialog can hand off to the
 * `<UpgradeOrCreateDialog>` (for first-Org users) or navigate to
 * `/${org.slug}/dashboard`.
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
        const upstream = await fetch(`${API_URL}/organizations/register-company`, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            cache: 'no-store',
        });
        const text = await upstream.text();
        const payload = text ? safeParse(text) : null;
        if (!upstream.ok) {
            return NextResponse.json(payload ?? { error: 'Failed to register company' }, {
                status: upstream.status || 500,
            });
        }
        return NextResponse.json(payload, { status: 201 });
    } catch (error) {
        console.error('Failed to proxy POST /api/organizations/register-company:', error);
        return NextResponse.json({ error: 'Failed to register company' }, { status: 500 });
    }
}

function safeParse(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}
