import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import {
    FleetPortsException,
    type FleetPortsCaller,
    type FleetPortTunnelLinkPort,
} from '@ever-works/agent/fleet';
import {
    decodeFleetPortTunnelChunk,
    encodeFleetPortTunnelChunk,
    FLEET_LINK_FRAME_KINDS,
    FLEET_PORT_TUNNEL_CHUNK_BYTES,
    FLEET_PORT_TUNNEL_MAX_INFLIGHT,
    FLEET_PORT_TUNNEL_REQUEST_TIMEOUT_MS,
    type FleetLinkCloseReason,
    type FleetLinkFrameKind,
    type FleetPortTunnelClosedReason,
} from '@ever-works/contracts';
import type { FleetLinkChannel } from '../../fleet-link/fleet-link-channel';
import { FleetLinkException } from '../../fleet-link/fleet-link.errors';
import { FleetLinkService } from '../../fleet-link/fleet-link.service';

/**
 * Servers and ports, phase 2 (FL-10) — the platform half of the tunnel
 * transport: `FLEET_PORT_TUNNEL_LINK_PORT`, plus `forward` for the preview
 * host.
 *
 * Each API replica keeps ITS OWN `tunnel` channel per tunnel, opened lazily
 * on the first request it serves (through `FleetLinkService.openChannel`, so
 * the link's gate runs and a link another replica holds is reached through
 * the relay bus) and closed after two idle minutes. Every request is
 * authorised against the tunnel ROW before it gets here, so any replica can
 * serve any request and a tunnel closed elsewhere is refused everywhere at
 * its next request — no cross-replica tunnel state at all.
 *
 * Opening the channel is not audited as a `node.link.channel-open`
 * (`stateChanging: false`): the tunnel's own open and close rows are the
 * record (R-17, one per tunnel — never per request or per replica). The kill
 * switch still refuses the open (the link's gate refuses every act while the
 * fleet is stopped).
 *
 * Requests share the channel (`[request u32]` on every body chunk), at most
 * 32 at once per channel; a response that has not started within 60 s is a
 * timeout. Bodies stream both ways in 64 KiB chunks.
 */

export interface TunnelForwardCallbacks {
    onResponse(status: number, headers: Record<string, string | string[]>): void;
    /** A body chunk toward the browser. */
    onData(bytes: Uint8Array): void;
    onEnd(): void;
    /** The request failed before or during the answer. */
    onError(code: 'unreachable' | 'timeout' | 'invalid' | 'busy', hint: string): void;
}

export interface TunnelForwardRequest {
    tunnel: { id: string; nodeId: string; port: number; ownerUserId: string };
    method: string;
    path: string;
    query: string;
    headers: Record<string, string | string[]>;
    /** The request body, streamed (empty for GET/HEAD). */
    body: AsyncIterable<Buffer | Uint8Array | string>;
}

interface Pending extends TunnelForwardCallbacks {
    timer: ReturnType<typeof setTimeout>;
    responded: boolean;
    /** Phase 3: a WebSocket passthrough — accepted, then raw bytes both ways until END. */
    upgrade?: TunnelUpgradeCallbacks;
}

/** Phase 3 (FR-32) — what the preview host hears about one WebSocket upgrade. */
export interface TunnelUpgradeCallbacks {
    /** The loopback server switched protocols: write the 101 with these headers to the browser. */
    onAccept(status: number, headers: Record<string, string | string[]>): void;
    /** The loopback server answered without switching protocols. */
    onRefused(status: number): void;
}

/** A live WebSocket passthrough: bytes toward the machine, and its end. */
export interface TunnelUpgradeHandle {
    send(bytes: Uint8Array): boolean;
    end(): void;
}

interface OpenTunnel {
    tunnelId: string;
    channel: FleetLinkChannel;
    nextRequest: number;
    pending: Map<number, Pending>;
    lastUsed: number;
    unlisten: () => void;
}

/** A replica's channel of a tunnel is closed after this long without a request. */
export const FLEET_PORT_TUNNEL_CHANNEL_IDLE_MS = 2 * 60_000;

@Injectable()
export class FleetPortTunnelBridge implements FleetPortTunnelLinkPort, OnModuleDestroy {
    private readonly logger = new Logger(FleetPortTunnelBridge.name);
    private readonly tunnels = new Map<string, OpenTunnel>();
    private readonly opening = new Map<string, Promise<OpenTunnel>>();
    private readonly idleTimer: ReturnType<typeof setInterval>;

    constructor(private readonly link: FleetLinkService) {
        this.idleTimer = setInterval(() => this.closeIdle(), 30_000);
        this.idleTimer.unref?.();
    }

    onModuleDestroy(): void {
        clearInterval(this.idleTimer);
        for (const tunnelId of [...this.tunnels.keys()]) this.close(tunnelId, 'link-closed');
    }

    isConnected(nodeId: string): boolean {
        return this.link.isConnected(nodeId);
    }

    async open(input: {
        tunnelId: string;
        nodeId: string;
        port: number;
        caller: FleetPortsCaller;
    }): Promise<void> {
        await this.ensure(input.tunnelId, input.nodeId, input.port, input.caller);
    }

    close(tunnelId: string, reason: FleetPortTunnelClosedReason): void {
        const open = this.tunnels.get(tunnelId);
        if (!open) return;
        this.tunnels.delete(tunnelId);
        open.unlisten();
        this.failAll(open, 'unreachable', `the preview ended (${reason})`);
        if (!open.channel.isClosed) {
            try {
                open.channel.close('normal', reason);
            } catch {
                // already gone
            }
        }
    }

    /** Forward one request over this replica's channel of the tunnel. Resolves once the request is sent. */
    async forward(request: TunnelForwardRequest, callbacks: TunnelForwardCallbacks): Promise<void> {
        let open: OpenTunnel;
        try {
            open = await this.ensure(
                request.tunnel.id,
                request.tunnel.nodeId,
                request.tunnel.port,
                {
                    kind: 'user',
                    userId: request.tunnel.ownerUserId,
                },
            );
        } catch (error) {
            const hint =
                error instanceof FleetPortsException
                    ? error.portsError.hint
                    : error instanceof Error
                      ? error.message
                      : 'the computer could not be reached';
            callbacks.onError('unreachable', hint);
            return;
        }
        if (open.pending.size >= FLEET_PORT_TUNNEL_MAX_INFLIGHT) {
            callbacks.onError(
                'busy',
                'too many requests are in flight on this preview — try again',
            );
            return;
        }
        const requestId = open.nextRequest;
        open.nextRequest = (open.nextRequest + 1) >>> 0;
        open.lastUsed = Date.now();
        const pending: Pending = {
            ...callbacks,
            responded: false,
            timer: setTimeout(() => {
                const entry = open.pending.get(requestId);
                if (!entry) return;
                open.pending.delete(requestId);
                if (!entry.responded)
                    entry.onError('timeout', 'the computer did not answer within 60 s');
                else entry.onEnd();
            }, FLEET_PORT_TUNNEL_REQUEST_TIMEOUT_MS),
        };
        open.pending.set(requestId, pending);
        const sent = open.channel.sendJson({
            type: 'tunnel.request',
            requestId: String(requestId),
            method: request.method,
            path: request.path,
            query: request.query,
            headers: request.headers,
        });
        if (!sent) {
            this.settle(open, requestId, () =>
                callbacks.onError('unreachable', 'the request could not be sent'),
            );
            return;
        }
        try {
            for await (const raw of request.body) {
                const chunk = typeof raw === 'string' ? Buffer.from(raw) : Buffer.from(raw);
                for (
                    let offset = 0;
                    offset < chunk.length;
                    offset += FLEET_PORT_TUNNEL_CHUNK_BYTES
                ) {
                    const piece = chunk.subarray(offset, offset + FLEET_PORT_TUNNEL_CHUNK_BYTES);
                    if (
                        !open.channel.sendBinary(
                            FLEET_LINK_FRAME_KINDS.DATA,
                            encodeFleetPortTunnelChunk(requestId, piece),
                        )
                    ) {
                        throw new Error('the request body could not be sent');
                    }
                }
            }
            open.channel.sendBinary(
                FLEET_LINK_FRAME_KINDS.END,
                encodeFleetPortTunnelChunk(requestId),
            );
        } catch (error) {
            this.settle(open, requestId, () =>
                callbacks.onError(
                    'unreachable',
                    error instanceof Error ? error.message : 'the body could not be sent',
                ),
            );
        }
    }

    /**
     * Phase 3 (FR-32) — pass one WebSocket upgrade through: `tunnel.ws-open`
     * with the browser's handshake headers; once the node says the loopback
     * server switched protocols (`onAccept`), raw bytes flow both ways (`onData`
     * toward the browser, the handle's `send` toward the machine) until either
     * side ends. Counts toward the 32 in flight; no 60 s cap once accepted (the
     * tunnel's own idle / hard caps close it).
     */
    async upgrade(
        request: Omit<TunnelForwardRequest, 'method' | 'body'>,
        callbacks: TunnelForwardCallbacks & TunnelUpgradeCallbacks,
    ): Promise<TunnelUpgradeHandle | null> {
        let open: OpenTunnel;
        try {
            open = await this.ensure(
                request.tunnel.id,
                request.tunnel.nodeId,
                request.tunnel.port,
                {
                    kind: 'user',
                    userId: request.tunnel.ownerUserId,
                },
            );
        } catch (error) {
            callbacks.onError(
                'unreachable',
                error instanceof FleetPortsException
                    ? error.portsError.hint
                    : error instanceof Error
                      ? error.message
                      : 'the computer could not be reached',
            );
            return null;
        }
        if (open.pending.size >= FLEET_PORT_TUNNEL_MAX_INFLIGHT) {
            callbacks.onError(
                'busy',
                'too many requests are in flight on this preview — try again',
            );
            return null;
        }
        const requestId = open.nextRequest;
        open.nextRequest = (open.nextRequest + 1) >>> 0;
        open.lastUsed = Date.now();
        const pending: Pending = {
            ...callbacks,
            upgrade: { onAccept: callbacks.onAccept, onRefused: callbacks.onRefused },
            responded: false,
            timer: setTimeout(() => {
                const entry = open.pending.get(requestId);
                if (!entry || entry.responded) return;
                open.pending.delete(requestId);
                entry.onError('timeout', 'the computer did not accept the WebSocket within 60 s');
            }, FLEET_PORT_TUNNEL_REQUEST_TIMEOUT_MS),
        };
        open.pending.set(requestId, pending);
        if (
            !open.channel.sendJson({
                type: 'tunnel.ws-open',
                requestId: String(requestId),
                path: request.path,
                query: request.query,
                headers: request.headers,
            })
        ) {
            this.settle(open, requestId, () =>
                callbacks.onError('unreachable', 'the request could not be sent'),
            );
            return null;
        }
        return {
            send: (bytes) => {
                if (!open.pending.has(requestId)) return false;
                open.lastUsed = Date.now();
                return open.channel.sendBinary(
                    FLEET_LINK_FRAME_KINDS.DATA,
                    encodeFleetPortTunnelChunk(requestId, bytes),
                );
            },
            end: () => {
                if (!open.pending.has(requestId)) return;
                open.channel.sendBinary(
                    FLEET_LINK_FRAME_KINDS.END,
                    encodeFleetPortTunnelChunk(requestId),
                );
                this.settle(open, requestId, () => undefined);
            },
        };
    }

    // ─── Internals ─────────────────────────────────────────────────────────

    private async ensure(
        tunnelId: string,
        nodeId: string,
        port: number,
        caller: FleetPortsCaller,
    ): Promise<OpenTunnel> {
        const existing = this.tunnels.get(tunnelId);
        if (existing && !existing.channel.isClosed) return existing;
        const inFlight = this.opening.get(tunnelId);
        if (inFlight) return inFlight;
        const opening = (async () => {
            let channel: FleetLinkChannel;
            try {
                channel = await this.link.openChannel({
                    nodeId,
                    family: 'tunnel',
                    params: { tunnelId, port },
                    caller,
                    requirement: {
                        actionFamily: 'ports',
                        stateChanging: false,
                        target: `:${port}`,
                    },
                });
            } catch (error) {
                if (error instanceof FleetLinkException)
                    throw new FleetPortsException(error.linkError);
                throw error;
            }
            const open: OpenTunnel = {
                tunnelId,
                channel,
                nextRequest: 1,
                pending: new Map(),
                lastUsed: Date.now(),
                unlisten: () => undefined,
            };
            open.unlisten = channel.listen({
                json: (message) => this.onJson(open, message),
                binary: (kind, payload) => this.onBinary(open, kind, payload),
                close: (reason, hint) => this.onClosed(open, reason, hint),
            });
            this.tunnels.set(tunnelId, open);
            return open;
        })();
        this.opening.set(tunnelId, opening);
        try {
            return await opening;
        } finally {
            this.opening.delete(tunnelId);
        }
    }

    private onJson(open: OpenTunnel, message: Record<string, unknown>): void {
        const requestId = Number(message.requestId);
        const entry = open.pending.get(requestId);
        if (!entry) return;
        if (message.type === 'tunnel.response') {
            const status = typeof message.status === 'number' ? message.status : 502;
            const headers =
                typeof message.headers === 'object' && message.headers !== null
                    ? (message.headers as Record<string, string | string[]>)
                    : {};
            entry.responded = true;
            entry.onResponse(status >= 100 && status <= 599 ? status : 502, headers);
        } else if (message.type === 'tunnel.ws-accept' && entry.upgrade) {
            const headers =
                typeof message.headers === 'object' && message.headers !== null
                    ? (message.headers as Record<string, string | string[]>)
                    : {};
            entry.responded = true;
            clearTimeout(entry.timer);
            entry.upgrade.onAccept(
                typeof message.status === 'number' ? message.status : 101,
                headers,
            );
        } else if (message.type === 'tunnel.ws-refused' && entry.upgrade) {
            const upgrade = entry.upgrade;
            const status = typeof message.status === 'number' ? message.status : 502;
            this.settle(open, requestId, () => upgrade.onRefused(status));
        } else if (message.type === 'tunnel.error') {
            const code =
                message.code === 'timeout' || message.code === 'invalid'
                    ? message.code
                    : 'unreachable';
            const hint =
                typeof message.hint === 'string'
                    ? message.hint.slice(0, 300)
                    : 'the request failed';
            this.settle(open, requestId, () => entry.onError(code, hint));
        }
    }

    private onBinary(open: OpenTunnel, kind: FleetLinkFrameKind, payload: Uint8Array): void {
        const chunk = decodeFleetPortTunnelChunk(payload);
        if (!chunk) return;
        const entry = open.pending.get(chunk.request);
        if (!entry) return;
        open.lastUsed = Date.now();
        if (kind === FLEET_LINK_FRAME_KINDS.DATA) {
            if (chunk.bytes.byteLength > 0) entry.onData(chunk.bytes);
        } else if (kind === FLEET_LINK_FRAME_KINDS.END) {
            this.settle(open, chunk.request, () => entry.onEnd());
        }
    }

    private onClosed(open: OpenTunnel, reason: FleetLinkCloseReason, hint?: string): void {
        if (this.tunnels.get(open.tunnelId) === open) this.tunnels.delete(open.tunnelId);
        open.unlisten();
        this.failAll(open, 'unreachable', hint ?? `the computer closed the preview (${reason})`);
    }

    private settle(open: OpenTunnel, requestId: number, then: () => void): void {
        const entry = open.pending.get(requestId);
        if (!entry) return;
        clearTimeout(entry.timer);
        open.pending.delete(requestId);
        try {
            then();
        } catch (error) {
            this.logger.debug(
                `tunnel ${open.tunnelId} request ${requestId}: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    private failAll(open: OpenTunnel, code: 'unreachable', hint: string): void {
        for (const requestId of [...open.pending.keys()]) {
            const entry = open.pending.get(requestId)!;
            this.settle(open, requestId, () =>
                entry.responded ? entry.onEnd() : entry.onError(code, hint),
            );
        }
    }

    private closeIdle(): void {
        const cutoff = Date.now() - FLEET_PORT_TUNNEL_CHANNEL_IDLE_MS;
        for (const open of [...this.tunnels.values()]) {
            if (open.pending.size === 0 && open.lastUsed < cutoff)
                this.close(open.tunnelId, 'idle');
        }
    }
}
