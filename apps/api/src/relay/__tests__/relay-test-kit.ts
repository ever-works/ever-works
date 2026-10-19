import type { RelayRedisClient } from '../relay-bus.valkey';

/** The shared secret the specs' buses sign with (every replica of a deployment shares one). */
export const TEST_RELAY_SECRET = 'a-test-relay-secret-of-sufficient-length';

/**
 * A stand-in for one Valkey server shared by several replicas' clients: the
 * pub/sub fan-out (asynchronous and in order, like a socket), `SET … PX … NX`
 * with expiry, and a connection that can be cut and restored. Only what the
 * relay bus uses. A spec can run the same cases against a real Valkey by
 * setting `FLEET_RELAY_TEST_REDIS_URL`.
 */
export class FakeValkey {
    readonly clients: FakeValkeyClient[] = [];
    private readonly subscriptions = new Map<string, Set<FakeValkeyClient>>();
    private readonly keys = new Map<string, number>();
    published = 0;

    constructor(readonly now: () => number = () => Date.now()) {}

    client(): FakeValkeyClient {
        const client = new FakeValkeyClient(this);
        this.clients.push(client);
        return client;
    }

    /** Every client of the hub loses its connection (the server went away). */
    cutAll(): void {
        for (const client of this.clients) client.cut();
    }

    restoreAll(): void {
        for (const client of this.clients) client.restore();
    }

    /** @internal */
    subscribe(channel: string, client: FakeValkeyClient): void {
        let set = this.subscriptions.get(channel);
        if (!set) {
            set = new Set();
            this.subscriptions.set(channel, set);
        }
        set.add(client);
    }

    /** @internal */
    forget(client: FakeValkeyClient): void {
        for (const set of this.subscriptions.values()) set.delete(client);
    }

    /** @internal */
    deliver(channel: string, message: string): number {
        this.published += 1;
        const receivers = [...(this.subscriptions.get(channel) ?? [])].filter(
            (client) => client.status === 'ready',
        );
        for (const client of receivers) {
            setImmediate(() => {
                if (client.status === 'ready') client.emit('message', channel, message);
            });
        }
        return receivers.length;
    }

    /** @internal */
    setNx(key: string, ttlMs: number): 'OK' | null {
        const now = this.now();
        const until = this.keys.get(key);
        if (until !== undefined && until > now) return null;
        this.keys.set(key, now + ttlMs);
        return 'OK';
    }
}

export class FakeValkeyClient implements RelayRedisClient {
    status = 'ready';
    private readonly listeners = new Map<string, Array<(...args: any[]) => void>>();

    constructor(private readonly hub: FakeValkey) {}

    async publish(channel: string, message: string): Promise<number> {
        if (this.status !== 'ready') throw new Error('Connection is closed.');
        return this.hub.deliver(channel, message);
    }

    async subscribe(...channels: string[]): Promise<unknown> {
        for (const channel of channels) this.hub.subscribe(channel, this);
        return channels.length;
    }

    async set(key: string, _value: string, _px: 'PX', ttlMs: number, _nx: 'NX') {
        if (this.status !== 'ready') throw new Error('Connection is closed.');
        return this.hub.setNx(key, ttlMs);
    }

    on(event: string, listener: (...args: any[]) => void): unknown {
        const list = this.listeners.get(event) ?? [];
        list.push(listener);
        this.listeners.set(event, list);
        return this;
    }

    emit(event: string, ...args: unknown[]): void {
        for (const listener of this.listeners.get(event) ?? []) listener(...args);
    }

    cut(): void {
        if (this.status === 'end') return;
        this.status = 'reconnecting';
        this.emit('error', new Error('connect ECONNREFUSED 127.0.0.1:6399'));
        this.emit('close');
    }

    restore(): void {
        if (this.status === 'end') return;
        this.status = 'ready';
        this.emit('ready');
    }

    async quit(): Promise<unknown> {
        this.status = 'end';
        this.hub.forget(this);
        return 'OK';
    }

    disconnect(): void {
        this.status = 'end';
        this.hub.forget(this);
    }
}

/** Let `setImmediate` deliveries and promise continuations run. */
export async function flushBus(rounds = 5): Promise<void> {
    for (let i = 0; i < rounds; i += 1) {
        await new Promise((resolve) => setImmediate(resolve));
    }
}
