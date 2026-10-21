import { EventEmitter } from 'events';
import { config } from '@ever-works/agent/config';
import { encodeTerminalFrame, type TerminalFrame } from '@ever-works/contracts';
import { ComputerRelayRegistry } from '../../computer/computer-relay.registry';
import { TerminalRelayRegistry } from '../../terminal/terminal-relay.registry';
import type { RelayBus } from '../relay-bus';
import {
    createRelayBus,
    RELAY_BUS_REQUIRED_MESSAGE,
    RELAY_BUS_SECRET_REQUIRED_MESSAGE,
    RelayBusLifecycle,
    type RelayBusSignalProcess,
} from '../relay-bus.module';
import { InProcessRelayBus } from '../relay-bus.in-process';
import { ValkeyRelayBus } from '../relay-bus.valkey';
import {
    RELAY_TERMINAL_REMOTE_IDLE_MS,
    RELAY_TERMINAL_REMOTE_RETENTION_MS,
    RelayComputerFanoutBus,
    RelayTerminalFanoutBus,
} from '../relay-fanout';
import { FakeValkey, flushBus, TEST_RELAY_SECRET } from './relay-test-kit';

/**
 * Relay bus selection (CONTRACTS R-7, spec FR-29 … FR-31) and the terminal
 * and computer relays riding it: Valkey exactly when a Redis URL is set,
 * in-process otherwise, a boot error naming `FLEET_RELAY_REQUIRE_BUS` when a
 * required bus is missing — and a frame published on one replica reaching a
 * browser attached to the other.
 */

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
});

async function until(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error('timed out');
        await flushBus(2);
    }
}

describe('createRelayBus', () => {
    it('runs in-process without a Redis URL', () => {
        const bus = createRelayBus({ url: null, required: false });
        expect(bus).toBeInstanceOf(InProcessRelayBus);
        expect(bus.health()).toEqual({ configured: false, mode: 'single-replica', status: 'up' });
    });

    it('runs on Valkey whenever a Redis URL is set — no other setting chooses', async () => {
        const hub = new FakeValkey();
        const bus = createRelayBus({
            url: 'redis://valkey:6379',
            required: false,
            valkey: { createClient: () => hub.client() },
        });
        closers.push(() => bus.close());
        expect(bus).toBeInstanceOf(ValkeyRelayBus);
        expect(bus.mode).toBe('valkey');
        expect(bus.health()).toMatchObject({ configured: true, mode: 'valkey' });
    });

    it('stays in-process with a Redis URL when the operator switched the bus off, even where it is required', () => {
        for (const required of [false, true]) {
            const bus = createRelayBus({ url: 'redis://valkey:6379', required, enabled: false });
            expect(bus).toBeInstanceOf(InProcessRelayBus);
            expect(bus.health()).toEqual({
                configured: false,
                mode: 'single-replica',
                status: 'up',
            });
        }
    });

    it('reads FLEET_RELAY_BUS_ENABLED as on unless it says false, 0 or off (any case)', () => {
        const original = process.env.FLEET_RELAY_BUS_ENABLED;
        try {
            delete process.env.FLEET_RELAY_BUS_ENABLED;
            expect(config.fleet.isRelayBusEnabled()).toBe(true);
            for (const on of ['true', '1', 'on', 'TRUE', 'yes', '']) {
                process.env.FLEET_RELAY_BUS_ENABLED = on;
                expect(config.fleet.isRelayBusEnabled()).toBe(true);
            }
            for (const off of ['false', 'FALSE', 'False', '0', 'off', 'OFF', ' off ']) {
                process.env.FLEET_RELAY_BUS_ENABLED = off;
                expect(config.fleet.isRelayBusEnabled()).toBe(false);
            }
        } finally {
            if (original === undefined) delete process.env.FLEET_RELAY_BUS_ENABLED;
            else process.env.FLEET_RELAY_BUS_ENABLED = original;
        }
    });

    it('fails boot with a message naming FLEET_RELAY_REQUIRE_BUS when a required bus is missing', () => {
        expect(() => createRelayBus({ url: null, required: true })).toThrow(
            RELAY_BUS_REQUIRED_MESSAGE,
        );
        expect(RELAY_BUS_REQUIRED_MESSAGE).toContain('FLEET_RELAY_REQUIRE_BUS');
        expect(RELAY_BUS_REQUIRED_MESSAGE).toContain('REDIS_URL');
    });

    it('fails boot when a required bus has no usable signing secret (it would carry nothing)', () => {
        const hub = new FakeValkey();
        for (const secret of [null, '', 'too-short']) {
            expect(() =>
                createRelayBus({
                    url: 'redis://valkey:6379',
                    required: true,
                    valkey: { secret, createClient: () => hub.client() },
                }),
            ).toThrow(RELAY_BUS_SECRET_REQUIRED_MESSAGE);
        }
        expect(RELAY_BUS_SECRET_REQUIRED_MESSAGE).toContain('TERMINAL_ATTACH_SECRET');
        expect(RELAY_BUS_SECRET_REQUIRED_MESSAGE).not.toContain('too-short');

        // A usable secret boots; an optional bus without one still boots (and logs) as before.
        for (const [required, secret] of [
            [true, 'a-shared-secret-of-enough-length'],
            [false, null],
        ] as const) {
            const bus = createRelayBus({
                url: 'redis://valkey:6379',
                required,
                valkey: { secret, createClient: () => hub.client() },
            });
            closers.push(() => bus.close());
            expect(bus).toBeInstanceOf(ValkeyRelayBus);
        }
    });
});

function twoReplicas() {
    const hub = new FakeValkey();
    const a = new ValkeyRelayBus({
        secret: TEST_RELAY_SECRET,
        url: 'redis://fake',
        createClient: () => hub.client(),
    });
    const b = new ValkeyRelayBus({
        secret: TEST_RELAY_SECRET,
        url: 'redis://fake',
        createClient: () => hub.client(),
    });
    closers.push(
        () => a.close(),
        () => b.close(),
    );
    return { hub, a, b };
}

describe('the terminal relay over the bus', () => {
    it('fans a frame published on replica A out to a browser attached on replica B', async () => {
        const { a, b } = twoReplicas();
        await until(() => a.peers().length === 1 && b.peers().length === 1);
        const onA = new TerminalRelayRegistry(new RelayTerminalFanoutBus(a));
        const onB = new TerminalRelayRegistry(new RelayTerminalFanoutBus(b));
        const received: string[] = [];
        onB.attach('run-1', { id: 'browser', role: 'driver', send: (wire) => received.push(wire) });
        const frame: TerminalFrame = {
            kind: 'stdout',
            seq: 0,
            data: Buffer.from('hi').toString('base64'),
        };
        expect(onA.publish('run-1', frame)).toBe(true);
        await until(() => received.some((wire) => wire === encodeTerminalFrame(frame)));
    });

    it('sends nothing with the single-replica bus', () => {
        const bus = new InProcessRelayBus();
        const publish = jest.spyOn(bus, 'publish');
        const registry = new TerminalRelayRegistry(new RelayTerminalFanoutBus(bus));
        registry.publish('run-1', { kind: 'stdout', seq: 0, data: '' });
        expect(publish).toHaveBeenCalled();
        expect(publish.mock.results.every((result) => result.value === false)).toBe(true);
    });
});

describe('the computer relay over the bus', () => {
    it('answers "a peer may have it" only when another replica is there', async () => {
        const { a, b } = twoReplicas();
        const busA = new RelayComputerFanoutBus(a);
        const seen: Array<[string, string]> = [];
        new RelayComputerFanoutBus(b).onRemote((sessionId, wire) => seen.push([sessionId, wire]));
        expect(busA.publishRemote('view-1', 'lost')).toBe(false); // nobody heard yet: nothing sent
        await until(() => a.peers().length === 1);
        expect(busA.publishRemote('view-2', 'wire')).toBe(true);
        await until(() => seen.length === 1);
        await flushBus();
        expect(seen).toEqual([['view-2', 'wire']]);
        // The real registry accepts the seam's shape.
        expect(new ComputerRelayRegistry(busA)).toBeInstanceOf(ComputerRelayRegistry);
    });

    it('ignores a message that is not a [key, wire] pair', async () => {
        const { a, b } = twoReplicas();
        await until(() => a.peers().length === 1);
        const seen: unknown[] = [];
        new RelayComputerFanoutBus(b).onRemote((...args) => seen.push(args));
        a.publish('relay.computer', '{"not":"a pair"}');
        a.publish('relay.computer', JSON.stringify(['', 'empty key']));
        a.publish('relay.computer', JSON.stringify(['ok', 'wire']));
        await until(() => seen.length === 1);
        expect(seen).toEqual([['ok', 'wire']]);
    });
});

/** A `process` double: signals delivered by hand, `kill` recorded. */
class SignalDouble extends EventEmitter implements RelayBusSignalProcess {
    readonly pid = 4242;
    readonly killed: Array<[number, NodeJS.Signals]> = [];
    kill(pid: number, signal: NodeJS.Signals): boolean {
        this.killed.push([pid, signal]);
        return true;
    }
}

function lifecycleWith(bus: Partial<RelayBus>, signals: SignalDouble) {
    return new RelayBusLifecycle(
        {
            mode: 'valkey',
            replicaId: 'r-x',
            close: jest.fn(async () => undefined),
            ...bus,
        } as RelayBus,
        { publishRemote: () => undefined, onRemote: () => undefined },
        {} as never,
        signals,
    );
}

describe('RelayBusLifecycle: the boot log', () => {
    it('warns, with the bus switched off over a Redis URL, that single-use tokens become per-process', () => {
        const original = {
            url: process.env.REDIS_URL,
            enabled: process.env.FLEET_RELAY_BUS_ENABLED,
        };
        const warn = jest
            .spyOn(require('@nestjs/common').Logger.prototype, 'warn')
            .mockImplementation(() => undefined);
        try {
            process.env.REDIS_URL = 'redis://valkey:6379';
            process.env.FLEET_RELAY_BUS_ENABLED = 'off';
            lifecycleWith({ mode: 'single-replica' }, new SignalDouble()).onApplicationBootstrap();
            const lines = warn.mock.calls.map((call) => String(call[0])).join('\n');
            expect(lines).toContain('FLEET_RELAY_BUS_ENABLED');
            expect(lines).toContain('once per replica');
        } finally {
            warn.mockRestore();
            for (const [name, value] of [
                ['REDIS_URL', original.url],
                ['FLEET_RELAY_BUS_ENABLED', original.enabled],
            ] as const) {
                if (value === undefined) delete process.env[name];
                else process.env[name] = value;
            }
        }
    });
});

describe('RelayBusLifecycle: the goodbye on SIGTERM (no app-wide shutdown hooks)', () => {
    it('closes the bus (its leave goes out), then re-raises the signal so the process ends as before', async () => {
        const signals = new SignalDouble();
        const close = jest.fn(async () => undefined);
        const lifecycle = lifecycleWith({ close }, signals);
        lifecycle.onApplicationBootstrap();
        expect(signals.listenerCount('SIGTERM')).toBe(1);
        expect(signals.listenerCount('SIGINT')).toBe(1);
        signals.emit('SIGTERM');
        await flushBus();
        expect(close).toHaveBeenCalledTimes(1);
        expect(signals.killed).toEqual([[4242, 'SIGTERM']]);
        // Both listeners are gone: a second signal gets Node's default at once.
        expect(signals.listenerCount('SIGTERM')).toBe(0);
        expect(signals.listenerCount('SIGINT')).toBe(0);
    });

    it('leaves the signal to another listener when there is one (as it would without this hook)', async () => {
        const signals = new SignalDouble();
        const close = jest.fn(async () => undefined);
        const other = jest.fn();
        signals.on('SIGTERM', other);
        lifecycleWith({ close }, signals).onApplicationBootstrap();
        signals.emit('SIGTERM');
        await flushBus();
        expect(close).toHaveBeenCalledTimes(1);
        expect(other).toHaveBeenCalledTimes(1);
        expect(signals.killed).toEqual([]);
    });

    it('never holds the exit up for long: a goodbye that hangs is abandoned', async () => {
        jest.useFakeTimers();
        try {
            const signals = new SignalDouble();
            const lifecycle = lifecycleWith(
                { close: () => new Promise<void>(() => undefined) },
                signals,
            );
            lifecycle.onApplicationBootstrap();
            const done = lifecycle.onSignal('SIGTERM');
            await jest.advanceTimersByTimeAsync(2_000);
            await done;
            expect(signals.killed).toEqual([[4242, 'SIGTERM']]);
        } finally {
            jest.useRealTimers();
        }
    });

    it('does not listen with the in-process bus, and stops listening on an orderly shutdown', async () => {
        const signals = new SignalDouble();
        lifecycleWith({ mode: 'single-replica' }, signals).onApplicationBootstrap();
        expect(signals.listenerCount('SIGTERM')).toBe(0);
        const lifecycle = lifecycleWith({}, signals);
        lifecycle.onApplicationBootstrap();
        await lifecycle.onApplicationShutdown();
        expect(signals.listenerCount('SIGTERM')).toBe(0);
        expect(signals.listenerCount('SIGINT')).toBe(0);
    });
});

describe('RelayTerminalFanoutBus: remote-created runs released (real TerminalRelayRegistry)', () => {
    function seam() {
        let deliver: ((body: string, from: string) => void) | null = null;
        const bus = {
            publish: () => true,
            subscribe: (_topic: string, handler: (body: string, from: string) => void) => {
                deliver = handler;
                return () => undefined;
            },
        } as unknown as RelayBus;
        let now = 1_000_000;
        const fanout = new RelayTerminalFanoutBus(bus, () => now);
        const registry = new TerminalRelayRegistry(fanout);
        let seq = 0;
        const stdout = (): TerminalFrame => ({
            kind: 'stdout',
            seq: seq++,
            data: Buffer.from('x').toString('base64'),
        });
        /** A frame of `runId` published on a PEER replica. */
        const remote = (runId: string, frame: TerminalFrame = stdout()) =>
            deliver!(JSON.stringify([runId, encodeTerminalFrame(frame)]), 'r-peer');
        return {
            fanout,
            registry,
            remote,
            stdout,
            advance: (ms: number) => {
                now += ms;
            },
        };
    }

    it('releases a run that never ended here once it was silent for an hour with nobody watching', () => {
        const h = seam();
        h.remote('run-orphan');
        expect(h.registry.getStatus('run-orphan')).toMatchObject({ exists: true, ended: false });
        h.advance(RELAY_TERMINAL_REMOTE_IDLE_MS - 1);
        expect(h.fanout.sweep(h.registry)).toBe(0);
        h.remote('run-orphan'); // still alive: the clock restarts
        h.advance(RELAY_TERMINAL_REMOTE_IDLE_MS - 1);
        expect(h.fanout.sweep(h.registry)).toBe(0);
        h.advance(1);
        expect(h.fanout.sweep(h.registry)).toBe(1);
        expect(h.registry.getStatus('run-orphan').exists).toBe(false);
        expect(h.fanout.trackedRuns).toBe(0);
    });

    it('keeps a run alive whose worker now publishes on THIS replica', () => {
        const h = seam();
        h.remote('run-moved');
        h.advance(RELAY_TERMINAL_REMOTE_IDLE_MS - 1);
        // The worker reconnected here: its frames are published locally.
        expect(h.registry.publish('run-moved', h.stdout())).toBe(true);
        h.advance(RELAY_TERMINAL_REMOTE_IDLE_MS - 1);
        expect(h.fanout.sweep(h.registry)).toBe(0);
        expect(h.registry.getStatus('run-moved').exists).toBe(true);
        expect(h.fanout.trackedRuns).toBe(1);
    });

    it('never releases a run somebody here watches, and keeps tracking it', () => {
        const h = seam();
        h.remote('run-watched');
        h.registry.attach('run-watched', { id: 'tab-1', role: 'viewer', send: () => undefined });
        h.advance(RELAY_TERMINAL_REMOTE_IDLE_MS * 2);
        expect(h.fanout.sweep(h.registry)).toBe(0);
        expect(h.registry.getStatus('run-watched').exists).toBe(true);
        expect(h.fanout.trackedRuns).toBe(1);
        // Once the viewer leaves and the run stays silent, it goes.
        h.registry.detach('run-watched', 'tab-1');
        expect(h.fanout.sweep(h.registry)).toBe(1);
        expect(h.registry.getStatus('run-watched').exists).toBe(false);
    });

    it('releases an ended run after the retention', () => {
        const h = seam();
        h.remote('run-ended');
        h.remote('run-ended', { kind: 'exit', code: 0, reason: 'completed' });
        expect(h.registry.getStatus('run-ended').ended).toBe(true);
        expect(h.fanout.sweep(h.registry)).toBe(0); // ended: first seen now
        h.advance(RELAY_TERMINAL_REMOTE_RETENTION_MS);
        expect(h.fanout.sweep(h.registry)).toBe(1);
        expect(h.registry.getStatus('run-ended').exists).toBe(false);
        expect(h.fanout.trackedRuns).toBe(0);
    });
});
