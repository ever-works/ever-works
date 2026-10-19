import { Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import Redis from 'ioredis';
import {
    decodeRelayEnvelope,
    encodeRelayEnvelope,
    isRelayBusTopic,
    isRelayReplicaId,
    newRelayReplicaId,
    RELAY_BUS_KEY_PREFIX,
    RELAY_BUS_LEAVE_TOPIC,
    RELAY_BUS_PRESENCE_INTERVAL_MS,
    RELAY_BUS_PRESENCE_TOPIC,
    RELAY_BUS_PRESENCE_TTL_MS,
    relayBusKey,
    relayBusNamespace,
    relayBusSecretFromEnv,
    type RelayBus,
    type RelayBusHandler,
    type RelayBusHealth,
} from './relay-bus';

/**
 * The relay bus over Valkey (CONTRACTS R-7) — ioredis pub/sub.
 *
 * Two connections, as pub/sub requires: one publishes (and answers
 * `claimOnce`), one only subscribes. Two channels, under a namespace derived
 * from the signing key (`ew:relay:<ns>:…`):
 *
 *  - `…:all` — broadcast; every replica subscribes;
 *  - `…:to:<replicaId>` — addressed to one replica.
 *
 * **Every message is signed** (HMAC over sender, destination, topic, sequence
 * and body, with a key derived from the attach secret every replica shares)
 * and **sequenced** per sender and destination: a message that does not verify,
 * or does not move its sender's sequence forward, is dropped. So a client that
 * can only publish to the server cannot speak for a replica, and one that can
 * also read it cannot replay what it read. Without a secret the bus carries
 * nothing and reads `degraded` (fail-closed).
 *
 * **The handshake** closes the gap a sequence alone leaves: a replica that has
 * never heard a sender has no sequence to compare a broadcast with, so a
 * broadcast captured before it started would pass. A replica therefore never
 * accepts a broadcast from a sender it holds no broadcast sequence for; it
 * drops it and asks that sender, in a message addressed to it, for its
 * sequence. The answer is addressed to this replica's id — random per process,
 * so no message addressed to it can predate it, and its own per-sender
 * sequence refuses a replay — and carries the sender's broadcast sequence at
 * the time it answered; only broadcasts above it are accepted. Every presence
 * message addressed to a replica carries the sender's sequence the same way.
 * A sender is a peer only once this handshake is done. A signed timestamp
 * would add a clock-skew failure mode and still admit a capture made seconds
 * before the receiver started, so there is none.
 *
 * Presence: a beacon every {@link RELAY_BUS_PRESENCE_INTERVAL_MS} (and a short
 * burst at start, and whenever a connection comes back); a newcomer's beacon
 * is answered at once; a replica not heard from for
 * {@link RELAY_BUS_PRESENCE_TTL_MS} is gone — but never while this replica's
 * own connection is down (it could not have heard anyone), and a message
 * addressed to a replica that no one receives marks it gone at once.
 * Broadcasts are skipped while nobody else is there.
 *
 * The publisher keeps no offline queue: while Valkey is unreachable a publish
 * is dropped (relays are live, not durable) and `claimOnce` throws, on every
 * replica — a single-use token is refused, never accepted once per replica.
 * (A deployment with no Redis URL at all runs the in-process bus, whose
 * claims are this process's.) ioredis reconnects on its own; health reads
 * `degraded` meanwhile. The URL is never logged — it may carry a password.
 */

/** The ioredis surface this bus uses — what the spec's double implements. */
export interface RelayRedisClient {
    readonly status: string;
    publish(channel: string, message: string): Promise<number>;
    subscribe(...channels: string[]): Promise<unknown>;
    set(key: string, value: string, px: 'PX', ttlMs: number, nx: 'NX'): Promise<'OK' | null>;
    on(event: string, listener: (...args: any[]) => void): unknown;
    quit(): Promise<unknown>;
    disconnect(): void;
}

export interface ValkeyRelayBusOptions {
    url: string;
    /** The shared secret the signing key is derived from; defaults to the attach secret in the environment. */
    secret?: string | null;
    createClient?: (url: string, role: 'publisher' | 'subscriber') => RelayRedisClient;
    now?: () => number;
    presenceIntervalMs?: number;
    presenceTtlMs?: number;
    replicaId?: string;
}

/** Extra beacons right after start, so two replicas starting together find each other fast. */
const STARTUP_BEACONS_MS = [250, 1_000, 2_500];

/** A replica asks one sender for its broadcast sequence at most this often. */
export const RELAY_BUS_HANDSHAKE_RETRY_MS = 1_000;

/**
 * The body of a presence message addressed to one replica: the sender's
 * broadcast sequence when it sent it, `?`-prefixed when the sender also asks
 * for the receiver's (the handshake). Null for anything else.
 */
export function parseRelayPresenceBody(body: string): { seq: number; ask: boolean } | null {
    const match = /^(\?)?([0-9]{1,15})$/.exec(body);
    if (!match) return null;
    return { seq: Number(match[2]), ask: match[1] === '?' };
}

export function createDefaultRelayRedisClient(
    url: string,
    role: 'publisher' | 'subscriber',
): RelayRedisClient {
    return new Redis(url, {
        connectTimeout: 5_000,
        retryStrategy: (times: number) => Math.min(times * 500, 5_000),
        // The subscriber queues its SUBSCRIBE until it is connected; the
        // publisher drops what it cannot send now.
        enableOfflineQueue: role === 'subscriber',
        maxRetriesPerRequest: role === 'publisher' ? 1 : null,
        commandTimeout: role === 'publisher' ? 2_000 : undefined,
        autoResubscribe: true,
        connectionName: `ever-works-relay-${role}`,
    }) as unknown as RelayRedisClient;
}

export class ValkeyRelayBus implements RelayBus {
    readonly mode = 'valkey' as const;
    readonly replicaId: string;
    private readonly logger = new Logger('RelayBus');
    private readonly key: Buffer | null;
    private readonly broadcastChannel: string;
    private readonly ownChannel: string;
    private readonly channelPrefix: string;
    private readonly publisher: RelayRedisClient;
    private readonly subscriber: RelayRedisClient;
    private readonly now: () => number;
    private readonly presenceTtlMs: number;
    private readonly handlers = new Map<string, Set<RelayBusHandler>>();
    private readonly heard = new Map<string, number>();
    private readonly peerListeners = new Set<(replicaId: string, present: boolean) => void>();
    private readonly presenceTimer: NodeJS.Timeout;
    private readonly startupTimers: NodeJS.Timeout[] = [];
    /** Sequences this replica sends: the broadcast's, and one per addressee. */
    private sentAll = 0;
    private readonly sentTo = new Map<string, number>();
    /**
     * Highest sequence received from each sender, per channel. A sender with
     * no `lastAll` entry has not completed the handshake: its broadcasts are
     * dropped and it is not a peer.
     */
    private readonly lastAll = new Map<string, number>();
    private readonly lastDirect = new Map<string, number>();
    /** When this replica last asked each sender for its broadcast sequence. */
    private readonly asked = new Map<string, number>();
    private closed = false;
    private lastErrorLogAt = 0;

    constructor(options: ValkeyRelayBusOptions) {
        this.replicaId = options.replicaId ?? newRelayReplicaId(randomUUID());
        this.now = options.now ?? (() => Date.now());
        this.presenceTtlMs = options.presenceTtlMs ?? RELAY_BUS_PRESENCE_TTL_MS;
        this.key = relayBusKey(
            options.secret === undefined ? relayBusSecretFromEnv() : options.secret,
        );
        const namespace = this.key ? relayBusNamespace(this.key) : 'unsigned';
        this.channelPrefix = `${RELAY_BUS_KEY_PREFIX}${namespace}:`;
        this.broadcastChannel = `${this.channelPrefix}all`;
        this.ownChannel = this.directChannel(this.replicaId);
        if (!this.key) {
            this.logger.error(
                'Relay bus: no shared secret (TERMINAL_ATTACH_SECRET or BETTER_AUTH_SECRET) to sign messages with — the bus carries nothing.',
            );
        }
        const create = options.createClient ?? createDefaultRelayRedisClient;
        this.publisher = create(options.url, 'publisher');
        this.subscriber = create(options.url, 'subscriber');
        for (const client of [this.publisher, this.subscriber]) {
            client.on('error', (error: Error) => this.logError(error));
        }
        this.subscriber.on('message', (channel: string, message: string) =>
            this.dispatch(channel, message),
        );
        // Back after a drop: nobody could be heard meanwhile, so what was
        // known is fresh again; and say hello.
        this.subscriber.on('ready', () => {
            const now = this.now();
            for (const replicaId of this.heard.keys()) this.heard.set(replicaId, now);
            this.beacon();
        });
        // The beacon goes out through the publisher, which may connect later.
        this.publisher.on('ready', () => this.beacon());
        void this.subscriber.subscribe(this.broadcastChannel, this.ownChannel).then(
            () => this.beacon(),
            (error: Error) => this.logError(error),
        );
        this.presenceTimer = setInterval(
            () => this.tick(),
            options.presenceIntervalMs ?? RELAY_BUS_PRESENCE_INTERVAL_MS,
        );
        this.presenceTimer.unref?.();
        for (const delay of STARTUP_BEACONS_MS) {
            const timer = setTimeout(() => this.beacon(), delay);
            timer.unref?.();
            this.startupTimers.push(timer);
        }
    }

    publish(topic: string, body: string): boolean {
        if (!isRelayBusTopic(topic) || !this.isUp() || this.peers().length === 0) return false;
        return this.send('all', topic, body);
    }

    sendTo(replicaId: string, topic: string, body: string): boolean {
        if (!isRelayReplicaId(replicaId) || replicaId === this.replicaId) return false;
        if (!isRelayBusTopic(topic) || !this.isUp()) return false;
        return this.send(replicaId, topic, body);
    }

    subscribe(topic: string, handler: RelayBusHandler): () => void {
        if (!isRelayBusTopic(topic)) throw new Error(`invalid relay bus topic: ${topic}`);
        let set = this.handlers.get(topic);
        if (!set) {
            set = new Set();
            this.handlers.set(topic, set);
        }
        set.add(handler);
        return () => {
            set?.delete(handler);
        };
    }

    peers(): string[] {
        const cutoff = this.now() - this.presenceTtlMs;
        const present: string[] = [];
        for (const [replicaId, at] of this.heard) if (at > cutoff) present.push(replicaId);
        return present;
    }

    onPeerChange(listener: (replicaId: string, present: boolean) => void): () => void {
        this.peerListeners.add(listener);
        return () => {
            this.peerListeners.delete(listener);
        };
    }

    health(): RelayBusHealth {
        return { configured: true, mode: 'valkey', status: this.isUp() ? 'up' : 'degraded' };
    }

    async claimOnce(key: string, ttlMs: number): Promise<boolean> {
        // Fail closed: a configured bus that cannot answer refuses the claim
        // (and so the token) on every replica. Claims kept in this process
        // while Valkey is down would let one token be accepted once per
        // replica, and would never reach Valkey afterwards.
        if (!this.key || this.publisher.status !== 'ready' || this.closed) {
            throw new Error('the relay bus is not connected');
        }
        const answer = await this.publisher.set(
            `${this.channelPrefix}once:${key}`,
            '1',
            'PX',
            Math.max(1, Math.ceil(ttlMs)),
            'NX',
        );
        return answer === 'OK';
    }

    async close(): Promise<void> {
        if (this.closed) return;
        // Say goodbye first, while the bus still counts as up.
        if (this.isUp()) this.send('all', RELAY_BUS_LEAVE_TOPIC, '');
        this.closed = true;
        clearInterval(this.presenceTimer);
        for (const timer of this.startupTimers) clearTimeout(timer);
        await Promise.all(
            [this.publisher, this.subscriber].map(async (client) => {
                try {
                    await client.quit();
                } catch {
                    client.disconnect();
                }
            }),
        );
        this.handlers.clear();
        this.peerListeners.clear();
    }

    // ─── Internals ─────────────────────────────────────────────────────────

    private directChannel(replicaId: string): string {
        return `${this.channelPrefix}to:${replicaId}`;
    }

    private isUp(): boolean {
        return (
            !this.closed &&
            this.key !== null &&
            this.publisher.status === 'ready' &&
            this.subscriber.status === 'ready'
        );
    }

    private send(to: string, topic: string, body: string): boolean {
        if (!this.key) return false;
        let seq: number;
        if (to === 'all') seq = ++this.sentAll;
        else {
            seq = (this.sentTo.get(to) ?? 0) + 1;
            this.sentTo.set(to, seq);
        }
        const channel = to === 'all' ? this.broadcastChannel : this.directChannel(to);
        try {
            void this.publisher
                .publish(
                    channel,
                    encodeRelayEnvelope(this.key, { from: this.replicaId, to, topic, seq, body }),
                )
                .then(
                    (receivers) => {
                        // Nobody listens on that replica's channel: it is gone.
                        if (to !== 'all' && receivers === 0) this.peerGone(to);
                    },
                    (error: Error) => this.logError(error),
                );
            return true;
        } catch (error) {
            this.logError(error as Error);
            return false;
        }
    }

    private beacon(): void {
        if (!this.closed && this.key && this.publisher.status === 'ready') {
            this.send('all', RELAY_BUS_PRESENCE_TOPIC, '');
        }
    }

    private tick(): void {
        this.beacon();
        // A replica that could not hear anyone cannot conclude anyone left.
        if (!this.isUp()) return;
        const cutoff = this.now() - this.presenceTtlMs;
        for (const [replicaId, at] of [...this.heard]) {
            if (at <= cutoff) this.peerGone(replicaId);
        }
    }

    private peerGone(replicaId: string): void {
        if (!this.heard.delete(replicaId)) return;
        // Sequences are kept: a replica thought gone may still be there, and a
        // reset would let an old message of its be replayed, or make it refuse ours.
        this.boundSequences();
        this.emitPeer(replicaId, false);
    }

    /** A presence message addressed to `replicaId`, carrying this replica's broadcast sequence. False when it could not go out. */
    private sendPresence(replicaId: string, ask: boolean): boolean {
        if (!this.isUp()) return false;
        return this.send(replicaId, RELAY_BUS_PRESENCE_TOPIC, `${ask ? '?' : ''}${this.sentAll}`);
    }

    /** Ask a sender this replica holds no broadcast sequence for to send it (at most once a second). */
    private askForSequence(replicaId: string): void {
        const now = this.now();
        const last = this.asked.get(replicaId);
        if (last !== undefined && now - last < RELAY_BUS_HANDSHAKE_RETRY_MS) return;
        this.asked.delete(replicaId);
        this.asked.set(replicaId, now);
        this.boundSequences();
        this.sendPresence(replicaId, true);
    }

    /** Sequence tables grow by one entry per replica ever heard; past 10 000, forget the oldest. */
    private boundSequences(): void {
        for (const table of [this.lastAll, this.lastDirect, this.sentTo, this.asked]) {
            while (table.size > 10_000) {
                const oldest = table.keys().next().value;
                if (oldest === undefined) break;
                table.delete(oldest);
            }
        }
    }

    private dispatch(channel: string, raw: string): void {
        if (!this.key || this.closed) return;
        const direct = channel === this.ownChannel;
        if (!direct && channel !== this.broadcastChannel) return;
        const envelope = decodeRelayEnvelope(this.key, raw);
        if (!envelope || envelope.from === this.replicaId) return;
        // The destination is signed too: a broadcast cannot be replayed as a direct message, nor the reverse.
        if (envelope.to !== (direct ? this.replicaId : 'all')) return;
        const { from, topic, body } = envelope;
        if (!direct && !this.lastAll.has(from)) {
            // No handshake with this sender yet: nothing to compare the
            // sequence with, so the broadcast could be a capture. Drop it and
            // ask the sender, addressed, for its sequence.
            this.askForSequence(from);
            return;
        }
        const last = direct ? this.lastDirect : this.lastAll;
        if (envelope.seq <= (last.get(from) ?? 0)) return;
        last.set(from, envelope.seq);
        let answered = false;
        if (direct && topic === RELAY_BUS_PRESENCE_TOPIC) {
            // Addressed to this process, so sent after it started: the
            // sender's broadcast sequence it carries is a safe floor.
            const presence = parseRelayPresenceBody(body);
            if (presence) {
                this.lastAll.set(from, Math.max(this.lastAll.get(from) ?? 0, presence.seq));
                this.asked.delete(from);
                if (presence.ask) answered = this.sendPresence(from, false);
            }
        }
        if (topic === RELAY_BUS_LEAVE_TOPIC) {
            this.peerGone(from);
            return;
        }
        if (!this.lastAll.has(from)) {
            // An addressed message from a sender still without a handshake:
            // it is genuine and fresh, so it is delivered, but the sender is
            // not a peer until the handshake is done.
            this.askForSequence(from);
        } else if (this.heard.has(from)) {
            this.heard.set(from, this.now());
        } else if (answered || this.sendPresence(from, false)) {
            // A newcomer, told this replica's sequence (before anything the
            // peer listeners send it) so it takes this replica's broadcasts
            // too. Not a peer while that could not go out (the publisher is
            // reconnecting): the one-shot "a peer joined" work would be lost
            // on it. Its next message tries again.
            this.heard.set(from, this.now());
            this.emitPeer(from, true);
        }
        if (topic === RELAY_BUS_PRESENCE_TOPIC) return;
        for (const handler of [...(this.handlers.get(topic) ?? [])]) {
            try {
                handler(body, from);
            } catch (error) {
                this.logger.warn(
                    `relay bus handler for ${topic} failed: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                );
            }
        }
    }

    private emitPeer(replicaId: string, present: boolean): void {
        for (const listener of [...this.peerListeners]) {
            try {
                listener(replicaId, present);
            } catch {
                // a listener's failure is its own
            }
        }
    }

    private logError(error: Error): void {
        // ioredis repeats a connection error on every retry: one line a minute.
        const now = this.now();
        if (now - this.lastErrorLogAt < 60_000) return;
        this.lastErrorLogAt = now;
        this.logger.warn(`relay bus connection: ${error?.message ?? String(error)}`);
    }
}
