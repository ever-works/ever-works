import { NextResponse } from 'next/server';
import { bffProxy } from '@/lib/api/bff-proxy';
import { toAttachSocketUrl } from '@/lib/api/attach-socket-origin';
import {
    fleetApiUrl,
    invalidIdResponse,
    isUuid,
    parsePortSegment,
    readJsonBody,
    sanitizeOpenBody,
} from '@/lib/api/fleet-ports-bff';

type RouteContext = { params: Promise<{ id: string; port: string }> };

/**
 * Servers and ports (FL-10) — **Open**: on the machine's desktop, or in its
 * preview browser. The body is rebuilt (`target`, `scheme`); for a preview the
 * platform's answer carries a 60-second, single-use viewer token for the
 * preview picture, whose relative `wsPath` becomes a browser-reachable socket
 * URL here ({@link toAttachSocketUrl}) — the token rides this JSON answer
 * only, never a URL. A refusal (`busy` naming who is previewing,
 * `consent_missing` naming `--attend`, `permission_denied`) passes through.
 */
export const POST = bffProxy<RouteContext>(async ({ request, headers }, ctx) => {
    const { id, port: portSegment } = await ctx.params;
    const port = parsePortSegment(portSegment);
    if (!isUuid(id) || port === null) return invalidIdResponse();
    const body = sanitizeOpenBody(await readJsonBody(request));
    headers.set('Accept', 'application/json');
    headers.set('Content-Type', 'application/json');
    const upstream = await fetch(fleetApiUrl(`/nodes/${id}/ports/${port}/open`), {
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
    const result = (await upstream.json().catch(() => null)) as {
        target?: string;
        url?: string;
        previewViewId?: string;
        endsAt?: string;
        attach?: { token?: string; wsPath?: string; expiresInSec?: number; role?: string };
    } | null;
    if (!result?.target || !result.url) {
        return NextResponse.json({ error: 'Malformed upstream response' }, { status: 502 });
    }
    const attach =
        result.attach?.token && result.attach.wsPath
            ? {
                  token: result.attach.token,
                  wsUrl: toAttachSocketUrl(result.attach.wsPath),
                  expiresInSec: result.attach.expiresInSec,
                  role: result.attach.role,
              }
            : undefined;
    return NextResponse.json(
        {
            target: result.target,
            url: result.url,
            ...(result.previewViewId ? { previewViewId: result.previewViewId } : {}),
            ...(result.endsAt ? { endsAt: result.endsAt } : {}),
            ...(attach ? { attach } : {}),
        },
        { headers: { 'Cache-Control': 'no-store' } },
    );
});
