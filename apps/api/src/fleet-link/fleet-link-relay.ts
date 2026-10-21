import {
    decodeFleetLinkFrame,
    decodeFleetLinkJson,
    encodeFleetLinkControl,
    encodeFleetLinkFrame,
    encodeFleetLinkJson,
    FLEET_LINK_FRAME_KINDS,
    FLEET_LINK_MAX_PAYLOAD_BYTES,
    FLEET_LINK_SLOW_READER_MS,
    FLEET_LINK_VIEWER_CHANNEL,
    FLEET_LINK_VIEWER_CLOSE_CODES,
    FLEET_LINK_VIEWER_FRAME_KINDS,
    FLEET_LINK_VIEWER_MAX_BUFFER_BYTES,
    FLEET_LINK_VIEWER_SLOW_BUFFER_BYTES,
    fleetLinkViewerMaySend,
    type FleetLinkCloseReason,
    type FleetLinkError,
    type FleetLinkFamily,
    type FleetLinkFrameKind,
    type FleetLinkViewerReady,
    type FleetLinkViewerRefused,
    type FleetLinkViewerResumed,
    type FleetLinkViewerRole,
} from '@ever-works/contracts';
import type { FleetLinkChannel, FleetLinkChannelEvents } from './fleet-link-channel';

/**
 * The viewer bridge (FL-02, spec FR-33): one browser socket ↔ one channel of a
 * node's link — local or on another API replica, the bridge cannot tell.
 *
 * Transport-free like the registry: a viewer is anything that can `send` a
 * frame, report what it has not sent yet, and `close`.
 *
 *  - **Out** (node → browser): every frame of the channel is re-numbered to
 *    channel {@link FLEET_LINK_VIEWER_CHANNEL}; resume and close are told on
 *    channel 0 (`viewer.resumed`, `channel.close`) and the socket closes.
 *  - **In** (browser → node): every frame is role-checked. A `driver`'s frames
 *    are forwarded; a `viewer`'s only when they are `ACK` credit or a JSON view
 *    control its family lists (`FLEET_LINK_VIEWER_JSON_TYPES`) — anything
 *    else is answered `viewer.refused` to the sender alone and never reaches
 *    the node. A frame on another channel, or one that does not decode,
 *    closes the socket `4009`. A `CLOSE` frame ends the channel.
 *  - **Slow viewers**: past {@link FLEET_LINK_VIEWER_SLOW_BUFFER_BYTES}
 *    waiting for {@link FLEET_LINK_SLOW_READER_MS}, or past
 *    {@link FLEET_LINK_VIEWER_MAX_BUFFER_BYTES} at all, the viewer is closed
 *    `4011` and the channel with it — one stalled tab never holds a link.
 *
 * Payloads are never logged.
 */

export interface FleetLinkViewerSocket {
    /** Send one binary frame; false when it could not go out. */
    send(frame: Uint8Array): boolean;
    /** Bytes queued and not yet sent. */
    bufferedAmount(): number;
    close(code: number, reason: string): void;
}

export interface FleetLinkViewerBridgeOptions {
    socket: FleetLinkViewerSocket;
    family: FleetLinkFamily;
    target: string;
    role: FleetLinkViewerRole;
    now?: () => number;
    slowReaderMs?: number;
    slowBufferBytes?: number;
    maxBufferBytes?: number;
}

/** At most one `viewer.refused` a second goes back to a viewer that keeps trying. */
const REFUSAL_INTERVAL_MS = 1_000;

export class FleetLinkViewerBridge {
    private channel: FleetLinkChannel | null = null;
    private ended = false;
    private slowSince: number | null = null;
    private lastRefusalAt = -Infinity;
    /** The node's frames that arrived before `viewer.ready` went out; null once it has. */
    private early: Uint8Array[] | null = [];
    private earlyBytes = 0;
    private readonly now: () => number;
    private readonly slowReaderMs: number;
    private readonly slowBufferBytes: number;
    private readonly maxBufferBytes: number;

    /** What the channel tells the bridge — pass to `openChannel` so nothing is missed before {@link attach}. */
    readonly events: FleetLinkChannelEvents = {
        json: (message) => this.outData(encodeFleetLinkJson(FLEET_LINK_VIEWER_CHANNEL, message)),
        binary: (kind, payload) =>
            this.outData(encodeFleetLinkFrame(FLEET_LINK_VIEWER_CHANNEL, kind, payload)),
        resume: (linkGeneration) => {
            const resumed: FleetLinkViewerResumed = { type: 'viewer.resumed', linkGeneration };
            this.outData(encodeFleetLinkControl(resumed));
        },
        close: (reason, hint) => this.channelClosed(reason, hint),
    };

    constructor(private readonly options: FleetLinkViewerBridgeOptions) {
        this.now = options.now ?? (() => Date.now());
        this.slowReaderMs = options.slowReaderMs ?? FLEET_LINK_SLOW_READER_MS;
        this.slowBufferBytes = options.slowBufferBytes ?? FLEET_LINK_VIEWER_SLOW_BUFFER_BYTES;
        this.maxBufferBytes = options.maxBufferBytes ?? FLEET_LINK_VIEWER_MAX_BUFFER_BYTES;
    }

    get isEnded(): boolean {
        return this.ended;
    }

    /** The node accepted the channel: tell the viewer, and start forwarding its frames. */
    attach(channel: FleetLinkChannel): void {
        if (this.ended) {
            channel.close('normal');
            return;
        }
        this.channel = channel;
        const ready: FleetLinkViewerReady = {
            type: 'viewer.ready',
            family: this.options.family,
            target: this.options.target,
            role: this.options.role,
            linkGeneration: channel.linkGeneration,
        };
        this.out(encodeFleetLinkControl(ready));
        // The wire promises `viewer.ready` first: whatever the node sent while
        // the open was being answered follows it, in order.
        const early = this.early ?? [];
        this.early = null;
        this.earlyBytes = 0;
        for (const frame of early) this.out(frame);
    }

    /** The channel could not be opened: say why on channel 0, then close. */
    fail(error: FleetLinkError): void {
        this.channelClosed(error.code, error.hint);
    }

    /** One message from the browser (after its auth message). */
    fromViewer(data: Uint8Array): void {
        if (this.ended) return;
        const frame = decodeFleetLinkFrame(data);
        if (!frame || frame.channel !== FLEET_LINK_VIEWER_CHANNEL) {
            this.end(FLEET_LINK_VIEWER_CLOSE_CODES.protocol, 'protocol');
            return;
        }
        const channel = this.channel;
        if (!channel || !channel.isOpen) return; // not open yet (or closing): nothing to forward to
        if (frame.kind === FLEET_LINK_FRAME_KINDS.CLOSE) {
            channel.close('normal');
            return;
        }
        if (frame.kind === FLEET_LINK_FRAME_KINDS.JSON) {
            const message = decodeFleetLinkJson(frame.payload, FLEET_LINK_MAX_PAYLOAD_BYTES);
            if (!message) {
                this.end(FLEET_LINK_VIEWER_CLOSE_CODES.protocol, 'protocol');
                return;
            }
            if (
                this.options.role === 'viewer' &&
                !fleetLinkViewerMaySend(this.options.family, message.type)
            ) {
                this.refuse();
                return;
            }
            channel.sendJson(message);
            return;
        }
        if (this.options.role === 'viewer' && !FLEET_LINK_VIEWER_FRAME_KINDS.includes(frame.kind)) {
            this.refuse();
            return;
        }
        channel.sendBinary(frame.kind as FleetLinkFrameKind, frame.payload);
    }

    /** The browser went away: the channel ends with it. */
    viewerClosed(): void {
        if (this.ended) return;
        this.ended = true;
        this.channel?.close('normal');
    }

    /** Periodic check (the gateway's ping tick) — a viewer slow with nothing new to send is still slow. */
    tick(): void {
        if (!this.ended) this.checkSlow();
    }

    // ─── Internals ─────────────────────────────────────────────────────────

    private refuse(): void {
        const now = this.now();
        if (now - this.lastRefusalAt < REFUSAL_INTERVAL_MS) return;
        this.lastRefusalAt = now;
        const refused: FleetLinkViewerRefused = {
            type: 'viewer.refused',
            error: { code: 'permission_denied', hint: 'this view is read-only' },
        };
        this.send(encodeFleetLinkControl(refused));
    }

    /** A frame from the node: held until `viewer.ready` is out, then sent. */
    private outData(frame: Uint8Array | null): void {
        if (this.ended || !frame) return;
        if (this.early === null) {
            this.out(frame);
            return;
        }
        this.earlyBytes += frame.byteLength;
        if (this.earlyBytes > this.maxBufferBytes) {
            this.slowReader();
            return;
        }
        this.early.push(frame);
    }

    private out(frame: Uint8Array | null): void {
        if (this.ended || !frame) return;
        if (this.options.socket.bufferedAmount() + frame.byteLength > this.maxBufferBytes) {
            this.slowReader();
            return;
        }
        this.send(frame);
        this.checkSlow();
    }

    private send(frame: Uint8Array | null): void {
        if (!frame) return;
        try {
            this.options.socket.send(frame);
        } catch {
            // the socket's own close follows
        }
    }

    private checkSlow(): void {
        if (this.options.socket.bufferedAmount() <= this.slowBufferBytes) {
            this.slowSince = null;
            return;
        }
        const now = this.now();
        if (this.slowSince === null) this.slowSince = now;
        else if (now - this.slowSince >= this.slowReaderMs) this.slowReader();
    }

    private slowReader(): void {
        // The viewer's close first, so the channel's own close event is not
        // what the viewer reads.
        this.end(FLEET_LINK_VIEWER_CLOSE_CODES.slowReader, 'slow reader');
        this.channel?.close('normal');
    }

    private channelClosed(reason: FleetLinkCloseReason, hint?: string): void {
        if (this.ended) return;
        const close: {
            type: 'channel.close';
            channel: number;
            reason: FleetLinkCloseReason;
            hint?: string;
        } = {
            type: 'channel.close',
            channel: FLEET_LINK_VIEWER_CHANNEL,
            reason,
        };
        if (hint) close.hint = hint;
        this.send(encodeFleetLinkControl(close));
        this.end(
            reason === 'normal'
                ? FLEET_LINK_VIEWER_CLOSE_CODES.normal
                : FLEET_LINK_VIEWER_CLOSE_CODES.channelClosed,
            reason,
        );
    }

    private end(code: number, reason: string): void {
        if (this.ended) return;
        this.ended = true;
        this.early = null;
        try {
            this.options.socket.close(code, reason);
        } catch {
            // already gone
        }
    }
}
