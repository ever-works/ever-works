import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { randomUUID } from 'crypto';
import type { Duplex } from 'stream';
import type { IncomingMessage } from 'http';
import { WebSocketServer, type WebSocket } from 'ws';
import {
    decodeTerminalFrame,
    encodeTerminalFrame,
    isValidTerminalRunId,
    makeTerminalErrorFrame,
} from '@ever-works/contracts';
import { TerminalAttachService } from './terminal-attach.service';
import { TerminalRelayRegistry, type TerminalClientRole } from './terminal-relay.registry';

/**
 * Terminal WebSocket gateway (streaming-terminal M3).
 *
 * Hosted directly on the API's HTTP server via the `upgrade` event —
 * a raw `ws` server (`noServer: true`), no socket.io, no extra Nest
 * transport packages. Cloud/local parity falls out for free: the same
 * process serves `wss://api.ever.works/ws/terminal/:runId` in k8s and
 * `ws://localhost:3100/ws/terminal/:runId` under `pnpm dev:api`.
 *
 * Handshake contract:
 *  - Upgrade path must match `/ws/terminal/<uuid>` (shape-gated before
 *    any registry touch); anything else → 404-style socket destroy.
 *  - The FIRST message MUST be an `auth` frame carrying a valid attach
 *    token for THIS run (token in the body, never the URL — stays out
 *    of proxy/access logs). Unauthenticated sockets are closed with
 *    code 4001 after {@link AUTH_TIMEOUT_MS}.
 *  - After auth: the socket joins the relay (replay → live tail), and
 *    inbound frames are decoded + direction-checked; `stdin`/`resize`
 *    route through the role-checked `deliverInbound`.
 *  - Per-socket heartbeat ping every 30s — keeps Cloudflare's ~100s
 *    idle proxy timeout from reaping quiet sessions and reaps dead
 *    peers that miss two pongs.
 */
const AUTH_TIMEOUT_MS = 5_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const WS_PATH_PATTERN = /^\/ws\/terminal\/([0-9a-f-]{36})$/i;

interface SocketState {
    authenticated: boolean;
    runId: string;
    clientId: string;
    role: TerminalClientRole | null;
    alive: boolean;
}

@Injectable()
export class TerminalWsService implements OnApplicationBootstrap, OnApplicationShutdown {
    private readonly logger = new Logger(TerminalWsService.name);
    private wss: WebSocketServer | null = null;
    private heartbeat: NodeJS.Timeout | null = null;
    private readonly states = new Map<WebSocket, SocketState>();
    private upgradeHandler: ((req: IncomingMessage, socket: Duplex, head: Buffer) => void) | null =
        null;

    constructor(
        private readonly adapterHost: HttpAdapterHost,
        private readonly attach: TerminalAttachService,
        private readonly registry: TerminalRelayRegistry,
    ) {}

    onApplicationBootstrap(): void {
        const httpServer = this.adapterHost.httpAdapter?.getHttpServer?.();
        if (!httpServer || typeof httpServer.on !== 'function') {
            // Test harnesses without a real HTTP server — the REST
            // surface still works; only live attach is absent.
            this.logger.warn('No HTTP server available — terminal WebSocket gateway not mounted.');
            return;
        }
        this.wss = new WebSocketServer({ noServer: true });
        this.upgradeHandler = (req, socket, head) => this.handleUpgrade(req, socket, head);
        httpServer.on('upgrade', this.upgradeHandler);

        this.heartbeat = setInterval(() => this.pingAll(), HEARTBEAT_INTERVAL_MS);
        // Never hold the process open for the heartbeat alone.
        this.heartbeat.unref?.();
        this.logger.log('Terminal WebSocket gateway mounted at /ws/terminal/:runId');
    }

    onApplicationShutdown(): void {
        if (this.heartbeat) clearInterval(this.heartbeat);
        const httpServer = this.adapterHost.httpAdapter?.getHttpServer?.();
        if (httpServer && this.upgradeHandler) {
            httpServer.off?.('upgrade', this.upgradeHandler);
        }
        for (const ws of this.states.keys()) {
            try {
                ws.close(1001, 'server shutting down');
            } catch {
                // best-effort
            }
        }
        this.states.clear();
        this.wss?.close();
    }

    private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
        const rawUrl = req.url ?? '';
        if (rawUrl.includes('?')) {
            // Attach tokens ride the FIRST FRAME, never the URL — a query
            // string on a terminal upgrade is always a mistake or an
            // exfiltration attempt; refuse instead of ignoring it.
            socket.destroy();
            return;
        }
        const match = WS_PATH_PATTERN.exec(rawUrl);
        if (!match || !this.wss) {
            // Not ours — other upgrade listeners (none today) could still
            // claim it; destroy only if nobody else is listening.
            socket.destroy();
            return;
        }
        const runId = match[1].toLowerCase();
        if (!isValidTerminalRunId(runId)) {
            socket.destroy();
            return;
        }
        this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, runId));
    }

    private onConnection(ws: WebSocket, runId: string): void {
        const state: SocketState = {
            authenticated: false,
            runId,
            clientId: `ws-${randomUUID()}`,
            role: null,
            alive: true,
        };
        this.states.set(ws, state);

        const authTimer = setTimeout(() => {
            if (!state.authenticated) {
                this.safeClose(ws, 4001, 'auth timeout');
            }
        }, AUTH_TIMEOUT_MS);
        authTimer.unref?.();

        ws.on('pong', () => {
            state.alive = true;
        });

        ws.on('message', (data: Buffer | ArrayBuffer | Buffer[] | string) => {
            // ws.RawData is Buffer | ArrayBuffer | Buffer[] — normalize
            // every form before decoding.
            const raw =
                typeof data === 'string'
                    ? data
                    : Array.isArray(data)
                      ? new Uint8Array(Buffer.concat(data))
                      : data instanceof ArrayBuffer
                        ? new Uint8Array(data)
                        : new Uint8Array(data);
            const frame = decodeTerminalFrame(raw);
            if (!frame) {
                // Garbage is dropped silently — never throw, never echo.
                return;
            }

            if (!state.authenticated) {
                if (frame.kind !== 'auth') {
                    this.safeClose(ws, 4001, 'auth required');
                    return;
                }
                const claims = this.attach.verify(frame.token);
                if (!claims || claims.runId !== state.runId) {
                    this.safeClose(ws, 4001, 'invalid attach token');
                    return;
                }
                clearTimeout(authTimer);
                state.authenticated = true;
                state.role = claims.role;
                this.registry.attach(state.runId, {
                    id: state.clientId,
                    role: claims.role,
                    send: (wire) => {
                        // The registry drops clients whose send throws;
                        // a closed ws throws synchronously — exactly the
                        // contract it expects.
                        if (ws.readyState !== ws.OPEN) {
                            throw new Error('socket not open');
                        }
                        ws.send(wire);
                    },
                });
                return;
            }

            if (frame.kind === 'stdin' || frame.kind === 'resize') {
                const delivered = this.registry.deliverInbound(state.runId, state.clientId, frame);
                if (!delivered && state.role === 'viewer') {
                    // deliverInbound already answered the sender with the
                    // read-only error frame; nothing more to do.
                }
                return;
            }
            // Every other kind (auth re-send, server-direction kinds) is
            // dropped: an echoed replay can never re-enter as input, and
            // the registry's own guards back this up.
            if (frame.kind !== 'auth') {
                const refusal = encodeTerminalFrame(
                    makeTerminalErrorFrame('protocol: frame kind not accepted on this leg'),
                );
                if (refusal && ws.readyState === ws.OPEN) {
                    try {
                        ws.send(refusal);
                    } catch {
                        // socket died mid-answer — close path handles it
                    }
                }
            }
        });

        ws.on('close', () => {
            clearTimeout(authTimer);
            if (state.authenticated) {
                this.registry.detach(state.runId, state.clientId);
            }
            this.states.delete(ws);
        });

        ws.on('error', (err) => {
            this.logger.debug(`terminal ws error (${state.clientId}): ${err.message}`);
        });
    }

    private pingAll(): void {
        for (const [ws, state] of this.states) {
            if (!state.alive) {
                this.safeClose(ws, 4002, 'heartbeat lost');
                continue;
            }
            state.alive = false;
            try {
                ws.ping();
            } catch {
                this.safeClose(ws, 4002, 'ping failed');
            }
        }
    }

    private safeClose(ws: WebSocket, code: number, reason: string): void {
        const state = this.states.get(ws);
        if (state?.authenticated) {
            this.registry.detach(state.runId, state.clientId);
        }
        this.states.delete(ws);
        try {
            ws.close(code, reason);
        } catch {
            try {
                ws.terminate();
            } catch {
                // already gone
            }
        }
    }
}
