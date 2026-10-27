import { describe, expect, it, vi } from 'vitest';
import {
    decodeFleetLinkFrame,
    decodeFleetLinkJson,
    encodeFleetLinkControl,
    encodeFleetLinkExit,
    encodeFleetLinkFrame,
    encodeFleetLinkJson,
    FLEET_LINK_FRAME_KINDS,
} from '@ever-works/contracts';
import { FleetSessionSocket, sessionCloseVerdict, type SessionSocketClose } from './session-socket';

/** A socket that records what is sent and lets the test play the server. */
class FakeSocket {
    static last: FakeSocket | null = null;
    readyState = 0;
    binaryType = 'blob';
    sent: Array<string | Uint8Array> = [];
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onclose: ((event: { code: number }) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(readonly url: string) {
        FakeSocket.last = this;
    }
    send(data: string | Uint8Array) {
        this.sent.push(data);
    }
    close(code = 1000) {
        this.readyState = 3;
        this.onclose?.({ code });
    }
    open() {
        this.readyState = 1;
        this.onopen?.();
    }
    serve(frame: Uint8Array | null) {
        this.onmessage?.({
            data: frame!.buffer.slice(frame!.byteOffset, frame!.byteOffset + frame!.byteLength),
        });
    }
}

function mintOk(role = 'driver') {
    return vi.fn(
        async () =>
            new Response(
                JSON.stringify({ token: 'tok', wsUrl: 'wss://api.test/ws/fleet/session/s1', role }),
                {
                    status: 200,
                },
            ),
    );
}

async function attached(role: 'viewer' | 'driver' = 'driver') {
    const events = {
        onBytes: vi.fn(),
        onAttached: vi.fn(),
        onExit: vi.fn(),
        onNotice: vi.fn(),
        onRefused: vi.fn(),
        onClosed: vi.fn(),
        onRole: vi.fn(),
    };
    const socket = new FleetSessionSocket(
        's1',
        role,
        events,
        {
            fetchImpl: mintOk(role) as unknown as typeof fetch,
            webSocketImpl: FakeSocket as unknown as typeof WebSocket,
        },
        () => ({ cols: 100, rows: 30 }),
    );
    await socket.open();
    const ws = FakeSocket.last!;
    ws.open();
    ws.serve(
        encodeFleetLinkControl({
            type: 'viewer.ready',
            family: 'session',
            target: 's1',
            role,
            linkGeneration: 1,
        }),
    );
    ws.serve(
        encodeFleetLinkJson(1, {
            requestId: 'browser-attach-1',
            result: { alive: true, cols: 100, rows: 30, exitCode: null },
        }),
    );
    return { socket, ws, events };
}

describe('FleetSessionSocket (FL-04 P1b)', () => {
    it('authenticates first, then asks the node to attach with the renderer size', async () => {
        const { ws, events } = await attached();
        expect(ws.binaryType).toBe('arraybuffer');
        expect(JSON.parse(ws.sent[0] as string)).toEqual({ type: 'auth', token: 'tok' });
        const request = decodeFleetLinkFrame(ws.sent[1] as Uint8Array)!;
        expect(request.channel).toBe(1);
        expect(decodeFleetLinkJson(request.payload)).toEqual({
            requestId: 'browser-attach-1',
            type: 'session.attach',
            params: { cols: 100, rows: 30 },
        });
        expect(events.onAttached).toHaveBeenCalledWith({
            alive: true,
            cols: 100,
            rows: 30,
            exitCode: null,
        });
    });

    it('renders DATA, reports EXIT and notices', async () => {
        const { ws, events, socket } = await attached();
        ws.serve(
            encodeFleetLinkFrame(1, FLEET_LINK_FRAME_KINDS.DATA, new TextEncoder().encode('hi')),
        );
        expect(events.onBytes).toHaveBeenCalledTimes(1);
        expect(socket.bytesIn).toBe(2);
        ws.serve(
            encodeFleetLinkJson(1, {
                type: 'session.notice',
                notice: 'paused',
                reason: 'fleet stop',
            }),
        );
        expect(events.onNotice).toHaveBeenCalledWith({
            type: 'session.notice',
            notice: 'paused',
            reason: 'fleet stop',
        });
        ws.serve(encodeFleetLinkFrame(1, FLEET_LINK_FRAME_KINDS.EXIT, encodeFleetLinkExit(3)!));
        expect(events.onExit).toHaveBeenCalledWith(3);
    });

    it('sends a driver’s keys and size as frames on channel 1', async () => {
        const { ws, socket } = await attached('driver');
        expect(socket.sendInput('ls\r')).toBe(true);
        const keys = decodeFleetLinkFrame(ws.sent[2] as Uint8Array)!;
        expect(keys.kind).toBe(FLEET_LINK_FRAME_KINDS.DATA);
        expect(new TextDecoder().decode(keys.payload)).toBe('ls\r');
        socket.sendResize(90, 20);
        expect(decodeFleetLinkFrame(ws.sent[3] as Uint8Array)!.kind).toBe(
            FLEET_LINK_FRAME_KINDS.RESIZE,
        );
    });

    it('never sends a watcher’s keys', async () => {
        const { ws, socket } = await attached('viewer');
        expect(socket.sendInput('rm -rf /\r')).toBe(false);
        socket.sendResize(90, 20);
        expect(ws.sent).toHaveLength(2);
    });

    it('reads the close and the reason that preceded it', async () => {
        const { ws, events } = await attached();
        ws.serve(
            encodeFleetLinkControl({
                type: 'channel.close',
                channel: 1,
                reason: 'kill_switch',
                hint: 'stopped',
            }),
        );
        ws.close(4013);
        const close = events.onClosed.mock.calls[0][0] as SessionSocketClose;
        expect(close).toMatchObject({
            code: 4013,
            linkReason: 'kill_switch',
            hint: 'stopped',
            wasAttached: true,
        });
        expect(sessionCloseVerdict(close, false)).toBe('refused');
    });

    it('answers a mint refusal without opening a socket', async () => {
        FakeSocket.last = null;
        const onClosed = vi.fn();
        const socket = new FleetSessionSocket(
            's1',
            'viewer',
            { onBytes: vi.fn(), onClosed },
            {
                fetchImpl: vi.fn(
                    async () =>
                        new Response(
                            JSON.stringify({
                                error: {
                                    code: 'limit_exceeded',
                                    hint: 'This session already has 5 watchers.',
                                },
                            }),
                            { status: 429 },
                        ),
                ) as unknown as typeof fetch,
                webSocketImpl: FakeSocket as unknown as typeof WebSocket,
            },
            () => ({ cols: 80, rows: 24 }),
        );
        await socket.open();
        expect(FakeSocket.last).toBeNull();
        const close = onClosed.mock.calls[0][0] as SessionSocketClose;
        expect(close.mintError?.code).toBe('limit_exceeded');
        expect(sessionCloseVerdict(close, false)).toBe('refused');
    });
});

describe('sessionCloseVerdict', () => {
    const base: SessionSocketClose = {
        code: 1006,
        linkReason: null,
        hint: null,
        mintError: null,
        attachError: null,
        wasAttached: true,
        exitCode: null,
    };

    it('retries a dropped link, ends on an exit, detaches when we closed it', () => {
        expect(sessionCloseVerdict(base, false)).toBe('retry');
        expect(sessionCloseVerdict({ ...base, linkReason: 'unreachable' }, false)).toBe('retry');
        expect(sessionCloseVerdict({ ...base, exitCode: 0 }, false)).toBe('ended');
        expect(sessionCloseVerdict(base, true)).toBe('detached');
    });

    it('reads an ended session from the mint refusal', () => {
        expect(
            sessionCloseVerdict(
                {
                    ...base,
                    mintError: {
                        code: 'invalid',
                        hint: 'ended',
                        details: { state: 'ended' },
                        status: 422,
                    },
                },
                false,
            ),
        ).toBe('ended');
    });
});
