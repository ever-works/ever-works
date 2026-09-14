import type { ComputerFrame } from '@ever-works/contracts';
import {
    COMPUTER_RELAY_ENDED_RETENTION_MS,
    COMPUTER_RELAY_IDLE_RETENTION_MS,
    COMPUTER_RELAY_SWEEP_INTERVAL_MS,
    ComputerRelayRegistry,
    type ComputerRelayClient,
} from './computer-relay.registry';

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

    it('retains a startup banner published while only the machine’s own leg is attached', () => {
        const relay = new ComputerRelayRegistry();
        const node = client('node', 'worker');
        relay.attach(SESSION, node);
        relay.publish(SESSION, { kind: 'error', message: 'No browser found on studio' });

        const first = client('first', 'viewer');
        relay.attach(SESSION, first);

        expect(first.received).toEqual([{ kind: 'error', message: 'No browser found on studio' }]);
        expect(node.received).toEqual([]);
    });

    it('never replays browser-directed output to a machine leg that (re)attaches', () => {
        const relay = new ComputerRelayRegistry();
        relay.publish(SESSION, { kind: 'error', message: 'starting the capture…' });
        relay.publish(SESSION, picture(0));
        relay.publish(SESSION, {
            kind: 'stats',
            nodeLocalTime: '2026-09-13T09:41:07+02:00',
            quality: 'sharp',
            effectiveQuality: 'sharp',
            fps: 8,
            backlog: 0,
            bytesOut: 10,
        });
        const node = client('node', 'worker');
        relay.attach(SESSION, node);
        relay.end(SESSION, 'closed-by-user');
        const again = client('node-again', 'worker');
        relay.attach(SESSION, again);

        expect(node.received).toEqual([]);
        expect(again.received).toEqual([]);
        expect(relay.getStatus(SESSION)).toMatchObject({ nodeAttached: true, viewerCount: 0 });
        // A machine leg is not a viewer: it does not count as having seen the end.
        expect(relay.canReclaim(SESSION)).toBe(false);
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

describe('ComputerRelayRegistry — the sweep releases what nothing uses', () => {
    const OTHER = '3a9d1f2a-9c7e-4b1a-8f0d-0a1b2c3d4e5f';
    const later = (ms: number) => Date.now() + ms;

    it('drops an ended view someone saw once they left, on the next pass', () => {
        const relay = new ComputerRelayRegistry();
        relay.publish(SESSION, picture(0));
        relay.attach(SESSION, client('v1', 'viewer'));
        relay.end(SESSION, 'closed-by-user');

        expect(relay.sweep()).toBe(0); // still attached
        relay.detach(SESSION, 'v1');
        expect(relay.sweep()).toBe(1);
        expect(relay.getStatus(SESSION).exists).toBe(false);
        expect(relay.size()).toBe(0);
    });

    it('keeps an ended view nobody saw for a late viewer, then drops it', () => {
        const relay = new ComputerRelayRegistry();
        relay.publish(SESSION, { kind: 'error', message: 'No browser found' });
        relay.end(SESSION, 'abandoned');

        expect(relay.sweep(later(COMPUTER_RELAY_ENDED_RETENTION_MS - 1_000))).toBe(0);
        expect(relay.getStatus(SESSION).ended).toBe(true);
        expect(relay.sweep(later(COMPUTER_RELAY_ENDED_RETENTION_MS + 1_000))).toBe(1);
        expect(relay.size()).toBe(0);
    });

    it('drops an idle view whose end never reached this replica, and keeps a busy one', () => {
        const relay = new ComputerRelayRegistry();
        relay.publish(SESSION, picture(0));
        relay.publish(OTHER, picture(0));
        relay.attach(OTHER, client('node', 'worker'));

        expect(relay.sweep(later(COMPUTER_RELAY_IDLE_RETENTION_MS - 1_000))).toBe(0);
        expect(relay.sweep(later(COMPUTER_RELAY_IDLE_RETENTION_MS + 1_000))).toBe(1);
        expect(relay.getStatus(SESSION).exists).toBe(false);
        // A view with any client attached — even only the machine leg — is never swept.
        expect(relay.getStatus(OTHER).exists).toBe(true);
    });

    it('runs on an unref’d timer from module init, and stops on destroy', () => {
        jest.useFakeTimers();
        try {
            const relay = new ComputerRelayRegistry();
            const sweep = jest.spyOn(relay, 'sweep');
            relay.onModuleInit();
            relay.onModuleInit(); // idempotent: one timer
            jest.advanceTimersByTime(COMPUTER_RELAY_SWEEP_INTERVAL_MS * 2);
            expect(sweep).toHaveBeenCalledTimes(2);
            relay.onModuleDestroy();
            jest.advanceTimersByTime(COMPUTER_RELAY_SWEEP_INTERVAL_MS * 2);
            expect(sweep).toHaveBeenCalledTimes(2);
        } finally {
            jest.useRealTimers();
        }
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

    it('reports a platform request delivered when a peer replica accepted it, even with no local state', () => {
        const bus = { publishRemote: jest.fn(() => true), onRemote: () => undefined };
        const relay = new ComputerRelayRegistry(bus);

        // Nothing about this view lives on this replica; the machine's leg is elsewhere.
        expect(relay.deliverToNode(SESSION, { kind: 'refresh' })).toBe(true);
        expect(bus.publishRemote).toHaveBeenCalledWith(
            SESSION,
            JSON.stringify({ kind: 'refresh' }),
        );
        expect(relay.getStatus(SESSION).exists).toBe(false);

        // A viewer here, the machine on a peer.
        relay.attach(SESSION, client('viewer', 'viewer'));
        expect(relay.deliverToNode(SESSION, { kind: 'quality', quality: 'steady' })).toBe(true);
    });

    it('reports not delivered when no local leg took it and the bus cannot say a peer did', () => {
        for (const publishRemote of [jest.fn(() => false), jest.fn(() => undefined)]) {
            const relay = new ComputerRelayRegistry({ publishRemote, onRemote: () => undefined });
            expect(relay.deliverToNode(SESSION, { kind: 'refresh' })).toBe(false);
            expect(publishRemote).toHaveBeenCalledTimes(1);
        }
        const throwing = new ComputerRelayRegistry({
            publishRemote: () => {
                throw new Error('bus down');
            },
            onRemote: () => undefined,
        });
        expect(throwing.deliverToNode(SESSION, { kind: 'refresh' })).toBe(false);
    });

    it('tells no peer about a request for a view that has ended here', () => {
        const bus = { publishRemote: jest.fn(() => true), onRemote: () => undefined };
        const relay = new ComputerRelayRegistry(bus);
        relay.end(SESSION, 'closed-by-user');
        bus.publishRemote.mockClear();
        expect(relay.deliverToNode(SESSION, { kind: 'refresh' })).toBe(false);
        expect(bus.publishRemote).not.toHaveBeenCalled();
    });
});

describe('ComputerRelayRegistry — taking control', () => {
    const HOLD_MS = 60_000;

    function controlled() {
        const relay = new ComputerRelayRegistry(undefined, true);
        const node = client('node', 'worker');
        const viewer = client('viewer', 'viewer');
        const driver = client('driver', 'driver');
        relay.attach(SESSION, node);
        relay.attach(SESSION, viewer);
        relay.attach(SESSION, driver);
        return { relay, node, viewer, driver };
    }

    const key: ComputerFrame = {
        kind: 'key',
        action: 'down',
        key: 'a',
        code: 'KeyA',
        modifiers: 0,
    };

    it('refuses a driving socket’s input until its view holds control, telling the sender', () => {
        const { relay, node, driver } = controlled();

        expect(relay.deliverInbound(SESSION, 'driver', key)).toBe(false);
        expect(node.received).toEqual([]);
        expect(driver.received).toEqual([
            { kind: 'error', message: 'You do not have control of this computer.' },
        ]);
    });

    it('forwards input while the view holds control, and refuses it once the hold has run out', () => {
        const { relay, node, driver } = controlled();
        relay.applyControl(SESSION, { held: true, untilMs: Date.now() + HOLD_MS });
        node.received.length = 0;
        driver.received.length = 0;

        expect(relay.deliverInbound(SESSION, 'driver', key)).toBe(true);
        expect(node.received).toEqual([key]);

        relay.applyControl(SESSION, { held: true, untilMs: Date.now() - 1 });
        expect(relay.deliverInbound(SESSION, 'driver', key)).toBe(false);
        expect(node.received).toEqual([key]);
        expect(driver.received.at(-1)).toMatchObject({ kind: 'error' });
    });

    it('never lets a watching socket inject input, even into a view that holds control', () => {
        const { relay, node, viewer } = controlled();
        relay.applyControl(SESSION, { held: true, untilMs: Date.now() + HOLD_MS });
        node.received.length = 0;

        expect(relay.deliverInbound(SESSION, 'viewer', key)).toBe(false);
        expect(node.received).toEqual([]);
        expect(viewer.received.at(-1)).toMatchObject({ kind: 'error' });
    });

    it('tells the view’s sockets and the machine when control is taken and given back, once each', () => {
        const { relay, node, viewer, driver } = controlled();

        relay.applyControl(SESSION, { held: true, untilMs: Date.now() + HOLD_MS });
        relay.applyControl(SESSION, { held: true, untilMs: Date.now() + 2 * HOLD_MS });
        relay.applyControl(SESSION, { held: false, untilMs: null });

        const modes = [
            { kind: 'mode', mode: 'controlling' },
            { kind: 'mode', mode: 'watching' },
        ];
        expect(node.received).toEqual(modes);
        expect(viewer.received).toEqual(modes);
        expect(driver.received).toEqual(modes);
        expect(relay.deliverInbound(SESSION, 'driver', key)).toBe(false);
    });

    it('keeps a machine leg that rejoins, and a browser that attaches, in the controlling mode', () => {
        const { relay } = controlled();
        relay.applyControl(SESSION, { held: true, untilMs: Date.now() + HOLD_MS });

        const rejoined = client('node-again', 'worker');
        relay.attach(SESSION, rejoined);
        expect(rejoined.received).toEqual([{ kind: 'mode', mode: 'controlling' }]);

        const late = client('late', 'viewer');
        relay.attach(SESSION, late);
        expect(late.received).toEqual([{ kind: 'mode', mode: 'controlling' }]);
    });

    it('forgets control when the view ends, and creates no state for a release it never saw', () => {
        const { relay, driver } = controlled();
        relay.applyControl(SESSION, { held: true, untilMs: Date.now() + HOLD_MS });
        relay.end(SESSION, 'closed-by-user');
        expect(relay.getControl(SESSION)).toBeNull();
        expect(driver.received.at(-1)).toMatchObject({ kind: 'end' });
        expect(relay.deliverInbound(SESSION, 'driver', key)).toBe(false);

        relay.applyControl('never-seen', { held: false, untilMs: null });
        expect(relay.getStatus('never-seen').exists).toBe(false);
    });

    it('answers a control frame over the socket with where control is taken instead', () => {
        const { relay, node, driver } = controlled();
        expect(
            relay.deliverInbound(SESSION, 'driver', { kind: 'control', action: 'release' }),
        ).toBe(false);
        expect(node.received).toEqual([]);
        expect(driver.received.at(-1)).toMatchObject({ kind: 'error' });
    });
});
