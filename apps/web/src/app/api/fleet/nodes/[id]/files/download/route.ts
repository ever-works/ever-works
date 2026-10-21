import { NextResponse } from 'next/server';
import { bffProxy } from '@/lib/api/bff-proxy';
import { applyBffWorkspaceScopeFromNavigation } from '@/lib/api/bff-scope';
import {
    filesUpstreamQuery,
    fleetApiUrl,
    invalidIdResponse,
    invalidLocationResponse,
    isUuid,
} from '@/lib/api/fleet-files-bff';

type RouteContext = { params: Promise<{ id: string }> };

/** Never echo a caller-controlled value into a response header. */
const FALLBACK_DISPOSITION = 'attachment; filename="download"';

/**
 * Files on computers (FL-11, FR-10, FR-11) — download entries of a folder:
 * one file as itself, several entries or a folder as a `.zip`. Reached by a
 * browser NAVIGATION (the Download button sets `location`), so the workspace
 * selector travels as `?scope=` and is read back with
 * `applyBffWorkspaceScopeFromNavigation` (Referer-checked); the carrier never
 * reaches the platform. The upstream body is PIPED, never buffered — a 2 GiB
 * download passes through without the web tier holding it. A refusal (409
 * `confirmation_required` for a credential-shaped file, `unreachable`,
 * `permission_denied`, …) passes through as the CONTRACTS §8 envelope.
 */
export const GET = bffProxy<RouteContext>(
    async ({ request, token }, ctx) => {
        const { id } = await ctx.params;
        if (!isUuid(id)) return invalidIdResponse();
        let headers: Headers;
        try {
            headers = applyBffWorkspaceScopeFromNavigation(request, {
                Authorization: `Bearer ${token}`,
            });
        } catch {
            return NextResponse.json({ error: 'Invalid workspace scope' }, { status: 400 });
        }
        const query = filesUpstreamQuery(new URL(request.url).searchParams, {
            single: ['confirm'],
            repeated: ['entries'],
        });
        if (query === null) return invalidLocationResponse();
        headers.set('Accept', 'application/octet-stream, application/zip, application/json');
        const upstream = await fetch(fleetApiUrl(`/nodes/${id}/files/download${query}`), {
            method: 'GET',
            headers,
            cache: 'no-store',
        });
        if (!upstream.ok || !upstream.body) {
            const text = await upstream.text().catch(() => '');
            return new Response(text, {
                status: upstream.status || 502,
                headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
            });
        }
        const disposition = upstream.headers.get('content-disposition');
        const out = new Headers({
            'Content-Type':
                upstream.headers.get('content-type') === 'application/zip'
                    ? 'application/zip'
                    : 'application/octet-stream',
            'Content-Disposition':
                disposition && !/[\r\n]/.test(disposition) ? disposition : FALLBACK_DISPOSITION,
            'X-Content-Type-Options': 'nosniff',
            'Cache-Control': 'no-store',
        });
        const length = upstream.headers.get('content-length');
        if (length && /^\d+$/.test(length)) out.set('Content-Length', length);
        for (const name of ['x-fleet-transfer-id', 'x-fleet-operation-id']) {
            const value = upstream.headers.get(name);
            if (value && /^[A-Za-z0-9_-]{1,64}$/.test(value)) out.set(name, value);
        }
        return new Response(upstream.body, { status: 200, headers: out });
    },
    {
        scope: 'none',
        reason: 'A navigation (the Download button) cannot send x-ever-workspace: the selector arrives as ?scope= and is applied above with applyBffWorkspaceScopeFromNavigation, failing closed on a tampered value.',
    },
);
