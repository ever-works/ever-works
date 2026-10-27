import { NextResponse } from 'next/server';
import { isFleetDesktopQuality, isFleetDisplayId } from '@ever-works/contracts';
import { toAttachSocketUrl } from './attach-socket-origin';

/**
 * Desktop view & control (FL-07) — the shared half of the Desktop BFF routes
 * under `app/api/fleet/nodes/[id]/desktop/`. Same rules as the session and
 * logs BFFs: ids are checked before anything leaves the web tier, the body is
 * REBUILT field by field (the browser never smuggles a field upstream), the
 * platform's status and CONTRACTS §8 envelope pass through untouched, and a
 * grant's relative `wsPath` becomes a browser-reachable `wsUrl` — the token
 * rides the JSON answer only, never a URL.
 */

export {
    fleetApiUrl,
    forwardFleetCall,
    invalidIdResponse,
    isUuid,
    readJsonBody,
} from './fleet-sessions-bff';

/** The open / update body, rebuilt: a display id and a quality, nothing else. */
export function sanitizeDesktopViewBody(raw: Record<string, unknown>): Record<string, unknown> {
    const body: Record<string, unknown> = {};
    if (isFleetDisplayId(raw.displayId)) body.displayId = raw.displayId;
    if (isFleetDesktopQuality(raw.quality)) body.quality = raw.quality;
    return body;
}

interface UpstreamGrant {
    token?: unknown;
    wsPath?: unknown;
    expiresInSec?: unknown;
    role?: unknown;
}

/** A grant with its socket URL made browser-reachable; null when the upstream answer is malformed. */
export function browserGrant(
    grant: UpstreamGrant | null | undefined,
): Record<string, unknown> | null {
    if (!grant || typeof grant.token !== 'string' || typeof grant.wsPath !== 'string') return null;
    return {
        token: grant.token,
        wsUrl: toAttachSocketUrl(grant.wsPath),
        expiresInSec: typeof grant.expiresInSec === 'number' ? grant.expiresInSec : 60,
        role: grant.role === 'driver' ? 'driver' : 'viewer',
    };
}

/** Forward a call whose answer carries a grant (`{ view, attach, … }`, or the grant itself). */
export async function forwardGrantCall(
    url: string,
    init: { method: 'POST' | 'PATCH'; headers: Headers; body?: Record<string, unknown> },
    shape: 'open' | 'grant',
): Promise<Response> {
    init.headers.set('Accept', 'application/json');
    if (init.body) init.headers.set('Content-Type', 'application/json');
    const upstream = await fetch(url, {
        method: init.method,
        headers: init.headers,
        cache: 'no-store',
        ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    });
    if (!upstream.ok) {
        const text = await upstream.text().catch(() => '');
        return new Response(text, {
            status: upstream.status,
            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        });
    }
    const answer = (await upstream.json().catch(() => null)) as Record<string, unknown> | null;
    if (shape === 'grant') {
        const grant = browserGrant(answer as UpstreamGrant | null);
        if (!grant)
            return NextResponse.json({ error: 'Malformed upstream response' }, { status: 502 });
        return NextResponse.json(grant, {
            status: upstream.status,
            headers: { 'Cache-Control': 'no-store' },
        });
    }
    const grant = browserGrant((answer?.attach ?? null) as UpstreamGrant | null);
    if (!answer || !grant)
        return NextResponse.json({ error: 'Malformed upstream response' }, { status: 502 });
    return NextResponse.json(
        {
            view: answer.view,
            display: answer.display ?? null,
            fellBack: answer.fellBack === true,
            attach: grant,
        },
        { status: upstream.status, headers: { 'Cache-Control': 'no-store' } },
    );
}

// ─── Control (FL-07 P2) ─────────────────────────────────────────────────────

/** `POST …/control` body, rebuilt: `request: true` or `confirm: true`, nothing else. */
export function sanitizeDesktopControlBody(raw: Record<string, unknown>): Record<string, unknown> {
    const body: Record<string, unknown> = {};
    if (raw.request === true) body.request = true;
    if (raw.confirm === true) body.confirm = true;
    return body;
}

/** `POST …/control/handover` body, rebuilt; null when it is not a request id and a decision. */
export function sanitizeDesktopAnswerBody(
    raw: Record<string, unknown>,
): Record<string, unknown> | null {
    const requestId = typeof raw.requestId === 'string' ? raw.requestId : '';
    if (!isUuidLike(requestId)) return null;
    if (raw.decision !== 'hand-over' && raw.decision !== 'keep') return null;
    return { requestId, decision: raw.decision };
}

function isUuidLike(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/**
 * Forward a control call: the upstream answers `{ state, attach }`; the grant,
 * when there is one, has its socket URL made browser-reachable (a `driver`
 * grant only ever comes from the platform, for the view holding control).
 */
export async function forwardControlCall(
    url: string,
    init: { method: 'POST' | 'DELETE'; headers: Headers; body?: Record<string, unknown> },
): Promise<Response> {
    init.headers.set('Accept', 'application/json');
    if (init.body) init.headers.set('Content-Type', 'application/json');
    const upstream = await fetch(url, {
        method: init.method,
        headers: init.headers,
        cache: 'no-store',
        ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    });
    if (!upstream.ok) {
        const text = await upstream.text().catch(() => '');
        return new Response(text, {
            status: upstream.status,
            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        });
    }
    const answer = (await upstream.json().catch(() => null)) as Record<string, unknown> | null;
    if (!answer || !answer.state || typeof answer.state !== 'object') {
        return NextResponse.json({ error: 'Malformed upstream response' }, { status: 502 });
    }
    const attach = answer.attach ? browserGrant(answer.attach as UpstreamGrant) : null;
    return NextResponse.json(
        { state: answer.state, attach },
        { status: upstream.status, headers: { 'Cache-Control': 'no-store' } },
    );
}
