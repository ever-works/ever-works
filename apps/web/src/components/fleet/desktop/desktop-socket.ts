import {
    decodeComputerFrame,
    decodeDesktopTiles,
    encodeComputerFrame,
    encodeFleetLinkFrame,
    decodeFleetLinkFrame,
    decodeFleetLinkJson,
    encodeFleetLinkJson,
    FLEET_DESKTOP_MESSAGES,
    FLEET_LINK_FRAME_KINDS,
    FLEET_LINK_VIEWER_CHANNEL,
    normalizeFleetDisplay,
    normalizeFleetDesktopInputRefusedCode,
    normalizeFleetDisplays,
    type ComputerInputFrame,
    type ComputerQuality,
    type FleetDesktopInputRefusedCode,
    type FleetDesktopTiles,
    type FleetDisplayView,
} from '@ever-works/contracts';

/**
 * Desktop view & control (FL-07, plan §6.4, CONTRACTS §3.4) — the Desktop
 * tab's socket: one attach to FL-02's viewer gateway
 * (`/ws/fleet/desktop/<viewId>`) with the single-use token the view's open
 * answered (role `viewer`). No React: `DesktopTab` drives it.
 *
 *  1. The FIRST message is text `{ type: 'auth', token }`.
 *  2. Channel 0 says `viewer.ready`; channel 1 then carries `desktop.started`
 *     (what the view shows), `FRAME` keyframes (the computer-frame encoding),
 *     `TILES` changed regions, `desktop.stats` once a second and
 *     `desktop.displayChanged` on a hot-plug.
 *  3. The viewer may send only the family's view controls:
 *     `desktop.quality`, `desktop.refresh`, `desktop.displays`. Nothing it
 *     sends can reach the machine as input (the gateway refuses a watcher's).
 *  4. `channel.close { reason, hint }` precedes the socket's close.
 *
 * P2 (control): on a `driver` grant — only the view holding the computer's
 * control lock is minted one — `sendInput` sends the person's pointer, wheel,
 * keys and text as `INPUT` frames (the contracts' computer input frame); the
 * machine answers an input it did not take with `desktop.inputRefused { code }`.
 */

export interface DesktopSocketClose {
    code: number;
    reason: string | null;
    hint: string | null;
    wasReady: boolean;
}

export interface DesktopStarted {
    display: FleetDisplayView | null;
    displays: FleetDisplayView[];
    fellBack: boolean;
}

export interface DesktopStats {
    fps: number;
    bytesOut: number;
    quality: ComputerQuality | null;
}

export interface DesktopSocketEvents {
    onReady?(): void;
    onStarted?(started: DesktopStarted): void;
    onKeyframe(picture: { blob: Blob; width: number; height: number }): void;
    onTiles(tiles: FleetDesktopTiles): void;
    onStats?(stats: DesktopStats): void;
    onDisplays?(displays: FleetDisplayView[], fallback: FleetDisplayView | null): void;
    onRefused?(hint: string): void;
    onClosed?(close: DesktopSocketClose): void;
    /** P2: an input the machine did not take (a code only). */
    onInputRefused?(code: FleetDesktopInputRefusedCode): void;
}

const utf8 = new TextEncoder();

function messageBytes(data: unknown): Uint8Array | null {
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data))
        return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return null;
}

function base64Bytes(data: string): Uint8Array<ArrayBuffer> {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
}

export class FleetDesktopSocket {
    private socket: WebSocket | null = null;
    private ready = false;
    private finished = false;
    private reason: string | null = null;
    private hint: string | null = null;
    /** Bytes received on the channel (the bandwidth readout, FR-29). */
    bytesIn = 0;

    constructor(
        private readonly wsUrl: string,
        private readonly token: string,
        private readonly events: DesktopSocketEvents,
        private readonly webSocketImpl?: typeof WebSocket,
    ) {}

    open(): void {
        const WS = this.webSocketImpl ?? WebSocket;
        let socket: WebSocket;
        try {
            socket = new WS(this.wsUrl);
        } catch {
            this.finish(0);
            return;
        }
        this.socket = socket;
        socket.binaryType = 'arraybuffer';
        socket.onopen = () => {
            try {
                socket.send(JSON.stringify({ type: 'auth', token: this.token }));
            } catch {
                // the close follows
            }
        };
        socket.onmessage = (event: MessageEvent) => this.onMessage(event.data);
        socket.onclose = (event: CloseEvent) => this.finish(event.code);
        socket.onerror = () => {
            // the close event carries the outcome
        };
    }

    /** Ask for a full picture now (after a missed tile, a resize, a click on ↻). */
    refresh(): void {
        this.sendJson({ type: FLEET_DESKTOP_MESSAGES.refresh });
    }

    quality(quality: ComputerQuality): void {
        this.sendJson({ type: FLEET_DESKTOP_MESSAGES.quality, quality });
    }

    /** P2: one input to the machine (a watcher's never reaches it — the gateway refuses it). False when it could not go. */
    sendInput(input: ComputerInputFrame): boolean {
        const socket = this.socket;
        if (!this.ready || !socket || socket.readyState !== 1) return false;
        const encoded = encodeComputerFrame(input);
        if (!encoded) return false;
        const frame = encodeFleetLinkFrame(
            FLEET_LINK_VIEWER_CHANNEL,
            FLEET_LINK_FRAME_KINDS.INPUT,
            utf8.encode(encoded),
        );
        if (!frame) return false;
        try {
            socket.send(frame);
            return true;
        } catch {
            return false;
        }
    }

    close(): void {
        const socket = this.socket;
        if (!socket) return;
        try {
            socket.close(1000, 'leave');
        } catch {
            // already gone
        }
    }

    private sendJson(message: Record<string, unknown>): void {
        const socket = this.socket;
        if (!this.ready || !socket || socket.readyState !== 1) return;
        const frame = encodeFleetLinkJson(FLEET_LINK_VIEWER_CHANNEL, message);
        if (!frame) return;
        try {
            socket.send(frame);
        } catch {
            // the close follows
        }
    }

    private onMessage(data: unknown): void {
        const bytes = messageBytes(data);
        if (!bytes) return;
        this.bytesIn += bytes.byteLength;
        const frame = decodeFleetLinkFrame(bytes);
        if (!frame) return;
        if (frame.channel === 0) {
            if (frame.kind !== FLEET_LINK_FRAME_KINDS.JSON) return;
            const message = decodeFleetLinkJson(frame.payload);
            if (!message) return;
            if (message.type === 'viewer.ready') {
                this.ready = true;
                this.events.onReady?.();
            } else if (message.type === 'viewer.refused') {
                const error = message.error as { hint?: unknown } | undefined;
                this.events.onRefused?.(typeof error?.hint === 'string' ? error.hint : '');
            } else if (message.type === 'channel.close') {
                this.reason = typeof message.reason === 'string' ? message.reason : null;
                this.hint = typeof message.hint === 'string' ? message.hint : null;
            }
            return;
        }
        if (frame.channel !== FLEET_LINK_VIEWER_CHANNEL) return;
        if (frame.kind === FLEET_LINK_FRAME_KINDS.FRAME) {
            const picture = decodeComputerFrame(frame.payload);
            if (!picture || picture.kind !== 'frame') return;
            const blob = new Blob([base64Bytes(picture.data)], { type: picture.mime });
            this.events.onKeyframe({ blob, width: picture.width, height: picture.height });
            return;
        }
        if (frame.kind === FLEET_LINK_FRAME_KINDS.TILES) {
            const tiles = decodeDesktopTiles(frame.payload);
            if (tiles) this.events.onTiles(tiles);
            return;
        }
        if (frame.kind !== FLEET_LINK_FRAME_KINDS.JSON) return;
        const message = decodeFleetLinkJson(frame.payload);
        if (!message) return;
        switch (message.type) {
            case FLEET_DESKTOP_MESSAGES.started:
                this.events.onStarted?.({
                    display: normalizeFleetDisplay(message.display),
                    displays: normalizeFleetDisplays(message.displays),
                    fellBack: message.fellBack === true,
                });
                return;
            case FLEET_DESKTOP_MESSAGES.stats:
                this.events.onStats?.({
                    fps: typeof message.fps === 'number' ? message.fps : 0,
                    bytesOut: typeof message.bytesOut === 'number' ? message.bytesOut : 0,
                    quality:
                        message.quality === 'sharp' ||
                        message.quality === 'smooth' ||
                        message.quality === 'steady'
                            ? message.quality
                            : null,
                });
                return;
            case FLEET_DESKTOP_MESSAGES.inputRefused:
                this.events.onInputRefused?.(normalizeFleetDesktopInputRefusedCode(message.code));
                return;
            case FLEET_DESKTOP_MESSAGES.displayChanged:
            case FLEET_DESKTOP_MESSAGES.displays:
                this.events.onDisplays?.(
                    normalizeFleetDisplays(message.displays),
                    normalizeFleetDisplay(message.fallback),
                );
                return;
            default:
                return;
        }
    }

    private finish(code: number): void {
        if (this.finished) return;
        this.finished = true;
        this.socket = null;
        this.events.onClosed?.({
            code,
            reason: this.reason,
            hint: this.hint,
            wasReady: this.ready,
        });
    }
}
