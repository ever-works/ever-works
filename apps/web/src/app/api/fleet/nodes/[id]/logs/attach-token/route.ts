import { NextResponse } from 'next/server';
import { bffProxy } from '@/lib/api/bff-proxy';
import { toAttachSocketUrl } from '@/lib/api/attach-socket-origin';
import {
    fleetApiUrl,
    invalidIdResponse,
    isUuid,
    readJsonBody,
    sanitizeLogsAttachBody,
} from '@/lib/api/fleet-logs-bff';

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Logs on computers (FL-08) — the attach-token proxy for the log viewer
 * (`/ws/fleet/logs/<nodeId>`, FL-02's viewer gateway).
 *
 * As the session and computer attach proxies: the token is minted here with
 * the session bearer, rides this JSON answer only — never a URL — and the
 * relative `wsPath` becomes an absolute, browser-reachable socket URL. The
 * body is rebuilt from its allow-list (a source id, merged ids, a line count,
 * follow). A refusal (`limit_exceeded` with the eight open logs,
 * `kill_switch`, `unreachable`, `invalid` for a path outside the shared
 * folders) passes through with its status and hint.
 */
export const POST = bffProxy<RouteContext>(async ({ request, headers }, ctx) => {
    const { id } = await ctx.params;
    if (!isUuid(id)) return invalidIdResponse();
    const body = sanitizeLogsAttachBody(await readJsonBody(request));
    if (!body) {
        return NextResponse.json(
            { error: { code: 'invalid', hint: 'pick a log source from the list' } },
            { status: 400 },
        );
    }
    headers.set('Accept', 'application/json');
    headers.set('Content-Type', 'application/json');
    const upstream = await fetch(fleetApiUrl(`/nodes/${id}/logs/attach-token`), {
        method: 'POST',
        headers,
        cache: 'no-store',
        body: JSON.stringify(body),
    });
    if (!upstream.ok) {
        const text = await upstream.text().catch(() => '');
        return new Response(text, {
            status: upstream.status,
            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        });
    }
    const grant = (await upstream.json().catch(() => null)) as {
        token?: string;
        wsPath?: string;
        expiresInSec?: number;
        sources?: string[];
        lines?: number;
        follow?: boolean;
    } | null;
    if (!grant?.token || !grant.wsPath) {
        return NextResponse.json({ error: 'Malformed upstream response' }, { status: 502 });
    }
    return NextResponse.json(
        {
            token: grant.token,
            wsUrl: toAttachSocketUrl(grant.wsPath),
            expiresInSec: grant.expiresInSec,
            sources: grant.sources,
            lines: grant.lines,
            follow: grant.follow,
        },
        { headers: { 'Cache-Control': 'no-store' } },
    );
});
