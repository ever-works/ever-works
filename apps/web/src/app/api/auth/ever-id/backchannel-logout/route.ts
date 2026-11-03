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
 * Nothing of the browser travels: no cookie, no session; only the sender's address,
 * for the API's rate limit. The body is capped; the answer is never cached.
 */

/** A logout token is a few hundred bytes; anything far larger is not one. */
const MAX_BODY_BYTES = 16 * 1024;
const UPSTREAM_TIMEOUT_MS = 10_000;

function answer(status: number): NextResponse {
    return new NextResponse(null, { status, headers: { 'Cache-Control': 'no-store' } });
}

/** The body as text, or `null` once it passes `max` bytes (the read stops there). */
async function readCapped(request: NextRequest, max: number): Promise<string | null> {
    if (!request.body) return '';
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > max) {
            await reader.cancel().catch(() => undefined);
            return null;
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
}

/**
 * The sender's address, so the API's per-IP limit on this public route counts per
 * sender rather than for the web server as a whole (otherwise anyone posting junk
 * here would use up the allowance real notices from Ever ID share).
 *
 * Same rule as `clientIpHeaders` in `lib/api/account-deletion.ts`: the incoming
 * `X-Forwarded-For` chain is passed on WHOLE (its left-most entry is whatever the
 * caller wrote; the API's `TRUST_PROXY_HOPS` counts from the right, where the
 * ingress appended the real peer), with `X-Real-IP` as the fallback.
 */
function clientIpHeaders(request: NextRequest): Record<string, string> {
    const chain = request.headers.get('x-forwarded-for')?.trim();
    if (chain) return { 'X-Forwarded-For': chain };
    const realIp = request.headers.get('x-real-ip')?.trim();
    return realIp ? { 'X-Forwarded-For': realIp } : {};
}

export async function POST(request: NextRequest) {
    const declared = Number(request.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return answer(400);
    const body = await readCapped(request, MAX_BODY_BYTES);
    if (body === null) return answer(400);

    try {
        const upstream = await fetch(`${API_URL}/auth/ever-id/backchannel-logout`, {
            method: 'POST',
            headers: {
                'Content-Type':
                    request.headers.get('content-type') ?? 'application/x-www-form-urlencoded',
                ...clientIpHeaders(request),
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
