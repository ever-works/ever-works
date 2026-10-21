import {
    FLEET_LINK_COMPUTER_LEG_FRAME,
    FLEET_LINK_COMPUTER_LEG_REQUEST,
    type FleetLinkExtensionMessage,
} from '@ever-works/contracts';
import { ComputerLinkLegBridge, COMPUTER_LINK_LEG_JOB } from './computer-link-leg.bridge';

/**
 * Fleet node link (FL-02, T-22, spec FR-34) — the platform half of a live
 * view's leg over the link: a node's `computer.leg` request opens a `desktop`
 * channel only for a live view pinned to THAT node, the channel becomes the
 * view's `worker` client on the relay, and closing it detaches the client.
 */

const NODE = '11111111-2222-4333-8444-555555555555';
const OTHER_NODE = '99999999-2222-4333-8444-555555555555';
const SESSION = '5b0f2c1e-3a4d-4e5f-8a6b-7c8d9e0f1a2b';

type Listener = (nodeId: string, message: FleetLinkExtensionMessage) => void;

function fakeChannel() {
    const sent: Array<Record<string, unknown>> = [];
    const listeners: Array<{ close?: () => void }> = [];
    const channel = {
        nodeId: NODE,
        channel: 4,
        family: 'desktop' as const,
        isOpen: true,
        isClosed: false,
        linkGeneration: 1,
        request: jest.fn(),
        sendJson: jest.fn((message: Record<string, unknown>) => {
            sent.push(message);
            return true;
        }),
        sendBinary: jest.fn(() => true),
        close: jest.fn(),
        listen: jest.fn((events: { close?: () => void }) => {
            listeners.push(events);
            return () => undefined;
        }),
    };
    return {
        channel,
        sent,
        dropped: () => {
            channel.isClosed = true;
            channel.isOpen = false;
            for (const events of listeners) events.close?.();
        },
    };
}

function setup(
    options: { row?: { status: string } | null; stopped?: boolean; openFails?: boolean } = {},
) {
    let listener: Listener | null = null;
    const linkRegistry = {
        onNodeControl: jest.fn((type: string, fn: Listener) => {
            if (type === FLEET_LINK_COMPUTER_LEG_REQUEST) listener = fn;
            return () => undefined;
        }),
    };
    const fake = fakeChannel();
    const link = {
        openChannel: jest.fn(async () => {
            if (options.openFails)
                throw Object.assign(new Error('refused'), { code: 'kill_switch' });
            return fake.channel;
        }),
    };
    const row = options.row === undefined ? { status: 'live' } : options.row;
    const sessions = {
        findForNode: jest.fn(async (sessionId: string, nodeId: string) =>
            sessionId === SESSION && nodeId === NODE ? row : null,
        ),
        expireIfDue: jest.fn(async (value: unknown) => value),
        endIfStopped: jest.fn(async () => options.stopped === true),
    };
    const attached: Array<{
        sessionId: string;
        client: { id: string; role: string; send: (wire: string) => void };
    }> = [];
    const relay = {
        attach: jest.fn(
            (
                sessionId: string,
                client: { id: string; role: string; send: (wire: string) => void },
            ) => {
                attached.push({ sessionId, client });
            },
        ),
        detach: jest.fn(),
    };
    const bridge = new ComputerLinkLegBridge(
        sessions as never,
        relay as never,
        linkRegistry as never,
        link as never,
    );
    bridge.onModuleInit();
    return {
        bridge,
        link,
        relay,
        attached,
        fake,
        ask: (nodeId: string, sessionId: unknown = SESSION) =>
            listener?.(nodeId, {
                type: FLEET_LINK_COMPUTER_LEG_REQUEST,
                sessionId,
            } as FleetLinkExtensionMessage),
    };
}

describe('ComputerLinkLegBridge', () => {
    const saved = { fleet: process.env.FLEET_ENABLED, link: process.env.FLEET_NODE_LINK_ENABLED };
    beforeEach(() => {
        process.env.FLEET_ENABLED = 'true';
        process.env.FLEET_NODE_LINK_ENABLED = 'true';
    });
    afterEach(() => {
        if (saved.fleet === undefined) delete process.env.FLEET_ENABLED;
        else process.env.FLEET_ENABLED = saved.fleet;
        if (saved.link === undefined) delete process.env.FLEET_NODE_LINK_ENABLED;
        else process.env.FLEET_NODE_LINK_ENABLED = saved.link;
    });

    it('opens a desktop channel for a live view pinned to the asking node and attaches it as the worker', async () => {
        const h = setup();
        expect(
            await h.bridge.onLegRequest(NODE, {
                type: FLEET_LINK_COMPUTER_LEG_REQUEST,
                sessionId: SESSION,
            }),
        ).toBe(true);
        expect(h.link.openChannel).toHaveBeenCalledWith({
            nodeId: NODE,
            family: 'desktop',
            params: { source: 'browser', sessionId: SESSION },
            caller: { kind: 'system', job: COMPUTER_LINK_LEG_JOB },
            requirement: { target: SESSION },
        });
        expect(h.attached).toHaveLength(1);
        expect(h.attached[0].sessionId).toBe(SESSION);
        expect(h.attached[0].client.role).toBe('worker');

        // A relay frame for the machine rides the channel in the computer frame encoding.
        h.attached[0].client.send('{"kind":"refresh"}');
        expect(h.fake.sent).toEqual([
            { type: FLEET_LINK_COMPUTER_LEG_FRAME, data: '{"kind":"refresh"}' },
        ]);
        expect(h.bridge.size).toBe(1);
    });

    it('detaches the worker when the channel closes', async () => {
        const h = setup();
        await h.bridge.onLegRequest(NODE, {
            type: FLEET_LINK_COMPUTER_LEG_REQUEST,
            sessionId: SESSION,
        });
        h.fake.dropped();
        expect(h.relay.detach).toHaveBeenCalledWith(SESSION, h.attached[0].client.id);
        expect(h.bridge.size).toBe(0);
    });

    it('never attaches a node to a view pinned to another machine, an ended view or a stopped fleet', async () => {
        const stranger = setup();
        expect(
            await stranger.bridge.onLegRequest(OTHER_NODE, {
                type: FLEET_LINK_COMPUTER_LEG_REQUEST,
                sessionId: SESSION,
            }),
        ).toBe(false);
        expect(stranger.link.openChannel).not.toHaveBeenCalled();

        const ended = setup({ row: { status: 'ended' } });
        expect(
            await ended.bridge.onLegRequest(NODE, {
                type: FLEET_LINK_COMPUTER_LEG_REQUEST,
                sessionId: SESSION,
            }),
        ).toBe(false);
        const stopped = setup({ stopped: true });
        expect(
            await stopped.bridge.onLegRequest(NODE, {
                type: FLEET_LINK_COMPUTER_LEG_REQUEST,
                sessionId: SESSION,
            }),
        ).toBe(false);
        expect(ended.link.openChannel).not.toHaveBeenCalled();
        expect(stopped.link.openChannel).not.toHaveBeenCalled();
    });

    it('stays silent on a refused open, a malformed id, or links switched off (the node keeps its own leg)', async () => {
        const refused = setup({ openFails: true });
        expect(
            await refused.bridge.onLegRequest(NODE, {
                type: FLEET_LINK_COMPUTER_LEG_REQUEST,
                sessionId: SESSION,
            }),
        ).toBe(false);
        expect(refused.attached).toHaveLength(0);

        const malformed = setup();
        expect(
            await malformed.bridge.onLegRequest(NODE, {
                type: FLEET_LINK_COMPUTER_LEG_REQUEST,
                sessionId: 'not-a-uuid',
            }),
        ).toBe(false);

        process.env.FLEET_NODE_LINK_ENABLED = 'false';
        const off = setup();
        expect(
            await off.bridge.onLegRequest(NODE, {
                type: FLEET_LINK_COMPUTER_LEG_REQUEST,
                sessionId: SESSION,
            }),
        ).toBe(false);
        expect(off.link.openChannel).not.toHaveBeenCalled();
    });

    it('listens on the holder replica for the node’s channel-0 request', async () => {
        const h = setup();
        h.ask(NODE);
        await new Promise((resolve) => setImmediate(resolve));
        expect(h.link.openChannel).toHaveBeenCalledTimes(1);
    });

    it('does nothing without the link module', () => {
        const bridge = new ComputerLinkLegBridge({} as never, {} as never);
        expect(() => bridge.onModuleInit()).not.toThrow();
        expect(() => bridge.onModuleDestroy()).not.toThrow();
    });
});
