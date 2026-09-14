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
    isComputerInputFrame,
    makeComputerErrorFrame,
} from '@ever-works/contracts';
import { ComputerControlArbiter, ComputerSessionService } from '@ever-works/agent/computer';
import { config } from '@ever-works/agent/config';
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
 *  - With `FLEET_ENABLED=false` every live-view upgrade is refused, and an
 *    already-open socket cannot authenticate: the gateway goes dark with
 *    the REST surface, whatever token a client still holds.
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
 *
 * Taking control (with the control arbiter wired):
 *
 *  - a `driver` socket's input reaches the relay, which forwards it only while
 *    the view holds control; accepted input pushes the idle deadline (written
 *    at most every {@link INPUT_WRITE_INTERVAL_MS}), and refused input makes
 *    the gateway re-read the hold (at most every
 *    {@link HOLD_REFRESH_INTERVAL_MS}) so a hold granted on another replica
 *    starts working without a reconnect;
 *  - a `driver` socket answering its heartbeat acknowledges the hold;
 *  - when the last `driver` socket of the holding view goes away, control is
 *    given back after the disconnect grace (30 s) unless one returns.
 */
const INPUT_WRITE_INTERVAL_MS = 5_000;
const HOLD_REFRESH_INTERVAL_MS = 1_000;
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
    private readonly disconnectTimers = new Map<string, NodeJS.Timeout>();
    /** Per view: when input was last written, and when the hold was last re-read. */
    private readonly controlWrites = new Map<string, { inputAt: number; refreshAt: number }>();
    private upgradeHandler: ((req: IncomingMessage, socket: Duplex, head: Buffer) => void) | null =
        null;

    constructor(
        private readonly adapterHost: HttpAdapterHost,
        private readonly attach: ComputerAttachService,
        private readonly registry: ComputerRelayRegistry,
        // Appended LAST + @Optional(): without the session service the
        // gateway still relays; it just cannot end a view nobody watches.
        @Optional() private readonly sessions?: ComputerSessionService,
        // Appended LAST + @Optional(): without the arbiter nobody can hold
        // control, so there is no hold to renew, refresh or release here.
        @Optional() private readonly control?: ComputerControlArbiter,
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
        for (const timer of this.disconnectTimers.values()) clearTimeout(timer);
        this.disconnectTimers.clear();
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
        if (!config.fleet.isEnabled()) {
            // `FLEET_ENABLED=false` takes the whole live-view surface dark,
            // this socket included — refused before any token is looked at,
            // like the REST routes' `FleetEnabledGuard`. Read per upgrade,
            // like that guard, so flipping the flag needs no restart.
            socket.destroy();
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
            if (state.authenticated && state.role === 'driver') {
                this.runControl(state.sessionId, 'acknowledge', (control) =>
                    control.acknowledge(state.sessionId),
                );
            }
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
                if (!config.fleet.isEnabled()) {
                    // Switched off after the upgrade: an unexpired token buys nothing.
                    this.safeClose(ws, 4001, 'unavailable');
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
                if (claims.role === 'driver') {
                    this.cancelDisconnect(state.sessionId);
                    this.refreshHold(state.sessionId, true);
                }
                this.registry.attach(state.sessionId, {
                    id: state.clientId,
                    role: claims.role,
                    send: (wire) => {
                        if (ws.readyState !== ws.OPEN) throw new Error('socket not open');
                        ws.send(wire);
                    },
                });
                if (claims.role === 'worker' && this.registry.getControl(state.sessionId)?.held) {
                    // The machine's leg rejoined a view this replica believes is
                    // held: its replay told it what this replica last heard, so
                    // confirm the hold with the arbiter (renewed elsewhere →
                    // `controlling` again; ran out → released and `watching`).
                    this.refreshHold(state.sessionId, true, false);
                }
                return;
            }

            if (frame.kind === 'auth') return;
            if (!isComputerClientToServerFrame(frame)) {
                this.answer(ws, 'protocol: frame kind not accepted on this leg');
                return;
            }
            const delivered = this.registry.deliverInbound(state.sessionId, state.clientId, frame);
            if (state.role === 'driver' && isComputerInputFrame(frame)) {
                if (delivered) this.recordInput(state.sessionId);
                else this.refreshHold(state.sessionId);
            }
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
        if (state.role === 'driver') this.scheduleDisconnect(state.sessionId);
    }

    /** The holding view's last driving socket left: give control back after the grace unless one returns. */
    private scheduleDisconnect(sessionId: string): void {
        if (!this.control || this.hasDriver(sessionId) || this.disconnectTimers.has(sessionId)) {
            return;
        }
        if (!this.registry.getControl(sessionId)?.held) return;
        const timer = setTimeout(() => {
            this.disconnectTimers.delete(sessionId);
            if (this.hasDriver(sessionId)) return;
            this.runControl(sessionId, 'disconnect release', (control) =>
                control.releaseForSession(sessionId, 'disconnected'),
            );
        }, this.control.limits().disconnectMs);
        timer.unref?.();
        this.disconnectTimers.set(sessionId, timer);
    }

    private cancelDisconnect(sessionId: string): void {
        const timer = this.disconnectTimers.get(sessionId);
        if (timer) {
            clearTimeout(timer);
            this.disconnectTimers.delete(sessionId);
        }
    }

    private hasDriver(sessionId: string): boolean {
        for (const state of this.states.values()) {
            if (state.authenticated && state.role === 'driver' && state.sessionId === sessionId) {
                return true;
            }
        }
        return false;
    }

    /** Accepted input: push the idle deadline, at most every few seconds per view. */
    private recordInput(sessionId: string): void {
        if (!this.control) return;
        const writes = this.writesFor(sessionId);
        const now = Date.now();
        if (now - writes.inputAt < INPUT_WRITE_INTERVAL_MS) return;
        writes.inputAt = now;
        this.runControl(sessionId, 'input', async (control) => {
            this.registry.applyControl(sessionId, await control.recordInput(sessionId));
            this.scheduleDisconnect(sessionId);
        });
    }

    /**
     * Re-read this view's hold from the arbiter into the relay (throttled
     * unless `force`). `fromDriver`: a driving socket on this replica asked
     * for it — if that socket left while the read was in flight, its close
     * found no hold here to give back, so the disconnect grace starts now.
     */
    private refreshHold(sessionId: string, force = false, fromDriver = true): void {
        if (!this.control) return;
        const writes = this.writesFor(sessionId);
        const now = Date.now();
        if (!force && now - writes.refreshAt < HOLD_REFRESH_INTERVAL_MS) return;
        writes.refreshAt = now;
        this.runControl(sessionId, 'hold refresh', async (control) => {
            this.registry.applyControl(sessionId, await control.holdOf(sessionId));
            if (fromDriver) this.scheduleDisconnect(sessionId);
        });
    }

    private writesFor(sessionId: string): { inputAt: number; refreshAt: number } {
        let writes = this.controlWrites.get(sessionId);
        if (!writes) {
            writes = { inputAt: 0, refreshAt: 0 };
            this.controlWrites.set(sessionId, writes);
            if (this.controlWrites.size > 10_000) {
                const oldest = this.controlWrites.keys().next().value;
                if (oldest !== undefined) this.controlWrites.delete(oldest);
            }
        }
        return writes;
    }

    /** Fire-and-log: a control write from a socket event must never throw into the socket. */
    private runControl(
        sessionId: string,
        what: string,
        work: (control: ComputerControlArbiter) => Promise<unknown>,
    ): void {
        const control = this.control;
        if (!control) return;
        void work(control).catch((error: unknown) =>
            this.logger.warn(
                `computer session ${sessionId}: control ${what} failed: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            ),
        );
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
