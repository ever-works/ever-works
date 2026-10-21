import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { WebSocket } from 'ws';
import {
    decodeFleetLinkControl,
    decodeFleetLinkFrame,
    encodeFleetLinkFrame,
    encodeFleetLinkJson,
    FLEET_LINK_FRAME_KINDS,
    FLEET_LINK_VIEWER_CHANNEL,
    type FleetLinkChannelOpen,
} from '@ever-works/contracts';
import { TerminalAttachService } from '../../terminal/terminal-attach.service';
import {
    FLEET_LINK_VIEWER_MAX_TARGET_LENGTH,
    FleetLinkAttachService,
} from '../fleet-link-attach.service';
import { FLEET_LINK_CLAIM_SKEW_MARGIN_MS } from '../fleet-link-token.service';
import { OwnerOnlyFleetLinkAudience } from '../fleet-link-audience';
import { FleetLinkAuthorizer } from '../fleet-link.authorizer';
import { FleetLinkGatewayService } from '../fleet-link-gateway.service';
import { FleetLinkRegistry } from '../fleet-link.registry';
import { FleetLinkService } from '../fleet-link.service';
import { FleetLinkTokenService } from '../fleet-link-token.service';
import { FleetLinkViewerGatewayService } from '../fleet-link-viewer-gateway.service';
import { FleetOperationsService } from '../fleet-operations.service';
import { controlFrame, hello, NODE_ID, OWNER, RecordingPort } from './link-test-kit';

/**
 * Viewer tokens and the viewer gateway (FL-02 P1b, spec FR-32, FR-33, T-21):
 * a token is minted only after the channel's authorisation, for a person,
 * for a connected computer; it opens exactly one socket on exactly its path,
 * once; the socket is bridged to the node's channel with the role enforced.
 */

const ORIGINAL = {
    secret: process.env.TERMINAL_ATTACH_SECRET,
    link: process.env.FLEET_NODE_LINK_ENABLED,
    fleet: process.env.FLEET_ENABLED,
};

beforeEach(() => {
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
    lastHeartbeatAt: new Date(Date.now() - 3 * 60_000),
    consents: { work: true, attend: false, manage: true, usageScan: false },
    capabilities: [],
    workerState: 'idle',
};

function core() {
    const registry = new FleetLinkRegistry();
    const killSwitch = { isStopped: jest.fn(async () => false) };
    const authorizer = new FleetLinkAuthorizer(
        killSwitch as never,
        registry,
        new OwnerOnlyFleetLinkAudience(),
    );
    const operations = new FleetOperationsService(registry);
    const nodes = {
        findById: jest.fn(async (id: string) => (id === NODE_ID ? row : null)),
        findStatusesByIds: jest.fn(async (ids: string[]) =>
            ids.map((id) => ({ id, status: 'online' })),
        ),
    };
    const links = new FleetLinkService(registry, authorizer, operations, nodes as never);
    const signer = new TerminalAttachService();
    const attach = new FleetLinkAttachService(signer, nodes as never, authorizer, links);
    const node = () => {
        const port = new RecordingPort();
        const session = registry.accept({
            nodeId: NODE_ID,
            ownerUserId: OWNER,
            nodeName: 'build-01',
            nodeKind: 'node',
            hello: hello(),
            socket: port,
        });
        const answerOpen = () => {
            const open = port.last('channel.open') as FleetLinkChannelOpen;
            session.receive(
                controlFrame({
                    type: 'channel.ready',
                    channel: open.channel,
                    requestId: open.requestId,
                }),
            );
            return open;
        };
        return { port, session, answerOpen };
    };
    return { registry, killSwitch, authorizer, links, signer, attach, nodes, node };
}

const owner = { kind: 'user' as const, userId: OWNER };

describe('FleetLinkAttachService.mint', () => {
    it('mints a 60-second token bound to the path, the node and the role', async () => {
        const h = core();
        h.node();
        const grant = await h.attach.mint({
            nodeId: NODE_ID,
            family: 'logs',
            target: NODE_ID,
            role: 'viewer',
            caller: owner,
            params: { source: 'journal' },
        });
        expect(grant).toMatchObject({
            wsPath: `/ws/fleet/logs/${NODE_ID}`,
            expiresInSec: 60,
            role: 'viewer',
        });
        const claims = h.signer.verify(grant.token)!;
        expect(claims).toMatchObject({
            channel: 'fleet-link-viewer',
            runId: `logs:${NODE_ID}`,
            role: 'viewer',
            userId: OWNER,
            linkNodeId: NODE_ID,
            linkParams: { source: 'journal' },
        });
        expect(typeof claims.jti).toBe('string');
    });

    it('authorises first: a stranger is not_found, a missing consent says the command, a stopped fleet is kill_switch', async () => {
        const h = core();
        h.node();
        await expect(
            h.attach.mint({
                nodeId: NODE_ID,
                family: 'logs',
                target: 'x',
                role: 'viewer',
                caller: { kind: 'user', userId: 'mallory' },
            }),
        ).rejects.toMatchObject({ linkError: { code: 'not_found' } });
        await expect(
            h.attach.mint({
                nodeId: NODE_ID,
                family: 'desktop',
                target: 'v-1',
                role: 'viewer',
                caller: owner,
            }),
        ).rejects.toMatchObject({
            linkError: {
                code: 'consent_missing',
                hint: 'start the node with --attend on build-01',
            },
        });
        h.killSwitch.isStopped.mockResolvedValue(true);
        await expect(
            h.attach.mint({
                nodeId: NODE_ID,
                family: 'logs',
                target: 'x',
                role: 'viewer',
                caller: owner,
            }),
        ).rejects.toMatchObject({ linkError: { code: 'kill_switch' } });
    });

    it('refuses a computer without a link, a caller that is not a person, oversized params, and a storm', async () => {
        const h = core();
        await expect(
            h.attach.mint({
                nodeId: NODE_ID,
                family: 'logs',
                target: 'x',
                role: 'viewer',
                caller: owner,
            }),
        ).rejects.toMatchObject({
            linkError: { code: 'unreachable', hint: expect.stringContaining('last seen') },
        });
        h.node();
        await expect(
            h.attach.mint({
                nodeId: NODE_ID,
                family: 'logs',
                target: 'x',
                role: 'viewer',
                caller: { kind: 'agent', agentId: 'a', ownerUserId: OWNER },
            }),
        ).rejects.toMatchObject({ linkError: { code: 'invalid' } });
        await expect(
            h.attach.mint({
                nodeId: NODE_ID,
                family: 'logs',
                target: 'x',
                role: 'viewer',
                caller: owner,
                params: { blob: 'x'.repeat(600) },
            }),
        ).rejects.toMatchObject({ linkError: { code: 'invalid', hint: 'params' } });
        await expect(
            h.attach.mint({
                nodeId: NODE_ID,
                family: 'logs',
                target: 'bad target',
                role: 'viewer',
                caller: owner,
            }),
        ).rejects.toMatchObject({ linkError: { code: 'invalid', hint: 'target' } });
        // One mint counted already (the unreachable one); 29 more reach the 30 a minute.
        for (let i = 0; i < 29; i += 1) {
            await h.attach.mint({
                nodeId: NODE_ID,
                family: 'logs',
                target: 'x',
                role: 'viewer',
                caller: owner,
            });
        }
        await expect(
            h.attach.mint({
                nodeId: NODE_ID,
                family: 'logs',
                target: 'x',
                role: 'viewer',
                caller: owner,
            }),
        ).rejects.toMatchObject({ status: 429, linkError: { code: 'limit_exceeded' } });
    });

    it('answers unreachable while this deployment does not accept links', async () => {
        const h = core();
        process.env.FLEET_NODE_LINK_ENABLED = 'false';
        await expect(
            h.attach.mint({
                nodeId: NODE_ID,
                family: 'logs',
                target: 'x',
                role: 'viewer',
                caller: owner,
            }),
        ).rejects.toMatchObject({ linkError: { code: 'unreachable' } });
    });
});

describe('FleetLinkAttachService — what the token carries', () => {
    it('measures params in UTF-8 bytes, as the token carries them', async () => {
        const h = core();
        h.node();
        // 200 characters, 600 bytes: under the cap counted in UTF-16 units, over it in bytes.
        await expect(
            h.attach.mint({
                nodeId: NODE_ID,
                family: 'logs',
                target: 'x',
                role: 'viewer',
                caller: owner,
                params: { path: '日'.repeat(200) },
            }),
        ).rejects.toMatchObject({ linkError: { code: 'invalid', hint: 'params' } });
    });

    it('carries the narrowed requirement, so the open is authorised exactly as the mint was', async () => {
        const h = core();
        h.node();
        const { token } = await h.attach.mint({
            nodeId: NODE_ID,
            family: 'logs',
            target: 'n-1',
            role: 'driver',
            caller: owner,
            requirement: { target: '/var/log/syslog' },
        });
        expect(h.signer.verify(token)!.linkRequirement).toEqual({ target: '/var/log/syslog' });
        expect(await h.attach.verify(token, { family: 'logs', target: 'n-1' })).toMatchObject({
            requirement: { target: '/var/log/syslog' },
        });
        const viewer = await h.attach.mint({
            nodeId: NODE_ID,
            family: 'logs',
            target: 'n-2',
            role: 'viewer',
            caller: owner,
        });
        expect(
            await h.attach.verify(viewer.token, { family: 'logs', target: 'n-2' }),
        ).toMatchObject({
            requirement: { stateChanging: false },
        });
    });
});

describe('FleetLinkAttachService — the target it was authorised for', () => {
    it('refuses a requirement target over the cap at mint, rather than signing a cut one', async () => {
        const h = core();
        h.node();
        const mint = (target: unknown) =>
            h.attach.mint({
                nodeId: NODE_ID,
                family: 'logs',
                target: 'n-1',
                role: 'driver',
                caller: owner,
                requirement: { target: target as string },
            });
        await expect(
            mint('x'.repeat(FLEET_LINK_VIEWER_MAX_TARGET_LENGTH + 1)),
        ).rejects.toMatchObject({
            linkError: {
                code: 'invalid',
                hint: 'requirement.target',
                details: { maxLength: FLEET_LINK_VIEWER_MAX_TARGET_LENGTH },
            },
        });
        await expect(mint(42)).rejects.toMatchObject({ linkError: { code: 'invalid' } });
        const exact = 'y'.repeat(FLEET_LINK_VIEWER_MAX_TARGET_LENGTH);
        const { token } = await mint(exact);
        expect(h.signer.verify(token)!.linkRequirement).toEqual({ target: exact });
        expect(await h.attach.verify(token, { family: 'logs', target: 'n-1' })).toMatchObject({
            requirement: { target: exact },
        });
    });

    it('holds a token’s single-use claim past its expiry by a clock-skew margin (L4)', async () => {
        const claims: number[] = [];
        const h = core();
        h.node();
        const attach = new FleetLinkAttachService(
            h.signer,
            h.nodes as never,
            h.authorizer,
            h.links,
            {
                claim: (_jti: string, ttlMs: number) => {
                    claims.push(ttlMs);
                    return true;
                },
            },
        );
        const { token } = await attach.mint({
            nodeId: NODE_ID,
            family: 'logs',
            target: 'n-1',
            role: 'viewer',
            caller: owner,
        });
        await attach.verify(token, { family: 'logs', target: 'n-1' });
        expect(claims).toHaveLength(1);
        expect(claims[0]).toBeGreaterThan(FLEET_LINK_CLAIM_SKEW_MARGIN_MS + 55_000);
        expect(claims[0]).toBeLessThanOrEqual(FLEET_LINK_CLAIM_SKEW_MARGIN_MS + 60_000);
    });
});

describe('FleetLinkAttachService.verify', () => {
    it('accepts a token once, on its own path only, and nothing minted for another socket', async () => {
        const h = core();
        h.node();
        const { token } = await h.attach.mint({
            nodeId: NODE_ID,
            family: 'logs',
            target: 'n-1',
            role: 'driver',
            caller: owner,
        });
        expect(await h.attach.verify(token, { family: 'logs', target: 'n-2' })).toBeNull();
        expect(await h.attach.verify(token, { family: 'session', target: 'n-1' })).toBeNull();
        expect(await h.attach.verify(token, { family: 'logs', target: 'n-1' })).toMatchObject({
            userId: OWNER,
            nodeId: NODE_ID,
            role: 'driver',
        });
        expect(await h.attach.verify(token, { family: 'logs', target: 'n-1' })).toBeNull();
        const linkToken = new FleetLinkTokenService(h.signer).mint(NODE_ID).token;
        expect(await h.attach.verify(linkToken, { family: 'logs', target: NODE_ID })).toBeNull();
        const terminal = h.signer.mint({ userId: OWNER, runId: 'logs:n-1', role: 'driver' }).token;
        expect(await h.attach.verify(terminal, { family: 'logs', target: 'n-1' })).toBeNull();
        expect(await h.attach.verify(42, { family: 'logs', target: 'n-1' })).toBeNull();
    });
});

describe('FleetLinkViewerGatewayService', () => {
    let server: Server;
    let url: string;
    let h: ReturnType<typeof core>;
    let linkGateway: FleetLinkGatewayService;
    let viewerGateway: FleetLinkViewerGatewayService;

    beforeEach(async () => {
        h = core();
        server = createServer();
        linkGateway = new FleetLinkGatewayService(
            { httpAdapter: { getHttpServer: () => server } } as never,
            new FleetLinkTokenService(h.signer),
            h.registry,
            h.nodes as never,
            h.killSwitch as never,
        );
        viewerGateway = new FleetLinkViewerGatewayService(linkGateway, h.attach, h.links);
        linkGateway.onApplicationBootstrap();
        viewerGateway.onApplicationBootstrap();
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterEach(async () => {
        viewerGateway.onApplicationShutdown();
        linkGateway.onApplicationShutdown();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    /** A browser: connects, authenticates, collects channel-0 messages and channel-1 frames. */
    function browser(path: string, token: string | null) {
        const socket = new WebSocket(`${url}${path}`);
        const controls: Array<Record<string, unknown>> = [];
        const frames: Array<{ kind: number; payload: Uint8Array }> = [];
        const closed = new Promise<number>((resolve) =>
            socket.on('close', (code) => resolve(code)),
        );
        socket.on('error', () => undefined);
        socket.on('open', () => {
            if (token !== null) socket.send(JSON.stringify({ type: 'auth', token }));
        });
        socket.on('message', (data: Buffer) => {
            const frame = decodeFleetLinkFrame(new Uint8Array(data));
            if (!frame) return;
            if (frame.channel === 0) {
                const message = decodeFleetLinkControl(frame.payload);
                if (message) controls.push(message as never);
            } else frames.push({ kind: frame.kind, payload: frame.payload });
        });
        return { socket, controls, frames, closed };
    }

    async function until(predicate: () => boolean, timeoutMs = 5_000) {
        const deadline = Date.now() + timeoutMs;
        while (!predicate()) {
            if (Date.now() > deadline) throw new Error('timed out');
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
    }

    it('bridges a driver to the node’s channel, both ways', async () => {
        const node = h.node();
        const { token, wsPath } = await h.attach.mint({
            nodeId: NODE_ID,
            family: 'logs',
            target: NODE_ID,
            role: 'driver',
            caller: owner,
            params: { source: 'journal' },
        });
        const tab = browser(wsPath, token);
        await until(() => node.port.controls().some((m) => m.type === 'channel.open'));
        const open = node.answerOpen();
        expect(open).toMatchObject({ family: 'logs', params: { source: 'journal' } });
        await until(() => tab.controls.some((m) => m.type === 'viewer.ready'));
        expect(tab.controls[0]).toMatchObject({
            type: 'viewer.ready',
            family: 'logs',
            role: 'driver',
        });

        node.session.receive(
            decodeFleetLinkFrame(
                encodeFleetLinkFrame(
                    open.channel,
                    FLEET_LINK_FRAME_KINDS.DATA,
                    new Uint8Array([7, 8]),
                )!,
            )!,
        );
        await until(() => tab.frames.length === 1);
        expect(tab.frames[0]).toEqual({
            kind: FLEET_LINK_FRAME_KINDS.DATA,
            payload: new Uint8Array([7, 8]),
        });

        tab.socket.send(encodeFleetLinkJson(FLEET_LINK_VIEWER_CHANNEL, { type: 'logs.follow' })!);
        await until(() => node.port.jsonOn(open.channel).some((m) => m.type === 'logs.follow'));
        tab.socket.close();
        await until(() =>
            node.port
                .controls()
                .some(
                    (m) =>
                        m.type === 'channel.close' &&
                        (m as { channel: number }).channel === open.channel,
                ),
        );
    });

    it('never forwards a viewer’s input, and answers it (FR-33)', async () => {
        const node = h.node();
        const { token, wsPath } = await h.attach.mint({
            nodeId: NODE_ID,
            family: 'logs',
            target: NODE_ID,
            role: 'viewer',
            caller: owner,
        });
        const tab = browser(wsPath, token);
        await until(() => node.port.controls().some((m) => m.type === 'channel.open'));
        const open = node.answerOpen();
        await until(() => tab.controls.some((m) => m.type === 'viewer.ready'));
        const before = node.port.frames.length;
        tab.socket.send(
            encodeFleetLinkFrame(
                FLEET_LINK_VIEWER_CHANNEL,
                FLEET_LINK_FRAME_KINDS.DATA,
                new Uint8Array([1]),
            )!,
        );
        await until(() => tab.controls.some((m) => m.type === 'viewer.refused'));
        expect(node.port.frames.slice(before).filter((f) => f.channel === open.channel)).toEqual(
            [],
        );
        tab.socket.close();
    });

    it('opens one socket per token: a second presentation, and another path’s token, close 4001', async () => {
        h.node();
        const { token, wsPath } = await h.attach.mint({
            nodeId: NODE_ID,
            family: 'logs',
            target: NODE_ID,
            role: 'viewer',
            caller: owner,
        });
        const first = browser(wsPath, token);
        await until(() => first.socket.readyState === first.socket.OPEN);
        await new Promise((resolve) => setTimeout(resolve, 50));
        const replay = browser(wsPath, token);
        expect(await replay.closed).toBe(4001);
        const other = await h.attach.mint({
            nodeId: NODE_ID,
            family: 'logs',
            target: 'elsewhere',
            role: 'viewer',
            caller: owner,
        });
        expect(await browser(wsPath, other.token).closed).toBe(4001);
        expect(await browser(wsPath, 'garbage').closed).toBe(4001);
        first.socket.close();
    });

    it('explains a channel the node refused, then closes 4013', async () => {
        const node = h.node();
        const { token, wsPath } = await h.attach.mint({
            nodeId: NODE_ID,
            family: 'logs',
            target: NODE_ID,
            role: 'viewer',
            caller: owner,
        });
        const tab = browser(wsPath, token);
        await until(() => node.port.controls().some((m) => m.type === 'channel.open'));
        const open = node.port.last('channel.open') as FleetLinkChannelOpen;
        node.session.receive(
            controlFrame({
                type: 'channel.refused',
                channel: open.channel,
                requestId: open.requestId,
                error: {
                    code: 'unsupported_on_node',
                    hint: 'build-01 (node 0.3.0) cannot do this yet: logs',
                },
            }),
        );
        expect(await tab.closed).toBe(4013);
        expect(tab.controls).toEqual([
            {
                type: 'channel.close',
                channel: FLEET_LINK_VIEWER_CHANNEL,
                reason: 'unsupported_on_node',
                hint: 'build-01 (node 0.3.0) cannot do this yet: logs',
            },
        ]);
    });

    it('re-authorises at open time: a kill switch thrown between mint and open refuses the channel', async () => {
        const node = h.node();
        const { token, wsPath } = await h.attach.mint({
            nodeId: NODE_ID,
            family: 'logs',
            target: NODE_ID,
            role: 'driver',
            caller: owner,
        });
        h.killSwitch.isStopped.mockResolvedValue(true);
        const tab = browser(wsPath, token);
        expect(await tab.closed).toBe(4013);
        expect(tab.controls).toEqual([
            expect.objectContaining({ type: 'channel.close', reason: 'kill_switch' }),
        ]);
        expect(node.port.controls().some((m) => m.type === 'channel.open')).toBe(false);
    });

    it('opens a session channel with the viewer’s role as its mode, so the node enforces it too', async () => {
        const node = h.node();
        for (const role of ['viewer', 'driver'] as const) {
            const { token, wsPath } = await h.attach.mint({
                nodeId: NODE_ID,
                family: 'session',
                target: `s-${role}`,
                role,
                caller: owner,
                params: { sessionId: `s-${role}`, mode: 'driver' },
            });
            const tab = browser(wsPath, token);
            await until(
                () =>
                    (node.port.last('channel.open') as FleetLinkChannelOpen | undefined)?.params
                        ?.sessionId === `s-${role}`,
            );
            const open = node.answerOpen();
            // The token's own params cannot widen it: the mode is the role.
            expect(open).toMatchObject({
                family: 'session',
                params: { sessionId: `s-${role}`, mode: role },
            });
            await until(() => tab.controls.some((m) => m.type === 'viewer.ready'));
            tab.socket.close();
        }
    });

    it('closes an unauthenticated socket after 5 s with 4001', async () => {
        const tab = browser(`/ws/fleet/logs/${NODE_ID}`, null);
        expect(await tab.closed).toBe(4001);
    }, 15_000);

    it('refuses an upgrade to a path that is not a viewer path', async () => {
        const tab = browser('/ws/fleet/nowhere/x', null);
        await expect(tab.closed).resolves.toBe(1006);
    });
});
