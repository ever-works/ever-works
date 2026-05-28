import { NextRequest, NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';

/**
 * EW-661 (Tenants & Organizations Phase 9) — web BFF proxy for
 * `GET /api/organizations/check-slug?value=<name>`.
 *
 * Mirrors the shape of `apps/web/src/app/api/organizations/route.ts` so
 * the client-side CreateOrganizationModal can hit a same-origin URL. The
 * upstream endpoint is `@Public()` + throttled, so this proxy does NOT
 * attach the auth cookie — but we keep the proxy in place anyway for two
 * reasons:
 *
 *  1. The browser never needs to know `API_URL` (kept server-side only).
 *  2. Future hardening (e.g. CSRF, rate-limit by user) can land here
 *     without touching the modal.
 */
export async function GET(request: NextRequest) {
    const value = request.nextUrl.searchParams.get('value');
    if (!value || value.length === 0) {
        return NextResponse.json(
            { error: 'Missing required `value` query parameter' },
            { status: 400 },
        );
    }

    try {
        const upstream = await fetch(
            `${API_URL}/organizations/check-slug?value=${encodeURIComponent(value)}`,
            {
                method: 'GET',
                cache: 'no-store',
            },
        );
        if (!upstream.ok) {
            return NextResponse.json(
                { error: 'Failed to check slug availability' },
                { status: upstream.status || 500 },
            );
        }
        const body = await upstream.json();
        return NextResponse.json(body, { status: 200 });
    } catch (error) {
        console.error('Failed to proxy /api/organizations/check-slug:', error);
        return NextResponse.json({ error: 'Failed to check slug availability' }, { status: 500 });
    }
}
