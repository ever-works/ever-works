import {
    decodeFleetLinkControl,
    FLEET_LINK_FRAME_KINDS,
    type FleetLinkChannelOpen,
} from '@ever-works/contracts';
import { FleetLinkException } from '../fleet-link.errors';
import { FleetLinkRegistry, type FleetLinkSession } from '../fleet-link.registry';
import type { FleetLinkRequirement } from '../fleet-link.types';
import {
    controlFrame,
    hello,
    jsonFrame,
    manualTimers,
    NODE_ID,
    OWNER,
    RecordingPort,
    settle,
} from './link-test-kit';

/**
 * FleetLinkRegistry (FL-02, CONTRACTS §3) — the transport-free core of the
 * platform end: generations, channel open / refuse / close, request
 * correlation, resume after a drop, consent withdrawal, pause, drain.
 */

const MANAGE: FleetLinkRequirement = {
    consent: 'manage',
    actionFamily: 'logs',
    stateChanging: false,
};
const SESSION: FleetLinkRequirement = {
    consent: 'manage',
    actionFamily: 'sessions',
    stateChanging: true,
};

function setup() {
    const timers = manualTimers();
    const registry = new FleetLinkRegistry({
        ...timers.options,
        requestTimeoutMs: 30_000,
        openTimeoutMs: 10_000,
    });
    const connect = (overrides: Parameters<typeof hello>[0] = {}) => {
        const port = new RecordingPort();
        const session = registry.accept({
            nodeId: NODE_ID,
            ownerUserId: OWNER,
            nodeName: 'build-01',
            nodeKind: 'node',
            hello: hello(overrides),
            socket: port,
        });
        return { port, session };
    };
    return { timers, registry, connect };
}

/** Answer the last channel.open the port saw. */
function answerOpen(
    port: RecordingPort,
    session: FleetLinkSession,
    resumeKey?: string,
): FleetLinkChannelOpen {
    const open = port.last('channel.open') as FleetLinkChannelOpen;
    session.receive(
        controlFrame({
            type: 'channel.ready',
            channel: open.channel,
            requestId: open.requestId,
            ...(resumeKey ? { resumeKey } : {}),
        }),
    );
    return open;
}

async function openAccepted(
    h: ReturnType<typeof setup>,
    link: { port: RecordingPort; session: FleetLinkSession },
    family: 'logs' | 'session' | 'command',
    resumeKey?: string,
) {
    const opening = h.registry.openChannel({
        nodeId: NODE_ID,
        family,
        requirement: family === 'session' ? SESSION : MANAGE,
        requestedBy: `user:${OWNER}`,
    });
    const open = answerOpen(link.port, link.session, resumeKey);
    const handle = await opening;
    return { handle, open };
}

describe('FleetLinkRegistry — accepting links', () => {
    it('answers ready with a generation, the limits and the server time (FR-4)', () => {
        const h = setup();
        const { session } = h.connect();
        expect(session.ready).toEqual({
            type: 'link.ready',
            linkGeneration: 1,
            limits: {
                maxFrameBytes: 16_777_216,
                maxChannels: 64,
                pingIntervalMs: 15_000,
                silenceMs: 45_000,
                inlineReplyMs: 2_000,
            },
            serverTime: new Date(h.timers.now()).toISOString(),
            resumed: [],
            closed: [],
        });
        expect(h.registry.isConnected(NODE_ID)).toBe(true);
    });

    it('never repeats a generation: max(known, presented) + 1, even after an API restart', () => {
        const h = setup();
        expect(h.connect().session.linkGeneration).toBe(1);
        expect(h.connect().session.linkGeneration).toBe(2);
        const restarted = setup();
        expect(
            restarted.connect({ resume: { linkGeneration: 41, channels: [] } }).session
                .linkGeneration,
        ).toBe(42);
    });

    it('replaces an older link of the same node, closing it 4010', () => {
        const h = setup();
        const first = h.connect();
        const second = h.connect();
        expect(first.port.closed).toEqual({ code: 4010, reason: 'replaced' });
        expect(second.port.closed).toBeNull();
        // The old session's late drop does not take the new link down.
        first.session.dropped('closed 4010');
        expect(h.registry.isConnected(NODE_ID)).toBe(true);
    });

    it('answers the node’s ping with a pong', () => {
        const h = setup();
        const { port, session } = h.connect();
        session.receive(controlFrame({ type: 'link.ping', t: 99 }));
        expect(port.last('link.pong')).toEqual({ type: 'link.pong', t: 99 });
    });
});

describe('FleetLinkRegistry — channels', () => {
    it('opens a channel the node acknowledges and routes its messages (FR-13)', async () => {
        const h = setup();
        const link = h.connect();
        const seen: unknown[] = [];
        const opening = h.registry.openChannel({
            nodeId: NODE_ID,
            family: 'logs',
            params: { source: 'journal' },
            requirement: MANAGE,
            requestedBy: `user:${OWNER}`,
            events: { json: (message) => seen.push(message) },
        });
        const open = link.port.last('channel.open') as FleetLinkChannelOpen;
        expect(open).toMatchObject({
            type: 'channel.open',
            channel: 1,
            family: 'logs',
            params: { source: 'journal' },
        });
        answerOpen(link.port, link.session);
        const handle = await opening;
        expect(handle.isOpen).toBe(true);
        link.session.receive(jsonFrame(1, { type: 'logs.line', line: 'hello' }));
        expect(seen).toEqual([{ type: 'logs.line', line: 'hello' }]);
    });

    it('carries the node’s refusal back as the same typed error', async () => {
        const h = setup();
        const link = h.connect();
        const opening = h.registry.openChannel({
            nodeId: NODE_ID,
            family: 'logs',
            requirement: MANAGE,
            requestedBy: 'x',
        });
        const open = link.port.last('channel.open') as FleetLinkChannelOpen;
        link.session.receive(
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

    it('never reuses a channel number on a generation (FR-14)', async () => {
        const h = setup();
        const link = h.connect();
        const first = await openAccepted(h, link, 'logs');
        first.handle.close();
        expect(link.port.last('channel.close')).toEqual({
            type: 'channel.close',
            channel: 1,
            reason: 'normal',
        });
        const second = await openAccepted(h, link, 'logs');
        expect(second.handle.channel).toBe(2);
    });

    it('refuses the 65th channel with limit_exceeded and the stated hint (FR-15)', async () => {
        const h = setup();
        const link = h.connect();
        for (let i = 0; i < 64; i += 1) await openAccepted(h, link, 'command');
        await expect(
            h.registry.openChannel({
                nodeId: NODE_ID,
                family: 'command',
                requirement: MANAGE,
                requestedBy: 'x',
            }),
        ).rejects.toMatchObject({
            linkError: {
                code: 'limit_exceeded',
                hint: '64 channels are open on build-01; close one',
            },
        });
    });

    it('answers unreachable when the node never acknowledges, and tells the node to drop it', async () => {
        const h = setup();
        const link = h.connect();
        const opening = h.registry.openChannel({
            nodeId: NODE_ID,
            family: 'logs',
            requirement: MANAGE,
            requestedBy: 'x',
        });
        h.timers.advance(10_000);
        await expect(opening).rejects.toMatchObject({ linkError: { code: 'unreachable' } });
        expect(link.port.last('channel.close')).toMatchObject({
            channel: 1,
            reason: 'unreachable',
        });
        // A late ready for it is answered with a close, not adopted.
        link.session.receive(
            controlFrame({ type: 'channel.ready', channel: 1, requestId: 'late' }),
        );
        expect(link.port.last('channel.close')).toEqual({
            type: 'channel.close',
            channel: 1,
            reason: 'normal',
        });
    });

    it('correlates replies by request id and times a silent node out (FR-16)', async () => {
        const h = setup();
        const link = h.connect();
        const { handle } = await openAccepted(h, link, 'command');
        const answered = handle.request('command.run', { command: 'uptime' });
        const silent = handle.request('command.run', { command: 'sleep' }, { timeoutMs: 5_000 });
        const [first, second] = link.port.jsonOn(1);
        expect(first).toMatchObject({ type: 'command.run', params: { command: 'uptime' } });
        link.session.receive(
            jsonFrame(1, { requestId: first.requestId as string, result: { exitCode: 0 } }),
        );
        await expect(answered).resolves.toEqual({
            requestId: first.requestId,
            result: { exitCode: 0 },
        });
        expect(second.requestId).not.toBe(first.requestId);
        h.timers.advance(5_000);
        await expect(silent).rejects.toMatchObject({ linkError: { code: 'unreachable' } });
    });

    it('shares one machine channel per link', async () => {
        const h = setup();
        const link = h.connect();
        const a = h.registry.machineChannel(NODE_ID, 'x');
        const b = h.registry.machineChannel(NODE_ID, 'y');
        answerOpen(link.port, link.session, 'machine');
        const [first, second] = await Promise.all([a, b]);
        expect(first).toBe(second);
        expect(
            link.port.controls().filter((message) => message.type === 'channel.open'),
        ).toHaveLength(1);
        expect(first.family).toBe('machine');
    });

    it('closes the channel a node closed, telling its listeners why', async () => {
        const h = setup();
        const link = h.connect();
        const closed: unknown[] = [];
        const { handle } = await openAccepted(h, link, 'command');
        handle.listen({ close: (reason, hint) => closed.push([reason, hint]) });
        link.session.receive(
            controlFrame({
                type: 'channel.close',
                channel: 1,
                reason: 'operation_failed',
                hint: 'exited',
            }),
        );
        expect(closed).toEqual([['operation_failed', 'exited']]);
        expect(handle.isClosed).toBe(true);
        expect(handle.sendJson({ late: true })).toBe(false);
    });

    it('closes only the channel an oversized frame was aimed at (U5)', async () => {
        const h = setup();
        const link = h.connect();
        const { handle } = await openAccepted(h, link, 'command');
        link.session.refuseOversized(1);
        expect(handle.isClosed).toBe(true);
        expect(link.port.last('channel.close')).toEqual({
            type: 'channel.close',
            channel: 1,
            reason: 'invalid',
            hint: 'frame over 16 MiB',
        });
        expect(h.registry.isConnected(NODE_ID)).toBe(true);
    });

    it('answers unreachable for a node with no link', async () => {
        const h = setup();
        await expect(
            h.registry.openChannel({
                nodeId: NODE_ID,
                family: 'logs',
                requirement: MANAGE,
                requestedBy: 'x',
            }),
        ).rejects.toBeInstanceOf(FleetLinkException);
    });
});

describe('FleetLinkRegistry — resume after a drop (FR-9)', () => {
    it('resumes the channels the node still holds and closes the rest', async () => {
        const h = setup();
        const link = h.connect();
        const kept = await openAccepted(h, link, 'session', 's-1');
        const lost = await openAccepted(h, link, 'logs');
        const unresumed = await openAccepted(h, link, 'session', 's-3');
        const lostReason: unknown[] = [];
        lost.handle.listen({ close: (reason) => lostReason.push(reason) });
        const unresumedReason: unknown[] = [];
        unresumed.handle.listen({ close: (reason) => unresumedReason.push(reason) });
        const resumedAt: number[] = [];
        kept.handle.listen({ resume: (generation) => resumedAt.push(generation) });

        link.session.dropped('closed 1006');
        // A channel without a resume key closes at once.
        expect(lostReason).toEqual(['resume_failed']);
        expect(h.registry.linkView({ id: NODE_ID, kind: 'node' }, true).state).toBe('reconnecting');

        const again = h.connect({
            resume: {
                linkGeneration: 1,
                channels: [
                    { channel: kept.handle.channel, family: 'session', resumeKey: 's-1' },
                    { channel: 99, family: 'logs' },
                ],
            },
        });
        expect(again.session.ready).toMatchObject({
            linkGeneration: 2,
            resumed: [kept.handle.channel],
            closed: [99],
        });
        expect(resumedAt).toEqual([2]);
        expect(unresumedReason).toEqual(['resume_failed']);
        // The same handle keeps working on the new link.
        expect(kept.handle.isOpen).toBe(true);
        expect(kept.handle.sendJson({ type: 'session.input' })).toBe(true);
        expect(again.port.jsonOn(kept.handle.channel)).toEqual([{ type: 'session.input' }]);
        // New channels number above the resumed ones.
        const next = await openAccepted(h, again, 'logs');
        expect(next.handle.channel).toBeGreaterThan(kept.handle.channel);
    });

    it('closes a resumable channel consent_missing when the node came back without its consent (U10)', async () => {
        const h = setup();
        const link = h.connect();
        const kept = await openAccepted(h, link, 'session', 's-1');
        const reasons: unknown[] = [];
        kept.handle.listen({ close: (reason) => reasons.push(reason) });
        link.session.dropped('closed');
        const again = h.connect({
            consents: { work: true, attend: false, manage: false, usageScan: false },
            resume: {
                linkGeneration: 1,
                channels: [{ channel: 1, family: 'session', resumeKey: 's-1' }],
            },
        });
        expect(again.session.ready).toMatchObject({ resumed: [], closed: [1] });
        expect(reasons).toEqual(['consent_missing']);
    });

    it('closes held channels resume_failed when no reconnect comes within the window', async () => {
        const h = setup();
        const link = h.connect();
        const kept = await openAccepted(h, link, 'session', 's-1');
        const reasons: unknown[] = [];
        kept.handle.listen({ close: (reason) => reasons.push(reason) });
        link.session.dropped('closed');
        h.timers.advance(120_000);
        expect(reasons).toEqual(['resume_failed']);
        expect(h.registry.linkView({ id: NODE_ID, kind: 'node' }, true).state).toBe('not-open');
    });

    it('resolves a request across a resume when the node answers on the new link', async () => {
        const h = setup();
        const link = h.connect();
        const { handle } = await openAccepted(h, link, 'session', 's-1');
        const reply = handle.request('session.status');
        const [request] = link.port.jsonOn(1);
        link.session.dropped('closed');
        const again = h.connect({
            resume: {
                linkGeneration: 1,
                channels: [{ channel: 1, family: 'session', resumeKey: 's-1' }],
            },
        });
        again.session.receive(
            jsonFrame(1, { requestId: request.requestId as string, result: 'working' }),
        );
        await expect(reply).resolves.toMatchObject({ result: 'working' });
    });
});

describe('FleetLinkRegistry — consents, pause, drain', () => {
    it('closes the channels whose consent a heartbeat withdrew, telling the node (FR-22)', async () => {
        const h = setup();
        const link = h.connect();
        const logs = await openAccepted(h, link, 'logs');
        const machineOpening = h.registry.machineChannel(NODE_ID, 'x');
        answerOpen(link.port, link.session, 'machine');
        const machine = await machineOpening;
        const closedCount = h.registry.applyConsents(NODE_ID, {
            work: true,
            attend: false,
            manage: false,
            usageScan: false,
        });
        expect(closedCount).toBe(1);
        expect(logs.handle.isClosed).toBe(true);
        expect(machine.isOpen).toBe(true);
        expect(link.port.last('channel.close')).toEqual({
            type: 'channel.close',
            channel: logs.handle.channel,
            reason: 'consent_missing',
            hint: 'start the node with --manage on build-01',
        });
        // Unchanged consents close nothing.
        expect(
            h.registry.applyConsents(NODE_ID, {
                work: true,
                attend: false,
                manage: false,
                usageScan: false,
            }),
        ).toBe(0);
    });

    it('tells every link link.pause and link.resume, and a link accepted while paused right after its ready (FR-26)', () => {
        const h = setup();
        const first = h.connect();
        h.registry.setPaused(true);
        h.registry.setPaused(true);
        expect(
            first.port.controls().filter((message) => message.type === 'link.pause'),
        ).toHaveLength(1);
        const second = h.connect();
        expect(second.port.controls().map((message) => message.type)).toEqual([
            'link.ready',
            'link.pause',
        ]);
        expect(second.port.last('link.pause')).toEqual({
            type: 'link.pause',
            reason: 'kill_switch',
        });
        h.registry.setPaused(false);
        expect(second.port.last('link.resume')).toEqual({ type: 'link.resume' });
    });

    it('sends the drain warning to each connected node it names (FR-27)', () => {
        const h = setup();
        const link = h.connect();
        expect(h.registry.drainNodes([NODE_ID, 'other-node'], 60)).toBe(1);
        expect(link.port.last('link.drain')).toEqual({ type: 'link.drain', graceSec: 60 });
    });

    it('hands operation progress and completion to the operations sink', () => {
        const h = setup();
        const link = h.connect();
        const seen: unknown[] = [];
        h.registry.setOperationSink((nodeId, message) => seen.push([nodeId, message.type]));
        link.session.receive(
            controlFrame({
                type: 'operation.progress',
                operationId: 'op-1',
                progress: { percent: 5 },
            }),
        );
        link.session.receive(
            controlFrame({ type: 'operation.done', operationId: 'op-1', result: {} }),
        );
        expect(seen).toEqual([
            [NODE_ID, 'operation.progress'],
            [NODE_ID, 'operation.done'],
        ]);
        expect(h.registry.cancelOperation(NODE_ID, 'op-1')).toBe(true);
        expect(link.port.last('operation.cancel')).toEqual({
            type: 'operation.cancel',
            operationId: 'op-1',
        });
    });

    it('routes a family’s own channel-0 message to its listener', () => {
        const h = setup();
        const link = h.connect();
        const seen: unknown[] = [];
        h.registry.onNodeControl('session.event', (nodeId, message) =>
            seen.push([nodeId, message.sessionId]),
        );
        link.session.receive(controlFrame({ type: 'session.event', sessionId: 's-1' }));
        expect(seen).toEqual([[NODE_ID, 's-1']]);
    });

    it('counts the bytes both ways and shows the link as connected (FR-41, FR-42)', async () => {
        const h = setup();
        const link = h.connect();
        await openAccepted(h, link, 'logs');
        link.session.receive({
            channel: 1,
            kind: FLEET_LINK_FRAME_KINDS.DATA,
            payload: new Uint8Array(100),
        });
        const view = h.registry.linkView({ id: NODE_ID, kind: 'node' }, true);
        expect(view).toMatchObject({ state: 'connected', linkGeneration: 1, openChannels: 1 });
        expect(view.bytesIn).toBeGreaterThanOrEqual(109);
        expect(view.bytesOut).toBeGreaterThan(0);
        expect(h.registry.linkView({ id: 'x', kind: 'node' }, false).state).toBe('refused');
        expect(h.registry.linkView({ id: 'x', kind: 'desktop-node' }, true).state).toBe(
            'unsupported-kind',
        );
    });

    it('closes every link and held channel at shutdown', async () => {
        const h = setup();
        const link = h.connect();
        const { handle } = await openAccepted(h, link, 'session', 's-1');
        h.registry.closeAll(1001, 'server shutting down');
        expect(link.port.closed).toEqual({ code: 1001, reason: 'server shutting down' });
        expect(handle.isClosed).toBe(true);
        expect(h.registry.isConnected(NODE_ID)).toBe(false);
        await settle();
    });
});

describe('FleetLinkRegistry — wire order, unconfirmed generations, node-sent opens', () => {
    /** Channel-0 frames by type, other channels as `ch<n>`, in wire order. */
    const wire = (port: RecordingPort) =>
        port.frames.map((frame) =>
            frame.channel === 0
                ? (decodeFleetLinkControl(frame.payload)?.type ?? '?')
                : `ch${frame.channel}`,
        );

    it('sends link.ready first, then the pause in force, then what a resumed channel sends', async () => {
        const h = setup();
        const link = h.connect();
        const kept = await openAccepted(h, link, 'session', 's-1');
        kept.handle.listen({ resume: () => kept.handle.sendJson({ type: 'session.replay' }) });
        link.session.dropped('closed 1006');
        h.registry.setPaused(true);
        const again = h.connect({
            resume: {
                linkGeneration: 1,
                channels: [{ channel: kept.handle.channel, family: 'session', resumeKey: 's-1' }],
            },
        });
        expect(wire(again.port)).toEqual(['link.ready', 'link.pause', `ch${kept.handle.channel}`]);
    });

    it('treats a reconnect presenting the generation an unheard link resumed from as the same node process', async () => {
        const h = setup();
        const events: Array<{ type: string; continued?: boolean }> = [];
        h.registry.onLinkEvent((event) => events.push(event));
        const first = h.connect();
        const kept = await openAccepted(h, first, 'session', 's-1');
        first.session.dropped('closed 1006');
        const offer = {
            linkGeneration: 1,
            channels: [
                { channel: kept.handle.channel, family: 'session' as const, resumeKey: 's-1' },
            ],
        };
        // Generation 2 is issued, but the link dies before the node says
        // anything on it: its ready may never have arrived.
        const lost = h.connect({ resume: offer });
        expect(lost.session.linkGeneration).toBe(2);
        lost.session.dropped('closed 1006');
        const again = h.connect({ resume: offer });
        expect(again.session.ready).toMatchObject({
            linkGeneration: 3,
            resumed: [kept.handle.channel],
            closed: [],
        });
        expect(kept.handle.isOpen).toBe(true);
        expect(
            events.filter((event) => event.type === 'connected').map((event) => event.continued),
        ).toEqual([false, true, true]);
    });

    it('does not, once the node was heard on that link (it had the newer generation)', async () => {
        const h = setup();
        const events: Array<{ type: string; continued?: boolean }> = [];
        h.registry.onLinkEvent((event) => events.push(event));
        const first = h.connect();
        const kept = await openAccepted(h, first, 'session', 's-1');
        first.session.dropped('closed 1006');
        const offer = {
            linkGeneration: 1,
            channels: [
                { channel: kept.handle.channel, family: 'session' as const, resumeKey: 's-1' },
            ],
        };
        const heard = h.connect({ resume: offer });
        heard.session.receive(controlFrame({ type: 'link.ping', t: 1 }));
        heard.session.dropped('closed 1006');
        const stale = h.connect({ resume: offer });
        expect(stale.session.ready).toMatchObject({ resumed: [], closed: [kept.handle.channel] });
        expect(events.at(-1)).toMatchObject({ type: 'connected', continued: false });
    });

    it('refuses a channel.open the node sends; nothing opens (ACC-FL02-07)', () => {
        const h = setup();
        const link = h.connect();
        link.session.receive(
            controlFrame({
                type: 'channel.open',
                channel: 5,
                family: 'logs',
                params: {},
                requestId: 'from-node',
            }),
        );
        expect(link.port.last('channel.refused')).toEqual({
            type: 'channel.refused',
            channel: 5,
            requestId: 'from-node',
            error: { code: 'invalid', hint: 'channels are opened by the platform' },
        });
        expect(h.registry.linkView({ id: NODE_ID, kind: 'node' }, true).openChannels).toBe(0);
    });

    it('answers a request cut off by a dropped link unreachable, never resume_failed (CONTRACTS §8)', async () => {
        const h = setup();
        const link = h.connect();
        const { handle } = await openAccepted(h, link, 'logs');
        const reply = handle.request('logs.read');
        link.session.dropped('closed 1006');
        await expect(reply).rejects.toMatchObject({
            linkError: { code: 'unreachable', hint: 'the link to the computer dropped' },
        });
    });
});
