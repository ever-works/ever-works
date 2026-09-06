import { NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { bffProxy } from '@/lib/api/bff-proxy';

/**
 * Proxy for the scheduled Memory Consolidation settings.
 *
 * `GET` reads the current cadence/mode/enabled flags (defaults when the
 * Organization has never configured it); `PUT` writes them.
 *
 * The write matters more than it looks: the scheduler only selects
 * organizations whose settings column is non-null, and nothing used to
 * write that column, so the scheduled pass could never run for anyone.
 *
 * EW-786 — both handlers are genuinely Organization-scoped:
 * `OrgMemoryController.getConsolidationSettings` /
 * `putConsolidationSettings` take the Organization from
 * `ScopeContextService.getOrganizationId()`, which the API populates only
 * from an `/api/<slug>/…` path or the `X-Scope-Slug` header. Translating
 * the browser's per-tab `x-ever-workspace` selector into that header is
 * therefore the whole feature on an Organization: without it `GET`
 * answered with the personal-scope defaults instead of the stored
 * settings, and `PUT` answered 422 "No active Organization", which the
 * panel showed as a toggle that flipped and quietly flipped back.
 *
 * The selector only arrives if the caller sends it, so this change and
 * the `browserApiFetch` switch in `MemoryConsolidationSettings` are one
 * change: scoping the route alone would turn those silent failures into
 * a hard 400.
 */

/**
 * Auth and scope are settled by {@link bffProxy} before this runs, and it
 * fails closed on a missing or stale selector — which is the point: an
 * unscoped forward would silently read and write the caller's PERSONAL
 * scope while they are looking at an Organization.
 */
async function forward(headers: Headers, method: 'GET' | 'PUT', body?: string) {
    headers.set('Accept', 'application/json');
    if (body !== undefined) headers.set('Content-Type', 'application/json');

    const upstream = await fetch(`${API_URL}/memory/consolidation/settings`, {
        method,
        headers,
        body,
        cache: 'no-store',
    });

    if (!upstream.ok) {
        const text = await upstream.text().catch(() => '');
        return new Response(text, {
            status: upstream.status,
            headers: {
                'Content-Type': upstream.headers.get('content-type') ?? 'application/json',
                'Cache-Control': 'no-store',
            },
        });
    }

    const json = await upstream.json().catch(() => null);
    return NextResponse.json(json ?? {}, { status: 200 });
}

// The plain-text `Unauthorized` is preserved deliberately: the wrapper's
// default is JSON, and changing this route's wire format as a side effect of
// adopting it would be exactly the kind of silent drift bffProxy exists to
// stop.
const unauthorizedText = () => new Response('Unauthorized', { status: 401 });

export const GET = bffProxy(async ({ headers }) => forward(headers, 'GET'), {
    onUnauthorized: unauthorizedText,
});

export const PUT = bffProxy(
    async ({ request, headers }) => {
        // Read and re-serialize rather than streaming: this is a small JSON
        // body, and buffering keeps the upstream Content-Length honest.
        const raw = await request.text().catch(() => '{}');
        return forward(headers, 'PUT', raw || '{}');
    },
    { onUnauthorized: unauthorizedText },
);
