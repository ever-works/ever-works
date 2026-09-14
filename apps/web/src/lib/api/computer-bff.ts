import { NextResponse } from 'next/server';
import {
    COMPUTER_CHANNELS,
    COMPUTER_QUALITIES,
    type ComputerChannel,
    type ComputerQuality,
} from '@ever-works/contracts';
import { API_URL } from '@/lib/constants';

/**
 * Agent computers — the shared half of the computer BFF routes.
 *
 * Every route under `app/api/agents/[id]/computer/` is a thin, auth- and
 * scope-carrying forward (see `bffProxy`) to the platform's owner-facing
 * computer controller. Two rules hold for all of them and live here once:
 *
 *  - **Ids are checked before anything leaves the web tier**, and a request
 *    body is rebuilt field by field from an allow-list — the browser never
 *    gets to smuggle a field (or a role) upstream.
 *  - **The platform's status passes through unchanged.** 409 (stopped, the
 *    computer cannot be watched), 422 (a channel it cannot serve), 429 (too
 *    many live views) and 404 each carry a named reason the page renders as
 *    its own state; flattening them into a generic failure would erase it.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
    return typeof value === 'string' && UUID.test(value);
}

export function invalidIdResponse(): Response {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
}

export function computerApiUrl(agentId: string, path: string): string {
    return `${API_URL}/agents/${agentId}/computer${path}`;
}

/** Forward one call and pass the platform's status and body through untouched. */
export async function forwardComputerCall(
    url: string,
    init: {
        method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
        headers: Headers;
        body?: Record<string, unknown>;
    },
): Promise<Response> {
    init.headers.set('Accept', 'application/json');
    if (init.body) init.headers.set('Content-Type', 'application/json');
    const upstream = await fetch(url, {
        method: init.method,
        headers: init.headers,
        cache: 'no-store',
        ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    });
    const text = await upstream.text().catch(() => '');
    return new Response(upstream.status === 204 ? null : text, {
        status: upstream.status,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
}

/** Read a JSON body without throwing; anything unreadable is an empty object. */
export async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
    try {
        const parsed = (await request.json()) as unknown;
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {};
    } catch {
        return {};
    }
}

/** The open body, rebuilt from the three fields the platform accepts. */
export function sanitizeOpenBody(raw: Record<string, unknown>): {
    nodeId?: string;
    channels?: ComputerChannel[];
    quality?: ComputerQuality;
} {
    const body: { nodeId?: string; channels?: ComputerChannel[]; quality?: ComputerQuality } = {};
    if (isUuid(raw.nodeId)) body.nodeId = raw.nodeId;
    if (Array.isArray(raw.channels)) {
        const channels = [
            ...new Set(
                raw.channels.filter((channel): channel is ComputerChannel =>
                    (COMPUTER_CHANNELS as readonly string[]).includes(channel as string),
                ),
            ),
        ];
        if (channels.length > 0) body.channels = channels;
    }
    if ((COMPUTER_QUALITIES as readonly string[]).includes(raw.quality as string)) {
        body.quality = raw.quality as ComputerQuality;
    }
    return body;
}

/** The update body, rebuilt from the two fields the platform accepts. */
export function sanitizeUpdateBody(raw: Record<string, unknown>): {
    quality?: ComputerQuality;
    activeChannel?: ComputerChannel;
} {
    const body: { quality?: ComputerQuality; activeChannel?: ComputerChannel } = {};
    if ((COMPUTER_QUALITIES as readonly string[]).includes(raw.quality as string)) {
        body.quality = raw.quality as ComputerQuality;
    }
    if ((COMPUTER_CHANNELS as readonly string[]).includes(raw.activeChannel as string)) {
        body.activeChannel = raw.activeChannel as ComputerChannel;
    }
    return body;
}

/** API_URL ends in /api — the live-view gateway hangs off the ORIGIN (http→ws, https→wss). */
export function toComputerSocketUrl(apiUrl: string, wsPath: string): string {
    const origin = apiUrl.replace(/\/+$/, '').replace(/\/api$/, '');
    return origin.replace(/^http/, 'ws') + (wsPath.startsWith('/') ? wsPath : `/${wsPath}`);
}
