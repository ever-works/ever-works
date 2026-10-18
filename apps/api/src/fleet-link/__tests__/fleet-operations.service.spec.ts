import { FleetLinkRegistry } from '../fleet-link.registry';
import { FleetOperationsService } from '../fleet-operations.service';
import { controlFrame, hello, NODE_ID, OWNER, RecordingPort } from './link-test-kit';

/**
 * FleetOperationsService (FL-02, spec FR-17, FR-18, ACC-FL02-08, -22):
 * progress, completion, cancel → cancelled, one hour of retention, nobody but
 * the requester or the node's owner sees one, and only the node that runs an
 * operation may report on it.
 */

function setup() {
    let now = 1_760_000_000_000;
    const registry = new FleetLinkRegistry();
    const operations = new FleetOperationsService(registry, { now: () => now });
    const port = new RecordingPort();
    const session = registry.accept({
        nodeId: NODE_ID,
        ownerUserId: OWNER,
        nodeName: 'build-01',
        nodeKind: 'node',
        hello: hello(),
        socket: port,
    });
    const track = () =>
        operations.track({
            operationId: 'op-1',
            nodeId: NODE_ID,
            family: 'machine',
            verb: 'docker.image.pull',
            requesterUserId: 'requester',
            ownerUserId: OWNER,
        });
    return { registry, operations, port, session, track, advance: (ms: number) => (now += ms) };
}

describe('FleetOperationsService', () => {
    it('tracks progress and completion from the node that runs it', () => {
        const h = setup();
        expect(h.track()).toMatchObject({
            id: 'op-1',
            state: 'running',
            progress: null,
            cancelRequested: false,
        });
        h.session.receive(
            controlFrame({
                type: 'operation.progress',
                operationId: 'op-1',
                progress: { percent: 40, message: 'pulling' },
            }),
        );
        expect(h.operations.get('op-1', 'requester')).toMatchObject({
            state: 'running',
            progress: { percent: 40, message: 'pulling' },
        });
        h.session.receive(
            controlFrame({
                type: 'operation.done',
                operationId: 'op-1',
                result: { digest: 'sha256:1' },
            }),
        );
        const done = h.operations.get('op-1', OWNER);
        expect(done).toMatchObject({ state: 'done', result: { digest: 'sha256:1' } });
        expect(done.endedAt).not.toBeNull();
    });

    it('fails an operation the node reports an error for, with the shared envelope', () => {
        const h = setup();
        h.track();
        h.session.receive(
            controlFrame({
                type: 'operation.done',
                operationId: 'op-1',
                error: { code: 'operation_failed', hint: 'no space left on device' },
            }),
        );
        expect(h.operations.get('op-1', 'requester')).toMatchObject({
            state: 'failed',
            error: { code: 'operation_failed', hint: 'no space left on device' },
        });
    });

    it('ignores another node reporting on it', () => {
        const h = setup();
        h.track();
        const other = h.registry.accept({
            nodeId: '11111111-2222-4333-8444-555555555555',
            ownerUserId: 'mallory',
            nodeName: 'other',
            nodeKind: 'node',
            hello: hello({ nodeId: '11111111-2222-4333-8444-555555555555' }),
            socket: new RecordingPort(),
        });
        other.receive(
            controlFrame({ type: 'operation.done', operationId: 'op-1', result: 'forged' }),
        );
        expect(h.operations.get('op-1', 'requester').state).toBe('running');
    });

    it('sends operation.cancel and reads cancelled once the node confirms (ACC-FL02-22)', () => {
        const h = setup();
        h.track();
        const result = h.operations.cancel('op-1', 'requester');
        expect(result).toMatchObject({
            sent: true,
            operation: { state: 'running', cancelRequested: true },
        });
        expect(h.port.last('operation.cancel')).toEqual({
            type: 'operation.cancel',
            operationId: 'op-1',
        });
        h.session.receive(
            controlFrame({
                type: 'operation.done',
                operationId: 'op-1',
                error: { code: 'operation_failed', hint: 'cancelled' },
            }),
        );
        expect(h.operations.get('op-1', 'requester')).toMatchObject({
            state: 'cancelled',
            error: { hint: 'cancelled' },
        });
        // Cancelling what already ended sends nothing.
        expect(h.operations.cancel('op-1', 'requester')).toMatchObject({ sent: false });
    });

    it('answers unreachable when the node is gone, and leaves the operation running', () => {
        const h = setup();
        h.track();
        h.session.dropped('closed');
        expect(() => h.operations.cancel('op-1', 'requester')).toThrow(
            expect.objectContaining({
                linkError: expect.objectContaining({ code: 'unreachable' }),
            }),
        );
        expect(h.operations.get('op-1', 'requester').state).toBe('running');
    });

    it('is not_found for anyone but the requester and the node owner', () => {
        const h = setup();
        h.track();
        expect(() => h.operations.get('op-1', 'stranger')).toThrow(
            expect.objectContaining({ linkError: expect.objectContaining({ code: 'not_found' }) }),
        );
        expect(() => h.operations.get('nope', 'requester')).toThrow(
            expect.objectContaining({ linkError: expect.objectContaining({ code: 'not_found' }) }),
        );
    });

    describe('interrupted (CONTRACTS §3.3 rev 5)', () => {
        function withTimers() {
            const timers: Array<{ at: number; callback: () => void }> = [];
            let now = 0;
            const registry = new FleetLinkRegistry({ now: () => now });
            const operations = new FleetOperationsService(registry, {
                now: () => now,
                resumeWindowMs: 120_000,
                setTimer: (callback, ms) => timers.push({ at: now + ms, callback }),
                clearTimer: (handle) => {
                    const index = (handle as number) - 1;
                    if (timers[index]) timers[index] = { at: Infinity, callback: () => undefined };
                },
            });
            const connect = (resume?: number) =>
                registry.accept({
                    nodeId: NODE_ID,
                    ownerUserId: OWNER,
                    nodeName: 'build-01',
                    nodeKind: 'node',
                    hello: hello(
                        resume === undefined
                            ? {}
                            : { resume: { linkGeneration: resume, channels: [] } },
                    ),
                    socket: new RecordingPort(),
                });
            const track = () =>
                operations.track({
                    operationId: 'op-1',
                    nodeId: NODE_ID,
                    family: 'machine',
                    verb: 'compose.up',
                    requesterUserId: OWNER,
                    ownerUserId: OWNER,
                });
            const advance = (ms: number) => {
                now += ms;
                for (const timer of timers)
                    if (timer.at <= now) {
                        const run = timer.callback;
                        timer.at = Infinity;
                        run();
                    }
            };
            return { registry, operations, connect, track, advance };
        }

        it('reads interrupted when the node comes back as a fresh process, and ignores a late completion', () => {
            const h = withTimers();
            const first = h.connect();
            h.track();
            first.dropped('closed');
            const second = h.connect(); // no resume: the node restarted
            expect(h.operations.get('op-1', OWNER)).toMatchObject({
                state: 'interrupted',
                error: {
                    code: 'unreachable',
                    hint: 'the computer restarted while this was running',
                },
            });
            second.receive(
                controlFrame({ type: 'operation.done', operationId: 'op-1', result: { ok: true } }),
            );
            expect(h.operations.get('op-1', OWNER).state).toBe('interrupted');
        });

        it('keeps running across a reconnect of the same node process', () => {
            const h = withTimers();
            const first = h.connect();
            h.track();
            first.dropped('closed');
            const again = h.connect(first.linkGeneration);
            h.advance(200_000);
            expect(h.operations.get('op-1', OWNER).state).toBe('running');
            again.receive(
                controlFrame({ type: 'operation.done', operationId: 'op-1', result: { ok: true } }),
            );
            expect(h.operations.get('op-1', OWNER).state).toBe('done');
        });

        it('reads interrupted when the link stays away past the resume window', () => {
            const h = withTimers();
            const first = h.connect();
            h.track();
            first.dropped('closed');
            h.advance(119_000);
            expect(h.operations.get('op-1', OWNER).state).toBe('running');
            h.advance(1_000);
            expect(h.operations.get('op-1', OWNER)).toMatchObject({
                state: 'interrupted',
                error: { hint: 'the computer went away while this was running' },
            });
        });
    });

    describe('updates that arrive before the reply naming the operation', () => {
        it('are applied when the operation is tracked', () => {
            const h = setup();
            h.session.receive(
                controlFrame({
                    type: 'operation.progress',
                    operationId: 'op-1',
                    progress: { percent: 10 },
                }),
            );
            h.session.receive(
                controlFrame({ type: 'operation.done', operationId: 'op-1', result: { ok: true } }),
            );
            expect(h.operations.earlyCount).toBe(1);
            expect(h.track()).toMatchObject({
                state: 'done',
                progress: { percent: 10 },
                result: { ok: true },
            });
            expect(h.operations.earlyCount).toBe(0);
        });

        it('never reach another node’s operation, and are forgotten after 10 s', () => {
            const h = setup();
            const other = h.registry.accept({
                nodeId: '11111111-2222-4333-8444-555555555555',
                ownerUserId: 'mallory',
                nodeName: 'other',
                nodeKind: 'node',
                hello: hello({ nodeId: '11111111-2222-4333-8444-555555555555' }),
                socket: new RecordingPort(),
            });
            other.receive(
                controlFrame({ type: 'operation.done', operationId: 'op-1', result: 'forged' }),
            );
            expect(h.track()).toMatchObject({ state: 'running' });

            const late = setup();
            late.session.receive(
                controlFrame({
                    type: 'operation.progress',
                    operationId: 'op-1',
                    progress: { percent: 99 },
                }),
            );
            late.advance(10_000);
            expect(late.track()).toMatchObject({ state: 'running', progress: null });
        });
    });

    it('keeps a finished operation one hour and fails one never finished after a day', () => {
        const h = setup();
        h.track();
        h.session.receive(
            controlFrame({ type: 'operation.done', operationId: 'op-1', result: null }),
        );
        h.advance(59 * 60_000);
        h.operations.sweep();
        expect(h.operations.get('op-1', 'requester').state).toBe('done');
        h.advance(60_000);
        h.operations.sweep();
        expect(h.operations.size).toBe(0);

        h.operations.track({
            operationId: 'op-2',
            nodeId: NODE_ID,
            family: 'machine',
            verb: 'vm.create',
            requesterUserId: OWNER,
            ownerUserId: OWNER,
        });
        h.advance(24 * 60 * 60_000);
        h.operations.sweep();
        expect(h.operations.get('op-2', OWNER)).toMatchObject({
            state: 'failed',
            error: { code: 'operation_failed' },
        });
    });
});
