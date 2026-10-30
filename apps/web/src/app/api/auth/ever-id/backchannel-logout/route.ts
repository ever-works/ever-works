import { NextRequest, NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';

/**
 * Ever ID back-channel logout on the web host: the identity provider's sign-out
 * notice (`logout_token`, form-encoded) is handed to the API route that checks it
 * and ends the sessions it names, and the API's status is answered unchanged.
 *
 * It exists so the sign-in return address (`/api/auth/ever-id/callback`) and the
 * back-channel logout address share one origin, which Ever Platform requires of
 * the sign-in client it makes for a connected installation. The API route itself
 * stays reachable as before.
 *
 * Nothing of the browser travels: no cookie, no session. The body is capped; the
 * answer is never cached.
 */

/** A logout token is a few hundred bytes; anything far larger is not one. */
const MAX_BODY_BYTES = 16 * 1024;
const UPSTREAM_TIMEOUT_MS = 10_000;

function answer(status: number): NextResponse {
    return new NextResponse(null, { status, headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request: NextRequest) {
    const body = await request.text();
    if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) return answer(400);

    try {
        const upstream = await fetch(`${API_URL}/auth/ever-id/backchannel-logout`, {
            method: 'POST',
            headers: {
                'Content-Type':
                    request.headers.get('content-type') ?? 'application/x-www-form-urlencoded',
            },
            body,
            cache: 'no-store',
            redirect: 'manual',
            signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        });
        return answer(upstream.status);
    } catch {
        // The notice could not be handed over; the provider may retry it.
        return answer(502);
    }
}
