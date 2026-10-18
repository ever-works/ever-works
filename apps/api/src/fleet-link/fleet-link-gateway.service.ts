import {
    Injectable,
    Logger,
    OnApplicationBootstrap,
    OnApplicationShutdown,
    Optional,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { Duplex } from 'stream';
import type { IncomingMessage } from 'http';
import { WebSocketServer, type WebSocket } from 'ws';
import { config } from '@ever-works/agent/config';
import {
    FleetAuditService,
    FleetKillSwitchService,
    FleetNodeRepository,
} from '@ever-works/agent/fleet';
import {
    decodeFleetLinkControl,
    decodeFleetLinkFrame,
    FLEET_LINK_AUTH_TIMEOUT_MS,
    FLEET_LINK_CLOSE_CODES,
    FLEET_LINK_FRAME_KINDS,
    FLEET_LINK_HELLO_BLOCK_MS,
    FLEET_LINK_HELLO_RATE_LIMIT,
    FLEET_LINK_HELLO_RATE_WINDOW_MS,
    FLEET_LINK_KILL_SWITCH_POLL_MS,
    FLEET_LINK_FRAME_HEADER_BYTES,
    FLEET_LINK_MAX_FRAME_BYTES,
    FLEET_LINK_MAX_JSON_BYTES,
    FLEET_LINK_SILENCE_MS,
    FLEET_LINK_VERSION,
    FLEET_LINK_WS_PATH,
    FLEET_WS_PATH_PREFIX,
    isFleetLinkEligible,
    peekFleetLinkFrameChannel,
    type FleetLinkFrame,
    type FleetLinkHello,
} from '@ever-works/contracts';
import {
    FleetLinkRegistry,
    type FleetLinkSession,
    type FleetLinkSocketPort,
} from './fleet-link.registry';
import { FleetLinkTokenService } from './fleet-link-token.service';

/**
 * Fleet node link — the WebSocket gateway on `/ws/fleet/link` (FL-02,
 * CONTRACTS §3.1).
 *
 * The computer and terminal gateways' handshake on its own path of the same
 * HTTP server: raw `ws` with `noServer`, no socket.io, the token in the FIRST
 * frame and never in the URL. It is the only gateway a NODE connects to; it
 * never dials anything.
 *
 *  - With `FLEET_ENABLED=false` or `FLEET_NODE_LINK_ENABLED` off every upgrade
 *    is refused, and links already open close `4003`.
 *  - A query string on any `/ws/fleet/` upgrade is refused outright.
 *  - The first frame must be `link.hello` on channel 0 within
 *    {@link FLEET_LINK_AUTH_TIMEOUT_MS}; its token must be a valid, unused
 *    link token for the node it names, and the node must exist and not be
 *    still enrolling (a re-keyed node is). Every one of those refusals is the
 *    SAME close, `4001`. A DISABLED node keeps its link: disabling drains
 *    work, it does not sever the machine — it keeps heartbeating "so it
 *    remains observable" (`FleetService.setDisabledForUser`), and drain-all
 *    (which disables) warns owner sessions over this very link.
 *  - A node removed or re-keyed loses its link: at once from the fleet
 *    controller (`FLEET_LINK_NODE_LIFECYCLE`), and on the next re-read of the
 *    connected nodes' rows (every {@link FLEET_LINK_NODE_SWEEP_MS}) for any
 *    other path.
 *  - A node presenting more than {@link FLEET_LINK_HELLO_RATE_LIMIT} accepted
 *    hellos a minute is refused `4008` for a minute (spec U9).
 *  - A node presenting no consent that opens a link is refused `4012`.
 *  - 45 s without a frame closes the link `4002`; the node pings every 15 s.
 *  - A frame over 16 MiB closes only the channel it was aimed at (spec U5).
 *  - While the fleet kill switch is on, every link is told `link.pause`
 *    (polled every {@link FLEET_LINK_KILL_SWITCH_POLL_MS}); clearing it sends
 *    `link.resume` without a reconnect (spec FR-26).
 *
 * It owns the `/ws/fleet/` prefix on the shared `upgrade` event (the terminal
 * gateway leaves it alone): a fleet path it does not serve is destroyed here.
 * Frames are never logged.
 */

/** ws refuses (1009) anything this far over the frame cap; between the two the link stays up. */
const WS_MAX_PAYLOAD_BYTES = FLEET_LINK_MAX_FRAME_BYTES + 1024 * 1024;
/** A link whose outgoing buffer passes this is not sent more until it drains. */
const SEND_BUFFER_CAP_BYTES = 32 * 1024 * 1024;
/** The largest frame an unauthenticated socket may send: one hello. */
const PRE_AUTH_MAX_FRAME_BYTES = FLEET_LINK_FRAME_HEADER_BYTES + FLEET_LINK_MAX_JSON_BYTES;
/** How often the rows of the connected nodes are re-read (removed / re-keyed elsewhere). */
export const FLEET_LINK_NODE_SWEEP_MS = 30_000;

interface SocketState {
    session: FleetLinkSession | null;
    authenticating: boolean;
    nodeId: string | null;
    ownerUserId: string | null;
}

/** The serving half another fleet socket gateway plugs into the same prefix (the viewer bridge). */
export interface FleetWsPathHandler {
    /** True when this handler serves `path` (already query-free and under `/ws/fleet/`). */
    claims(path: string): boolean;
    handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, path: string): void;
}

@Injectable()
export class FleetLinkGatewayService implements OnApplicationBootstrap, OnApplicationShutdown {
    private readonly logger = new Logger(FleetLinkGatewayService.name);
    private wss: WebSocketServer | null = null;
    private ticker: NodeJS.Timeout | null = null;
    private polling = false;
    private sweeping = false;
    private lastSweepAt = 0;
    private readonly states = new Map<WebSocket, SocketState>();
    private readonly hellos = new Map<string, number[]>();
    private readonly blockedUntil = new Map<string, number>();
    private readonly pathHandlers: FleetWsPathHandler[] = [];
    private upgradeHandler: ((req: IncomingMessage, socket: Duplex, head: Buffer) => void) | null =
        null;

    constructor(
        private readonly adapterHost: HttpAdapterHost,
        private readonly tokens: FleetLinkTokenService,
        private readonly registry: FleetLinkRegistry,
        private readonly nodes: FleetNodeRepository,
        private readonly killSwitch: FleetKillSwitchService,
        @Optional() private readonly audit?: FleetAuditService,
    ) {}

    onApplicationBootstrap(): void {
        const httpServer = this.adapterHost.httpAdapter?.getHttpServer?.();
        if (!httpServer || typeof httpServer.on !== 'function') {
            this.logger.warn('No HTTP server available — fleet link gateway not mounted.');
            return;
        }
        this.wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD_BYTES });
        this.upgradeHandler = (req, socket, head) => this.handleUpgrade(req, socket, head);
        httpServer.on('upgrade', this.upgradeHandler);
        this.ticker = setInterval(() => void this.tick(), FLEET_LINK_KILL_SWITCH_POLL_MS);
        this.ticker.unref?.();
        this.logger.log(`Fleet link gateway mounted at ${FLEET_LINK_WS_PATH}`);
    }

    onApplicationShutdown(): void {
        if (this.ticker) clearInterval(this.ticker);
        const httpServer = this.adapterHost.httpAdapter?.getHttpServer?.();
        if (httpServer && this.upgradeHandler) httpServer.off?.('upgrade', this.upgradeHandler);
        this.registry.closeAll(FLEET_LINK_CLOSE_CODES.shutdown, 'server shutting down');
        for (const ws of this.states.keys())
            this.safeClose(ws, FLEET_LINK_CLOSE_CODES.shutdown, 'server shutting down');
        this.states.clear();
        this.wss?.close();
    }

    /** Another `/ws/fleet/` gateway (the viewer bridge) registers the paths it serves. */
    registerPathHandler(handler: FleetWsPathHandler): void {
        this.pathHandlers.push(handler);
    }

    /** Exposed for the spec: decide what to do with one upgrade request. */
    handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
        const rawUrl = req.url ?? '';
        if (!rawUrl.startsWith(FLEET_WS_PATH_PREFIX)) return; // another gateway's
        if (!config.fleet.isEnabled() || !config.fleet.isNodeLinkEnabled()) {
            socket.destroy();
            return;
        }
        if (rawUrl.includes('?')) {
            // Tokens ride the first frame; a query string is a mistake or an
            // attempt to put a credential in an access log.
            socket.destroy();
            return;
        }
        if (rawUrl !== FLEET_LINK_WS_PATH) {
            const handler = this.pathHandlers.find((candidate) => candidate.claims(rawUrl));
            if (handler) handler.handleUpgrade(req, socket, head, rawUrl);
            else socket.destroy();
            return;
        }
        if (!this.wss) {
            socket.destroy();
            return;
        }
        this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws));
    }

    /** Exposed for the spec. */
    onConnection(ws: WebSocket): void {
        const state: SocketState = {
            session: null,
            authenticating: false,
            nodeId: null,
            ownerUserId: null,
        };
        this.states.set(ws, state);
        const authTimer = setTimeout(() => {
            if (!state.session) this.safeClose(ws, FLEET_LINK_CLOSE_CODES.auth, 'auth timeout');
        }, FLEET_LINK_AUTH_TIMEOUT_MS);
        authTimer.unref?.();

        ws.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
            const bytes = toBytes(data);
            if (!isBinary) {
                // The link is binary-only; text before auth is an auth failure.
                if (!state.session)
                    this.safeClose(ws, FLEET_LINK_CLOSE_CODES.auth, 'auth required');
                return;
            }
            if (!state.session && bytes.byteLength > PRE_AUTH_MAX_FRAME_BYTES) {
                // Before auth only a hello is expected, and a hello is small.
                this.safeClose(ws, FLEET_LINK_CLOSE_CODES.auth, 'auth required');
                return;
            }
            if (bytes.byteLength > FLEET_LINK_MAX_FRAME_BYTES) {
                state.session?.refuseOversized(peekFleetLinkFrameChannel(bytes));
                return;
            }
            const frame = decodeFleetLinkFrame(bytes);
            if (state.session) {
                if (frame) state.session.receive(frame);
                return;
            }
            if (state.authenticating) return; // one hello per socket
            state.authenticating = true;
            void this.authenticate(ws, state, frame).finally(() => clearTimeout(authTimer));
        });

        ws.on('close', (code: number) => {
            clearTimeout(authTimer);
            this.states.delete(ws);
            this.endSession(state, `closed ${code}`, code);
        });

        ws.on('error', (error) => {
            this.logger.debug(`fleet link socket error: ${error.message}`);
        });
    }

    /** Poll once: feature flags, silence, kill switch. Exposed for the spec. */
    async tick(now: number = Date.now()): Promise<void> {
        if (!config.fleet.isEnabled() || !config.fleet.isNodeLinkEnabled()) {
            if (this.registry.connectedNodeIds().length > 0) {
                this.registry.closeAll(FLEET_LINK_CLOSE_CODES.disabled, 'node links switched off');
            }
            return;
        }
        for (const [ws, state] of this.states) {
            if (state.session && now - state.session.lastFrameAt() >= FLEET_LINK_SILENCE_MS) {
                // A dead peer may never complete a close handshake: the link is
                // dropped NOW, and the socket terminated.
                this.endSession(state, 'silence', FLEET_LINK_CLOSE_CODES.silence);
                this.safeClose(ws, FLEET_LINK_CLOSE_CODES.silence, 'silence', true);
            }
        }
        if (now - this.lastSweepAt >= FLEET_LINK_NODE_SWEEP_MS) {
            this.lastSweepAt = now;
            void this.sweepNodes();
        }
        if (this.polling || this.registry.connectedNodeIds().length === 0) return;
        this.polling = true;
        try {
            let stopped: boolean;
            try {
                stopped = await this.killSwitch.isStopped();
            } catch {
                stopped = true; // fail-closed, like every other reader
            }
            this.registry.setPaused(stopped);
        } finally {
            this.polling = false;
        }
    }

    /**
     * Re-read the rows of every connected node: a node whose row is gone
     * (deleted, unenrolled) or back to `enrolling` (an owner re-key) loses its
     * link `4001`. A failed read closes nothing. Exposed for the spec.
     */
    async sweepNodes(): Promise<number> {
        const ids = this.registry.connectedNodeIds();
        if (this.sweeping || ids.length === 0) return 0;
        this.sweeping = true;
        try {
            let rows: Array<{ id: string; status: string }>;
            try {
                rows = await this.nodes.findStatusesByIds(ids);
            } catch (error) {
                this.logger.debug(
                    `fleet link node sweep skipped: ${error instanceof Error ? error.message : String(error)}`,
                );
                return 0;
            }
            const statuses = new Map(rows.map((row) => [row.id, row.status]));
            let closed = 0;
            for (const id of ids) {
                const status = statuses.get(id);
                if (status !== undefined && status !== 'enrolling') continue;
                this.registry.closeNode(
                    id,
                    FLEET_LINK_CLOSE_CODES.auth,
                    status === undefined ? 'node removed' : 'credential replaced',
                );
                closed += 1;
            }
            return closed;
        } finally {
            this.sweeping = false;
        }
    }

    private async authenticate(
        ws: WebSocket,
        state: SocketState,
        frame: FleetLinkFrame | null,
    ): Promise<void> {
        const hello = helloOf(frame);
        if (!hello) {
            this.safeClose(ws, FLEET_LINK_CLOSE_CODES.auth, 'auth required');
            return;
        }
        if (!config.fleet.isEnabled() || !config.fleet.isNodeLinkEnabled()) {
            this.safeClose(ws, FLEET_LINK_CLOSE_CODES.disabled, 'node links are not accepted');
            return;
        }
        if (hello.linkVersion !== FLEET_LINK_VERSION) {
            this.safeClose(ws, FLEET_LINK_CLOSE_CODES.protocol, 'unsupported link version');
            return;
        }
        let accepted = false;
        try {
            accepted = await this.tokens.consume(hello.token, hello.nodeId);
        } catch {
            accepted = false;
        }
        const node = accepted ? await this.nodes.findById(hello.nodeId).catch(() => null) : null;
        if (!node || node.status === 'enrolling') {
            this.safeClose(ws, FLEET_LINK_CLOSE_CODES.auth, 'invalid link token');
            return;
        }
        if (!this.admitHello(node.id, Date.now())) {
            this.safeClose(ws, FLEET_LINK_CLOSE_CODES.rateLimited, 'too many hellos');
            return;
        }
        if (!isFleetLinkEligible(hello.consents)) {
            this.safeClose(ws, FLEET_LINK_CLOSE_CODES.noConsent, 'no consent opens a link');
            return;
        }
        if (ws.readyState !== ws.OPEN) return;
        const port: FleetLinkSocketPort = {
            send: (bytes) => {
                if (ws.readyState !== ws.OPEN || ws.bufferedAmount > SEND_BUFFER_CAP_BYTES)
                    return false;
                ws.send(bytes, { binary: true });
                return true;
            },
            close: (code, reason) => this.safeClose(ws, code, reason),
        };
        const session = this.registry.accept({
            nodeId: node.id,
            ownerUserId: node.userId,
            nodeName: node.name,
            nodeKind: node.kind,
            hello,
            socket: port,
        });
        state.session = session;
        state.nodeId = node.id;
        state.ownerUserId = node.userId;
        void this.auditLink('node.link.connect', state, {
            linkGeneration: session.linkGeneration,
            resumed: session.ready.resumed.length,
            consents: { ...hello.consents },
        });
    }

    /** The link of this socket is over: tell the registry once, and audit it. */
    private endSession(state: SocketState, reason: string, code: number): void {
        if (!state.session) return;
        const session = state.session;
        state.session = null;
        session.dropped(reason);
        void this.auditLink('node.link.disconnect', state, {
            linkGeneration: session.linkGeneration,
            code,
            reason,
        });
    }

    /** Count an accepted hello; false when the node is over its rate (and now blocked for a minute). */
    private admitHello(nodeId: string, now: number): boolean {
        const blocked = this.blockedUntil.get(nodeId);
        if (blocked !== undefined && blocked > now) return false;
        const recent = (this.hellos.get(nodeId) ?? []).filter(
            (at) => now - at < FLEET_LINK_HELLO_RATE_WINDOW_MS,
        );
        recent.push(now);
        this.hellos.set(nodeId, recent);
        if (recent.length > FLEET_LINK_HELLO_RATE_LIMIT) {
            this.blockedUntil.set(nodeId, now + FLEET_LINK_HELLO_BLOCK_MS);
            this.hellos.delete(nodeId);
            this.logger.warn(
                `node ${nodeId} presented more than ${FLEET_LINK_HELLO_RATE_LIMIT} hellos a minute; refused for 60 s`,
            );
            return false;
        }
        if (this.hellos.size > 10_000) {
            for (const [id, times] of this.hellos)
                if (times.every((at) => now - at >= FLEET_LINK_HELLO_RATE_WINDOW_MS))
                    this.hellos.delete(id);
        }
        return true;
    }

    private async auditLink(
        action: 'node.link.connect' | 'node.link.disconnect',
        state: SocketState,
        details: Record<string, unknown>,
    ): Promise<void> {
        if (!this.audit || !state.nodeId) return;
        await this.audit.tryRecord({
            action,
            actorUserId: null,
            ownerUserId: state.ownerUserId,
            nodeId: state.nodeId,
            details,
        });
    }

    private safeClose(ws: WebSocket, code: number, reason: string, terminate = false): void {
        try {
            if (terminate) {
                ws.close(code, reason);
                ws.terminate();
            } else {
                ws.close(code, reason);
            }
        } catch {
            try {
                ws.terminate();
            } catch {
                // already gone
            }
        }
    }
}

function toBytes(data: Buffer | ArrayBuffer | Buffer[]): Uint8Array {
    if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function helloOf(frame: FleetLinkFrame | null): FleetLinkHello | null {
    if (!frame || frame.channel !== 0 || frame.kind !== FLEET_LINK_FRAME_KINDS.JSON) return null;
    const message = decodeFleetLinkControl(frame.payload);
    return message && message.type === 'link.hello' ? (message as FleetLinkHello) : null;
}
