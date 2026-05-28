import { NextRequest, NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { getAuthAccessCookie } from '@/lib/auth/cookies';

/**
 * EW-661 (Tenants & Organizations Phase 9) — web BFF proxy for
 * `POST /api/organizations/:id/upgrade-from-account`.
 *
 * Triggered from the `UpgradeOrCreateDialog` after the user creates
 * their first Organization and picks "Move existing items". The upstream
 * service enforces the first-Org guard (spec §5.2) and may return 409
 * with `UPGRADE_NOT_AVAILABLE_AFTER_MULTIPLE_ORGS` — we pass that body
 * through verbatim so the dialog can surface the right copy.
 */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const token = await getAuthAccessCookie();
    if (!token) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;
    if (!id) {
        return NextResponse.json({ error: 'Missing organization id' }, { status: 400 });
    }

    const headers = new Headers();
    headers.set('Authorization', `Bearer ${token}`);
    headers.set('Content-Type', 'application/json');

    try {
        const upstream = await fetch(
            `${API_URL}/organizations/${encodeURIComponent(id)}/upgrade-from-account`,
            {
                method: 'POST',
                headers,
                cache: 'no-store',
            },
        );
        const text = await upstream.text();
        const payload = text ? safeParse(text) : null;
        if (!upstream.ok) {
            return NextResponse.json(payload ?? { error: 'Failed to upgrade from account' }, {
                status: upstream.status || 500,
            });
        }
        return NextResponse.json(payload, { status: 200 });
    } catch (error) {
        console.error('Failed to proxy POST /api/organizations/:id/upgrade-from-account:', error);
        return NextResponse.json({ error: 'Failed to upgrade from account' }, { status: 500 });
    }
}

function safeParse(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}
