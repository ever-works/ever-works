import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import type { Duplex } from 'stream';
import type { IncomingMessage } from 'http';
import { WebSocketServer, type WebSocket } from 'ws';
import { config } from '@ever-works/agent/config';
import {
    FLEET_LINK_MAX_FRAME_BYTES,
    FLEET_LINK_VIEWER_AUTH_TIMEOUT_MS,
    FLEET_LINK_VIEWER_CLOSE_CODES,
    FLEET_LINK_VIEWER_PING_INTERVAL_MS,
    parseFleetLinkViewerPath,
    type FleetLinkFamily,
} from '@ever-works/contracts';
import { FleetLinkAttachService } from './fleet-link-attach.service';
import { FleetLinkException } from './fleet-link.errors';
import { FleetLinkGatewayService, type FleetWsPathHandler } from './fleet-link-gateway.service';
import { FleetLinkViewerBridge } from './fleet-link-relay';
import { FleetLinkService } from './fleet-link.service';

/**
 * The viewer gateway (FL-02, spec FR-32, FR-33): `/ws/fleet/<family>/<target>`.
 *
 * Mounted through the link gateway's `/ws/fleet/` prefix (which has already
 * refused the upgrade when node links are off, or when the URL carries a
 * query string). Then:
 *
 *  1. the first message must be text `{ "type": "auth", "token" }` within
 *     5 s, carrying an unused viewer token for exactly this path — every
 *     refusal is the same close `4001`;
 *  2. the channel is opened through `FleetLinkService.openChannel` as the
 *     token's person — so the kill switch, the consent and the family
 *     audience are checked again at open time, not only at mint time — on
 *     whichever replica holds the node's link;
 *  3. the socket is bridged to it (`FleetLinkViewerBridge`): role-checked
 *     input, re-numbered output, slow viewers dropped.
 *
 * Pings every 30 s; two unanswered close the socket `4002`.
 */

const WS_MAX_PAYLOAD_BYTES = FLEET_LINK_MAX_FRAME_BYTES + 1024 * 1024;

interface ViewerState {
    bridge: FleetLinkViewerBridge | null;
    authenticating: boolean;
    missedPongs: number;
}

@Injectable()
export class FleetLinkViewerGatewayService
    implements OnApplicationBootstrap, OnApplicationShutdown, FleetWsPathHandler
{
    private readonly logger = new Logger(FleetLinkViewerGatewayService.name);
    private wss: WebSocketServer | null = null;
    private pinger: NodeJS.Timeout | null = null;
    private readonly sockets = new Map<WebSocket, ViewerState>();

    constructor(
        private readonly gateway: FleetLinkGatewayService,
        private readonly attach: FleetLinkAttachService,
        private readonly links: FleetLinkService,
    ) {}

    onApplicationBootstrap(): void {
        this.wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD_BYTES });
        this.gateway.registerPathHandler(this);
        this.pinger = setInterval(() => this.pingAll(), FLEET_LINK_VIEWER_PING_INTERVAL_MS);
        this.pinger.unref?.();
    }

    onApplicationShutdown(): void {
        if (this.pinger) clearInterval(this.pinger);
        for (const [ws, state] of [...this.sockets]) {
            state.bridge?.viewerClosed();
            this.safeClose(ws, FLEET_LINK_VIEWER_CLOSE_CODES.shutdown, 'server shutting down');
        }
        this.sockets.clear();
        this.wss?.close();
    }

    claims(path: string): boolean {
        return parseFleetLinkViewerPath(path) !== null;
    }

    handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, path: string): void {
        const target = parseFleetLinkViewerPath(path);
        if (!this.wss || !target) {
            socket.destroy();
            return;
        }
        this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, target));
    }

    /** Exposed for the spec. */
    onConnection(ws: WebSocket, path: { family: FleetLinkFamily; target: string }): void {
        const state: ViewerState = { bridge: null, authenticating: false, missedPongs: 0 };
        this.sockets.set(ws, state);
        const authTimer = setTimeout(() => {
            if (!state.bridge)
                this.safeClose(ws, FLEET_LINK_VIEWER_CLOSE_CODES.auth, 'auth timeout');
        }, FLEET_LINK_VIEWER_AUTH_TIMEOUT_MS);
        authTimer.unref?.();

        ws.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
            if (state.bridge) {
                if (isBinary) state.bridge.fromViewer(toBytes(data));
                else
                    this.safeClose(
                        ws,
                        FLEET_LINK_VIEWER_CLOSE_CODES.protocol,
                        'binary frames only',
                    );
                return;
            }
            if (state.authenticating) return; // one auth per socket
            state.authenticating = true;
            void this.authenticate(ws, state, path, isBinary ? null : toBytes(data)).finally(() =>
                clearTimeout(authTimer),
            );
        });
        ws.on('pong', () => {
            state.missedPongs = 0;
        });
        ws.on('close', () => {
            clearTimeout(authTimer);
            this.sockets.delete(ws);
            state.bridge?.viewerClosed();
        });
        ws.on('error', (error) => {
            this.logger.debug(`fleet viewer socket error: ${error.message}`);
        });
    }

    private async authenticate(
        ws: WebSocket,
        state: ViewerState,
        path: { family: FleetLinkFamily; target: string },
        text: Uint8Array | null,
    ): Promise<void> {
        const token = authTokenOf(text);
        const claims =
            token !== null && config.fleet.isNodeLinkEnabled()
                ? await this.attach.verify(token, path).catch(() => null)
                : null;
        if (!claims) {
            this.safeClose(ws, FLEET_LINK_VIEWER_CLOSE_CODES.auth, 'auth required');
            return;
        }
        if (ws.readyState !== ws.OPEN) return;
        const bridge = new FleetLinkViewerBridge({
            socket: {
                send: (frame) => {
                    if (ws.readyState !== ws.OPEN) return false;
                    ws.send(frame, { binary: true });
                    return true;
                },
                bufferedAmount: () => ws.bufferedAmount,
                close: (code, reason) => this.safeClose(ws, code, reason),
            },
            family: claims.family,
            target: claims.target,
            role: claims.role,
        });
        state.bridge = bridge;
        // CONTRACTS §3.3: a session channel opens with the viewer's mode.
        const params =
            claims.family === 'session' ? { ...claims.params, mode: claims.role } : claims.params;
        try {
            const channel = await this.links.openChannel({
                nodeId: claims.nodeId,
                family: claims.family,
                params,
                caller: { kind: 'user', userId: claims.userId },
                requirement: FleetLinkAttachService.requirementFor(claims.role, claims.requirement),
                events: bridge.events,
            });
            bridge.attach(channel);
        } catch (error) {
            bridge.fail(
                error instanceof FleetLinkException
                    ? error.linkError
                    : { code: 'internal', hint: 'the channel could not be opened' },
            );
        }
    }

    private pingAll(): void {
        for (const [ws, state] of this.sockets) {
            state.bridge?.tick();
            if (state.missedPongs >= 2) {
                state.bridge?.viewerClosed();
                this.safeClose(ws, FLEET_LINK_VIEWER_CLOSE_CODES.silence, 'ping timeout', true);
                continue;
            }
            state.missedPongs += 1;
            try {
                ws.ping();
            } catch {
                this.safeClose(ws, FLEET_LINK_VIEWER_CLOSE_CODES.silence, 'ping failed', true);
            }
        }
    }

    private safeClose(ws: WebSocket, code: number, reason: string, terminate = false): void {
        try {
            if (terminate) ws.terminate();
            else ws.close(code, reason);
        } catch {
            // already gone
        }
    }
}

function toBytes(data: Buffer | ArrayBuffer | Buffer[]): Uint8Array {
    if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

/** The token of a text `{ "type": "auth", "token" }`, or null. */
function authTokenOf(text: Uint8Array | null): string | null {
    if (!text || text.byteLength > 4096) return null;
    try {
        const value: unknown = JSON.parse(Buffer.from(text).toString('utf8'));
        if (
            value &&
            typeof value === 'object' &&
            (value as Record<string, unknown>).type === 'auth' &&
            typeof (value as Record<string, unknown>).token === 'string'
        ) {
            return (value as { token: string }).token;
        }
    } catch {
        // not an auth message
    }
    return null;
}
