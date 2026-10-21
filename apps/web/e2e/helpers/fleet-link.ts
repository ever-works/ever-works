import { expect, type APIRequestContext } from '@playwright/test';
import {
    FLEET_LINK_VERSION,
    decodeFleetLinkControl,
    decodeFleetLinkFrame,
    encodeFleetLinkControl,
    type FleetConsents,
    type FleetLinkHello,
} from '@ever-works/contracts';
import { API_BASE, authedHeaders } from './api';
import { fleetUniq } from './fleet-hub';

/**
 * Fleet node link (FL-02, T-18) — what the link's e2e walks share: whether
 * this run's API accepts node links, a REAL enrolled node WITH its secret
 * (the hub helper drops it), a heartbeat carrying consents, the node's link
 * token, and a raw link socket driven exactly as `apps/node`'s link client
 * drives it — binary frames from the contracts codec, the token in the first
 * frame (never the URL).
 */

export const FLEET_LINK_ON =
    process.env.FLEET_NODE_LINK_ENABLED === 'true' && process.env.FLEET_ENABLED !== 'false';

export interface LinkNode {
    nodeId: string;
    secret: string;
    name: string;
}

export const NO_CONSENTS: FleetConsents = {
    work: false,
    attend: false,
    manage: false,
    usageScan: false,
};

export async function enrollLinkNode(
    request: APIRequestContext,
    accessToken: string,
    name = `Link node ${fleetUniq()}`,
): Promise<LinkNode> {
    const minted = await request.post(`${API_BASE}/api/fleet/nodes/enrollment-token`, {
        headers: authedHeaders(accessToken),
        data: { name, kind: 'node' },
    });
    expect(minted.status(), `mint body=${await minted.text().catch(() => '')}`).toBe(201);
    const { token } = await minted.json();
    const enrolled = await request.post(`${API_BASE}/api/fleet/enroll`, {
        data: {
            token,
            platform: 'linux/x64',
            version: '1.0.0',
            capabilities: ['terminal', 'workspace'],
        },
    });
    expect(enrolled.status(), `enroll body=${await enrolled.text().catch(() => '')}`).toBe(201);
    const body = (await enrolled.json()) as { nodeId: string; secret: string };
    return { nodeId: body.nodeId, secret: body.secret, name };
}

/** One heartbeat reporting these consents (CONTRACTS §1.1), as `apps/node` sends it. */
export async function beatWithConsents(
    request: APIRequestContext,
    node: LinkNode,
    consents: FleetConsents,
    capabilities: string[] = ['terminal', 'workspace'],
): Promise<Record<string, unknown>> {
    const beat = await request.post(`${API_BASE}/api/fleet/heartbeat`, {
        data: {
            nodeId: node.nodeId,
            secret: node.secret,
            version: '1.0.0',
            capabilities: consents.manage ? [...capabilities, 'managed'] : capabilities,
            consents,
        },
    });
    expect(beat.status(), `heartbeat body=${await beat.text().catch(() => '')}`).toBe(200);
    return (await beat.json()) as Record<string, unknown>;
}

/** `POST /api/fleet/link-token` with the node credential. */
export function mintLinkToken(
    request: APIRequestContext,
    node: Pick<LinkNode, 'nodeId' | 'secret'>,
) {
    return request.post(`${API_BASE}/api/fleet/link-token`, {
        data: { nodeId: node.nodeId, secret: node.secret },
    });
}

/** The node's link socket URL on the API's origin. */
export function linkSocketUrl(path = '/ws/fleet/link'): string {
    const url = new URL(path, API_BASE);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return url.toString();
}

export function helloFor(node: LinkNode, token: string, consents: FleetConsents): FleetLinkHello {
    return {
        type: 'link.hello',
        nodeId: node.nodeId,
        linkVersion: FLEET_LINK_VERSION,
        capabilities: consents.manage
            ? ['terminal', 'workspace', 'managed']
            : ['terminal', 'workspace'],
        consents,
        token,
        nodeVersion: '1.0.0',
    };
}

export type LinkEvent =
    | { kind: 'control'; message: Record<string, unknown> }
    | { kind: 'closed'; code: number; reason: string };

export interface LinkProbe {
    /** The next control message or the close, whichever comes first; throws after `timeoutMs`. */
    next(timeoutMs?: number): Promise<LinkEvent>;
    /** Wait for a control message of this `type`, skipping others (pings, pauses). */
    until(type: string, timeoutMs?: number): Promise<Record<string, unknown>>;
    /** Wait for the close. */
    closed(timeoutMs?: number): Promise<{ code: number; reason: string }>;
    send(message: Parameters<typeof encodeFleetLinkControl>[0]): void;
    close(): void;
}

/** Open a raw link socket (the global WebSocket of the Node running Playwright). */
export function openLinkSocket(path = '/ws/fleet/link'): Promise<LinkProbe> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(linkSocketUrl(path));
        ws.binaryType = 'arraybuffer';
        const queue: LinkEvent[] = [];
        const waiters: Array<(event: LinkEvent) => void> = [];
        let opened = false;
        const push = (event: LinkEvent) => {
            const waiter = waiters.shift();
            if (waiter) waiter(event);
            else queue.push(event);
        };
        ws.addEventListener('message', (event) => {
            if (!(event.data instanceof ArrayBuffer)) return;
            const frame = decodeFleetLinkFrame(new Uint8Array(event.data));
            if (!frame || frame.channel !== 0) return;
            const message = decodeFleetLinkControl(frame.payload);
            if (message)
                push({ kind: 'control', message: message as unknown as Record<string, unknown> });
        });
        ws.addEventListener('close', (event) => {
            push({ kind: 'closed', code: event.code, reason: event.reason });
            if (!opened) reject(new Error(`link socket closed before it opened (${event.code})`));
        });
        ws.addEventListener('error', () => {
            if (!opened) reject(new Error('link socket failed to open'));
        });
        const next = (timeoutMs = 10_000) =>
            new Promise<LinkEvent>((resolveNext, rejectNext) => {
                const queued = queue.shift();
                if (queued) {
                    resolveNext(queued);
                    return;
                }
                const timer = setTimeout(() => {
                    const index = waiters.indexOf(waiter);
                    if (index >= 0) waiters.splice(index, 1);
                    rejectNext(new Error(`no link event within ${timeoutMs} ms`));
                }, timeoutMs);
                const waiter = (event: LinkEvent) => {
                    clearTimeout(timer);
                    resolveNext(event);
                };
                waiters.push(waiter);
            });
        ws.addEventListener('open', () => {
            opened = true;
            resolve({
                next,
                async until(type, timeoutMs = 10_000) {
                    const deadline = Date.now() + timeoutMs;
                    for (;;) {
                        const event = await next(Math.max(1, deadline - Date.now()));
                        if (event.kind === 'closed') {
                            throw new Error(
                                `link closed ${event.code} (${event.reason}) before ${type}`,
                            );
                        }
                        if (event.message.type === type) return event.message;
                    }
                },
                async closed(timeoutMs = 10_000) {
                    const deadline = Date.now() + timeoutMs;
                    for (;;) {
                        const event = await next(Math.max(1, deadline - Date.now()));
                        if (event.kind === 'closed')
                            return { code: event.code, reason: event.reason };
                    }
                },
                send(message) {
                    const bytes = encodeFleetLinkControl(message);
                    if (!bytes) throw new Error('control message could not be encoded');
                    ws.send(bytes);
                },
                close() {
                    try {
                        ws.close(1000, 'test done');
                    } catch {
                        // already closed
                    }
                },
            });
        });
    });
}
