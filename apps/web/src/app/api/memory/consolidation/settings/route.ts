import { NextRequest, NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { getAuthAccessCookie } from '@/lib/auth/cookies';
import { applyBffWorkspaceScope } from '@/lib/api/bff-scope';

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

async function forward(request: NextRequest, method: 'GET' | 'PUT', body?: string) {
    const token = await getAuthAccessCookie();
    if (!token) return new Response('Unauthorized', { status: 401 });

    const base: Record<string, string> = {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
    };
    if (body !== undefined) base['Content-Type'] = 'application/json';

    // Fail closed. A missing or stale selector is answered here rather
    // than forwarded unscoped, which would silently read and write the
    // caller's personal scope while they are looking at an Organization.
    let headers: Headers;
    try {
        headers = applyBffWorkspaceScope(request, base);
    } catch {
        return NextResponse.json({ error: 'Invalid workspace scope' }, { status: 400 });
    }

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

export async function GET(request: NextRequest) {
    return forward(request, 'GET');
}

export async function PUT(request: NextRequest) {
    // Read and re-serialize rather than streaming: this is a small JSON
    // body, and buffering keeps the upstream Content-Length honest.
    const raw = await request.text().catch(() => '{}');
    return forward(request, 'PUT', raw || '{}');
}
