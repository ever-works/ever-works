import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import type { Duplex } from 'stream';
import { WebSocket } from 'ws';
import {
    decodeFleetLinkControl,
    decodeFleetLinkFrame,
    encodeFleetLinkControl,
    type FleetLinkControlMessage,
    type FleetLinkExtensionMessage,
} from '@ever-works/contracts';
import { TerminalAttachService } from '../../terminal/terminal-attach.service';
import { FleetLinkGatewayService } from '../fleet-link-gateway.service';
import { FleetLinkRegistry } from '../fleet-link.registry';
import { FleetLinkTokenService } from '../fleet-link-token.service';
import { hello, NODE_ID, OWNER } from './link-test-kit';

/**
 * The link gateway over real sockets (FL-02, spec FR-4, FR-5, U2, U9,
 * ACC-FL02-02, -03, -05, -12): the first frame is the hello, every credential
 * refusal is the same 4001, a storm is refused, silence closes, the kill
 * switch pauses.
 */

const OTHER_NODE = '11111111-2222-4333-8444-555555555555';
const ORIGINAL = {
    secret: process.env.TERMINAL_ATTACH_SECRET,
    link: process.env.FLEET_NODE_LINK_ENABLED,
    fleet: process.env.FLEET_ENABLED,
};

beforeEach(() => {
    process.env.TERMINAL_ATTACH_SECRET = 'a-test-secret-of-sufficient-length';
    process.env.FLEET_NODE_LINK_ENABLED = 'true';
    delete process.env.FLEET_ENABLED;
});

afterAll(() => {
    for (const [key, value] of [
        ['TERMINAL_ATTACH_SECRET', ORIGINAL.secret],
        ['FLEET_NODE_LINK_ENABLED', ORIGINAL.link],
        ['FLEET_ENABLED', ORIGINAL.fleet],
    ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
});

interface Harness {
    gateway: FleetLinkGatewayService;
    registry: FleetLinkRegistry;
    tokens: FleetLinkTokenService;
    killSwitch: { isStopped: jest.Mock };
    nodes: { findById: jest.Mock; findStatusesByIds: jest.Mock };
    audit: { tryRecord: jest.Mock };
    url: string;
    close(): Promise<void>;
}

async function start(nodeStatus = 'online'): Promise<Harness> {
    const server: Server = createServer();
    const registry = new FleetLinkRegistry();
    const tokens = new FleetLinkTokenService(new TerminalAttachService());
    const killSwitch = { isStopped: jest.fn(async () => false) };
    const nodes = {
        findById: jest.fn(async (id: string) =>
            id === NODE_ID || id === OTHER_NODE
                ? { id, userId: OWNER, name: 'build-01', kind: 'node', status: nodeStatus }
                : null,
        ),
        findStatusesByIds: jest.fn(async (ids: string[]) =>
            ids.map((id) => ({ id, status: nodeStatus })),
        ),
    };
    const audit = { tryRecord: jest.fn(async () => true) };
    const gateway = new FleetLinkGatewayService(
        { httpAdapter: { getHttpServer: () => server } } as never,
        tokens,
        registry,
        nodes as never,
        killSwitch as never,
        audit as never,
    );
    gateway.onApplicationBootstrap();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return {
        gateway,
        registry,
        tokens,
        killSwitch,
        nodes,
        audit,
        url: `ws://127.0.0.1:${port}`,
        close: async () => {
            gateway.onApplicationShutdown();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}

/** Open a socket, send `first`, and collect control messages until it closes or `until` matches. */
function exchange(
    url: string,
    first: Uint8Array | string | null,
    until?: (message: FleetLinkControlMessage | FleetLinkExtensionMessage) => boolean,
): Promise<{
    messages: Array<FleetLinkControlMessage | FleetLinkExtensionMessage>;
    code: number | null;
    socket: WebSocket;
}> {
    return new Promise((resolve, reject) => {
        const socket = new WebSocket(url);
        const messages: Array<FleetLinkControlMessage | FleetLinkExtensionMessage> = [];
        let done = false;
        const finish = (code: number | null) => {
            if (done) return;
            done = true;
            resolve({ messages, code, socket });
        };
        socket.on('open', () => {
            if (first !== null) socket.send(first);
        });
        socket.on('message', (data: Buffer) => {
            const frame = decodeFleetLinkFrame(new Uint8Array(data));
            const message = frame ? decodeFleetLinkControl(frame.payload) : null;
            if (!message) return;
            messages.push(message);
            if (until?.(message)) finish(null);
        });
        socket.on('close', (code) => finish(code));
        socket.on('error', (error) => (done ? undefined : reject(error)));
    });
}

const helloFrame = (overrides: Parameters<typeof hello>[0]) =>
    encodeFleetLinkControl(hello(overrides))!;
const isReady = (message: { type: string }) => message.type === 'link.ready';

describe('FleetLinkGatewayService', () => {
    let h: Harness;

    afterEach(async () => {
        await h?.close();
    });

    it('answers a valid hello with ready and registers the link (FR-4)', async () => {
        h = await start();
        const { token } = h.tokens.mint(NODE_ID);
        const { messages, socket } = await exchange(
            `${h.url}/ws/fleet/link`,
            helloFrame({ token }),
            isReady,
        );
        expect(messages[0]).toMatchObject({
            type: 'link.ready',
            linkGeneration: 1,
            resumed: [],
            closed: [],
        });
        expect(h.registry.isConnected(NODE_ID)).toBe(true);
        expect(h.audit.tryRecord).toHaveBeenCalledWith(
            expect.objectContaining({
                action: 'node.link.connect',
                nodeId: NODE_ID,
                ownerUserId: OWNER,
            }),
        );
        socket.close();
        // The close travels the loopback socket: wait for it, bounded (a fixed
        // 50 ms flaked under parallel load).
        for (let waited = 0; waited < 5_000 && h.registry.isConnected(NODE_ID); waited += 10) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(h.registry.isConnected(NODE_ID)).toBe(false);
        expect(h.audit.tryRecord).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'node.link.disconnect' }),
        );
    });

    it('refuses a replayed token, another node’s token and a re-keyed (enrolling) node with the same 4001 (FR-5)', async () => {
        h = await start();
        const { token } = h.tokens.mint(NODE_ID);
        const first = await exchange(`${h.url}/ws/fleet/link`, helloFrame({ token }), isReady);
        first.socket.close();
        expect((await exchange(`${h.url}/ws/fleet/link`, helloFrame({ token }))).code).toBe(4001);
        const foreign = h.tokens.mint(OTHER_NODE).token;
        expect(
            (await exchange(`${h.url}/ws/fleet/link`, helloFrame({ token: foreign }))).code,
        ).toBe(4001);
        expect(
            (await exchange(`${h.url}/ws/fleet/link`, helloFrame({ token: 'garbage.token' }))).code,
        ).toBe(4001);
        await h.close();

        h = await start('enrolling');
        const rekeyed = h.tokens.mint(NODE_ID).token;
        expect(
            (await exchange(`${h.url}/ws/fleet/link`, helloFrame({ token: rekeyed }))).code,
        ).toBe(4001);
    });

    it('lets a disabled node keep its link: disabling drains work, it does not sever the machine', async () => {
        h = await start('disabled');
        const { messages, socket } = await exchange(
            `${h.url}/ws/fleet/link`,
            helloFrame({ token: h.tokens.mint(NODE_ID).token }),
            isReady,
        );
        expect(messages[0]).toMatchObject({ type: 'link.ready' });
        expect(h.registry.isConnected(NODE_ID)).toBe(true);
        socket.close();
    });

    it('closes the link of a node whose row is gone or re-keyed on the next re-read, 4001', async () => {
        h = await start();
        const { socket } = await exchange(
            `${h.url}/ws/fleet/link`,
            helloFrame({ token: h.tokens.mint(NODE_ID).token }),
            isReady,
        );
        const closed = new Promise<number>((resolve) =>
            socket.on('close', (code) => resolve(code)),
        );
        // A read that fails closes nothing.
        h.nodes.findStatusesByIds.mockRejectedValueOnce(new Error('db down'));
        expect(await h.gateway.sweepNodes()).toBe(0);
        expect(h.registry.isConnected(NODE_ID)).toBe(true);
        h.nodes.findStatusesByIds.mockResolvedValueOnce([]);
        expect(await h.gateway.sweepNodes()).toBe(1);
        expect(await closed).toBe(4001);
        expect(h.registry.isConnected(NODE_ID)).toBe(false);
    });

    it('refuses a large first frame before auth with 4001 — only a hello is expected', async () => {
        h = await start();
        const big = new Uint8Array(2 * 1024 * 1024);
        big[4] = 10;
        new DataView(big.buffer).setUint32(5, big.byteLength - 9, false);
        expect((await exchange(`${h.url}/ws/fleet/link`, big)).code).toBe(4001);
    });

    it('closes only the channel a frame over 16 MiB was aimed at; the link stays up (U5)', async () => {
        h = await start();
        const { socket } = await exchange(
            `${h.url}/ws/fleet/link`,
            helloFrame({ token: h.tokens.mint(NODE_ID).token }),
            isReady,
        );
        const seen: Array<{ type: string; [key: string]: unknown }> = [];
        socket.on('message', (data: Buffer) => {
            const frame = decodeFleetLinkFrame(new Uint8Array(data));
            const message = frame ? decodeFleetLinkControl(frame.payload) : null;
            if (!message) return;
            seen.push(message as never);
            if (message.type === 'channel.open') {
                socket.send(
                    encodeFleetLinkControl({
                        type: 'channel.ready',
                        channel: message.channel,
                        requestId: message.requestId,
                    })!,
                );
            }
        });
        const handle = await h.registry.openChannel({
            nodeId: NODE_ID,
            family: 'logs',
            requirement: { consent: 'manage', actionFamily: 'logs', stateChanging: false },
            requestedBy: `user:${OWNER}`,
        });
        const oversized = new Uint8Array(16 * 1024 * 1024 + 16);
        const view = new DataView(oversized.buffer);
        view.setUint32(0, handle.channel, false);
        view.setUint8(4, 1);
        view.setUint32(5, oversized.byteLength - 9, false);
        socket.send(oversized);
        // 16 MiB takes a moment over loopback: wait for the close, bounded.
        for (let waited = 0; waited < 10_000; waited += 50) {
            if (seen.some((message) => message.type === 'channel.close')) break;
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(seen.at(-1)).toEqual({
            type: 'channel.close',
            channel: handle.channel,
            reason: 'invalid',
            hint: 'frame over 16 MiB',
        });
        expect(handle.isClosed).toBe(true);
        expect(h.registry.isConnected(NODE_ID)).toBe(true);
        socket.close();
    }, 20_000);

    it('refuses a first frame that is not a hello, and text, with 4001', async () => {
        h = await start();
        expect(
            (
                await exchange(
                    `${h.url}/ws/fleet/link`,
                    encodeFleetLinkControl({ type: 'link.ping', t: 1 })!,
                )
            ).code,
        ).toBe(4001);
        expect((await exchange(`${h.url}/ws/fleet/link`, 'hello')).code).toBe(4001);
    });

    it('refuses a node that holds no consent that opens a link with 4012', async () => {
        h = await start();
        const { token } = h.tokens.mint(NODE_ID);
        const result = await exchange(
            `${h.url}/ws/fleet/link`,
            helloFrame({
                token,
                consents: { work: false, attend: false, manage: false, usageScan: true },
            }),
        );
        expect(result.code).toBe(4012);
    });

    it('refuses the eleventh hello in a minute with 4008 (U9)', async () => {
        h = await start();
        for (let i = 0; i < 10; i += 1) {
            const { socket } = await exchange(
                `${h.url}/ws/fleet/link`,
                helloFrame({ token: h.tokens.mint(NODE_ID).token }),
                isReady,
            );
            socket.close();
        }
        const storm = await exchange(
            `${h.url}/ws/fleet/link`,
            helloFrame({ token: h.tokens.mint(NODE_ID).token }),
        );
        expect(storm.code).toBe(4008);
    });

    it('closes an unauthenticated socket after 5 s with 4001', async () => {
        h = await start();
        const result = await exchange(`${h.url}/ws/fleet/link`, null);
        expect(result.code).toBe(4001);
    }, 15_000);

    it('pauses every link while the kill switch is on and resumes without a reconnect (FR-26)', async () => {
        h = await start();
        const { socket, messages } = await exchange(
            `${h.url}/ws/fleet/link`,
            helloFrame({ token: h.tokens.mint(NODE_ID).token }),
            isReady,
        );
        const seen: string[] = [];
        socket.on('message', (data: Buffer) => {
            const frame = decodeFleetLinkFrame(new Uint8Array(data));
            const message = frame ? decodeFleetLinkControl(frame.payload) : null;
            if (message) seen.push(message.type);
        });
        h.killSwitch.isStopped.mockResolvedValue(true);
        await h.gateway.tick();
        h.killSwitch.isStopped.mockResolvedValue(false);
        await h.gateway.tick();
        for (let waited = 0; waited < 5_000 && seen.length < 2; waited += 10) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(messages[0].type).toBe('link.ready');
        expect(seen).toEqual(['link.pause', 'link.resume']);
        expect(h.registry.isConnected(NODE_ID)).toBe(true);
        socket.close();
    });

    it('closes a link silent for 45 s with 4002 (FR-7)', async () => {
        h = await start();
        const { socket } = await exchange(
            `${h.url}/ws/fleet/link`,
            helloFrame({ token: h.tokens.mint(NODE_ID).token }),
            isReady,
        );
        const closed = new Promise<number>((resolve) =>
            socket.on('close', (code) => resolve(code)),
        );
        await h.gateway.tick(Date.now() + 45_000);
        expect([4002, 1006]).toContain(await closed);
        expect(h.registry.isConnected(NODE_ID)).toBe(false);
    });

    it('closes open links 4003 when node links are switched off (U2)', async () => {
        h = await start();
        const { socket } = await exchange(
            `${h.url}/ws/fleet/link`,
            helloFrame({ token: h.tokens.mint(NODE_ID).token }),
            isReady,
        );
        const closed = new Promise<number>((resolve) =>
            socket.on('close', (code) => resolve(code)),
        );
        process.env.FLEET_NODE_LINK_ENABLED = 'false';
        await h.gateway.tick();
        expect(await closed).toBe(4003);
    });
});

describe('FleetLinkGatewayService.handleUpgrade', () => {
    const gateway = () =>
        new FleetLinkGatewayService(
            { httpAdapter: { getHttpServer: () => undefined } } as never,
            {} as never,
            new FleetLinkRegistry(),
            {} as never,
            {} as never,
        );
    const upgrade = (target: FleetLinkGatewayService, url: string) => {
        const socket = { destroy: jest.fn() } as unknown as Duplex & { destroy: jest.Mock };
        target.handleUpgrade({ url } as never, socket, Buffer.alloc(0));
        return socket.destroy;
    };

    it('leaves every other gateway’s path alone', () => {
        expect(upgrade(gateway(), '/ws/terminal/x')).not.toHaveBeenCalled();
        expect(upgrade(gateway(), '/ws/computer/x')).not.toHaveBeenCalled();
    });

    it('destroys a query string, an unknown fleet path, and everything while links are off', () => {
        expect(upgrade(gateway(), '/ws/fleet/link?token=abc')).toHaveBeenCalled();
        expect(upgrade(gateway(), '/ws/fleet/nowhere')).toHaveBeenCalled();
        process.env.FLEET_NODE_LINK_ENABLED = 'false';
        expect(upgrade(gateway(), '/ws/fleet/link')).toHaveBeenCalled();
        process.env.FLEET_NODE_LINK_ENABLED = 'true';
        process.env.FLEET_ENABLED = 'false';
        expect(upgrade(gateway(), '/ws/fleet/link')).toHaveBeenCalled();
    });

    it('hands a path another fleet gateway claims to it', () => {
        const target = gateway();
        const handler = {
            claims: (path: string) => path.startsWith('/ws/fleet/session/'),
            handleUpgrade: jest.fn(),
        };
        target.registerPathHandler(handler);
        expect(upgrade(target, '/ws/fleet/session/abc')).not.toHaveBeenCalled();
        expect(handler.handleUpgrade).toHaveBeenCalled();
    });
});
