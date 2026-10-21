import Redis from 'ioredis';
import {
    decodeRelayEnvelope,
    encodeRelayEnvelope,
    isRelayBusTopic,
    newRelayReplicaId,
    relayBusKey,
    relayBusNamespace,
    type RelayBus,
} from '../relay-bus';
import { InProcessRelayBus } from '../relay-bus.in-process';
import { parseRelayPresenceBody, ValkeyRelayBus, type RelayRedisClient } from '../relay-bus.valkey';
import { FakeValkey, flushBus, TEST_RELAY_SECRET } from './relay-test-kit';

/**
 * The relay bus over Valkey (FL-02, CONTRACTS R-7, spec FR-29): round trips
 * between replicas, no loop-back, addressed messages, presence, a degraded
 * connection, and `claimOnce` held fleet-wide. Every case runs against an
 * in-memory Valkey; with `FLEET_RELAY_TEST_REDIS_URL` set the same cases run
 * against that server too.
 */

const REAL_URL = process.env.FLEET_RELAY_TEST_REDIS_URL;

interface Backend {
    name: string;
    make(): { a: ValkeyRelayBus; b: ValkeyRelayBus; cut?: () => void; restore?: () => void };
}

const buses: RelayBus[] = [];

const fakeBackend: Backend = {
    name: 'in-memory Valkey',
    make() {
        const hub = new FakeValkey();
        const create = () => hub.client();
        const a = new ValkeyRelayBus({
            secret: TEST_RELAY_SECRET,
            url: 'redis://fake',
            createClient: create,
        });
        const b = new ValkeyRelayBus({
            secret: TEST_RELAY_SECRET,
            url: 'redis://fake',
            createClient: create,
        });
        buses.push(a, b);
        return { a, b, cut: () => hub.cutAll(), restore: () => hub.restoreAll() };
    },
};

const realBackend: Backend = {
    name: 'Valkey at FLEET_RELAY_TEST_REDIS_URL',
    make() {
        const a = new ValkeyRelayBus({ secret: TEST_RELAY_SECRET, url: REAL_URL! });
        const b = new ValkeyRelayBus({ secret: TEST_RELAY_SECRET, url: REAL_URL! });
        buses.push(a, b);
        return { a, b };
    },
};

afterEach(async () => {
    await Promise.all(buses.splice(0).map((bus) => bus.close()));
});

async function until(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error('timed out');
        await flushBus(2);
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

describe('relay bus envelope', () => {
    const key = relayBusKey(TEST_RELAY_SECRET)!;
    const from = newRelayReplicaId('7d1f0c2a-3b4e-4f5a-8c6d-9e0f1a2b3c4d');

    it('round-trips a signed message with any body', () => {
        const body = 'a\u001fbody with the separator\nand newlines';
        const envelope = { from, to: 'all', topic: 'fleet-link.rpc', seq: 7, body };
        expect(decodeRelayEnvelope(key, encodeRelayEnvelope(key, envelope))).toEqual(envelope);
    });

    it('refuses a message signed with another key, a tampered field, or a malformed one', () => {
        const other = relayBusKey('another-deployments-secret-value')!;
        const wire = encodeRelayEnvelope(key, {
            from,
            to: 'all',
            topic: 'relay.terminal',
            seq: 1,
            body: 'x',
        });
        expect(decodeRelayEnvelope(other, wire)).toBeNull();
        expect(
            decodeRelayEnvelope(key, wire.replace('relay.terminal', 'relay.computer')),
        ).toBeNull();
        expect(decodeRelayEnvelope(key, wire.slice(0, -1) + 'y')).toBeNull();
        expect(decodeRelayEnvelope(key, wire.replace('\u001f1\u001f', '\u001f2\u001f'))).toBeNull();
        expect(decodeRelayEnvelope(key, '1\u001fx\u001fy\u001fz')).toBeNull();
        expect(decodeRelayEnvelope(key, 42)).toBeNull();
        expect(isRelayBusTopic('relay.terminal')).toBe(true);
        expect(isRelayBusTopic('__proto__')).toBe(false);
    });

    it('derives no key from a missing or short secret, and a namespace per key', () => {
        expect(relayBusKey(null)).toBeNull();
        expect(relayBusKey('short')).toBeNull();
        expect(relayBusNamespace(key)).not.toBe(
            relayBusNamespace(relayBusKey('another-deployments-secret-value')!),
        );
    });
});

describe('ValkeyRelayBus — what it refuses', () => {
    it('carries nothing without a secret to sign with', async () => {
        const hub = new FakeValkey();
        const bus = new ValkeyRelayBus({
            secret: null,
            url: 'redis://fake',
            createClient: () => hub.client(),
        });
        buses.push(bus);
        expect(bus.health().status).toBe('degraded');
        expect(bus.publish('test.topic', 'x')).toBe(false);
        await expect(bus.claimOnce('k', 1_000)).rejects.toThrow();
    });

    it('drops a forged message and a replayed one', async () => {
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
        buses.push(a, b);
        await until(() => a.peers().includes(b.replicaId) && b.peers().includes(a.replicaId));
        const seen: string[] = [];
        b.subscribe('test.topic', (body) => seen.push(body));
        // Capture what A really sends, then replay it, and forge one with another key.
        const raw: Array<[string, string]> = [];
        const spy = hub.client();
        spy.on('message', (channel: string, message: string) => raw.push([channel, message]));
        const namespace = relayBusNamespace(relayBusKey(TEST_RELAY_SECRET)!);
        await spy.subscribe(`ew:relay:${namespace}:all`);
        a.publish('test.topic', 'genuine');
        await until(() => seen.length === 1 && raw.some(([, m]) => m.includes('genuine')));
        const [channel, genuine] = raw.find(([, m]) => m.includes('genuine'))!;
        await spy.publish(channel, genuine);
        const forged = encodeRelayEnvelope(relayBusKey('an-attackers-own-secret-value')!, {
            from: a.replicaId,
            to: 'all',
            topic: 'test.topic',
            seq: 999,
            body: 'forged',
        });
        await spy.publish(channel, forged);
        await flushBus(10);
        expect(seen).toEqual(['genuine']);
    });
});

describe('ValkeyRelayBus — the handshake (a replica that has never heard a sender)', () => {
    function bus(hub: FakeValkey) {
        const created = new ValkeyRelayBus({
            secret: TEST_RELAY_SECRET,
            url: 'redis://fake',
            createClient: () => hub.client(),
        });
        buses.push(created);
        return created;
    }

    it('refuses a broadcast captured before it started, before AND after the handshake', async () => {
        const hub = new FakeValkey();
        const a = bus(hub);
        const b = bus(hub);
        await until(() => a.peers().includes(b.replicaId) && b.peers().includes(a.replicaId));
        // Capture a genuine broadcast of A's (as anyone who can read the server could).
        const raw: Array<[string, string]> = [];
        const spy = hub.client();
        spy.on('message', (channel: string, message: string) => raw.push([channel, message]));
        const namespace = relayBusNamespace(relayBusKey(TEST_RELAY_SECRET)!);
        await spy.subscribe(`ew:relay:${namespace}:all`);
        const seenByB: string[] = [];
        b.subscribe('test.topic', (body) => seenByB.push(body));
        a.publish('test.topic', 'drain everything');
        await until(() => seenByB.length === 1 && raw.some(([, m]) => m.includes('drain')));
        const [channel, captured] = raw.find(([, m]) => m.includes('drain'))!;

        // A brand-new replica: it holds no sequence for A, so the replay
        // would have passed a sequence check alone.
        const c = bus(hub);
        const seenByC: string[] = [];
        c.subscribe('test.topic', (body) => seenByC.push(body));
        await spy.publish(channel, captured);
        await flushBus(10);
        expect(seenByC).toEqual([]);
        // After the handshake C holds A's sequence at the time A answered:
        // the capture is below it, so it is still refused.
        await until(() => c.peers().includes(a.replicaId));
        await spy.publish(channel, captured);
        await flushBus(10);
        expect(seenByC).toEqual([]);
        // …and what A sends from now on is delivered.
        a.publish('test.topic', 'fresh');
        await until(() => seenByC.length === 1);
        expect(seenByC).toEqual(['fresh']);
    });

    it('makes a sender a peer only once the handshake is done, on both sides', async () => {
        const hub = new FakeValkey();
        const a = bus(hub);
        const joined: string[] = [];
        a.onPeerChange((replicaId, present) => {
            if (present) joined.push(replicaId);
        });
        const b = bus(hub);
        await until(() => a.peers().includes(b.replicaId) && b.peers().includes(a.replicaId));
        expect(joined).toEqual([b.replicaId]);
        // Both directions carry broadcasts.
        const seenByA: string[] = [];
        a.subscribe('test.topic', (body) => seenByA.push(body));
        b.publish('test.topic', 'from b');
        await until(() => seenByA.length === 1);
    });

    it('does not count a sender as a peer while this replica cannot answer it (its publisher is down)', async () => {
        const hub = new FakeValkey();
        const b = bus(hub); // hub.clients[0] is b's publisher
        await until(() => b.health().status === 'up');
        const changes: Array<[string, boolean]> = [];
        b.onPeerChange((replicaId, present) => changes.push([replicaId, present]));
        const key = relayBusKey(TEST_RELAY_SECRET)!;
        const sender = newRelayReplicaId('00000000-0000-4000-8000-0000000000aa');
        const spy = hub.client();
        const askB = (seq: number) =>
            spy.publish(
                `ew:relay:${relayBusNamespace(key)}:to:${b.replicaId}`,
                encodeRelayEnvelope(key, {
                    from: sender,
                    to: b.replicaId,
                    topic: 'relay.presence',
                    seq,
                    body: '?7',
                }),
            );
        hub.clients[0].cut();
        await askB(1);
        await flushBus(10);
        // Its answer could not go out: no peer yet, so the one-shot "a peer
        // joined" work (directory sync, drain re-sends) is not spent on it.
        expect(changes).toEqual([]);
        expect(b.peers()).not.toContain(sender);
        hub.clients[0].restore();
        await askB(2);
        await until(() => changes.some(([replicaId, present]) => replicaId === sender && present));
    });

    it('reads a presence body: the sender’s sequence, `?` when it asks for ours', () => {
        expect(parseRelayPresenceBody('17')).toEqual({ seq: 17, ask: false });
        expect(parseRelayPresenceBody('?0')).toEqual({ seq: 0, ask: true });
        expect(parseRelayPresenceBody('')).toBeNull();
        expect(parseRelayPresenceBody('?')).toBeNull();
        expect(parseRelayPresenceBody('-1')).toBeNull();
        expect(parseRelayPresenceBody('1e9')).toBeNull();
    });
});

describe('InProcessRelayBus', () => {
    it('has no peers, sends nothing, and holds a claim in this process', async () => {
        let now = 0;
        const bus = new InProcessRelayBus(() => now);
        expect(bus.publish()).toBe(false);
        expect(bus.peers()).toEqual([]);
        expect(bus.health()).toEqual({ configured: false, mode: 'single-replica', status: 'up' });
        expect(await bus.claimOnce('jti-1', 1_000)).toBe(true);
        expect(await bus.claimOnce('jti-1', 1_000)).toBe(false);
        now = 1_001;
        expect(await bus.claimOnce('jti-1', 1_000)).toBe(true);
    });
});

for (const backend of [fakeBackend, ...(REAL_URL ? [realBackend] : [])]) {
    describe(`ValkeyRelayBus — ${backend.name}`, () => {
        it('finds its peer, broadcasts to it and never to itself', async () => {
            const { a, b } = backend.make();
            await until(() => a.peers().includes(b.replicaId) && b.peers().includes(a.replicaId));
            const seenByA: string[] = [];
            const seenByB: Array<[string, string]> = [];
            a.subscribe('test.topic', (body) => seenByA.push(body));
            b.subscribe('test.topic', (body, from) => seenByB.push([body, from]));
            expect(a.publish('test.topic', 'hello')).toBe(true);
            await until(() => seenByB.length === 1);
            expect(seenByB).toEqual([['hello', a.replicaId]]);
            expect(seenByA).toEqual([]);
            expect(a.health()).toEqual({ configured: true, mode: 'valkey', status: 'up' });
        });

        it('delivers an addressed message to that replica only, and refuses a bad topic', async () => {
            const { a, b } = backend.make();
            await until(() => a.peers().includes(b.replicaId));
            const seen: string[] = [];
            b.subscribe('test.direct', (body) => seen.push(body));
            expect(a.sendTo(b.replicaId, 'test.direct', 'for b')).toBe(true);
            expect(a.sendTo(a.replicaId, 'test.direct', 'to myself')).toBe(false);
            expect(a.publish('Not A Topic', 'x')).toBe(false);
            expect(() => a.subscribe('Not A Topic', () => undefined)).toThrow();
            await until(() => seen.length === 1);
            expect(seen).toEqual(['for b']);
        });

        it('holds a claim fleet-wide: the second replica is refused', async () => {
            const { a, b } = backend.make();
            await until(() => a.health().status === 'up' && b.health().status === 'up');
            const key = `jti-${newRelayReplicaId('00000000-0000-4000-8000-000000000001')}-${Date.now()}`;
            expect(await a.claimOnce(key, 5_000)).toBe(true);
            expect(await b.claimOnce(key, 5_000)).toBe(false);
            expect(await a.claimOnce(key, 5_000)).toBe(false);
        });

        it('isolates a handler that throws', async () => {
            const { a, b } = backend.make();
            await until(() => a.peers().includes(b.replicaId));
            const seen: string[] = [];
            b.subscribe('test.throw', () => {
                throw new Error('handler bug');
            });
            b.subscribe('test.throw', (body) => seen.push(body));
            a.publish('test.throw', 'still delivered');
            await until(() => seen.length === 1);
        });

        it('tells its peers when it leaves', async () => {
            const { a, b } = backend.make();
            await until(() => b.peers().includes(a.replicaId));
            const changes: Array<[string, boolean]> = [];
            b.onPeerChange((replica, present) => changes.push([replica, present]));
            await a.close();
            await until(() => !b.peers().includes(a.replicaId));
            expect(changes).toContainEqual([a.replicaId, false]);
        });
    });
}

describe('ValkeyRelayBus — a lost connection', () => {
    it('reads degraded, drops what it cannot send, refuses a claim, and recovers', async () => {
        const { a, b, cut, restore } = fakeBackend.make();
        await until(() => a.peers().includes(b.replicaId));
        cut!();
        expect(a.health().status).toBe('degraded');
        expect(a.publish('test.topic', 'lost')).toBe(false);
        await expect(a.claimOnce('k', 1_000)).rejects.toThrow('not connected');
        restore!();
        expect(a.health().status).toBe('up');
        const seen: string[] = [];
        b.subscribe('test.topic', (body) => seen.push(body));
        a.publish('test.topic', 'back');
        await until(() => seen.length === 1);
    });

    it('refuses a claim while down even if it never heard a peer — one token is never accepted once per replica', async () => {
        const hub = new FakeValkey();
        const lonely = new ValkeyRelayBus({
            secret: TEST_RELAY_SECRET,
            url: 'redis://fake',
            createClient: () => hub.client(),
        });
        buses.push(lonely);
        expect(lonely.peers()).toEqual([]);
        hub.cutAll();
        await expect(lonely.claimOnce('jti-lonely', 1_000)).rejects.toThrow('not connected');
        hub.restoreAll();
        // Back: the claim is made on Valkey, so it holds for every replica.
        expect(await lonely.claimOnce('jti-lonely', 1_000)).toBe(true);
        expect(await lonely.claimOnce('jti-lonely', 1_000)).toBe(false);
    });

    it('logs a connection error at most once a minute and never the URL', async () => {
        const warn = jest
            .spyOn(require('@nestjs/common').Logger.prototype, 'warn')
            .mockImplementation(() => undefined);
        const hub = new FakeValkey();
        const bus = new ValkeyRelayBus({
            secret: TEST_RELAY_SECRET,
            url: 'redis://:hunter2-secret@valkey.internal:6379',
            createClient: () => hub.client(),
        });
        buses.push(bus);
        hub.cutAll();
        hub.cutAll();
        const lines = warn.mock.calls.map((call) => String(call[0]));
        expect(lines.filter((line) => line.includes('relay bus connection'))).toHaveLength(1);
        expect(lines.join('\n')).not.toContain('hunter2-secret');
        warn.mockRestore();
    });
});

describe('the default ioredis client', () => {
    it('is built lazily enough not to connect in a spec that never asks for Valkey', () => {
        // Construction with an unreachable URL must not throw synchronously;
        // the bus starts degraded and ioredis keeps retrying in the background.
        const bus = new ValkeyRelayBus({
            secret: TEST_RELAY_SECRET,
            url: 'redis://127.0.0.1:1',
            createClient: (url) =>
                new Redis(url, {
                    lazyConnect: true,
                    enableOfflineQueue: false,
                    retryStrategy: () => null,
                }) as unknown as RelayRedisClient,
        });
        buses.push(bus);
        expect(bus.health().status).toBe('degraded');
    });
});
