import { NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Skills shelf — the one upstream call behind the card toggle and the
 * re-check control. Those two interactions must feel instant, so they go
 * browser → BFF route → API rather than through a server-action round trip.
 *
 * Auth and workspace scope are settled by `bffProxy` before this runs; the
 * handed-in `headers` already carry the bearer and the Organization scope.
 * The upstream status is passed through unchanged, so a 404 for another
 * workspace's Skill reaches the card as a 404.
 */
export async function proxySkillShelfCall(
    headers: Headers,
    id: string,
    path: 'enable' | 'disable' | 'readiness' | 'readiness/refresh',
    method: 'GET' | 'POST',
): Promise<NextResponse> {
    if (!UUID.test(id)) {
        return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
    }
    headers.set('Accept', 'application/json');
    const upstream = await fetch(`${API_URL}/skills/${id}/${path}`, {
        method,
        headers,
        cache: 'no-store',
    });
    const body = await upstream.json().catch(() => ({ error: 'Request failed' }));
    return NextResponse.json(body, { status: upstream.status });
}
