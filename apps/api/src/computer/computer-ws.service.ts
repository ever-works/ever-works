import {
    Injectable,
    Logger,
    OnApplicationBootstrap,
    OnApplicationShutdown,
    Optional,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { randomUUID } from 'crypto';
import type { Duplex } from 'stream';
import type { IncomingMessage } from 'http';
import { WebSocketServer, type WebSocket } from 'ws';
import {
    decodeComputerFrame,
    encodeComputerFrame,
    isComputerClientToServerFrame,
    makeComputerErrorFrame,
} from '@ever-works/contracts';
import { ComputerSessionService } from '@ever-works/agent/computer';
import { ComputerAttachService } from './computer-attach.service';
import { ComputerRelayRegistry } from './computer-relay.registry';
import type { TerminalClientRole } from '../terminal/terminal-relay.registry';

/**
 * Agent computers — the live-view WebSocket gateway.
 *
 * The streaming terminal gateway's handshake, on its own path of the same
 * HTTP server (`/ws/computer/:sessionId`): raw `ws` with `noServer`, no
 * socket.io, the token in the FIRST frame and never in the URL.
 *
 *  - A query string on a live-view upgrade is refused outright.
 *  - An unauthenticated socket is closed `4001` after {@link AUTH_TIMEOUT_MS}.
 *  - A ping every 30 s; a socket that misses two pongs is reaped (`4002`).
 *  - After auth the socket joins the relay, and every inbound frame is
 *    decoded, direction-checked and role-checked there.
 *
 * It shares the `upgrade` event with the terminal gateway, so it ignores
 * every path that is not its own (the terminal gateway owns destroying
 * unknown paths and leaves `/ws/computer/` to this one).
 *
 * When the last browser leaves a view, the view ends after a short grace
 * (`lastViewerGraceMs`, 15 s by default) unless someone comes back — a live
 * view nobody is watching must not keep a machine publishing pictures.
 */
const AUTH_TIMEOUT_MS = 5_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_MISSED_PONGS = 2;
export const COMPUTER_WS_PATH_PREFIX = '/ws/computer/';
const WS_PATH_PATTERN =
    /^\/ws\/computer\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

interface SocketState {
    authenticated: boolean;
    sessionId: string;
    clientId: string;
    role: TerminalClientRole | null;
    missedPongs: number;
}

@Injectable()
export class ComputerWsService implements OnApplicationBootstrap, OnApplicationShutdown {
    private readonly logger = new Logger(ComputerWsService.name);
    private wss: WebSocketServer | null = null;
    private heartbeat: NodeJS.Timeout | null = null;
    private readonly states = new Map<WebSocket, SocketState>();
    private readonly viewerGraceTimers = new Map<string, NodeJS.Timeout>();
    private upgradeHandler: ((req: IncomingMessage, socket: Duplex, head: Buffer) => void) | null =
        null;

    constructor(
        private readonly adapterHost: HttpAdapterHost,
        private readonly attach: ComputerAttachService,
        private readonly registry: ComputerRelayRegistry,
        // Appended LAST + @Optional(): without the session service the
        // gateway still relays; it just cannot end a view nobody watches.
        @Optional() private readonly sessions?: ComputerSessionService,
    ) {}

    onApplicationBootstrap(): void {
        const httpServer = this.adapterHost.httpAdapter?.getHttpServer?.();
        if (!httpServer || typeof httpServer.on !== 'function') {
            this.logger.warn('No HTTP server available — computer WebSocket gateway not mounted.');
            return;
        }
        this.wss = new WebSocketServer({ noServer: true });
        this.upgradeHandler = (req, socket, head) => this.handleUpgrade(req, socket, head);
        httpServer.on('upgrade', this.upgradeHandler);
        this.heartbeat = setInterval(() => this.pingAll(), HEARTBEAT_INTERVAL_MS);
        this.heartbeat.unref?.();
        this.logger.log('Computer WebSocket gateway mounted at /ws/computer/:sessionId');
    }

    onApplicationShutdown(): void {
        if (this.heartbeat) clearInterval(this.heartbeat);
        for (const timer of this.viewerGraceTimers.values()) clearTimeout(timer);
        this.viewerGraceTimers.clear();
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

    /** Exposed for the spec: decide what to do with one upgrade request. */
    handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
        const rawUrl = req.url ?? '';
        if (!rawUrl.startsWith(COMPUTER_WS_PATH_PREFIX)) {
            // Not ours — the terminal gateway on the same server owns it.
            return;
        }
        if (rawUrl.includes('?')) {
            // The token rides the first frame. A query string here is a
            // mistake or an attempt to put a credential in an access log.
            socket.destroy();
            return;
        }
        const match = WS_PATH_PATTERN.exec(rawUrl);
        if (!match || !this.wss) {
            socket.destroy();
            return;
        }
        const sessionId = match[1].toLowerCase();
        this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, sessionId));
    }

    private onConnection(ws: WebSocket, sessionId: string): void {
        const state: SocketState = {
            authenticated: false,
            sessionId,
            clientId: `computer-ws-${randomUUID()}`,
            role: null,
            missedPongs: 0,
        };
        this.states.set(ws, state);

        const authTimer = setTimeout(() => {
            if (!state.authenticated) this.safeClose(ws, 4001, 'auth timeout');
        }, AUTH_TIMEOUT_MS);
        authTimer.unref?.();

        ws.on('pong', () => {
            state.missedPongs = 0;
        });

        ws.on('message', (data: Buffer | ArrayBuffer | Buffer[] | string) => {
            const raw =
                typeof data === 'string'
                    ? data
                    : Array.isArray(data)
                      ? new Uint8Array(Buffer.concat(data))
                      : data instanceof ArrayBuffer
                        ? new Uint8Array(data)
                        : new Uint8Array(data);
            const frame = decodeComputerFrame(raw);
            if (!frame) return;

            if (!state.authenticated) {
                if (frame.kind !== 'auth') {
                    this.safeClose(ws, 4001, 'auth required');
                    return;
                }
                const claims = this.attach.verify(frame.token);
                if (!claims || claims.sessionId !== state.sessionId) {
                    this.safeClose(ws, 4001, 'invalid attach token');
                    return;
                }
                clearTimeout(authTimer);
                state.authenticated = true;
                state.role = claims.role;
                if (claims.role !== 'worker') this.cancelViewerGrace(state.sessionId);
                this.registry.attach(state.sessionId, {
                    id: state.clientId,
                    role: claims.role,
                    send: (wire) => {
                        if (ws.readyState !== ws.OPEN) throw new Error('socket not open');
                        ws.send(wire);
                    },
                });
                return;
            }

            if (frame.kind === 'auth') return;
            if (!isComputerClientToServerFrame(frame)) {
                this.answer(ws, 'protocol: frame kind not accepted on this leg');
                return;
            }
            this.registry.deliverInbound(state.sessionId, state.clientId, frame);
        });

        ws.on('close', () => {
            clearTimeout(authTimer);
            this.release(ws);
        });

        ws.on('error', (err) => {
            this.logger.debug(`computer ws error (${state.clientId}): ${err.message}`);
        });
    }

    private release(ws: WebSocket): void {
        const state = this.states.get(ws);
        this.states.delete(ws);
        if (!state?.authenticated) return;
        this.registry.detach(state.sessionId, state.clientId);
        if (state.role !== 'worker') this.scheduleViewerGrace(state.sessionId);
    }

    /** The last browser left: end the view after the grace unless one returns. */
    private scheduleViewerGrace(sessionId: string): void {
        if (!this.sessions || this.registry.getStatus(sessionId).viewerCount > 0) return;
        if (this.viewerGraceTimers.has(sessionId)) return;
        const graceMs = this.sessions.limits().lastViewerGraceMs;
        const timer = setTimeout(() => {
            this.viewerGraceTimers.delete(sessionId);
            if (this.registry.getStatus(sessionId).viewerCount > 0) return;
            void this.sessions
                ?.closeById(sessionId, 'no-viewer')
                .catch((error: unknown) =>
                    this.logger.warn(
                        `computer session ${sessionId}: no-viewer close failed: ${
                            error instanceof Error ? error.message : String(error)
                        }`,
                    ),
                );
        }, graceMs);
        timer.unref?.();
        this.viewerGraceTimers.set(sessionId, timer);
    }

    private cancelViewerGrace(sessionId: string): void {
        const timer = this.viewerGraceTimers.get(sessionId);
        if (timer) {
            clearTimeout(timer);
            this.viewerGraceTimers.delete(sessionId);
        }
    }

    private answer(ws: WebSocket, message: string): void {
        const wire = encodeComputerFrame(makeComputerErrorFrame(message));
        if (wire && ws.readyState === ws.OPEN) {
            try {
                ws.send(wire);
            } catch {
                // the close path handles a dead socket
            }
        }
    }

    private pingAll(): void {
        for (const [ws, state] of this.states) {
            if (state.missedPongs >= MAX_MISSED_PONGS) {
                this.safeClose(ws, 4002, 'heartbeat lost');
                continue;
            }
            state.missedPongs += 1;
            try {
                ws.ping();
            } catch {
                this.safeClose(ws, 4002, 'ping failed');
            }
        }
    }

    private safeClose(ws: WebSocket, code: number, reason: string): void {
        this.release(ws);
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
