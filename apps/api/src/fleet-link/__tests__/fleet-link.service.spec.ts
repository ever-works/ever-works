import type { FleetLinkChannelOpen } from '@ever-works/contracts';
import { OwnerOnlyFleetLinkAudience } from '../fleet-link-audience';
import { FleetLinkAuthorizer } from '../fleet-link.authorizer';
import { FleetLinkRegistry } from '../fleet-link.registry';
import { FleetLinkService, NodeLinkService } from '../fleet-link.service';
import { FleetOperationsService } from '../fleet-operations.service';
import {
    controlFrame,
    hello,
    jsonFrame,
    NODE_ID,
    OWNER,
    RecordingPort,
    settle,
} from './link-test-kit';

/**
 * FleetLinkService (FL-02, spec S3, U1, FR-25, ACC-FL02-08, -11): the one
 * entry point — authorise, then reach the node, carry its refusal back,
 * track long operations, audit state-changing channel opens only.
 */

const ORIGINAL_FLAG = process.env.FLEET_NODE_LINK_ENABLED;

beforeEach(() => {
    process.env.FLEET_NODE_LINK_ENABLED = 'true';
});

afterEach(() => {
    if (ORIGINAL_FLAG === undefined) delete process.env.FLEET_NODE_LINK_ENABLED;
    else process.env.FLEET_NODE_LINK_ENABLED = ORIGINAL_FLAG;
});

const row = (overrides: Record<string, unknown> = {}) => ({
    id: NODE_ID,
    userId: OWNER,
    organizationId: null,
    name: 'build-01',
    kind: 'node',
    status: 'online',
    lastHeartbeatAt: new Date(Date.now() - 12 * 60_000),
    consents: { work: true, attend: false, manage: true, usageScan: false },
    capabilities: [],
    workerState: 'idle',
    ...overrides,
});

function setup(options: { node?: Record<string, unknown> | null } = {}) {
    const registry = new FleetLinkRegistry();
    const killSwitch = { isStopped: jest.fn(async () => false) };
    const authorizer = new FleetLinkAuthorizer(
        killSwitch as never,
        registry,
        new OwnerOnlyFleetLinkAudience(),
    );
    const operations = new FleetOperationsService(registry);
    const nodes = {
        findById: jest.fn(async () => (options.node === null ? null : row(options.node))),
    };
    const audit = { tryRecord: jest.fn(async () => true) };
    const service = new FleetLinkService(
        registry,
        authorizer,
        operations,
        nodes as never,
        audit as never,
    );
    const connect = () => {
        const port = new RecordingPort();
        const session = registry.accept({
            nodeId: NODE_ID,
            ownerUserId: OWNER,
            nodeName: 'build-01',
            nodeKind: 'node',
            hello: hello(),
            socket: port,
        });
        return { port, session };
    };
    return { service, registry, operations, nodes, audit, killSwitch, connect };
}

const owner = { kind: 'user' as const, userId: OWNER };

/** Acknowledge the next channel.open, then answer the next request on it. */
async function answer(
    link: { port: RecordingPort; session: ReturnType<FleetLinkRegistry['accept']> },
    reply: Record<string, unknown>,
) {
    await settle();
    const open = link.port.last('channel.open') as FleetLinkChannelOpen | undefined;
    if (open && !link.port.controls().some((m) => m.type === 'channel.ready')) {
        link.session.receive(
            controlFrame({
                type: 'channel.ready',
                channel: open.channel,
                requestId: open.requestId,
                resumeKey: 'machine',
            }),
        );
    }
    await settle();
    const channel = open?.channel ?? 1;
    const requests = link.port.jsonOn(channel);
    const request = requests[requests.length - 1];
    link.session.receive(jsonFrame(channel, { requestId: request.requestId as string, ...reply }));
}

describe('FleetLinkService.request', () => {
    it('opens the machine channel lazily and returns the node’s result (S3)', async () => {
        const h = setup();
        const link = h.connect();
        const pending = h.service.request({ nodeId: NODE_ID, verb: 'health.now', caller: owner });
        await answer(link, { result: { cpuPercent: 31 } });
        await expect(pending).resolves.toEqual({ result: { cpuPercent: 31 } });
        const request = link.port.jsonOn(1)[0];
        expect(request).toMatchObject({ type: 'health.now', params: {} });
    });

    it('carries the node’s refusal back as the same typed error (U7)', async () => {
        const h = setup();
        const link = h.connect();
        const pending = h.service.request({
            nodeId: NODE_ID,
            verb: 'services.list',
            caller: owner,
        });
        await answer(link, {
            error: {
                code: 'unsupported_on_node',
                hint: 'build-01 (node 0.2.1) cannot do this yet: services.list',
            },
        });
        await expect(pending).rejects.toMatchObject({
            status: 422,
            linkError: { code: 'unsupported_on_node' },
        });
    });

    it('tracks a long request as an operation the caller can poll (FR-17)', async () => {
        const h = setup();
        const link = h.connect();
        const pending = h.service.request({
            nodeId: NODE_ID,
            verb: 'docker.image.pull',
            caller: owner,
        });
        await answer(link, { operationId: 'op-7' });
        const outcome = await pending;
        expect(outcome).toMatchObject({
            operationId: 'op-7',
            operation: { id: 'op-7', state: 'running', verb: 'docker.image.pull' },
        });
        expect(h.operations.get('op-7', OWNER).nodeId).toBe(NODE_ID);
    });

    it('answers unreachable with when the computer was last seen, and contacts nothing (U1)', async () => {
        const h = setup();
        await expect(
            h.service.request({ nodeId: NODE_ID, verb: 'health.now', caller: owner }),
        ).rejects.toMatchObject({
            status: 503,
            linkError: {
                code: 'unreachable',
                hint: 'build-01 is not connected; last seen 12 min ago',
            },
        });
    });

    it('authorises before reaching the node: a refusal sends nothing (FR-23)', async () => {
        const h = setup({
            node: { consents: { work: true, attend: false, manage: false, usageScan: false } },
        });
        const link = h.connect();
        h.registry.applyConsents(NODE_ID, {
            work: true,
            attend: false,
            manage: false,
            usageScan: false,
        });
        await expect(
            h.service.request({ nodeId: NODE_ID, verb: 'services.list', caller: owner }),
        ).rejects.toMatchObject({
            linkError: { code: 'consent_missing' },
        });
        // Nothing after the link's own ready reached the node.
        expect(link.port.frames.map((frame) => frame.channel)).toEqual([0]);
        expect(link.port.controls().map((message) => message.type)).toEqual(['link.ready']);
    });

    it('is not_found for an unknown node or a stranger, and invalid for a malformed verb', async () => {
        await expect(
            setup({ node: null }).service.request({
                nodeId: NODE_ID,
                verb: 'health.now',
                caller: owner,
            }),
        ).rejects.toMatchObject({ linkError: { code: 'not_found' } });
        await expect(
            setup().service.request({
                nodeId: NODE_ID,
                verb: 'health.now',
                caller: { kind: 'user', userId: 'x' },
            }),
        ).rejects.toMatchObject({ linkError: { code: 'not_found' } });
        await expect(
            setup().service.request({ nodeId: NODE_ID, verb: 'DROP TABLE', caller: owner }),
        ).rejects.toMatchObject({
            linkError: { code: 'invalid' },
        });
    });

    it('refuses everything while this deployment does not accept links (FR-10)', async () => {
        delete process.env.FLEET_NODE_LINK_ENABLED;
        const h = setup();
        await expect(
            h.service.request({ nodeId: NODE_ID, verb: 'health.now', caller: owner }),
        ).rejects.toMatchObject({
            linkError: {
                code: 'unreachable',
                hint: 'this deployment does not accept node links yet',
            },
        });
        expect(h.nodes.findById).not.toHaveBeenCalled();
        expect(h.service.linkView({ id: NODE_ID, kind: 'node' }).state).toBe('refused');
    });
});

describe('FleetLinkService.openChannel', () => {
    it('audits opening a command channel once and a logs channel never (ACC-FL02-11)', async () => {
        const h = setup();
        const link = h.connect();
        const command = h.service.openChannel({
            nodeId: NODE_ID,
            family: 'command',
            caller: owner,
            requirement: { target: 'cmd-1' },
        });
        await settle();
        const open = link.port.last('channel.open') as FleetLinkChannelOpen;
        link.session.receive(
            controlFrame({
                type: 'channel.ready',
                channel: open.channel,
                requestId: open.requestId,
            }),
        );
        await command;
        expect(h.audit.tryRecord).toHaveBeenCalledTimes(1);
        expect(h.audit.tryRecord).toHaveBeenCalledWith(
            expect.objectContaining({
                action: 'node.link.channel-open',
                actorUserId: OWNER,
                ownerUserId: OWNER,
                nodeId: NODE_ID,
                details: {
                    family: 'command',
                    target: 'cmd-1',
                    requestedBy: `user:${OWNER}`,
                    outcome: 'opened',
                },
            }),
        );

        const logs = h.service.openChannel({ nodeId: NODE_ID, family: 'logs', caller: owner });
        await settle();
        const logsOpen = link.port.last('channel.open') as FleetLinkChannelOpen;
        link.session.receive(
            controlFrame({
                type: 'channel.ready',
                channel: logsOpen.channel,
                requestId: logsOpen.requestId,
            }),
        );
        await logs;
        expect(h.audit.tryRecord).toHaveBeenCalledTimes(1);
    });

    it('audits a node’s refusal of a state-changing channel with its code', async () => {
        const h = setup();
        const link = h.connect();
        const opening = h.service.openChannel({ nodeId: NODE_ID, family: 'files', caller: owner });
        await settle();
        const open = link.port.last('channel.open') as FleetLinkChannelOpen;
        link.session.receive(
            controlFrame({
                type: 'channel.refused',
                channel: open.channel,
                requestId: open.requestId,
                error: {
                    code: 'unsupported_on_node',
                    hint: 'build-01 (node 0.3.0) cannot do this yet: files',
                },
            }),
        );
        await expect(opening).rejects.toMatchObject({ linkError: { code: 'unsupported_on_node' } });
        expect(h.audit.tryRecord).toHaveBeenCalledWith(
            expect.objectContaining({
                details: expect.objectContaining({
                    outcome: 'refused',
                    code: 'unsupported_on_node',
                }),
            }),
        );
    });

    it('refuses kill_switch before contacting the node', async () => {
        const h = setup();
        const link = h.connect();
        h.killSwitch.isStopped.mockResolvedValue(true);
        await expect(
            h.service.openChannel({ nodeId: NODE_ID, family: 'command', caller: owner }),
        ).rejects.toMatchObject({
            status: 423,
            linkError: { code: 'kill_switch' },
        });
        // Nothing after the link's own ready reached the node.
        expect(link.port.frames.map((frame) => frame.channel)).toEqual([0]);
        expect(link.port.controls().map((message) => message.type)).toEqual(['link.ready']);
    });

    it('is the same class under the name later epics use', () => {
        expect(NodeLinkService).toBe(FleetLinkService);
    });
});
