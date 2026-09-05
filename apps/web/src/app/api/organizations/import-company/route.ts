import { NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { bffProxy } from '@/lib/api/bff-proxy';

/**
 * Teams & Prebuilt Companies (spec §6.2) — web BFF proxy for
 * `POST /api/organizations/import-company`.
 *
 * Forwards `{ templateSlug, name? }` verbatim with the user's bearer
 * token. Upstream statuses pass through (404 unknown slug, 503 catalog
 * unavailable, 409 slug conflict) so the modal renders the right copy.
 *
 * Auth and workspace scope come from {@link bffProxy}: no auth cookie is
 * `401 Unauthorized`, a missing or malformed per-tab selector is
 * `400 Invalid workspace scope`, and the handler is handed headers that
 * already carry the bearer and the Organization scope.
 */
export const POST = bffProxy(async ({ request, headers }) => {
    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

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
});
