import { NextRequest, NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { getAuthAccessCookie } from '@/lib/auth/cookies';

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Proxies the export-items feature-flag probe used by the web UI to hide
 * the Export button when the directory has not opted in. Always returns
 * a `{ export_enabled }` JSON shape — including on upstream failure, where
 * we default to `false` so the UI fails closed.
 */
export async function GET(_request: NextRequest, { params }: RouteContext) {
    const { id } = await params;
    const token = await getAuthAccessCookie();

    const headers = new Headers();
    if (token) {
        headers.set('Authorization', `Bearer ${token}`);
    }

    try {
        const upstream = await fetch(`${API_URL}/works/${id}/export-items/settings`, {
            method: 'GET',
            headers,
            cache: 'no-store',
        });
        if (!upstream.ok) {
            return NextResponse.json({ export_enabled: false }, { status: 200 });
        }
        const body = (await upstream.json().catch(() => null)) as {
            export_enabled?: boolean;
        } | null;
        return NextResponse.json({ export_enabled: !!body?.export_enabled }, { status: 200 });
    } catch {
        return NextResponse.json({ export_enabled: false }, { status: 200 });
    }
}
