import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { WebSocket } from 'ws';
import {
    asFleetLinkRequest,
    decodeFleetLinkControl,
    decodeFleetLinkFrame,
    decodeFleetLinkJson,
    encodeFleetLinkControl,
    encodeFleetLinkFrame,
    encodeFleetLinkJson,
    FLEET_LINK_FRAME_KINDS,
    FLEET_LINK_VIEWER_CHANNEL,
    type FleetLinkChannelOpen,
} from '@ever-works/contracts';
import { ValkeyRelayBus } from '../../relay/relay-bus.valkey';
import type { RelayBus } from '../../relay/relay-bus';
import { FakeValkey, TEST_RELAY_SECRET } from '../../relay/__tests__/relay-test-kit';
import { TerminalAttachService } from '../../terminal/terminal-attach.service';
import { FleetLinkAttachService } from '../fleet-link-attach.service';
import { OwnerOnlyFleetLinkAudience } from '../fleet-link-audience';
import { FleetLinkAuthorizer } from '../fleet-link.authorizer';
import { FleetLinkGatewayService } from '../fleet-link-gateway.service';
import { FleetLinkRegistry } from '../fleet-link.registry';
import { FleetLinkRemote } from '../fleet-link-remote.service';
import { FleetLinkService } from '../fleet-link.service';
import { FleetLinkTokenService, RelayBusFleetLinkReplayGuard } from '../fleet-link-token.service';
import { FleetLinkViewerGatewayService } from '../fleet-link-viewer-gateway.service';
import { FleetOperationsService } from '../fleet-operations.service';
import { NODE_ID, OWNER } from './link-test-kit';

/**
 * Two API replicas, one Valkey (FL-02 T-23, spec S7, FR-29): the node's link
 * lands on replica A, a browser's socket on replica B — and frames flow both
 * ways with no visible difference; a machine request made on B is answered by
 * the node on A; a link token is single-use across both; and losing the bus
 * reads `degraded`.
 *
 * Each replica is the real gateway stack on its own HTTP server, sockets and
 * all; the node is a raw `ws` client speaking the link protocol. The bus is an
 * in-memory Valkey, or the server at `FLEET_RELAY_TEST_REDIS_URL` when set.
 */

const REAL_URL = process.env.FLEET_RELAY_TEST_REDIS_URL;

const ORIGINAL = {
    secret: process.env.TERMINAL_ATTACH_SECRET,
    link: process.env.FLEET_NODE_LINK_ENABLED,
    fleet: process.env.FLEET_ENABLED,
};

beforeAll(() => {
    process.env.TERMINAL_ATTACH_SECRET = 'a-test-secret-of-sufficient-length';
    process.env.FLEET_NODE_LINK_ENABLED = 'true';
    process.env.FLEET_ENABLED = 'true';
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

const row = {
    id: NODE_ID,
    userId: OWNER,
    organizationId: null,
    name: 'build-01',
    kind: 'node',
    status: 'online',
    lastHeartbeatAt: new Date(),
    consents: { work: true, attend: false, manage: true, usageScan: false },
    capabilities: [],
    workerState: 'idle',
};

async function until(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error('timed out');
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

interface Replica {
    bus: RelayBus;
    registry: FleetLinkRegistry;
    links: FleetLinkService;
    attach: FleetLinkAttachService;
    tokens: FleetLinkTokenService;
    url: string;
    stop(): Promise<void>;
}

async function startReplica(bus: RelayBus): Promise<Replica> {
    const server: Server = createServer();
    const registry = new FleetLinkRegistry();
    const remote = new FleetLinkRemote(registry, bus);
    const killSwitch = { isStopped: jest.fn(async () => false) };
    const authorizer = new FleetLinkAuthorizer(
        killSwitch as never,
        registry,
        new OwnerOnlyFleetLinkAudience(),
        remote,
    );
    const operations = new FleetOperationsService(registry, undefined, remote);
    const nodes = {
        findById: jest.fn(async (id: string) => (id === NODE_ID ? row : null)),
        findStatusesByIds: jest.fn(async (ids: string[]) =>
            ids.map((id) => ({ id, status: 'online' })),
        ),
    };
    const links = new FleetLinkService(
        registry,
        authorizer,
        operations,
        nodes as never,
        undefined,
        remote,
    );
    const signer = new TerminalAttachService();
    const guard = new RelayBusFleetLinkReplayGuard(bus);
    const tokens = new FleetLinkTokenService(signer, guard);
    const attach = new FleetLinkAttachService(signer, nodes as never, authorizer, links, guard);
    const linkGateway = new FleetLinkGatewayService(
        { httpAdapter: { getHttpServer: () => server } } as never,
        tokens,
        registry,
        nodes as never,
        killSwitch as never,
    );
    const viewerGateway = new FleetLinkViewerGatewayService(linkGateway, attach, links);
    linkGateway.onApplicationBootstrap();
    viewerGateway.onApplicationBootstrap();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
        bus,
        registry,
        links,
        attach,
        tokens,
        url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
        stop: async () => {
            viewerGateway.onApplicationShutdown();
            linkGateway.onApplicationShutdown();
            remote.onModuleDestroy();
            operations.onModuleDestroy();
            await bus.close();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}

/** A node on the wire: hello, answers channel opens, replies to requests, echoes DATA with a prefix. */
function connectNode(url: string, token: string) {
    const socket = new WebSocket(`${url}/ws/fleet/link`);
    socket.binaryType = 'nodebuffer';
    const state = {
        ready: false,
        closeCode: null as number | null,
        channels: new Map<number, string>(),
        dataSeen: [] as Uint8Array[],
    };
    socket.on('error', () => undefined);
    socket.on('close', (code) => {
        state.closeCode = code;
    });
    socket.on('open', () => {
        socket.send(
            encodeFleetLinkControl({
                type: 'link.hello',
                nodeId: NODE_ID,
                linkVersion: 1,
                capabilities: ['os:linux', 'managed'],
                consents: { work: true, attend: false, manage: true, usageScan: false },
                token,
                nodeVersion: '0.3.0',
            })!,
        );
    });
    socket.on('message', (data: Buffer) => {
        const frame = decodeFleetLinkFrame(new Uint8Array(data));
        if (!frame) return;
        if (frame.channel === 0) {
            const message = decodeFleetLinkControl(frame.payload);
            if (message?.type === 'link.ready') state.ready = true;
            if (message?.type === 'channel.open') {
                const open = message as FleetLinkChannelOpen;
                state.channels.set(open.channel, open.family);
                socket.send(
                    encodeFleetLinkControl({
                        type: 'channel.ready',
                        channel: open.channel,
                        requestId: open.requestId,
                    })!,
                );
            }
            return;
        }
        if (frame.kind === FLEET_LINK_FRAME_KINDS.JSON) {
            const request = asFleetLinkRequest(decodeFleetLinkJson(frame.payload)!);
            if (request) {
                socket.send(
                    encodeFleetLinkJson(frame.channel, {
                        requestId: request.requestId,
                        result: { verb: request.type, answeredBy: 'the node' },
                    })!,
                );
            }
            return;
        }
        if (frame.kind === FLEET_LINK_FRAME_KINDS.DATA) {
            state.dataSeen.push(frame.payload);
            socket.send(
                encodeFleetLinkFrame(
                    frame.channel,
                    FLEET_LINK_FRAME_KINDS.DATA,
                    new Uint8Array([...Buffer.from('echo:'), ...frame.payload]),
                )!,
            );
        }
    });
    return { socket, state };
}

describe('two API replicas, one Valkey (S7)', () => {
    let a: Replica;
    let b: Replica;
    let hub: FakeValkey | null;

    beforeEach(async () => {
        hub = REAL_URL ? null : new FakeValkey();
        const bus = () =>
            hub
                ? new ValkeyRelayBus({
                      secret: TEST_RELAY_SECRET,
                      url: 'redis://fake',
                      createClient: () => hub!.client(),
                  })
                : new ValkeyRelayBus({ secret: TEST_RELAY_SECRET, url: REAL_URL! });
        a = await startReplica(bus());
        b = await startReplica(bus());
        await until(
            () =>
                a.bus.peers().includes(b.bus.replicaId) && b.bus.peers().includes(a.bus.replicaId),
        );
    });

    afterEach(async () => {
        await a.stop();
        await b.stop();
    });

    it('bridges a browser on B to the node’s channel on A, frames both ways', async () => {
        const node = connectNode(a.url, a.tokens.mint(NODE_ID).token);
        await until(() => node.state.ready);
        await until(() => b.links.isConnected(NODE_ID));
        expect(b.links.linkView({ id: NODE_ID, kind: 'node' })).toMatchObject({
            state: 'connected',
        });

        const grant = await b.attach.mint({
            nodeId: NODE_ID,
            family: 'logs',
            target: NODE_ID,
            role: 'driver',
            caller: { kind: 'user', userId: OWNER },
        });
        const tab = new WebSocket(`${b.url}${grant.wsPath}`);
        tab.on('error', () => undefined);
        const controls: Array<Record<string, unknown>> = [];
        const data: Uint8Array[] = [];
        tab.on('open', () => tab.send(JSON.stringify({ type: 'auth', token: grant.token })));
        tab.on('message', (raw: Buffer) => {
            const frame = decodeFleetLinkFrame(new Uint8Array(raw));
            if (!frame) return;
            if (frame.channel === 0) controls.push(decodeFleetLinkControl(frame.payload) as never);
            else if (frame.kind === FLEET_LINK_FRAME_KINDS.DATA) data.push(frame.payload);
        });
        await until(() => controls.some((message) => message?.type === 'viewer.ready'));
        expect([...node.state.channels.values()]).toContain('logs');

        tab.send(
            encodeFleetLinkFrame(
                FLEET_LINK_VIEWER_CHANNEL,
                FLEET_LINK_FRAME_KINDS.DATA,
                Buffer.from('ping'),
            )!,
        );
        await until(() => data.length === 1);
        expect(Buffer.from(node.state.dataSeen[0]).toString()).toBe('ping');
        expect(Buffer.from(data[0]).toString()).toBe('echo:ping');

        const closed = new Promise<number>((resolve) => tab.on('close', (code) => resolve(code)));
        node.socket.close();
        expect(await closed).toBe(4013);
    });

    it('answers a machine request made on B with the node’s reply through A', async () => {
        const node = connectNode(a.url, a.tokens.mint(NODE_ID).token);
        await until(() => node.state.ready);
        await until(() => b.links.isConnected(NODE_ID));
        await expect(
            b.links.request({
                nodeId: NODE_ID,
                verb: 'health.now',
                caller: { kind: 'user', userId: OWNER },
            }),
        ).resolves.toEqual({ result: { verb: 'health.now', answeredBy: 'the node' } });
        node.socket.close();
    });

    it('keeps a link token single-use across replicas', async () => {
        const { token } = a.tokens.mint(NODE_ID);
        const first = connectNode(a.url, token);
        await until(() => first.state.ready);
        const replay = connectNode(b.url, token);
        await until(() => replay.state.closeCode !== null);
        expect(replay.state.closeCode).toBe(4001);
        first.socket.close();
    });

    it('keeps a viewer token single-use across replicas: used on B, replayed on A, closed 4001', async () => {
        const node = connectNode(a.url, a.tokens.mint(NODE_ID).token);
        await until(() => node.state.ready);
        await until(() => b.links.isConnected(NODE_ID));
        const grant = await a.attach.mint({
            nodeId: NODE_ID,
            family: 'logs',
            target: NODE_ID,
            role: 'viewer',
            caller: { kind: 'user', userId: OWNER },
        });
        const viewer = (url: string) => {
            const tab = new WebSocket(`${url}${grant.wsPath}`);
            tab.on('error', () => undefined);
            const controls: Array<Record<string, unknown>> = [];
            tab.on('open', () => tab.send(JSON.stringify({ type: 'auth', token: grant.token })));
            tab.on('message', (raw: Buffer) => {
                const frame = decodeFleetLinkFrame(new Uint8Array(raw));
                if (frame?.channel === 0)
                    controls.push(decodeFleetLinkControl(frame.payload) as never);
            });
            const closed = new Promise<number>((resolve) =>
                tab.on('close', (code) => resolve(code)),
            );
            return { tab, controls, closed };
        };
        const first = viewer(b.url);
        await until(() => first.controls.some((message) => message?.type === 'viewer.ready'));
        const replay = viewer(a.url);
        expect(await replay.closed).toBe(4001);
        first.tab.close();
        node.socket.close();
    });

    if (!REAL_URL) {
        it('reads degraded when the bus is lost, and up again when it is back', async () => {
            expect(b.bus.health()).toEqual({ configured: true, mode: 'valkey', status: 'up' });
            hub!.cutAll();
            expect(b.bus.health().status).toBe('degraded');
            hub!.restoreAll();
            expect(b.bus.health().status).toBe('up');
        });
    }
});
