import { NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { bffProxy } from '@/lib/api/bff-proxy';
import {
    computerApiUrl,
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
 * Only the watching role exists for a live view today, so NO role is ever
 * forwarded: the platform mints `viewer`, and nothing the browser sends here
 * can ask for more.
 */
export const POST = bffProxy<RouteContext>(async ({ headers }, ctx) => {
    const { id, sessionId } = await ctx.params;
    if (!isUuid(id) || !isUuid(sessionId)) return invalidIdResponse();

    headers.set('Accept', 'application/json');
    const upstream = await fetch(computerApiUrl(id, `/sessions/${sessionId}/attach-token`), {
        method: 'POST',
        headers,
        cache: 'no-store',
    });
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
