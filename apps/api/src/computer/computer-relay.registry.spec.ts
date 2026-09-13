import type { ComputerFrame } from '@ever-works/contracts';
import { ComputerRelayRegistry, type ComputerRelayClient } from './computer-relay.registry';

/**
 * The live-view relay. What a viewer relies on, pinned: a re-attaching
 * viewer always gets a picture or an explicit banner, never a blank stage;
 * the end of a view is always learnable; and nothing a watching browser
 * sends ever reaches the machine as input.
 */

const SESSION = '2f9d1f2a-9c7e-4b1a-8f0d-0a1b2c3d4e5f';

const picture = (seq: number, keyframe = true): ComputerFrame => ({
    kind: 'frame',
    seq,
    keyframe,
    width: 1280,
    height: 720,
    mime: 'image/jpeg',
    data: 'aGk=',
});

function client(id: string, role: ComputerRelayClient['role']) {
    const received: Array<Record<string, unknown>> = [];
    const handle: ComputerRelayClient & { received: typeof received } = {
        id,
        role,
        received,
        send: (wire: string) => {
            received.push(JSON.parse(wire));
        },
    };
    return handle;
}

describe('ComputerRelayRegistry — replay on attach', () => {
    it('replays banners, then the latest keyframe, then stats, then the pinned end — in that order', () => {
        const relay = new ComputerRelayRegistry();
        relay.publish(SESSION, { kind: 'error', message: 'starting the capture…' });
        relay.publish(SESSION, picture(0));
        relay.publish(SESSION, picture(1, false));
        relay.publish(SESSION, picture(2));
        relay.publish(SESSION, {
            kind: 'stats',
            nodeLocalTime: '2026-09-13T09:41:07+02:00',
            quality: 'sharp',
            effectiveQuality: 'sharp',
            fps: 8,
            backlog: 0,
            bytesOut: 10,
        });
        relay.end(SESSION, 'closed-by-user');

        const viewer = client('v1', 'viewer');
        relay.attach(SESSION, viewer);

        expect(viewer.received.map((frame) => frame.kind)).toEqual([
            'error',
            'frame',
            'stats',
            'end',
        ]);
        // ONE keyframe, the latest — not a history of pictures.
        expect(viewer.received[1]).toMatchObject({ seq: 2, keyframe: true });
        expect(viewer.received[3]).toEqual({ kind: 'end', reason: 'closed-by-user' });
    });

    it('gives a late viewer of a view that never produced a picture its explanation', () => {
        const relay = new ComputerRelayRegistry();
        relay.publish(SESSION, { kind: 'error', message: 'No browser found on studio' });
        const viewer = client('late', 'viewer');
        relay.attach(SESSION, viewer);
        expect(viewer.received).toEqual([{ kind: 'error', message: 'No browser found on studio' }]);
    });

    it('does not retain an error banner published while someone is watching', () => {
        const relay = new ComputerRelayRegistry();
        relay.attach(SESSION, client('v1', 'viewer'));
        relay.publish(SESSION, { kind: 'error', message: 'transient' });
        const late = client('v2', 'viewer');
        relay.attach(SESSION, late);
        expect(late.received).toEqual([]);
    });
});

describe('ComputerRelayRegistry — publish discipline', () => {
    it('drops a duplicate or stale picture seq', () => {
        const relay = new ComputerRelayRegistry();
        const viewer = client('v1', 'viewer');
        relay.attach(SESSION, viewer);
        expect(relay.publish(SESSION, picture(5))).toBe(true);
        expect(relay.publish(SESSION, picture(5))).toBe(false);
        expect(relay.publish(SESSION, picture(4))).toBe(false);
        expect(viewer.received).toHaveLength(1);
    });

    it('refuses every browser-direction kind on the publish leg', () => {
        const relay = new ComputerRelayRegistry();
        expect(
            relay.publish(SESSION, { kind: 'pointer', action: 'down', x: 1, y: 1, button: 'left' }),
        ).toBe(false);
        expect(relay.publish(SESSION, { kind: 'refresh' })).toBe(false);
        expect(relay.publish(SESSION, { kind: 'mode', mode: 'watching' })).toBe(false);
    });

    it('accepts nothing after the end, so no picture renders after "session ended"', () => {
        const relay = new ComputerRelayRegistry();
        relay.end(SESSION, 'stopped');
        expect(relay.publish(SESSION, picture(9))).toBe(false);
        expect(relay.end(SESSION, 'error')).toBe(false);
        expect(relay.getStatus(SESSION)).toMatchObject({ ended: true, endReason: 'stopped' });
    });

    it('never sends pictures to the machine’s own leg', () => {
        const relay = new ComputerRelayRegistry();
        const node = client('node', 'worker');
        relay.attach(SESSION, node);
        relay.publish(SESSION, picture(0));
        expect(node.received).toEqual([]);
    });

    it('drops a client whose send throws, without disturbing the others', () => {
        const relay = new ComputerRelayRegistry();
        const good = client('good', 'viewer');
        relay.attach(SESSION, good);
        relay.attach(SESSION, {
            id: 'dead',
            role: 'viewer',
            send: () => {
                throw new Error('socket closed');
            },
        });
        relay.publish(SESSION, picture(0));
        expect(good.received).toHaveLength(1);
        expect(relay.getStatus(SESSION).clientCount).toBe(1);
    });
});

describe('ComputerRelayRegistry — role-checked inbound', () => {
    function withNode() {
        const relay = new ComputerRelayRegistry();
        const node = client('node', 'worker');
        const viewer = client('viewer', 'viewer');
        const other = client('other', 'viewer');
        relay.attach(SESSION, node);
        relay.attach(SESSION, viewer);
        relay.attach(SESSION, other);
        return { relay, node, viewer, other };
    }

    it.each<ComputerFrame>([
        { kind: 'pointer', action: 'down', x: 10, y: 10, button: 'left' },
        { kind: 'key', action: 'down', key: 'a', code: 'KeyA', modifiers: 0 },
        { kind: 'text', text: 'hunter2' },
        { kind: 'scroll', x: 1, y: 1, dx: 0, dy: 120 },
    ])('answers a watching socket’s %o with an error and never forwards it', (frame) => {
        const { relay, node, viewer, other } = withNode();

        expect(relay.deliverInbound(SESSION, 'viewer', frame)).toBe(false);

        expect(node.received).toEqual([]);
        expect(other.received).toEqual([]);
        expect(viewer.received).toHaveLength(1);
        expect(viewer.received[0].kind).toBe('error');
    });

    it('forwards a controlling socket’s input to the machine only', () => {
        const { relay, node, other } = withNode();
        const driver = client('driver', 'driver');
        relay.attach(SESSION, driver);

        expect(relay.deliverInbound(SESSION, 'driver', { kind: 'text', text: 'hi' })).toBe(true);

        expect(node.received).toEqual([{ kind: 'text', text: 'hi' }]);
        expect(other.received).toEqual([]);
    });

    it('passes a viewer’s refresh and quality requests to the machine', () => {
        const { relay, node } = withNode();
        expect(relay.deliverInbound(SESSION, 'viewer', { kind: 'refresh' })).toBe(true);
        expect(
            relay.deliverInbound(SESSION, 'viewer', { kind: 'quality', quality: 'steady' }),
        ).toBe(true);
        expect(node.received).toEqual([
            { kind: 'refresh' },
            { kind: 'quality', quality: 'steady' },
        ]);
    });

    it('refuses a control request while taking control is not available, telling the sender', () => {
        const { relay, node, viewer } = withNode();
        expect(
            relay.deliverInbound(SESSION, 'viewer', { kind: 'control', action: 'request' }),
        ).toBe(false);
        expect(node.received).toEqual([]);
        expect(viewer.received[0].kind).toBe('error');
    });

    it('ignores inbound from the machine’s own leg and from unknown senders', () => {
        const { relay, node } = withNode();
        expect(relay.deliverInbound(SESSION, 'node', { kind: 'refresh' })).toBe(false);
        expect(relay.deliverInbound(SESSION, 'nobody', { kind: 'refresh' })).toBe(false);
        expect(relay.deliverInbound('unknown-session', 'viewer', { kind: 'refresh' })).toBe(false);
        expect(node.received).toEqual([]);
    });

    it('reports whether a platform request reached an attached machine', () => {
        const relay = new ComputerRelayRegistry();
        relay.attach(SESSION, client('viewer', 'viewer'));
        expect(relay.deliverToNode(SESSION, { kind: 'refresh' })).toBe(false);
        relay.attach(SESSION, client('node', 'worker'));
        expect(relay.deliverToNode(SESSION, { kind: 'refresh' })).toBe(true);
    });
});

describe('ComputerRelayRegistry — status and reclaim', () => {
    it('counts browsers and the machine leg apart', () => {
        const relay = new ComputerRelayRegistry();
        relay.attach(SESSION, client('node', 'worker'));
        relay.attach(SESSION, client('v1', 'viewer'));
        relay.publish(SESSION, picture(3));
        expect(relay.getStatus(SESSION)).toEqual({
            exists: true,
            ended: false,
            endReason: null,
            clientCount: 2,
            viewerCount: 1,
            nodeAttached: true,
            hasKeyframe: true,
            lastSeq: 3,
        });
        expect(relay.getStatus('missing').exists).toBe(false);
    });

    it('reclaims only when nobody is attached, the view ended, and someone saw it', () => {
        const relay = new ComputerRelayRegistry();
        relay.end(SESSION, 'abandoned');
        expect(relay.canReclaim(SESSION)).toBe(false);
        expect(relay.canReclaim(SESSION, { force: true })).toBe(true);

        const viewer = client('v1', 'viewer');
        relay.attach(SESSION, viewer);
        expect(relay.canReclaim(SESSION)).toBe(false);
        relay.detach(SESSION, 'v1');
        expect(relay.reclaim(SESSION)).toBe(true);
        expect(relay.getStatus(SESSION).exists).toBe(false);
    });

    it('never reclaims a view that has not ended', () => {
        const relay = new ComputerRelayRegistry();
        relay.attach(SESSION, client('v1', 'viewer'));
        relay.detach(SESSION, 'v1');
        expect(relay.reclaim(SESSION, { force: true })).toBe(false);
    });
});

describe('ComputerRelayRegistry — cross-replica seam', () => {
    it('publishes accepted frames to the bus and fans peer frames out locally without echoing them', () => {
        let remoteHandler: ((sessionId: string, wire: string) => void) | null = null;
        const bus = {
            publishRemote: jest.fn(),
            onRemote: (handler: (sessionId: string, wire: string) => void) => {
                remoteHandler = handler;
            },
        };
        const relay = new ComputerRelayRegistry(bus);
        const viewer = client('v1', 'viewer');
        relay.attach(SESSION, viewer);

        relay.publish(SESSION, picture(0));
        expect(bus.publishRemote).toHaveBeenCalledTimes(1);

        remoteHandler!(SESSION, JSON.stringify(picture(1)));
        expect(viewer.received.map((frame) => frame.seq)).toEqual([0, 1]);
        expect(bus.publishRemote).toHaveBeenCalledTimes(1);
    });

    it('survives a bus that throws', () => {
        const relay = new ComputerRelayRegistry({
            publishRemote: () => {
                throw new Error('bus down');
            },
            onRemote: () => undefined,
        });
        expect(relay.publish(SESSION, picture(0))).toBe(true);
    });
});
