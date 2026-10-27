import {
    decodeComputerFrame,
    decodeFleetLinkFrame,
    decodeFleetLinkJson,
    encodeComputerFrame,
    encodeFleetLinkFrame,
    encodeFleetLinkJson,
    FLEET_LINK_FRAME_KINDS,
    FLEET_LINK_VIEWER_CHANNEL,
    type ComputerInputFrame,
} from '@ever-works/contracts';

/**
 * Servers and ports (FL-10, spec S4, FR-10) — the preview pane's socket: one
 * attach to the machine's preview browser over FL-02's viewer gateway
 * (`/ws/fleet/desktop/<viewId>`, family `desktop`, `profile: 'preview'`). No
 * React: `PreviewPane` drives it.
 *
 *  1. The token came with the Open answer (minted for the opener, role
 *     `driver`); the FIRST message is text `{ type: 'auth', token }`.
 *  2. Channel 0 says `viewer.ready`; channel 1 then carries `FRAME` frames —
 *     the existing computer-frame encoding (`{ kind: 'frame', mime, data, … }`)
 *     — which become an image URL for the pane.
 *  3. The opener's pointer, wheel, keys and text go back as `INPUT` frames in
 *     the same encoding; `desktop.refresh` asks for a fresh picture.
 *  4. `channel.close { reason, hint }` precedes the socket's close: the 60-minute
 *     cap, the kill switch, the preview ending on the machine.
 */

export interface PreviewSocketClose {
    code: number;
    reason: string | null;
    hint: string | null;
    wasReady: boolean;
}

export interface PreviewSocketEvents {
    onReady?(): void;
    onPicture(picture: { src: string; width: number; height: number }): void;
    onRefused?(hint: string): void;
    onClosed?(close: PreviewSocketClose): void;
}

const utf8 = new TextEncoder();

function messageBytes(data: unknown): Uint8Array | null {
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data))
        return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return null;
}

export class FleetPreviewSocket {
    private socket: WebSocket | null = null;
    private ready = false;
    private finished = false;
    private reason: string | null = null;
    private hint: string | null = null;

    constructor(
        private readonly wsUrl: string,
        private readonly token: string,
        private readonly events: PreviewSocketEvents,
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

    /** Send one input (the opener drives the preview browser). False when it could not go. */
    sendInput(input: ComputerInputFrame): boolean {
        if (!this.ready) return false;
        const encoded = encodeComputerFrame(input);
        if (!encoded) return false;
        return this.send(
            encodeFleetLinkFrame(
                FLEET_LINK_VIEWER_CHANNEL,
                FLEET_LINK_FRAME_KINDS.INPUT,
                utf8.encode(encoded),
            ),
        );
    }

    /** Ask for a fresh picture now. */
    refresh(): void {
        if (!this.ready) return;
        this.send(encodeFleetLinkJson(FLEET_LINK_VIEWER_CHANNEL, { type: 'desktop.refresh' }));
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
        if (!bytes) return;
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
        if (
            frame.channel !== FLEET_LINK_VIEWER_CHANNEL ||
            frame.kind !== FLEET_LINK_FRAME_KINDS.FRAME
        )
            return;
        const picture = decodeComputerFrame(frame.payload);
        if (!picture || picture.kind !== 'frame') return;
        this.events.onPicture({
            src: `data:${picture.mime};base64,${picture.data}`,
            width: picture.width,
            height: picture.height,
        });
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
