import { NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { bffProxy } from '@/lib/api/bff-proxy';

/**
 * Teams & Prebuilt Companies (spec §6) — web BFF proxy for
 * `GET /api/org-templates` (prebuilt-company catalog).
 *
 * The `CreateOrganizationModal` fetches this client-side when it opens;
 * ANY failure returns `[]` so the modal simply skips its template step
 * (guaranteed no-regression fallback, same posture as agent templates).
 *
 * Auth and workspace scope come from {@link bffProxy}, which forwards the
 * browser's per-tab selector by default. The unauthenticated response is
 * softened to `[]` here to preserve that fallback.
 */
export const GET = bffProxy(
    async ({ headers }) => {
        try {
            const upstream = await fetch(`${API_URL}/org-templates`, {
                method: 'GET',
                headers,
                cache: 'no-store',
                signal: AbortSignal.timeout(10_000),
            });
            if (!upstream.ok) {
                return NextResponse.json([], { status: 200 });
            }
            const body = await upstream.json();
            return NextResponse.json(Array.isArray(body) ? body : [], { status: 200 });
        } catch (error) {
            console.error('Failed to proxy /api/org-templates:', error);
            return NextResponse.json([], { status: 200 });
        }
    },
    { onUnauthorized: () => NextResponse.json([], { status: 200 }) },
);
