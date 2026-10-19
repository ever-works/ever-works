import {
    decodeFleetLinkControl,
    decodeFleetLinkFrame,
    decodeFleetLinkJson,
    encodeFleetLinkAck,
    encodeFleetLinkFrame,
    encodeFleetLinkJson,
    FLEET_LINK_FRAME_KINDS,
    FLEET_LINK_VIEWER_CHANNEL,
    FLEET_LINK_VIEWER_CLOSE_CODES,
    type FleetLinkFamily,
    type FleetLinkViewerRole,
} from '@ever-works/contracts';
import type { FleetLinkChannel, FleetLinkChannelEvents } from '../fleet-link-channel';
import { FleetLinkViewerBridge, type FleetLinkViewerSocket } from '../fleet-link-relay';

/**
 * The viewer bridge (FL-02, spec FR-33, T-21): a viewer's input is answered
 * with an error and never forwarded, a driver's is; output is re-numbered;
 * close and resume reach the browser; a slow viewer is dropped.
 */

class Viewer implements FleetLinkViewerSocket {
    readonly frames: Uint8Array[] = [];
    buffered = 0;
    closed: { code: number; reason: string } | null = null;
    send(frame: Uint8Array): boolean {
        this.frames.push(frame);
        return true;
    }
    bufferedAmount(): number {
        return this.buffered;
    }
    close(code: number, reason: string): void {
        this.closed = { code, reason };
    }
    controls() {
        return this.frames
            .map((frame) => decodeFleetLinkFrame(frame)!)
            .filter((frame) => frame.channel === 0)
            .map((frame) => decodeFleetLinkControl(frame.payload));
    }
    data() {
        return this.frames
            .map((frame) => decodeFleetLinkFrame(frame)!)
            .filter((frame) => frame.channel !== 0);
    }
}

class Channel implements FleetLinkChannel {
    readonly nodeId = 'node-1';
    readonly channel = 7;
    isOpen = true;
    isClosed = false;
    linkGeneration: number | null = 3;
    readonly json: Array<Record<string, unknown>> = [];
    readonly binary: Array<[number, Uint8Array]> = [];
    closedWith: string | null = null;
    private listeners = new Set<FleetLinkChannelEvents>();
    constructor(readonly family: FleetLinkFamily) {}
    request(): never {
        throw new Error('not used');
    }
    sendJson(message: Record<string, unknown>): boolean {
        this.json.push(message);
        return true;
    }
    sendBinary(kind: number, payload: Uint8Array): boolean {
        this.binary.push([kind, payload]);
        return true;
    }
    close(reason = 'normal'): void {
        if (this.isClosed) return;
        this.isClosed = true;
        this.isOpen = false;
        this.closedWith = reason;
        for (const listener of [...this.listeners]) listener.close?.(reason as never);
    }
    listen(events: FleetLinkChannelEvents): () => void {
        this.listeners.add(events);
        return () => this.listeners.delete(events);
    }
}

function setup(role: FleetLinkViewerRole, family: FleetLinkFamily = 'logs') {
    let now = 0;
    const viewer = new Viewer();
    const bridge = new FleetLinkViewerBridge({
        socket: viewer,
        family,
        target: 'node-1',
        role,
        now: () => now,
    });
    const channel = new Channel(family);
    channel.listen(bridge.events);
    bridge.attach(channel);
    return { viewer, bridge, channel, advance: (ms: number) => (now += ms) };
}

const json = (message: Record<string, unknown>, channel = FLEET_LINK_VIEWER_CHANNEL) =>
    encodeFleetLinkJson(channel, message)!;
const frame = (kind: number, bytes: number[] = [1, 2, 3]) =>
    encodeFleetLinkFrame(FLEET_LINK_VIEWER_CHANNEL, kind as never, new Uint8Array(bytes))!;

describe('FleetLinkViewerBridge — what reaches the node', () => {
    it('never forwards a viewer’s input; answers it with viewer.refused (FR-33)', () => {
        const h = setup('viewer', 'session');
        h.bridge.fromViewer(frame(FLEET_LINK_FRAME_KINDS.DATA));
        h.advance(1_000);
        h.bridge.fromViewer(json({ type: 'session.input', data: 'rm -rf /' }));
        h.advance(1_000);
        h.bridge.fromViewer(frame(FLEET_LINK_FRAME_KINDS.RESIZE, [0, 80, 0, 24]));
        expect(h.channel.binary).toEqual([]);
        expect(h.channel.json).toEqual([]);
        const refused = h.viewer.controls().filter((m) => m?.type === 'viewer.refused');
        expect(refused).toHaveLength(3);
        expect(refused[0]).toEqual({
            type: 'viewer.refused',
            error: { code: 'permission_denied', hint: 'this view is read-only' },
        });
        expect(h.viewer.closed).toBeNull();
    });

    it('answers a viewer that keeps trying at most once a second', () => {
        const h = setup('viewer', 'session');
        for (let i = 0; i < 50; i += 1) h.bridge.fromViewer(frame(FLEET_LINK_FRAME_KINDS.DATA));
        expect(h.viewer.controls().filter((m) => m?.type === 'viewer.refused')).toHaveLength(1);
    });

    it('lets a viewer send credit and its family’s view controls', () => {
        const h = setup('viewer', 'logs');
        h.bridge.fromViewer(
            encodeFleetLinkFrame(
                FLEET_LINK_VIEWER_CHANNEL,
                FLEET_LINK_FRAME_KINDS.ACK,
                encodeFleetLinkAck(4096),
            )!,
        );
        h.bridge.fromViewer(json({ type: 'logs.pause' }));
        expect(h.channel.binary.map(([kind]) => kind)).toEqual([FLEET_LINK_FRAME_KINDS.ACK]);
        expect(h.channel.json).toEqual([{ type: 'logs.pause' }]);
    });

    it('forwards everything a driver sends', () => {
        const h = setup('driver', 'session');
        h.bridge.fromViewer(frame(FLEET_LINK_FRAME_KINDS.DATA, [104, 105]));
        h.bridge.fromViewer(json({ type: 'session.input', data: 'ls' }));
        expect(h.channel.binary).toEqual([
            [FLEET_LINK_FRAME_KINDS.DATA, new Uint8Array([104, 105])],
        ]);
        expect(h.channel.json).toEqual([{ type: 'session.input', data: 'ls' }]);
    });

    it('closes the socket 4009 for a frame on another channel or one that does not decode', () => {
        const a = setup('driver');
        a.bridge.fromViewer(json({ type: 'x.y' }, 5));
        expect(a.viewer.closed).toEqual({
            code: FLEET_LINK_VIEWER_CLOSE_CODES.protocol,
            reason: 'protocol',
        });
        const b = setup('driver');
        b.bridge.fromViewer(new Uint8Array([0, 0, 0, 1, 1, 0, 0, 0, 9]));
        expect(b.viewer.closed?.code).toBe(FLEET_LINK_VIEWER_CLOSE_CODES.protocol);
        expect(a.channel.json).toEqual([]);
    });

    it('ends the channel on a CLOSE frame, and when the browser goes away', () => {
        const a = setup('driver');
        a.bridge.fromViewer(frame(FLEET_LINK_FRAME_KINDS.CLOSE, []));
        expect(a.channel.closedWith).toBe('normal');
        expect(a.viewer.closed?.code).toBe(FLEET_LINK_VIEWER_CLOSE_CODES.normal);
        const b = setup('viewer');
        b.bridge.viewerClosed();
        expect(b.channel.closedWith).toBe('normal');
    });
});

describe('FleetLinkViewerBridge — what reaches the browser', () => {
    it('says ready, then carries the node’s frames on channel 1', () => {
        const h = setup('viewer', 'logs');
        expect(h.viewer.controls()[0]).toEqual({
            type: 'viewer.ready',
            family: 'logs',
            target: 'node-1',
            role: 'viewer',
            linkGeneration: 3,
        });
        h.bridge.events.binary!(FLEET_LINK_FRAME_KINDS.DATA, new Uint8Array([9, 9]));
        h.bridge.events.json!({ type: 'logs.notice', text: 'rotated' });
        const out = h.viewer.data();
        expect(out.map((f) => f.channel)).toEqual([
            FLEET_LINK_VIEWER_CHANNEL,
            FLEET_LINK_VIEWER_CHANNEL,
        ]);
        expect(out[0].payload).toEqual(new Uint8Array([9, 9]));
        expect(decodeFleetLinkJson(out[1].payload, 1 << 20)).toEqual({
            type: 'logs.notice',
            text: 'rotated',
        });
    });

    it('tells a resume, and a close with its reason before closing the socket', () => {
        const h = setup('viewer');
        h.bridge.events.resume!(4);
        h.bridge.events.close!('resume_failed', 'the link to the computer dropped');
        expect(h.viewer.controls().slice(-2)).toEqual([
            { type: 'viewer.resumed', linkGeneration: 4 },
            {
                type: 'channel.close',
                channel: FLEET_LINK_VIEWER_CHANNEL,
                reason: 'resume_failed',
                hint: 'the link to the computer dropped',
            },
        ]);
        expect(h.viewer.closed).toEqual({
            code: FLEET_LINK_VIEWER_CLOSE_CODES.channelClosed,
            reason: 'resume_failed',
        });
    });

    it('holds what the node sends before the open is answered, and sends it after viewer.ready', () => {
        const viewer = new Viewer();
        const bridge = new FleetLinkViewerBridge({
            socket: viewer,
            family: 'session',
            target: 's-1',
            role: 'driver',
        });
        // The node answered ready and wrote at once; openChannel has not resolved yet.
        bridge.events.binary!(FLEET_LINK_FRAME_KINDS.DATA, new Uint8Array([1]));
        bridge.events.json!({ type: 'session.status', state: 'working' });
        expect(viewer.frames).toHaveLength(0);
        const channel = new Channel('session');
        bridge.attach(channel);
        const decoded = viewer.frames.map((frame) => decodeFleetLinkFrame(frame)!);
        expect(decoded.map((frame) => frame.channel)).toEqual([
            0,
            FLEET_LINK_VIEWER_CHANNEL,
            FLEET_LINK_VIEWER_CHANNEL,
        ]);
        expect(decodeFleetLinkControl(decoded[0].payload)).toMatchObject({ type: 'viewer.ready' });
    });

    it('explains a channel that could not be opened', () => {
        const viewer = new Viewer();
        const bridge = new FleetLinkViewerBridge({
            socket: viewer,
            family: 'logs',
            target: 'n',
            role: 'viewer',
        });
        bridge.fail({ code: 'consent_missing', hint: 'start the node with --manage on build-01' });
        expect(viewer.controls()).toEqual([
            {
                type: 'channel.close',
                channel: FLEET_LINK_VIEWER_CHANNEL,
                reason: 'consent_missing',
                hint: 'start the node with --manage on build-01',
            },
        ]);
        expect(viewer.closed?.code).toBe(FLEET_LINK_VIEWER_CLOSE_CODES.channelClosed);
    });

    it('drops a viewer that stays slow for 5 s, and closes its channel', () => {
        const h = setup('viewer');
        h.viewer.buffered = 9 * 1024 * 1024;
        h.bridge.events.binary!(FLEET_LINK_FRAME_KINDS.DATA, new Uint8Array([1]));
        h.advance(4_000);
        h.bridge.tick();
        expect(h.viewer.closed).toBeNull();
        h.advance(1_000);
        h.bridge.tick();
        expect(h.viewer.closed).toEqual({
            code: FLEET_LINK_VIEWER_CLOSE_CODES.slowReader,
            reason: 'slow reader',
        });
        expect(h.channel.closedWith).toBe('normal');
    });

    it('drops a viewer at once past the hard buffer cap, and forgives one that caught up', () => {
        const fast = setup('viewer');
        fast.viewer.buffered = 9 * 1024 * 1024;
        fast.bridge.tick();
        fast.advance(3_000);
        fast.viewer.buffered = 0;
        fast.bridge.tick();
        fast.advance(10_000);
        fast.bridge.tick();
        expect(fast.viewer.closed).toBeNull();
        const stuck = setup('viewer');
        stuck.viewer.buffered = 33 * 1024 * 1024;
        stuck.bridge.events.binary!(FLEET_LINK_FRAME_KINDS.DATA, new Uint8Array([1]));
        expect(stuck.viewer.closed?.code).toBe(FLEET_LINK_VIEWER_CLOSE_CODES.slowReader);
    });
});
