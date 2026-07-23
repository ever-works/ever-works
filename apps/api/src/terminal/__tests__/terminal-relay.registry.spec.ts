import { Test } from '@nestjs/testing';
import {
    InProcessTerminalFanoutBus,
    TERMINAL_FANOUT_BUS,
    TERMINAL_RELAY_REGISTRY_OPTIONS,
    TerminalRelayRegistry,
    type TerminalClientRole,
    type TerminalFanoutBus,
    type TerminalRelayClient,
} from '../terminal-relay.registry';
import { decodeTerminalFrame, type TerminalFrame } from '@ever-works/contracts';

const RUN = '2f9d1f2a-9c7e-4b1a-8f0d-0a1b2c3d4e5f';
const B64 = 'aGVsbG8='; // "hello"

function makeClient(id: string, role: TerminalClientRole = 'viewer') {
    const received: TerminalFrame[] = [];
    const client: TerminalRelayClient & {
        received: TerminalFrame[];
        failNext: { value: boolean };
    } = {
        id,
        role,
        received,
        failNext: { value: false },
        send(wire: string) {
            if (client.failNext.value) {
                throw new Error('socket dead');
            }
            const frame = decodeTerminalFrame(wire);
            if (!frame) {
                throw new Error(`relay emitted invalid wire: ${wire}`);
            }
            received.push(frame);
        },
    };
    return client;
}

function stdout(seq: number, data: string = B64): TerminalFrame {
    return { kind: 'stdout', seq, data };
}

describe('TerminalRelayRegistry', () => {
    describe('publish + backpressure of history', () => {
        it('retains pre-attach banners and stdout, replays them in order on attach, exit pinned last', () => {
            const registry = new TerminalRelayRegistry();
            registry.publish(RUN, { kind: 'error', message: 'starting provider…' });
            registry.publish(RUN, stdout(0));
            registry.publish(RUN, stdout(1));
            registry.publish(RUN, { kind: 'exit', code: 0, reason: 'completed' });

            const late = makeClient('late', 'viewer');
            const status = registry.attach(RUN, late);

            expect(late.received.map((f) => f.kind)).toEqual(['error', 'stdout', 'stdout', 'exit']);
            expect(late.received[1]).toEqual(stdout(0));
            expect(late.received[3]).toEqual({ kind: 'exit', code: 0, reason: 'completed' });
            expect(status.ended).toBe(true);
            expect(status.exitReason).toBe('completed');
        });

        it('replays history to EVERY future attach, not just the first', () => {
            const registry = new TerminalRelayRegistry();
            registry.publish(RUN, { kind: 'error', message: 'provider not configured' });
            registry.publish(RUN, { kind: 'exit', code: 1, reason: 'crashed' });

            const first = makeClient('a');
            registry.attach(RUN, first);
            registry.detach(RUN, 'a');
            const second = makeClient('b');
            registry.attach(RUN, second);

            // A session that failed before producing output still explains
            // itself to a viewer arriving arbitrarily late.
            expect(second.received.map((f) => f.kind)).toEqual(['error', 'exit']);
        });

        it('drops duplicate/stale stdout seq (publisher retries render nothing twice)', () => {
            const registry = new TerminalRelayRegistry();
            const client = makeClient('c', 'driver');
            registry.attach(RUN, client);

            expect(registry.publish(RUN, stdout(0))).toBe(true);
            expect(registry.publish(RUN, stdout(0))).toBe(false); // retry
            expect(registry.publish(RUN, stdout(1))).toBe(true);
            expect(registry.publish(RUN, stdout(1))).toBe(false);
            expect(registry.publish(RUN, stdout(0))).toBe(false); // stale

            expect(client.received.filter((f) => f.kind === 'stdout')).toHaveLength(2);
            expect(registry.getStatus(RUN).lastSeq).toBe(1);
        });

        it('evicts scrollback oldest-first under the byte budget, live clients unaffected', () => {
            const registry = new TerminalRelayRegistry(undefined, { scrollbackMaxBytes: 24 });
            registry.publish(RUN, stdout(0, 'AAAAAAAAAAAA')); // 12 chars
            registry.publish(RUN, stdout(1, 'BBBBBBBBBBBB'));
            registry.publish(RUN, stdout(2, 'CCCCCCCCCCCC')); // evicts seq 0

            const late = makeClient('late');
            registry.attach(RUN, late);
            const seqs = late.received
                .filter((f) => f.kind === 'stdout')
                .map((f) => (f as { seq: number }).seq);
            expect(seqs).toEqual([1, 2]);
        });

        it('caps retained banners (oldest evicted) while the pinned exit survives', () => {
            const registry = new TerminalRelayRegistry(undefined, { bannersCap: 2 });
            registry.publish(RUN, { kind: 'error', message: 'one' });
            registry.publish(RUN, { kind: 'error', message: 'two' });
            registry.publish(RUN, { kind: 'error', message: 'three' });
            registry.publish(RUN, { kind: 'exit', code: 1, reason: 'crashed' });

            const late = makeClient('late');
            registry.attach(RUN, late);
            expect(
                late.received.map((f) =>
                    f.kind === 'error' ? (f as { message: string }).message : f.kind,
                ),
            ).toEqual(['two', 'three', 'exit']);
        });

        it('errors published while clients are attached are transient (fanned out, not retained)', () => {
            const registry = new TerminalRelayRegistry();
            const live = makeClient('live');
            registry.attach(RUN, live);
            registry.publish(RUN, { kind: 'error', message: 'transient banner' });
            expect(live.received.map((f) => f.kind)).toEqual(['error']);

            registry.detach(RUN, 'live');
            const late = makeClient('late');
            registry.attach(RUN, late);
            expect(late.received).toEqual([]);
        });

        it('refuses client-direction kinds on the publish leg (no forged input via publish)', () => {
            const registry = new TerminalRelayRegistry();
            expect(registry.publish(RUN, { kind: 'stdin', data: B64 })).toBe(false);
            expect(registry.publish(RUN, { kind: 'resize', cols: 80, rows: 24 })).toBe(false);
            expect(registry.publish(RUN, { kind: 'auth', token: 't' })).toBe(false);
            expect(registry.getStatus(RUN).lastSeq).toBeNull();
        });

        it('ignores publishes after the session ended (exit is final)', () => {
            const registry = new TerminalRelayRegistry();
            const client = makeClient('c');
            registry.attach(RUN, client);
            registry.publish(RUN, { kind: 'exit', code: 0, reason: 'closed' });
            expect(registry.publish(RUN, stdout(5))).toBe(false);
            expect(registry.publish(RUN, { kind: 'exit', code: 1, reason: 'crashed' })).toBe(false);

            expect(registry.getStatus(RUN).exitReason).toBe('closed');
            expect(client.received.map((f) => f.kind)).toEqual(['exit']);
        });
    });

    describe('live fan-out', () => {
        it('fans published frames to every attached client', () => {
            const registry = new TerminalRelayRegistry();
            const a = makeClient('a', 'driver');
            const b = makeClient('b', 'viewer');
            registry.attach(RUN, a);
            registry.attach(RUN, b);

            registry.publish(RUN, stdout(0));

            expect(a.received.filter((f) => f.kind === 'stdout')).toHaveLength(1);
            expect(b.received.filter((f) => f.kind === 'stdout')).toHaveLength(1);
        });

        it('stops delivering after detach', () => {
            const registry = new TerminalRelayRegistry();
            const a = makeClient('a');
            registry.attach(RUN, a);
            registry.detach(RUN, 'a');
            registry.publish(RUN, stdout(0));
            expect(a.received).toEqual([]);
        });

        it('drops a client whose send throws without poisoning the rest of the fan-out', () => {
            const registry = new TerminalRelayRegistry();
            const dead = makeClient('dead');
            const alive = makeClient('alive');
            registry.attach(RUN, dead);
            registry.attach(RUN, alive);
            dead.failNext.value = true;

            registry.publish(RUN, stdout(0));

            expect(alive.received.filter((f) => f.kind === 'stdout')).toHaveLength(1);
            expect(registry.getStatus(RUN).clientCount).toBe(1);

            // Subsequent frames don't retry the dead client.
            dead.failNext.value = false;
            registry.publish(RUN, stdout(1));
            expect(dead.received).toEqual([]);
        });
    });

    describe('deliverInbound (role-checked input)', () => {
        function attachTrio(registry: TerminalRelayRegistry) {
            const driver = makeClient('driver-1', 'driver');
            const viewer = makeClient('viewer-1', 'viewer');
            const worker = makeClient('worker-1', 'worker');
            registry.attach(RUN, driver);
            registry.attach(RUN, viewer);
            registry.attach(RUN, worker);
            return { driver, viewer, worker };
        }

        it('driver stdin fans to all clients except the sender', () => {
            const registry = new TerminalRelayRegistry();
            const { driver, viewer, worker } = attachTrio(registry);

            expect(registry.deliverInbound(RUN, 'driver-1', { kind: 'stdin', data: B64 })).toBe(
                true,
            );

            expect(driver.received).toEqual([]);
            expect(viewer.received).toEqual([{ kind: 'stdin', data: B64 }]);
            expect(worker.received).toEqual([{ kind: 'stdin', data: B64 }]);
        });

        it('viewer input is refused with an error answered to the sender only', () => {
            const registry = new TerminalRelayRegistry();
            const { driver, viewer, worker } = attachTrio(registry);

            expect(registry.deliverInbound(RUN, 'viewer-1', { kind: 'stdin', data: B64 })).toBe(
                false,
            );

            expect(viewer.received).toHaveLength(1);
            expect(viewer.received[0].kind).toBe('error');
            expect(driver.received).toEqual([]);
            expect(worker.received).toEqual([]);
        });

        it('resize follows the same role policy', () => {
            const registry = new TerminalRelayRegistry();
            const { viewer, worker } = attachTrio(registry);

            expect(
                registry.deliverInbound(RUN, 'driver-1', { kind: 'resize', cols: 120, rows: 40 }),
            ).toBe(true);
            expect(worker.received).toEqual([{ kind: 'resize', cols: 120, rows: 40 }]);

            expect(
                registry.deliverInbound(RUN, 'viewer-1', { kind: 'resize', cols: 10, rows: 10 }),
            ).toBe(false);
        });

        it('server-direction kinds can never re-enter as input (echoed replay hardening)', () => {
            const registry = new TerminalRelayRegistry();
            const { driver, worker } = attachTrio(registry);

            expect(registry.deliverInbound(RUN, 'driver-1', stdout(99))).toBe(false);
            expect(
                registry.deliverInbound(RUN, 'driver-1', {
                    kind: 'exit',
                    code: 0,
                    reason: 'completed',
                }),
            ).toBe(false);
            expect(registry.deliverInbound(RUN, 'driver-1', { kind: 'auth', token: 't' })).toBe(
                false,
            );
            expect(worker.received).toEqual([]);
            expect(driver.received).toEqual([]);
            // The forged exit did not end the session.
            expect(registry.getStatus(RUN).ended).toBe(false);
        });

        it('rejects input from unknown sessions and unattached senders', () => {
            const registry = new TerminalRelayRegistry();
            expect(
                registry.deliverInbound('0f000000-0000-4000-8000-000000000000', 'x', {
                    kind: 'stdin',
                    data: B64,
                }),
            ).toBe(false);
            registry.attach(RUN, makeClient('a', 'driver'));
            expect(registry.deliverInbound(RUN, 'not-attached', { kind: 'stdin', data: B64 })).toBe(
                false,
            );
        });
    });

    describe('status + reclaim', () => {
        it('reports counts, ended state, and lastSeq', () => {
            const registry = new TerminalRelayRegistry();
            expect(registry.getStatus(RUN).exists).toBe(false);

            registry.attach(RUN, makeClient('d', 'driver'));
            registry.attach(RUN, makeClient('v', 'viewer'));
            registry.publish(RUN, stdout(7));

            const status = registry.getStatus(RUN);
            expect(status).toEqual({
                exists: true,
                ended: false,
                exitReason: null,
                clientCount: 2,
                viewerCount: 1,
                lastSeq: 7,
            });
        });

        it('reclaims only when unattached AND ended AND seen at least once', () => {
            const registry = new TerminalRelayRegistry();
            const client = makeClient('a');

            registry.publish(RUN, stdout(0));
            expect(registry.canReclaim(RUN)).toBe(false); // not ended

            registry.publish(RUN, { kind: 'exit', code: 0, reason: 'completed' });
            expect(registry.canReclaim(RUN)).toBe(false); // ended but never seen

            registry.attach(RUN, client);
            expect(registry.canReclaim(RUN)).toBe(false); // still attached

            registry.detach(RUN, 'a');
            expect(registry.canReclaim(RUN)).toBe(true);
            expect(registry.reclaim(RUN)).toBe(true);
            expect(registry.getStatus(RUN).exists).toBe(false);
        });

        it('force reclaim releases an ended-but-never-seen session (sweeper TTL path)', () => {
            const registry = new TerminalRelayRegistry();
            registry.publish(RUN, { kind: 'error', message: 'never seen' });
            registry.publish(RUN, { kind: 'exit', code: 1, reason: 'crashed' });

            expect(registry.reclaim(RUN)).toBe(false);
            expect(registry.reclaim(RUN, { force: true })).toBe(true);
            expect(registry.getStatus(RUN).exists).toBe(false);
        });

        it('force reclaim still refuses live sessions', () => {
            const registry = new TerminalRelayRegistry();
            registry.attach(RUN, makeClient('a'));
            registry.publish(RUN, { kind: 'exit', code: 0, reason: 'completed' });
            expect(registry.reclaim(RUN, { force: true })).toBe(false);
        });

        it('reclaim of an unknown session is a no-op', () => {
            const registry = new TerminalRelayRegistry();
            expect(registry.canReclaim('0f000000-0000-4000-8000-000000000000')).toBe(true);
            expect(registry.reclaim('0f000000-0000-4000-8000-000000000000')).toBe(false);
        });
    });

    describe('fan-out bus (multi-replica seam)', () => {
        function makeLoopBus(): TerminalFanoutBus & {
            handlers: Array<(runId: string, wire: string) => void>;
            published: Array<{ runId: string; wire: string }>;
        } {
            const bus = {
                handlers: [] as Array<(runId: string, wire: string) => void>,
                published: [] as Array<{ runId: string; wire: string }>,
                publishRemote(runId: string, wire: string) {
                    bus.published.push({ runId, wire });
                },
                onRemote(handler: (runId: string, wire: string) => void) {
                    bus.handlers.push(handler);
                },
            };
            return bus;
        }

        it('locally published frames are forwarded to the bus', () => {
            const bus = makeLoopBus();
            const registry = new TerminalRelayRegistry(bus);
            registry.publish(RUN, stdout(0));

            expect(bus.published).toHaveLength(1);
            expect(decodeTerminalFrame(bus.published[0].wire)).toEqual(stdout(0));
        });

        it('frames arriving from peers fan out locally but are NOT re-broadcast (no loops)', () => {
            const bus = makeLoopBus();
            const registry = new TerminalRelayRegistry(bus);
            const client = makeClient('local-viewer');
            registry.attach(RUN, client);

            bus.handlers[0](RUN, JSON.stringify(stdout(3)));

            expect(client.received).toEqual([stdout(3)]);
            expect(bus.published).toEqual([]);
        });

        it('garbage from the bus is dropped without effect', () => {
            const bus = makeLoopBus();
            const registry = new TerminalRelayRegistry(bus);
            bus.handlers[0](RUN, 'not json{{');
            bus.handlers[0](RUN, JSON.stringify({ kind: 'stdin', data: B64 }));
            expect(registry.getStatus(RUN).lastSeq).toBeNull();
        });

        it('the in-process bus is inert (single replica default)', () => {
            const bus = new InProcessTerminalFanoutBus();
            expect(() => bus.publishRemote()).not.toThrow();
            expect(() => bus.onRemote()).not.toThrow();
        });

        it('a throwing bus never fails the local publish (best-effort remote)', () => {
            const bus: TerminalFanoutBus = {
                publishRemote() {
                    throw new Error('redis down');
                },
                onRemote() {
                    // not needed
                },
            };
            const registry = new TerminalRelayRegistry(bus);
            const client = makeClient('local');
            registry.attach(RUN, client);

            expect(() => registry.publish(RUN, stdout(0))).not.toThrow();
            expect(registry.publish(RUN, stdout(1))).toBe(true);
            // Local delivery and seq bookkeeping proceeded normally.
            expect(client.received.filter((f) => f.kind === 'stdout')).toHaveLength(2);
            expect(registry.getStatus(RUN).lastSeq).toBe(1);
        });

        function makeLinkedRegistries() {
            // Two registries joined by a symmetric in-memory bus, the
            // shape a Redis pub/sub impl will have: publishRemote on one
            // replica fires onRemote handlers on the OTHER only.
            const handlersA: Array<(runId: string, wire: string) => void> = [];
            const handlersB: Array<(runId: string, wire: string) => void> = [];
            const busA: TerminalFanoutBus = {
                publishRemote: (runId, wire) => handlersB.forEach((h) => h(runId, wire)),
                onRemote: (h) => handlersA.push(h),
            };
            const busB: TerminalFanoutBus = {
                publishRemote: (runId, wire) => handlersA.forEach((h) => h(runId, wire)),
                onRemote: (h) => handlersB.push(h),
            };
            return {
                replicaA: new TerminalRelayRegistry(busA),
                replicaB: new TerminalRelayRegistry(busB),
            };
        }

        it('cross-replica: server frames published on one replica reach clients on the other', () => {
            const { replicaA, replicaB } = makeLinkedRegistries();
            const remoteViewer = makeClient('remote-viewer');
            replicaB.attach(RUN, remoteViewer);

            replicaA.publish(RUN, stdout(0));

            expect(remoteViewer.received).toEqual([stdout(0)]);
            // And the peer replica's seq bookkeeping advanced.
            expect(replicaB.getStatus(RUN).lastSeq).toBe(0);
        });

        it('cross-replica: driver stdin reaches a worker attached to the other replica (no loops)', () => {
            const { replicaA, replicaB } = makeLinkedRegistries();
            const driver = makeClient('driver-1', 'driver');
            const worker = makeClient('worker-1', 'worker');
            replicaA.attach(RUN, driver);
            replicaB.attach(RUN, worker);

            expect(replicaA.deliverInbound(RUN, 'driver-1', { kind: 'stdin', data: B64 })).toBe(
                true,
            );

            // The worker on replica B received the keystrokes…
            expect(worker.received).toEqual([{ kind: 'stdin', data: B64 }]);
            // …and nothing echoed back to the sending driver (no loop).
            expect(driver.received).toEqual([]);
        });

        it('cross-replica: remote stdin for a run with no local session is a no-op', () => {
            const { replicaA, replicaB } = makeLinkedRegistries();
            const driver = makeClient('driver-1', 'driver');
            replicaA.attach(RUN, driver);

            expect(() =>
                replicaA.deliverInbound(RUN, 'driver-1', { kind: 'stdin', data: B64 }),
            ).not.toThrow();
            expect(replicaB.getStatus(RUN).exists).toBe(false);
        });
    });

    describe('scrollback accounting (decoded bytes, not wire characters)', () => {
        it('budgets by decoded terminal bytes — a frame at the decoded budget survives', () => {
            // 12 base64 chars decode to 9 bytes. Under WIRE-character
            // accounting a 9-byte budget would evict this frame (12 > 9);
            // under decoded accounting it fits exactly.
            const registry = new TerminalRelayRegistry(undefined, { scrollbackMaxBytes: 9 });
            registry.publish(RUN, stdout(0, 'AAAAAAAAAAAA'));

            const late = makeClient('late');
            registry.attach(RUN, late);
            expect(late.received.filter((f) => f.kind === 'stdout')).toHaveLength(1);
        });

        it('padding does not count against the budget', () => {
            // 'QQ==' is 4 wire chars but exactly 1 decoded byte. Ten of
            // them fit in a 10-byte budget (40 wire chars would not).
            const registry = new TerminalRelayRegistry(undefined, { scrollbackMaxBytes: 10 });
            for (let i = 0; i < 10; i++) {
                registry.publish(RUN, stdout(i, 'QQ=='));
            }
            const late = makeClient('late');
            registry.attach(RUN, late);
            expect(late.received.filter((f) => f.kind === 'stdout')).toHaveLength(10);
        });
    });

    describe('attach reentrancy', () => {
        it('a frame published synchronously DURING replay still reaches the attaching client exactly once', () => {
            const registry = new TerminalRelayRegistry();
            registry.publish(RUN, stdout(0));
            registry.publish(RUN, stdout(1));

            let reentered = false;
            const received: TerminalFrame[] = [];
            const reentrant: TerminalRelayClient & { received: TerminalFrame[] } = {
                id: 'reentrant',
                role: 'viewer',
                received,
                send(wire: string) {
                    const frame = decodeTerminalFrame(wire);
                    if (!frame) throw new Error(`invalid wire: ${wire}`);
                    received.push(frame);
                    if (!reentered) {
                        reentered = true;
                        // A same-process worker adapter can publish from
                        // within a delivery callback.
                        registry.publish(RUN, stdout(2));
                    }
                },
            };

            registry.attach(RUN, reentrant);

            const seqs = received
                .filter((f) => f.kind === 'stdout')
                .map((f) => (f as { seq: number }).seq);
            expect(seqs).toEqual([0, 1, 2]);
        });

        it('an exit published during replay is delivered to the attaching client', () => {
            const registry = new TerminalRelayRegistry();
            registry.publish(RUN, stdout(0));

            let fired = false;
            const received: TerminalFrame[] = [];
            const client: TerminalRelayClient & { received: TerminalFrame[] } = {
                id: 'x',
                role: 'viewer',
                received,
                send(wire: string) {
                    const frame = decodeTerminalFrame(wire);
                    if (!frame) throw new Error('invalid wire');
                    received.push(frame);
                    if (!fired) {
                        fired = true;
                        registry.publish(RUN, { kind: 'exit', code: 0, reason: 'completed' });
                    }
                },
            };

            registry.attach(RUN, client);

            expect(received.map((f) => f.kind)).toEqual(['stdout', 'exit']);
        });
    });

    describe('NestJS injection tokens', () => {
        it('a DI-provided bus and options actually reach the registry (interfaces are erased at runtime)', async () => {
            const published: Array<{ runId: string; wire: string }> = [];
            const bus: TerminalFanoutBus = {
                publishRemote: (runId, wire) => published.push({ runId, wire }),
                onRemote: () => undefined,
            };
            const moduleRef = await Test.createTestingModule({
                providers: [
                    TerminalRelayRegistry,
                    { provide: TERMINAL_FANOUT_BUS, useValue: bus },
                    {
                        provide: TERMINAL_RELAY_REGISTRY_OPTIONS,
                        useValue: { scrollbackMaxBytes: 9 },
                    },
                ],
            }).compile();
            const registry = moduleRef.get(TerminalRelayRegistry);

            registry.publish(RUN, stdout(0, 'AAAAAAAAAAAA')); // 9 decoded bytes
            registry.publish(RUN, stdout(1, 'AAAAAAAAAAAA')); // evicts seq 0

            // The DI-provided bus received the publishes…
            expect(published).toHaveLength(2);
            // …and the DI-provided options took effect (9-byte budget
            // keeps exactly one 9-byte frame).
            const late = makeClient('late');
            registry.attach(RUN, late);
            const seqs = late.received
                .filter((f) => f.kind === 'stdout')
                .map((f) => (f as { seq: number }).seq);
            expect(seqs).toEqual([1]);
        });
    });

    describe('session isolation', () => {
        it('frames and clients never cross run boundaries', () => {
            const OTHER = '3a000000-0000-4000-8000-000000000001';
            const registry = new TerminalRelayRegistry();
            const a = makeClient('a');
            const b = makeClient('b');
            registry.attach(RUN, a);
            registry.attach(OTHER, b);

            registry.publish(RUN, stdout(0));

            expect(a.received).toHaveLength(1);
            expect(b.received).toEqual([]);
        });
    });
});
