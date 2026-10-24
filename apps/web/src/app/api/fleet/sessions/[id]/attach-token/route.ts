import { NextResponse } from 'next/server';
import { bffProxy } from '@/lib/api/bff-proxy';
import { toAttachSocketUrl } from '@/lib/api/attach-socket-origin';
import {
    fleetApiUrl,
    invalidIdResponse,
    isUuid,
    readJsonBody,
    sanitizeAttachBody,
} from '@/lib/api/fleet-sessions-bff';

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Sessions on computers (FL-04 P1b) — the attach-token proxy for the session
 * viewer (`/ws/fleet/session/<id>`, FL-02's viewer gateway).
 *
 * Like the computer and terminal attach proxies: the token is minted here
 * with the session bearer (the browser cannot call the platform), rides this
 * JSON answer only — never a URL — and the relative `wsPath` becomes an
 * absolute, browser-reachable socket URL ({@link toAttachSocketUrl}). The
 * role is the one the browser asked for, rebuilt from the allow-list
 * (`viewer` | `driver`); the platform decides whether the person may have it.
 * A refusal (`limit_exceeded` with the five watchers, `kill_switch`,
 * `unreachable`) passes through with its status and hint.
 */
export const POST = bffProxy<RouteContext>(async ({ request, headers }, ctx) => {
    const { id } = await ctx.params;
    if (!isUuid(id)) return invalidIdResponse();
    const body = sanitizeAttachBody(await readJsonBody(request));
    if (!body) {
        return NextResponse.json(
            { error: { code: 'invalid', hint: 'role must be viewer or driver' } },
            { status: 400 },
        );
    }
    headers.set('Accept', 'application/json');
    headers.set('Content-Type', 'application/json');
    const upstream = await fetch(fleetApiUrl(`/sessions/${id}/attach-token`), {
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
        role?: string;
        expiresInSec?: number;
    } | null;
    if (!grant?.token || !grant.wsPath) {
        return NextResponse.json({ error: 'Malformed upstream response' }, { status: 502 });
    }
    return NextResponse.json(
        {
            token: grant.token,
            wsUrl: toAttachSocketUrl(grant.wsPath),
            role: grant.role,
            expiresInSec: grant.expiresInSec,
        },
        { headers: { 'Cache-Control': 'no-store' } },
    );
});
