import type { FleetLinkChannelOpen, FleetLinkRequest } from '@ever-works/contracts';
import { asFleetLinkRequest } from '@ever-works/contracts';
import { Logger } from '@nestjs/common';
import { ValkeyRelayBus } from '../../relay/relay-bus.valkey';
import { FakeValkey, flushBus, TEST_RELAY_SECRET } from '../../relay/__tests__/relay-test-kit';
import { FleetLinkRegistry, type FleetLinkRegistryOptions } from '../fleet-link.registry';
import {
    FLEET_LINK_DIRECTORY_TTL_MS,
    FLEET_LINK_REMOTE_EARLY_EVENTS,
    FLEET_LINK_REMOTE_RECONCILE_GRACE_MS,
    FleetLinkRemote,
    isForwardableNodeControl,
    type FleetLinkRemoteOptions,
} from '../fleet-link-remote.service';
import { FleetOperationsService } from '../fleet-operations.service';
import type { FleetLinkRequirement } from '../fleet-link.types';
import { controlFrame, hello, jsonFrame, NODE_ID, OWNER, RecordingPort } from './link-test-kit';

/**
 * The node link across API replicas (FL-02 P1b, CONTRACTS R-7, spec S7): the
 * directory, forwarded requests and channels (frames both ways, close,
 * resume), one link per node fleet-wide, consents / drain / gone fanned out,
 * operation records shared, and a replica that goes away.
 */

const LOGS: FleetLinkRequirement = {
    consent: 'manage',
    actionFamily: 'logs',
    stateChanging: false,
};

const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
    for (const close of closers.splice(0).reverse()) await close();
});

async function until(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error('timed out');
        await flushBus(2);
        await new Promise((resolve) => setTimeout(resolve, 2));
    }
}

function replica(
    hub: FakeValkey,
    options: { remote?: FleetLinkRemoteOptions; registry?: FleetLinkRegistryOptions } = {},
) {
    const bus = new ValkeyRelayBus({
        secret: TEST_RELAY_SECRET,
        url: 'redis://fake',
        createClient: () => hub.client(),
    });
    const registry = new FleetLinkRegistry(options.registry);
    const remote = new FleetLinkRemote(registry, bus, options.remote);
    const operations = new FleetOperationsService(registry, undefined, remote);
    closers.push(
        () => bus.close(),
        () => remote.onModuleDestroy(),
        () => operations.onModuleDestroy(),
    );
    return { bus, registry, remote, operations };
}

async function twoReplicas() {
    const hub = new FakeValkey();
    const a = replica(hub);
    const b = replica(hub);
    await until(() => a.bus.peers().length === 1 && b.bus.peers().length === 1);
    return { hub, a, b };
}

/** A node linked to `side`, answering channel opens and requests like the real client would. */
function linkNode(
    side: ReturnType<typeof replica>,
    consents = { work: true, attend: false, manage: true, usageScan: false },
    resumeFrom?: number,
) {
    const port = new RecordingPort();
    const session = side.registry.accept({
        nodeId: NODE_ID,
        ownerUserId: OWNER,
        nodeName: 'build-01',
        nodeKind: 'node',
        hello: hello({
            consents,
            ...(resumeFrom !== undefined
                ? { resume: { linkGeneration: resumeFrom, channels: [] } }
                : {}),
        }),
        socket: port,
    });
    const openSeen = new Set<string>();
    const answerOpens = () => {
        for (const message of port.controls()) {
            if (message.type !== 'channel.open') continue;
            const open = message as FleetLinkChannelOpen;
            if (openSeen.has(open.requestId)) continue;
            openSeen.add(open.requestId);
            session.receive(
                controlFrame({
                    type: 'channel.ready',
                    channel: open.channel,
                    requestId: open.requestId,
                }),
            );
        }
    };
    const requestsOn = (channel: number): FleetLinkRequest[] =>
        port
            .jsonOn(channel)
            .map((message) => asFleetLinkRequest(message))
            .filter((request): request is FleetLinkRequest => request !== null);
    return { port, session, answerOpens, requestsOn };
}

describe('FleetLinkRemote — the directory', () => {
    it('tells every replica which one holds a node’s link, and forgets it when the link closes', async () => {
        const { a, b } = await twoReplicas();
        const events: string[] = [];
        b.remote.onLinkEvent((event) => events.push(event.type));
        const node = linkNode(a);
        await until(() => b.remote.holderOf(NODE_ID) === a.bus.replicaId);
        expect(a.remote.holderOf(NODE_ID)).toBeNull(); // held here
        expect(b.remote.linkView(NODE_ID)).toMatchObject({ state: 'connected', linkGeneration: 1 });
        expect(b.remote.liveConsents(NODE_ID)).toMatchObject({ manage: true });
        node.session.dropped('closed 1006');
        await until(() => b.remote.holderOf(NODE_ID) === null);
        expect(events).toEqual(['connected', 'dropped']);
    });

    it('forgets every link of a replica that leaves', async () => {
        const { a, b } = await twoReplicas();
        linkNode(a);
        await until(() => b.remote.isHeldElsewhere(NODE_ID));
        await a.bus.close();
        await until(() => !b.remote.isHeldElsewhere(NODE_ID));
    });

    it('keeps one link per node fleet-wide: a newer link on another replica replaces the older', async () => {
        const { a, b } = await twoReplicas();
        const older = linkNode(a);
        await until(() => b.remote.isHeldElsewhere(NODE_ID));
        await new Promise((resolve) => setTimeout(resolve, 5)); // a later connectedAt
        linkNode(b);
        await until(() => older.port.closed !== null);
        expect(older.port.closed?.code).toBe(4010);
        await until(() => a.remote.holderOf(NODE_ID) === b.bus.replicaId);
    });

    it('learns the links a replica already holds when it joins late', async () => {
        const hub = new FakeValkey();
        const a = replica(hub);
        linkNode(a);
        const b = replica(hub);
        await until(() => b.remote.holderOf(NODE_ID) === a.bus.replicaId);
    });
});

describe('FleetLinkRemote — forwarding', () => {
    it('answers a machine request on the replica that holds the link', async () => {
        const { a, b } = await twoReplicas();
        const node = linkNode(a);
        await until(() => b.remote.isHeldElsewhere(NODE_ID));
        const reply = b.remote.request({
            nodeId: NODE_ID,
            verb: 'health.now',
            params: {},
            requestedBy: `user:${OWNER}`,
        });
        await until(() => node.port.controls().some((m) => m.type === 'channel.open'));
        node.answerOpens();
        const open = node.port.last('channel.open') as FleetLinkChannelOpen;
        await until(() => node.requestsOn(open.channel).length === 1);
        const [request] = node.requestsOn(open.channel);
        expect(request.type).toBe('health.now');
        node.session.receive(
            jsonFrame(open.channel, { requestId: request.requestId, result: { cpu: 3 } }),
        );
        await expect(reply).resolves.toEqual({ requestId: request.requestId, result: { cpu: 3 } });
    });

    it('carries a channel both ways — open, frames, requests, close — and holds early frames until it is open', async () => {
        const { a, b } = await twoReplicas();
        const node = linkNode(a);
        await until(() => b.remote.isHeldElsewhere(NODE_ID));
        const seen: unknown[] = [];
        const opening = b.remote.openChannel({
            nodeId: NODE_ID,
            family: 'logs',
            params: { source: 'journal' },
            requirement: LOGS,
            requestedBy: `user:${OWNER}`,
            events: {
                json: (message) => seen.push(['json', message]),
                binary: (kind, payload) => seen.push(['bin', kind, [...payload]]),
                close: (reason) => seen.push(['close', reason]),
            },
        });
        await until(() => node.port.controls().some((m) => m.type === 'channel.open'));
        const open = node.port.last('channel.open') as FleetLinkChannelOpen;
        expect(open).toMatchObject({ family: 'logs', params: { source: 'journal' } });
        // The node answers ready and writes at once — before B has the answer.
        node.answerOpens();
        node.session.receive(jsonFrame(open.channel, { type: 'logs.initial-done' }));
        const channel = await opening;
        expect(channel.isOpen).toBe(true);
        expect(channel.channel).toBe(open.channel);
        await until(() => seen.length === 1);
        expect(seen[0]).toEqual(['json', { type: 'logs.initial-done' }]);

        expect(channel.sendJson({ type: 'logs.pause' })).toBe(true);
        await until(() => node.port.jsonOn(open.channel).some((m) => m.type === 'logs.pause'));
        channel.sendBinary(30, new Uint8Array([0, 0, 16, 0]));
        await until(() =>
            node.port.frames.some((f) => f.channel === open.channel && f.kind === 30),
        );

        const asked = channel.request('logs.earlier', { lines: 10 });
        await until(() => node.requestsOn(open.channel).some((r) => r.type === 'logs.earlier'));
        const request = node.requestsOn(open.channel).find((r) => r.type === 'logs.earlier')!;
        node.session.receive(
            jsonFrame(open.channel, { requestId: request.requestId, result: ['a'] }),
        );
        await expect(asked).resolves.toMatchObject({ result: ['a'] });

        node.session.receive(
            controlFrame({ type: 'channel.close', channel: open.channel, reason: 'normal' }),
        );
        await until(() => channel.isClosed);
        expect(seen.at(-1)).toEqual(['close', 'normal']);
    });

    it('closes a channel on the holder that the caller no longer knows (it gave up waiting)', async () => {
        const { a, b } = await twoReplicas();
        const node = linkNode(a);
        await until(() => b.remote.isHeldElsewhere(NODE_ID));
        const opening = b.remote.openChannel({
            nodeId: NODE_ID,
            family: 'logs',
            params: {},
            requirement: LOGS,
            requestedBy: 'x',
        });
        await until(() => node.port.controls().some((m) => m.type === 'channel.open'));
        node.answerOpens();
        const channel = (await opening) as unknown as { ref?: string };
        // B forgets the channel (as when its open timed out); the node keeps writing.
        (b.remote as unknown as { opened: Map<string, unknown> }).opened.clear();
        const open = node.port.last('channel.open') as FleetLinkChannelOpen;
        node.session.receive(jsonFrame(open.channel, { type: 'logs.line', text: 'hello' }));
        await until(() =>
            node.port
                .controls()
                .some(
                    (m) =>
                        m.type === 'channel.close' &&
                        (m as { channel: number }).channel === open.channel,
                ),
        );
        expect(channel).toBeDefined();
    });

    it('closes the node’s side when the caller closes', async () => {
        const { a, b } = await twoReplicas();
        const node = linkNode(a);
        await until(() => b.remote.isHeldElsewhere(NODE_ID));
        const opening = b.remote.openChannel({
            nodeId: NODE_ID,
            family: 'logs',
            params: {},
            requirement: LOGS,
            requestedBy: 'x',
        });
        await until(() => node.port.controls().some((m) => m.type === 'channel.open'));
        node.answerOpens();
        const channel = await opening;
        channel.close();
        await until(() => node.port.controls().some((m) => m.type === 'channel.close'));
    });

    it('carries the node’s refusal back as the same typed error', async () => {
        const { a, b } = await twoReplicas();
        const node = linkNode(a);
        await until(() => b.remote.isHeldElsewhere(NODE_ID));
        const opening = b.remote.openChannel({
            nodeId: NODE_ID,
            family: 'logs',
            params: {},
            requirement: LOGS,
            requestedBy: 'x',
        });
        await until(() => node.port.controls().some((m) => m.type === 'channel.open'));
        const open = node.port.last('channel.open') as FleetLinkChannelOpen;
        node.session.receive(
            controlFrame({
                type: 'channel.refused',
                channel: open.channel,
                requestId: open.requestId,
                error: {
                    code: 'consent_missing',
                    hint: 'start the node with --manage on build-01',
                },
            }),
        );
        await expect(opening).rejects.toMatchObject({
            linkError: {
                code: 'consent_missing',
                hint: 'start the node with --manage on build-01',
            },
        });
    });

    it('answers unreachable when the holder goes away mid-call, and ends its channels', async () => {
        const { a, b } = await twoReplicas();
        const node = linkNode(a);
        await until(() => b.remote.isHeldElsewhere(NODE_ID));
        const opening = b.remote.openChannel({
            nodeId: NODE_ID,
            family: 'logs',
            params: {},
            requirement: LOGS,
            requestedBy: 'x',
        });
        await until(() => node.port.controls().some((m) => m.type === 'channel.open'));
        node.answerOpens();
        const channel = await opening;
        const pending = b.remote.request({
            nodeId: NODE_ID,
            verb: 'health.now',
            params: {},
            requestedBy: 'x',
        });
        const reasons: string[] = [];
        channel.listen({ close: (reason) => reasons.push(reason) });
        await a.bus.close();
        await expect(pending).rejects.toMatchObject({ linkError: { code: 'unreachable' } });
        await until(() => channel.isClosed);
        expect(reasons).toEqual(['resume_failed']);
    });
});

describe('FleetLinkRemote — fan-out', () => {
    it('hands a heartbeat’s withdrawn consent to the holder, which closes the channels that needed it', async () => {
        const { a, b } = await twoReplicas();
        const node = linkNode(a);
        await until(() => b.remote.isHeldElsewhere(NODE_ID));
        const opening = a.registry.openChannel({
            nodeId: NODE_ID,
            family: 'logs',
            requirement: LOGS,
            requestedBy: 'x',
        });
        node.answerOpens();
        const logs = await opening;
        b.remote.forwardConsents(NODE_ID, {
            work: true,
            attend: false,
            manage: false,
            usageScan: false,
        });
        await until(() => logs.isClosed);
        expect(node.port.last('channel.close')).toMatchObject({ reason: 'consent_missing' });
    });

    it('drains and closes a gone node on whichever replica holds its link', async () => {
        const { a, b } = await twoReplicas();
        const node = linkNode(a);
        await until(() => b.remote.isHeldElsewhere(NODE_ID));
        b.remote.broadcastDrain([NODE_ID], 60);
        await until(() => node.port.controls().some((m) => m.type === 'link.drain'));
        b.remote.broadcastGone(NODE_ID, 'node removed');
        await until(() => node.port.closed !== null);
        expect(node.port.closed?.code).toBe(4001);
    });
});

describe('FleetLinkRemote — operation records', () => {
    it('shares a record: tracked on B, finished by the node on A, read done on both', async () => {
        const { a, b } = await twoReplicas();
        const node = linkNode(a);
        await until(() => b.remote.isHeldElsewhere(NODE_ID));
        // The node reports progress to A before B's record arrives there.
        node.session.receive(
            controlFrame({
                type: 'operation.progress',
                operationId: 'op-1',
                progress: { percent: 10 },
            }),
        );
        b.operations.track({
            operationId: 'op-1',
            nodeId: NODE_ID,
            family: 'machine',
            verb: 'docker.image.pull',
            requesterUserId: OWNER,
            ownerUserId: OWNER,
        });
        await until(() => a.operations.size === 1);
        await until(() => b.operations.get('op-1', OWNER).progress?.percent === 10);
        node.session.receive(
            controlFrame({ type: 'operation.done', operationId: 'op-1', result: { ok: 1 } }),
        );
        await until(() => b.operations.get('op-1', OWNER).state === 'done');
        expect(a.operations.get('op-1', OWNER)).toMatchObject({ state: 'done', result: { ok: 1 } });
    });

    it('cancels through the holder: the node is told, and both read cancelled', async () => {
        const { a, b } = await twoReplicas();
        const node = linkNode(a);
        await until(() => b.remote.isHeldElsewhere(NODE_ID));
        b.operations.track({
            operationId: 'op-2',
            nodeId: NODE_ID,
            family: 'machine',
            verb: 'compose.up',
            requesterUserId: OWNER,
            ownerUserId: OWNER,
        });
        await until(() => a.operations.size === 1);
        await expect(b.operations.requestCancel('op-2', OWNER)).resolves.toMatchObject({
            sent: true,
        });
        expect(node.port.last('operation.cancel')).toEqual({
            type: 'operation.cancel',
            operationId: 'op-2',
        });
        node.session.receive(
            controlFrame({
                type: 'operation.done',
                operationId: 'op-2',
                error: { code: 'operation_failed', hint: 'cancelled' },
            }),
        );
        await until(() => b.operations.get('op-2', OWNER).state === 'cancelled');
        expect(a.operations.get('op-2', OWNER).state).toBe('cancelled');
    });
});

/** Internals the hostile-input and reconciliation cases reach for. */
type RemoteInternals = {
    opened: Map<string, unknown>;
    served: Map<string, unknown>;
    directory: Map<string, unknown>;
    sendOnChannel(holder: string, message: Record<string, unknown>): boolean;
    callOnChannel<T>(
        holder: string,
        message: Record<string, unknown>,
        timeoutMs: number,
        ref: string,
    ): Promise<T>;
    onPeer(replicaId: string, present: boolean): void;
};
const internals = (remote: FleetLinkRemote) => remote as unknown as RemoteInternals;

const closesOf = (port: RecordingPort, channel: number) =>
    port
        .controls()
        .filter(
            (m) => m.type === 'channel.close' && (m as { channel: number }).channel === channel,
        );

describe('FleetLinkRemote — generations across replicas (a node that bounces A → B → A)', () => {
    it('reads the return to A as the same process continuing: no running operation is interrupted', async () => {
        const { a, b } = await twoReplicas();
        const continued: boolean[] = [];
        a.registry.onLinkEvent((event) => {
            if (event.type === 'connected') continued.push(event.continued);
        });
        const first = linkNode(a); // fresh process: generation 1 on A
        await until(() => b.remote.holderOf(NODE_ID) === a.bus.replicaId);
        a.operations.track({
            operationId: 'op-bounce',
            nodeId: NODE_ID,
            family: 'machine',
            verb: 'docker.image.pull',
            requesterUserId: OWNER,
            ownerUserId: OWNER,
        });
        await until(() => b.operations.size === 1);

        first.session.dropped('closed 1006');
        const onB = linkNode(b, undefined, 1); // the same process, resuming generation 1
        expect(onB.session.linkGeneration).toBe(2);
        await until(() => a.remote.holderOf(NODE_ID) === b.bus.replicaId);

        onB.session.dropped('closed 1006');
        await until(() => a.remote.holderOf(NODE_ID) === null);
        const back = linkNode(a, undefined, 2); // back on A, presenting B's generation
        expect(back.session.linkGeneration).toBe(3);
        expect(continued).toEqual([false, true]);
        await flushBus(10);
        expect(a.operations.get('op-bounce', OWNER).state).toBe('running');
        expect(b.operations.get('op-bounce', OWNER).state).toBe('running');
    });

    it('still reads a fresh process as fresh, and continues on a generation issued elsewhere before the directory said so', () => {
        const registry = new FleetLinkRegistry();
        const events: boolean[] = [];
        registry.onLinkEvent((event) => {
            if (event.type === 'connected') events.push(event.continued);
        });
        const accept = (resumeFrom?: number) =>
            registry.accept({
                nodeId: NODE_ID,
                ownerUserId: OWNER,
                nodeName: 'build-01',
                nodeKind: 'node',
                hello: hello(
                    resumeFrom !== undefined
                        ? { resume: { linkGeneration: resumeFrom, channels: [] } }
                        : {},
                ),
                socket: new RecordingPort(),
            });
        accept().dropped('x'); // generation 1, fresh
        accept(5).dropped('x'); // 5 was issued elsewhere: the same process
        accept().dropped('x'); // a fresh process again
        accept(2); // older than what this replica issued since: another process
        expect(events).toEqual([false, true, false, false]);
    });

    it('ends what an older link left suspended here as soon as another replica accepts the node (M4)', async () => {
        const { a, b } = await twoReplicas();
        const node = linkNode(a);
        await until(() => b.remote.isHeldElsewhere(NODE_ID));
        const opening = a.registry.openChannel({
            nodeId: NODE_ID,
            family: 'logs',
            requirement: LOGS,
            requestedBy: 'x',
        });
        const open = node.port.last('channel.open') as FleetLinkChannelOpen;
        node.session.receive(
            controlFrame({
                type: 'channel.ready',
                channel: open.channel,
                requestId: open.requestId,
                resumeKey: 'logs-1',
            }),
        );
        const channel = await opening;
        const reasons: string[] = [];
        channel.listen({ close: (reason) => reasons.push(reason) });
        node.session.dropped('closed 1006'); // suspended: it could resume within 2 minutes
        expect(channel.isClosed).toBe(false);
        linkNode(b, undefined, 1); // …but the node came back on B
        await until(() => channel.isClosed);
        expect(reasons).toEqual(['resume_failed']);
    });
});

describe('FleetLinkRemote — the holder’s own checks', () => {
    it('closes on the node an open whose caller closed before the node answered (item 6)', async () => {
        const { a, b } = await twoReplicas();
        const node = linkNode(a);
        await until(() => b.remote.isHeldElsewhere(NODE_ID));
        const opening = b.remote.openChannel({
            nodeId: NODE_ID,
            family: 'logs',
            params: {},
            requirement: LOGS,
            requestedBy: 'x',
        });
        const refused = opening.catch((error: unknown) => error);
        await until(() => node.port.controls().some((m) => m.type === 'channel.open'));
        const [ref] = [...internals(b.remote).opened.keys()];
        // The caller gives up (as on its own timeout) while the node has not answered yet.
        internals(b.remote).sendOnChannel(a.bus.replicaId, { op: 'close', ref, reason: 'normal' });
        await flushBus(10);
        node.answerOpens();
        const channelOpen = node.port.last('channel.open') as FleetLinkChannelOpen;
        await until(() => closesOf(node.port, channelOpen.channel).length === 1);
        await expect(refused).resolves.toMatchObject({ linkError: { code: 'unreachable' } });
        expect(internals(a.remote).served.size).toBe(0);
    });

    it('checks the consent against the link itself, so a withdrawal is honoured at once (item 7, L1)', async () => {
        const { a, b } = await twoReplicas();
        const node = linkNode(a);
        await until(() => b.remote.liveConsents(NODE_ID)?.manage === true);
        // The heartbeat withdrawing `manage` lands on A, which holds the link.
        a.registry.applyConsents(NODE_ID, {
            work: true,
            attend: false,
            manage: false,
            usageScan: false,
        });
        // Even a caller whose directory has not caught up is refused by the holder…
        await expect(
            b.remote.openChannel({
                nodeId: NODE_ID,
                family: 'logs',
                params: {},
                requirement: LOGS,
                requestedBy: 'x',
            }),
        ).rejects.toMatchObject({ linkError: { code: 'consent_missing' } });
        expect(node.port.controls().some((m) => m.type === 'channel.open')).toBe(false);
        // …and the directory itself is republished, not left to the next sync.
        await until(() => b.remote.liveConsents(NODE_ID)?.manage === false);
    });

    it('rebuilds a forwarded requirement: a malformed one is refused, a weaker consent is floored (M2)', async () => {
        const { a, b } = await twoReplicas();
        const node = linkNode(a, { work: true, attend: false, manage: false, usageScan: false });
        await until(() => b.remote.isHeldElsewhere(NODE_ID));
        const forwardOpen = (ref: string, requirement: unknown) =>
            internals(b.remote).callOnChannel(
                a.bus.replicaId,
                {
                    op: 'open',
                    nodeId: NODE_ID,
                    family: 'logs',
                    params: {},
                    requirement,
                    requestedBy: 'x',
                },
                3_000,
                ref,
            );
        await expect(forwardOpen('r-1', { consent: 'bogus' })).rejects.toMatchObject({
            linkError: { code: 'invalid' },
        });
        await expect(forwardOpen('r-2', undefined)).rejects.toMatchObject({
            linkError: { code: 'invalid' },
        });
        await expect(
            forwardOpen('r-3', { ...LOGS, target: 'x'.repeat(300) }),
        ).rejects.toMatchObject({ linkError: { code: 'invalid' } });
        // `logs` needs `manage`; a forwarded `link` is raised to it, and the link lacks it.
        await expect(
            forwardOpen('r-4', { consent: 'link', actionFamily: 'logs', stateChanging: false }),
        ).rejects.toMatchObject({ linkError: { code: 'consent_missing' } });
        expect(node.port.controls().some((m) => m.type === 'channel.open')).toBe(false);
    });

    it('never forwards the link’s own control types to a node, only a family’s (lane item 1)', async () => {
        const { a, b } = await twoReplicas();
        const node = linkNode(a);
        await until(() => b.remote.isHeldElsewhere(NODE_ID));
        for (const message of [
            { type: 'link.drain', graceSec: 0 },
            { type: 'link.pause', reason: 'kill_switch' },
            { type: 'channel.close', channel: 1, reason: 'normal' },
            { type: 'operation.cancel', operationId: 'op-1' },
            { type: 'link.anything-new' },
            { type: 'NotAType' },
        ]) {
            await expect(b.remote.sendNodeControl(NODE_ID, message as never)).resolves.toBe(false);
        }
        expect(node.port.controls().map((m) => m.type)).toEqual(['link.ready']);
        await expect(
            b.remote.sendNodeControl(NODE_ID, { type: 'session.event', sessionId: 's-1' }),
        ).resolves.toBe(true);
        expect(node.port.last('session.event')).toEqual({
            type: 'session.event',
            sessionId: 's-1',
        });
        expect(isForwardableNodeControl({ type: 'logs.follow' })).toBe(true);
        expect(isForwardableNodeControl({ type: 'operation.progress' })).toBe(false);
        expect(isForwardableNodeControl(null)).toBe(false);
    });

    it('survives hostile and malformed fleet-link messages, and bounds what it takes from them', async () => {
        const { a, b } = await twoReplicas();
        const node = linkNode(a);
        await until(() => b.remote.isHeldElsewhere(NODE_ID));
        for (const [topic, body] of [
            ['fleet-link.dir', 'not json'],
            ['fleet-link.dir', '[]'],
            ['fleet-link.dir', JSON.stringify({ op: 'up', link: { nodeId: 5 } })],
            ['fleet-link.dir', JSON.stringify({ op: 'sync', links: 'everything' })],
            ['fleet-link.dir', JSON.stringify({ op: 'down', nodeId: { $ne: 1 } })],
            [
                'fleet-link.fan',
                JSON.stringify({ op: 'consents', nodeId: NODE_ID, consents: 'all' }),
            ],
            ['fleet-link.fan', JSON.stringify({ op: 'gone', nodeId: ['x'] })],
            ['fleet-link.ops', JSON.stringify({ op: 'view', snapshot: { view: 7 } })],
            ['fleet-link.rpc', JSON.stringify({ op: 'json', ref: 42 })],
            ['fleet-link.rpc', JSON.stringify({ op: 'close' })],
            [
                'fleet-link.rpc',
                JSON.stringify({ op: 'open', ref: 'r', nodeId: NODE_ID, family: '__proto__' }),
            ],
            ['fleet-link.rpc', JSON.stringify({ op: 'refs', opened: 'x', served: null })],
            ['fleet-link.rpc', JSON.stringify({ op: 'mreq', nodeId: NODE_ID })],
        ] as const) {
            b.bus.sendTo(a.bus.replicaId, topic, body);
        }
        // A drain with an absurd grace is bounded as the link codec bounds it.
        b.bus.sendTo(
            a.bus.replicaId,
            'fleet-link.fan',
            JSON.stringify({ op: 'drain', nodeIds: [NODE_ID, 7], graceSec: 1e12 }),
        );
        await until(() => node.port.controls().some((m) => m.type === 'link.drain'));
        expect(node.port.last('link.drain')).toEqual({ type: 'link.drain', graceSec: 3_600 });
        expect(node.port.closed).toBeNull();
        expect(b.remote.holderOf(NODE_ID)).toBe(a.bus.replicaId);
        // And A still answers properly afterwards.
        const reply = b.remote.request({
            nodeId: NODE_ID,
            verb: 'health.now',
            params: {},
            requestedBy: 'x',
        });
        await until(() => node.port.controls().some((m) => m.type === 'channel.open'));
        node.answerOpens();
        const open = node.port.last('channel.open') as FleetLinkChannelOpen;
        await until(() => node.requestsOn(open.channel).length === 1);
        const [request] = node.requestsOn(open.channel);
        node.session.receive(jsonFrame(open.channel, { requestId: request.requestId, result: 1 }));
        await expect(reply).resolves.toMatchObject({ result: 1 });
    });

    it('hands back a channel the node closed right after accepting it, with the real reason — not as an overflow', async () => {
        const { a, b } = await twoReplicas();
        const node = linkNode(a);
        await until(() => b.remote.isHeldElsewhere(NODE_ID));
        const reasons: string[] = [];
        const opening = b.remote.openChannel({
            nodeId: NODE_ID,
            family: 'logs',
            params: {},
            requirement: LOGS,
            requestedBy: 'x',
            events: { close: (reason) => reasons.push(reason) },
        });
        await until(() => node.port.controls().some((m) => m.type === 'channel.open'));
        const open = node.port.last('channel.open') as FleetLinkChannelOpen;
        // The ack and a close in one chunk: the holder's `closed` goes out
        // before its answer to the open, and B replays it when the open lands.
        node.answerOpens();
        node.session.receive(
            controlFrame({
                type: 'channel.close',
                channel: open.channel,
                reason: 'unsupported_on_node',
            }),
        );
        const channel = await opening;
        expect(channel.isClosed).toBe(true);
        expect(reasons).toEqual(['unsupported_on_node']);
        // …and the holder keeps no entry for a channel that is already over.
        expect(internals(a.remote).served.size).toBe(0);
    });

    it('closes a remote channel whose early buffer overflows instead of dropping frames (L8)', async () => {
        const { a, b } = await twoReplicas();
        const node = linkNode(a);
        await until(() => b.remote.isHeldElsewhere(NODE_ID));
        const opening = b.remote.openChannel({
            nodeId: NODE_ID,
            family: 'logs',
            params: {},
            requirement: LOGS,
            requestedBy: 'x',
        });
        const refused = opening.catch((error: unknown) => error);
        await until(() => node.port.controls().some((m) => m.type === 'channel.open'));
        node.answerOpens();
        const open = node.port.last('channel.open') as FleetLinkChannelOpen;
        // The node floods the channel before B has the answer to its open.
        for (let i = 0; i <= FLEET_LINK_REMOTE_EARLY_EVENTS; i += 1) {
            node.session.receive(jsonFrame(open.channel, { type: 'logs.line', i }));
        }
        await expect(refused).resolves.toMatchObject({ linkError: { code: 'limit_exceeded' } });
        await until(() => closesOf(node.port, open.channel).length === 1);
    });
});

describe('FleetLinkRemote — liveness and reconciliation', () => {
    it('forgets a directory entry that was not refreshed within its lifetime', async () => {
        let now = Date.now();
        const hub = new FakeValkey();
        const a = replica(hub);
        const b = replica(hub, { remote: { now: () => now } });
        await until(() => a.bus.peers().length === 1 && b.bus.peers().length === 1);
        linkNode(a);
        await until(() => b.remote.holderOf(NODE_ID) === a.bus.replicaId);
        const events: string[] = [];
        b.remote.onLinkEvent((event) => events.push(event.type));
        now += FLEET_LINK_DIRECTORY_TTL_MS;
        expect(b.remote.holderOf(NODE_ID)).toBeNull();
        expect(events).toEqual(['dropped']);
    });

    it('answers at once when the holder died without a word, instead of waiting out the call', async () => {
        const hub = new FakeValkey();
        const a = replica(hub);
        const b = replica(hub);
        await until(() => a.bus.peers().length === 1 && b.bus.peers().length === 1);
        linkNode(a);
        await until(() => b.remote.isHeldElsewhere(NODE_ID));
        // A's process is killed: its connections drop, no leave message.
        hub.clients[0].disconnect();
        hub.clients[1].disconnect();
        const started = Date.now();
        await expect(
            b.remote.request({ nodeId: NODE_ID, verb: 'health.now', params: {}, requestedBy: 'x' }),
        ).rejects.toMatchObject({ linkError: { code: 'unreachable' } });
        expect(Date.now() - started).toBeLessThan(5_000);
        await until(() => !b.remote.isHeldElsewhere(NODE_ID));
    });

    it('breaks a tie between two links accepted at the same instant by replica id (4010)', async () => {
        const fixed = { now: () => 1_760_000_000_000 };
        const hub = new FakeValkey();
        const a = replica(hub, { registry: fixed });
        const b = replica(hub, { registry: fixed });
        await until(() => a.bus.peers().length === 1 && b.bus.peers().length === 1);
        const onA = linkNode(a);
        const onB = linkNode(b);
        const [loser, winner] = a.bus.replicaId < b.bus.replicaId ? [onA, onB] : [onB, onA];
        await until(() => loser.port.closed !== null);
        expect(loser.port.closed?.code).toBe(4010);
        await flushBus(10);
        expect(winner.port.closed).toBeNull();
    });

    it('ends a forwarded channel one side forgot, on the other side, after the grace (M3)', async () => {
        let now = Date.now();
        const clock = { now: () => now, syncIntervalMs: 25 };
        const hub = new FakeValkey();
        const a = replica(hub, { remote: clock });
        const b = replica(hub, { remote: clock });
        await until(() => a.bus.peers().length === 1 && b.bus.peers().length === 1);
        const node = linkNode(a);
        await until(() => b.remote.isHeldElsewhere(NODE_ID));
        const open1 = b.remote.openChannel({
            nodeId: NODE_ID,
            family: 'logs',
            params: {},
            requirement: LOGS,
            requestedBy: 'x',
        });
        await until(() => node.port.controls().some((m) => m.type === 'channel.open'));
        node.answerOpens();
        await open1;
        const first = node.port.last('channel.open') as FleetLinkChannelOpen;
        // B forgets it without a close reaching A; the node writes nothing more.
        internals(b.remote).opened.clear();
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(closesOf(node.port, first.channel)).toEqual([]); // still within the grace
        now += FLEET_LINK_REMOTE_RECONCILE_GRACE_MS + 1;
        await until(() => closesOf(node.port, first.channel).length === 1);

        // The other way: A stops serving one B still has open.
        const open2 = b.remote.openChannel({
            nodeId: NODE_ID,
            family: 'logs',
            params: {},
            requirement: LOGS,
            requestedBy: 'x',
        });
        await until(
            () => node.port.controls().filter((m) => m.type === 'channel.open').length === 2,
        );
        node.answerOpens();
        const second = await open2;
        const reasons: string[] = [];
        second.listen({ close: (reason) => reasons.push(reason) });
        internals(a.remote).served.clear();
        now += FLEET_LINK_REMOTE_RECONCILE_GRACE_MS + 1;
        await until(() => second.isClosed);
        expect(reasons).toEqual(['resume_failed']);
    });

    it('re-sends a drain-all to a replica that joins within its grace, and says when it could not go out (M6)', async () => {
        const hub = new FakeValkey();
        const a = replica(hub);
        a.remote.broadcastDrain([NODE_ID], 60); // nobody else is there yet
        const b = replica(hub);
        const node = linkNode(b); // a link that lands on the newcomer
        await until(() => node.port.controls().some((m) => m.type === 'link.drain'));
        const drain = node.port.last('link.drain') as { graceSec: number };
        expect(drain.graceSec).toBeGreaterThan(55);
        expect(drain.graceSec).toBeLessThanOrEqual(60);

        const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        try {
            hub.cutAll();
            a.remote.broadcastDrain([NODE_ID], 60);
            expect(warn.mock.calls.map((call) => String(call[0])).join('\n')).toContain(
                'could not reach the other API replicas',
            );
        } finally {
            warn.mockRestore();
            hub.restoreAll();
        }
    });

    it('asks a replica it just met for its links (L6)', async () => {
        const { a, b } = await twoReplicas();
        linkNode(b);
        await until(() => a.remote.holderOf(NODE_ID) === b.bus.replicaId);
        // A loses its picture of B (as across a partition B never noticed).
        internals(a.remote).directory.clear();
        internals(a.remote).onPeer(b.bus.replicaId, true);
        await until(() => a.remote.holderOf(NODE_ID) === b.bus.replicaId);
    });
});
