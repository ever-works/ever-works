import {
    decodeFleetLinkExit,
    decodeFleetLinkFrame,
    decodeFleetLinkJson,
    encodeFleetLinkFrame,
    encodeFleetLinkJson,
    encodeFleetLinkResize,
    FLEET_LINK_FRAME_KINDS,
    FLEET_LINK_VIEWER_CHANNEL,
    FLEET_SESSION_BROWSER_ATTACH_VERB,
    parseFleetSessionNotice,
    type FleetLinkCloseReason,
    type FleetSessionAttachResult,
    type FleetSessionAttachRole,
    type FleetSessionNotice,
} from '@ever-works/contracts';
import { readSessionError, type SessionErrorRead } from './sessions.shared';

/**
 * Sessions on computers (FL-04 P1b) — one browser attach to one session,
 * over FL-02's viewer gateway (`/ws/fleet/session/<id>`). No React: the hooks
 * (`use-session-attach.ts`, the Terminal pane's `fleet-session` source) drive
 * it, and the spec drives it with a fake socket.
 *
 * The wire (CONTRACTS §3, `fleet-link-viewer.types.ts`):
 *
 *  1. mint a token through the BFF (`POST /api/fleet/sessions/:id/attach-token
 *     { role }`) — the platform decides the role, the audience, the cap;
 *  2. open the socket; the FIRST message is text `{ type: 'auth', token }`;
 *  3. channel 0 says `viewer.ready` → send `session.attach { cols, rows }` on
 *     channel 1 (a watcher's size is ignored by the node); its reply carries
 *     the session's size, then the replay and live output arrive as `DATA`;
 *  4. channel 1 also carries `EXIT [code]` and `session.notice` JSON (kill
 *     switch paused/resumed, drain countdown, slow viewer, size, replay);
 *     channel 0 `viewer.refused` (an input the role may not send) and
 *     `channel.close { reason, hint }` just before the socket closes.
 *
 * A driver's keystrokes go out as `DATA` frames on channel 1 and its size as
 * `RESIZE`; a watcher sends nothing but the attach request.
 */

export type SessionSocketPhase = 'minting' | 'connecting' | 'attached' | 'closed';

export interface SessionSocketClose {
    /** The socket's close code (`FLEET_LINK_VIEWER_CLOSE_CODES`), or 0 when it never opened. */
    code: number;
    /** `channel.close`'s reason, when one preceded the close. */
    linkReason: FleetLinkCloseReason | null;
    hint: string | null;
    /** The token could not be minted: the platform's refusal. */
    mintError: SessionErrorRead | null;
    /** The node refused `session.attach`. */
    attachError: SessionErrorRead | null;
    /** The stream was attached before it closed. */
    wasAttached: boolean;
    /** An `EXIT` frame arrived: the process ended. */
    exitCode: number | null;
}

export interface SessionSocketEvents {
    onPhase?(phase: SessionSocketPhase): void;
    /** The platform granted this role (it may differ from the one asked for). */
    onRole?(role: FleetSessionAttachRole): void;
    onAttached?(info: FleetSessionAttachResult): void;
    onBytes(bytes: Uint8Array): void;
    onExit?(code: number): void;
    onNotice?(notice: FleetSessionNotice): void;
    /** An input this role may not send was refused (never forwarded). */
    onRefused?(hint: string): void;
    onClosed?(close: SessionSocketClose): void;
}

export interface SessionSocketDeps {
    fetchImpl: typeof fetch;
    webSocketImpl?: typeof WebSocket;
}

const ATTACH_REQUEST_ID = 'browser-attach-1';
const utf8 = new TextEncoder();

/** Bytes of a socket message, whatever shape the runtime hands it in. */
function messageBytes(data: unknown): Uint8Array | null {
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data))
        return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return null;
}

export class FleetSessionSocket {
    private socket: WebSocket | null = null;
    private closedByUs = false;
    private finished = false;
    private attached = false;
    private grantedRole: FleetSessionAttachRole | null = null;
    private linkReason: FleetLinkCloseReason | null = null;
    private hint: string | null = null;
    private attachError: SessionErrorRead | null = null;
    private exitCode: number | null = null;
    /** Payload bytes received (the footer's bandwidth counter). */
    bytesIn = 0;

    constructor(
        private readonly sessionId: string,
        private readonly role: FleetSessionAttachRole,
        private readonly events: SessionSocketEvents,
        private readonly deps: SessionSocketDeps,
        private readonly size: () => { cols: number; rows: number },
    ) {}

    /** The role the platform granted (null until minted). */
    get granted(): FleetSessionAttachRole | null {
        return this.grantedRole;
    }

    get isAttached(): boolean {
        return this.attached && !this.finished;
    }

    /** Mint, connect, attach. Never throws: every failure ends in `onClosed`. */
    async open(): Promise<void> {
        this.events.onPhase?.('minting');
        let token: string;
        let wsUrl: string;
        try {
            const response = await this.deps.fetchImpl(
                `/api/fleet/sessions/${encodeURIComponent(this.sessionId)}/attach-token`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ role: this.role, ...this.size() }),
                },
            );
            const body = (await response.json().catch(() => null)) as {
                token?: string;
                wsUrl?: string;
                role?: string;
            } | null;
            if (!response.ok || !body?.token || !body.wsUrl) {
                this.finish({ code: 0, mintError: readSessionError(response.status, body) });
                return;
            }
            token = body.token;
            wsUrl = body.wsUrl;
            this.grantedRole = body.role === 'driver' ? 'driver' : 'viewer';
            this.events.onRole?.(this.grantedRole);
        } catch {
            this.finish({
                code: 0,
                mintError: { code: 'network', hint: null, details: {}, status: 0 },
            });
            return;
        }
        if (this.closedByUs) {
            this.finish({ code: 1000 });
            return;
        }

        this.events.onPhase?.('connecting');
        const WS = this.deps.webSocketImpl ?? WebSocket;
        let socket: WebSocket;
        try {
            socket = new WS(wsUrl);
        } catch {
            this.finish({ code: 0 });
            return;
        }
        this.socket = socket;
        socket.binaryType = 'arraybuffer';
        socket.onopen = () => {
            try {
                socket.send(JSON.stringify({ type: 'auth', token }));
            } catch {
                // the close follows
            }
        };
        socket.onmessage = (event: MessageEvent) => this.onMessage(event.data);
        socket.onclose = (event: CloseEvent) => this.finish({ code: event.code });
        socket.onerror = () => {
            // the close event carries the outcome
        };
    }

    /** Send keystrokes. False when they could not go (not attached, not a driver): the caller may hold them. */
    sendInput(data: string): boolean {
        if (!this.isAttached || this.grantedRole !== 'driver' || data.length === 0) return false;
        const frame = encodeFleetLinkFrame(
            FLEET_LINK_VIEWER_CHANNEL,
            FLEET_LINK_FRAME_KINDS.DATA,
            utf8.encode(data),
        );
        return this.send(frame);
    }

    /** Size the terminal (a driver only; the newest driver's size wins on the machine). */
    sendResize(cols: number, rows: number): void {
        if (!this.isAttached || this.grantedRole !== 'driver') return;
        const payload = encodeFleetLinkResize(cols, rows);
        if (!payload) return;
        this.send(
            encodeFleetLinkFrame(FLEET_LINK_VIEWER_CHANNEL, FLEET_LINK_FRAME_KINDS.RESIZE, payload),
        );
    }

    /** Detach. The session keeps running on the machine. */
    close(): void {
        this.closedByUs = true;
        const socket = this.socket;
        if (!socket) return;
        try {
            socket.close(1000, 'detach');
        } catch {
            // already gone
        }
    }

    // ─── Internals ─────────────────────────────────────────────────────────

    private send(frame: Uint8Array | null): boolean {
        const socket = this.socket;
        if (!frame || !socket || socket.readyState !== 1) return false;
        try {
            socket.send(frame);
            return true;
        } catch {
            return false;
        }
    }

    private onMessage(data: unknown): void {
        const bytes = messageBytes(data);
        if (!bytes) return; // text from the gateway: nothing is defined
        const frame = decodeFleetLinkFrame(bytes);
        if (!frame) return;
        if (frame.channel === 0) {
            if (frame.kind !== FLEET_LINK_FRAME_KINDS.JSON) return;
            this.onControl(decodeFleetLinkJson(frame.payload));
            return;
        }
        if (frame.channel !== FLEET_LINK_VIEWER_CHANNEL) return;
        switch (frame.kind) {
            case FLEET_LINK_FRAME_KINDS.DATA:
                this.bytesIn += frame.payload.byteLength;
                this.events.onBytes(frame.payload);
                return;
            case FLEET_LINK_FRAME_KINDS.EXIT: {
                const code = decodeFleetLinkExit(frame.payload);
                this.exitCode = code ?? -1;
                this.events.onExit?.(this.exitCode);
                return;
            }
            case FLEET_LINK_FRAME_KINDS.JSON:
                this.onChannelJson(decodeFleetLinkJson(frame.payload));
                return;
            default:
                return;
        }
    }

    private onControl(message: Record<string, unknown> | null): void {
        if (!message) return;
        switch (message.type) {
            case 'viewer.ready': {
                const size = this.size();
                const request = encodeFleetLinkJson(FLEET_LINK_VIEWER_CHANNEL, {
                    requestId: ATTACH_REQUEST_ID,
                    type: FLEET_SESSION_BROWSER_ATTACH_VERB,
                    params: { cols: size.cols, rows: size.rows },
                });
                this.send(request);
                return;
            }
            case 'viewer.refused': {
                const error = message.error as { hint?: unknown } | undefined;
                this.events.onRefused?.(typeof error?.hint === 'string' ? error.hint : '');
                return;
            }
            case 'channel.close': {
                this.linkReason =
                    typeof message.reason === 'string'
                        ? (message.reason as FleetLinkCloseReason)
                        : null;
                this.hint = typeof message.hint === 'string' ? message.hint : null;
                return;
            }
            default:
                return;
        }
    }

    private onChannelJson(message: Record<string, unknown> | null): void {
        if (!message) return;
        if (message.requestId === ATTACH_REQUEST_ID) {
            if (message.error !== undefined) {
                this.attachError = readSessionError(0, { error: message.error });
                this.close();
                return;
            }
            const result = (message.result ?? {}) as Partial<FleetSessionAttachResult>;
            this.attached = true;
            this.events.onPhase?.('attached');
            this.events.onAttached?.({
                alive: result.alive !== false,
                cols: typeof result.cols === 'number' ? result.cols : this.size().cols,
                rows: typeof result.rows === 'number' ? result.rows : this.size().rows,
                exitCode: typeof result.exitCode === 'number' ? result.exitCode : null,
            });
            return;
        }
        const notice = parseFleetSessionNotice(message);
        if (notice) this.events.onNotice?.(notice);
    }

    private finish(partial: Partial<SessionSocketClose> & { code: number }): void {
        if (this.finished) return;
        this.finished = true;
        this.socket = null;
        this.events.onPhase?.('closed');
        this.events.onClosed?.({
            code: partial.code,
            linkReason: this.linkReason,
            hint: this.hint,
            mintError: partial.mintError ?? null,
            attachError: this.attachError,
            wasAttached: this.attached,
            exitCode: this.exitCode,
        });
    }
}

/**
 * What a close means for the page (spec §5.4, U7 … U12):
 *
 *  - `ended` — the process exited (an `EXIT` frame), or the platform says the
 *    session has ended;
 *  - `refused` — the platform or the node said no (audience, kill switch for a
 *    driver, the five-watcher cap, consent): the reason is shown, no retry;
 *  - `detached` — this browser closed it;
 *  - `retry` — the link dropped, the node restarted, the token was stale, a
 *    slow tab was dropped: reconnect with backoff, holding typed input.
 */
export type SessionCloseVerdict = 'ended' | 'refused' | 'detached' | 'retry';

const REFUSING_CODES: readonly string[] = [
    'not_found',
    'permission_denied',
    'kill_switch',
    'consent_missing',
    'limit_exceeded',
    'unsupported_on_node',
    'confirmation_required',
];

export function sessionCloseVerdict(
    close: SessionSocketClose,
    detachedByUs: boolean,
): SessionCloseVerdict {
    if (close.exitCode !== null) return 'ended';
    if (detachedByUs) return 'detached';
    const error = close.mintError ?? close.attachError;
    if (error) {
        if (error.code === 'invalid' && error.details.state === 'ended') return 'ended';
        if (REFUSING_CODES.includes(error.code) || error.code === 'invalid') return 'refused';
        return 'retry';
    }
    if (close.linkReason && REFUSING_CODES.includes(close.linkReason)) return 'refused';
    return 'retry';
}
