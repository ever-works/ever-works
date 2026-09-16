import { NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { bffProxy } from '@/lib/api/bff-proxy';
import {
    computerApiUrl,
    forwardedAttachRole,
    invalidIdResponse,
    isUuid,
    toComputerSocketUrl,
} from '@/lib/api/computer-bff';

type RouteContext = { params: Promise<{ id: string; sessionId: string }> };

/**
 * Agent computers — attach-token proxy, the terminal attach proxy's sibling.
 *
 * The browser cannot call the platform's attach endpoint (the session lives
 * in the web cookie) and cannot know the platform origin for the socket
 * (`API_URL` is a server env). This mints the token server-side with the
 * session bearer and turns the relative `wsPath` into an absolute socket
 * URL. The token is short-lived, rides this JSON response only (never a
 * URL) and is presented as the socket's first message.
 *
 * The one role this ever forwards is `controller`, and only when the browser
 * asked for exactly that (`?role=controller`): the platform then mints a
 * driving token if — and only if — this view holds control of the machine,
 * and a watching token otherwise. Any other value is dropped, so a plain
 * request is minted `viewer` exactly as before and nothing the browser sends
 * here can ask for more than the platform decides it holds.
 */
export const POST = bffProxy<RouteContext>(async ({ request, headers }, ctx) => {
    const { id, sessionId } = await ctx.params;
    if (!isUuid(id) || !isUuid(sessionId)) return invalidIdResponse();

    headers.set('Accept', 'application/json');
    const role = forwardedAttachRole(new URL(request.url).searchParams.get('role'));
    const query = role ? `?role=${role}` : '';
    const upstream = await fetch(
        computerApiUrl(id, `/sessions/${sessionId}/attach-token${query}`),
        {
            method: 'POST',
            headers,
            cache: 'no-store',
        },
    );
    if (!upstream.ok) {
        const text = await upstream.text().catch(() => '');
        return new Response(text, {
            status: upstream.status,
            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        });
    }

    const body = (await upstream.json().catch(() => null)) as {
        token?: string;
        wsPath?: string;
        role?: string;
        expiresInSec?: number;
    } | null;
    if (!body?.token || !body.wsPath) {
        return NextResponse.json({ error: 'Malformed upstream response' }, { status: 502 });
    }

    return NextResponse.json(
        {
            token: body.token,
            wsUrl: toComputerSocketUrl(API_URL, body.wsPath),
            role: body.role,
            expiresInSec: body.expiresInSec,
        },
        { headers: { 'Cache-Control': 'no-store' } },
    );
});
