import {
    decodeFleetLinkFrame,
    decodeFleetLinkJson,
    encodeFleetLinkAck,
    encodeFleetLinkFrame,
    encodeFleetLinkJson,
    FLEET_LINK_FRAME_KINDS,
    FLEET_LINK_VIEWER_CHANNEL,
    FLEET_LOGS_MESSAGES,
    parseFleetLogLines,
    parseFleetLogsChannelMessage,
    type FleetLinkCloseReason,
    type FleetLogLine,
    type FleetLogsEarlierDone,
    type FleetLogsInitialDone,
    type FleetLogsNotice,
} from '@ever-works/contracts';
import { readSessionError, type SessionErrorRead } from '../sessions/sessions.shared';

/**
 * Logs on computers (FL-08, T-12) — one browser viewer of one log source (or
 * a merged set), over FL-02's viewer gateway (`/ws/fleet/logs/<nodeId>`). No
 * React: `use-log-follow.ts` drives it, the spec drives it with a fake socket.
 *
 *  1. mint a token through the BFF (`POST /api/fleet/nodes/:id/logs/attach-token`);
 *  2. open the socket; the FIRST message is text `{ type: 'auth', token }`;
 *  3. channel 0 says `viewer.ready` → send `logs.follow { on: true, lines }`
 *     (or `logs.read` for a batch without follow) on channel 1;
 *  4. channel 1 carries `DATA` frames of NDJSON lines — each one credited
 *     back with `ACK` as it is consumed, so the node never sends more than
 *     this viewer takes — and JSON `logs.initial-done`, `logs.earlier-done`,
 *     `logs.notice`; channel 0 `viewer.resumed` (the link came back) and
 *     `channel.close { reason, hint }` just before the socket closes.
 *
 * Pause is the viewer's (lane log decision 6): the hook holds arrivals; the
 * socket keeps reading.
 */

export type LogSocketPhase = 'minting' | 'connecting' | 'open' | 'closed';

export interface LogSocketClose {
    /** The socket's close code, or 0 when it never opened. */
    code: number;
    linkReason: FleetLinkCloseReason | null;
    hint: string | null;
    mintError: SessionErrorRead | null;
    /** `viewer.ready` arrived before the close. */
    wasOpen: boolean;
}

export interface LogSocketEvents {
    onPhase?(phase: LogSocketPhase): void;
    onLines(lines: FleetLogLine[], bytes: number): void;
    onInitialDone?(done: FleetLogsInitialDone): void;
    onEarlierDone?(done: FleetLogsEarlierDone): void;
    onNotice?(notice: FleetLogsNotice): void;
    onResumed?(): void;
    onClosed?(close: LogSocketClose): void;
}

export interface LogSocketOptions {
    nodeId: string;
    sources: readonly string[];
    lines: number;
    follow: boolean;
}

export interface LogSocketDeps {
    fetchImpl: typeof fetch;
    webSocketImpl?: typeof WebSocket;
}

function messageBytes(data: unknown): Uint8Array | null {
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data))
        return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return null;
}

export class FleetLogSocket {
    private socket: WebSocket | null = null;
    private closedByUs = false;
    private finished = false;
    private open = false;
    private linkReason: FleetLinkCloseReason | null = null;
    private hint: string | null = null;
    private carry = '';
    private readonly decoder = new TextDecoder();

    constructor(
        private readonly options: LogSocketOptions,
        private readonly events: LogSocketEvents,
        private readonly deps: LogSocketDeps,
    ) {}

    get isOpen(): boolean {
        return this.open && !this.finished;
    }

    /** Mint, connect, ask. Never throws: every failure ends in `onClosed`. */
    async start(): Promise<void> {
        this.events.onPhase?.('minting');
        let token: string;
        let wsUrl: string;
        try {
            const [first, ...rest] = this.options.sources;
            const response = await this.deps.fetchImpl(
                `/api/fleet/nodes/${encodeURIComponent(this.options.nodeId)}/logs/attach-token`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        source: first,
                        ...(rest.length > 0 ? { sources: rest } : {}),
                        lines: this.options.lines,
                        follow: this.options.follow,
                    }),
                },
            );
            const body = (await response.json().catch(() => null)) as {
                token?: string;
                wsUrl?: string;
            } | null;
            if (!response.ok || !body?.token || !body.wsUrl) {
                this.finish({ code: 0, mintError: readSessionError(response.status, body) });
                return;
            }
            token = body.token;
            wsUrl = body.wsUrl;
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

    /** Stop the live lines (the channel stays; `follow()` starts them again). */
    stopFollowing(): void {
        this.sendJson({ type: FLEET_LOGS_MESSAGES.follow, on: false });
    }

    follow(): void {
        this.sendJson({ type: FLEET_LOGS_MESSAGES.follow, on: true, lines: this.options.lines });
    }

    /** P2: ask for an older page of one source. */
    earlier(src = 0, lines = this.options.lines): void {
        this.sendJson({ type: FLEET_LOGS_MESSAGES.earlier, lines, src });
    }

    close(): void {
        this.closedByUs = true;
        const socket = this.socket;
        if (!socket) return;
        try {
            socket.close(1000, 'closed');
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

    private sendJson(message: Record<string, unknown>): boolean {
        if (!this.isOpen) return false;
        return this.send(encodeFleetLinkJson(FLEET_LINK_VIEWER_CHANNEL, message));
    }

    private onMessage(data: unknown): void {
        const bytes = messageBytes(data);
        if (!bytes) return;
        const frame = decodeFleetLinkFrame(bytes);
        if (!frame) return;
        if (frame.channel === 0) {
            if (frame.kind === FLEET_LINK_FRAME_KINDS.JSON)
                this.onControl(decodeFleetLinkJson(frame.payload));
            return;
        }
        if (frame.channel !== FLEET_LINK_VIEWER_CHANNEL) return;
        if (frame.kind === FLEET_LINK_FRAME_KINDS.DATA) {
            this.carry += this.decoder.decode(frame.payload, { stream: true });
            const cut = this.carry.lastIndexOf('\n');
            if (cut >= 0) {
                const lines = parseFleetLogLines(this.carry.slice(0, cut + 1));
                this.carry = this.carry.slice(cut + 1);
                if (lines.length > 0) this.events.onLines(lines, frame.payload.byteLength);
            }
            // Consumed: credit it back so the node may send the next frame.
            const ack = encodeFleetLinkAck(frame.payload.byteLength);
            if (ack)
                this.send(
                    encodeFleetLinkFrame(
                        FLEET_LINK_VIEWER_CHANNEL,
                        FLEET_LINK_FRAME_KINDS.ACK,
                        ack,
                    ),
                );
            return;
        }
        if (frame.kind === FLEET_LINK_FRAME_KINDS.JSON) {
            const message = parseFleetLogsChannelMessage(decodeFleetLinkJson(frame.payload));
            if (!message) return;
            if (message.type === 'logs.initial-done') this.events.onInitialDone?.(message);
            else if (message.type === 'logs.earlier-done') this.events.onEarlierDone?.(message);
            else this.events.onNotice?.(message);
        }
    }

    private onControl(message: Record<string, unknown> | null): void {
        if (!message) return;
        switch (message.type) {
            case 'viewer.ready':
                this.open = true;
                this.events.onPhase?.('open');
                this.sendJson(
                    this.options.follow
                        ? { type: FLEET_LOGS_MESSAGES.follow, on: true, lines: this.options.lines }
                        : { type: FLEET_LOGS_MESSAGES.read, lines: this.options.lines },
                );
                return;
            case 'viewer.resumed':
                this.events.onResumed?.();
                return;
            case 'channel.close':
                this.linkReason =
                    typeof message.reason === 'string'
                        ? (message.reason as FleetLinkCloseReason)
                        : null;
                this.hint = typeof message.hint === 'string' ? message.hint : null;
                return;
            default:
                return;
        }
    }

    private finish(partial: Partial<LogSocketClose> & { code: number }): void {
        if (this.finished) return;
        this.finished = true;
        this.socket = null;
        this.events.onPhase?.('closed');
        this.events.onClosed?.({
            code: partial.code,
            linkReason: this.linkReason,
            hint: this.hint,
            mintError: partial.mintError ?? null,
            wasOpen: this.open,
        });
    }
}

/**
 * What a close means for the viewer (spec U3, U8, U10):
 *
 *  - `closed` — this browser closed it;
 *  - `refused` — the platform or the machine said no (audience, kill switch,
 *    consent, a path outside the roots, eight logs already open): shown, no retry;
 *  - `lost` — the link could not resume the channel: "Lost the live feed — reopen";
 *  - `retry` — a transient drop (a stale token, a slow tab, a restart): reconnect.
 */
export type LogCloseVerdict = 'closed' | 'refused' | 'lost' | 'retry';

const REFUSING: readonly string[] = [
    'not_found',
    'invalid',
    'permission_denied',
    'kill_switch',
    'consent_missing',
    'limit_exceeded',
    'unsupported_on_node',
];

export function logCloseVerdict(close: LogSocketClose, closedByUs: boolean): LogCloseVerdict {
    if (closedByUs) return 'closed';
    if (close.mintError) return REFUSING.includes(close.mintError.code) ? 'refused' : 'retry';
    if (close.linkReason && REFUSING.includes(close.linkReason)) return 'refused';
    if (close.linkReason === 'resume_failed') return 'lost';
    return 'retry';
}
