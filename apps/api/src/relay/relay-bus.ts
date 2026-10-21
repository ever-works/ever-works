import { createHash, createHmac, timingSafeEqual } from 'crypto';

/**
 * Relay bus (FL-02, CONTRACTS R-7, spec FR-29 … FR-31) — how one API replica
 * reaches the others.
 *
 * Every live relay of the platform keeps its sockets in its own process: the
 * terminal relay, the computer live view, and the node link. With more than
 * one API replica behind the load balancer, the browser's socket and the
 * machine's socket can land on different replicas; the bus is what carries
 * frames between them.
 *
 *  - **Valkey** whenever `getRedisUrl()` answers (`REDIS_URL`, or the
 *    throttler's `THROTTLER_REDIS_URL`) — pub/sub on two channels per
 *    replica set (one broadcast, one addressed to each replica), presence
 *    every few seconds, and `SET … NX PX` for things that must happen once
 *    fleet-wide (a single-use token).
 *  - **In-process** otherwise: no peers, nothing published, the per-process
 *    registries exactly as before. `GET /api/health/ready` says
 *    `fleet_relay: single-replica` so an operator can see the limit.
 *  - `FLEET_RELAY_REQUIRE_BUS=true` makes a missing bus a boot error, never a
 *    silently degraded relay. There is no other mode setting.
 *
 * Delivery is best-effort and at-most-once: local truth never depends on the
 * bus. Every message is SIGNED with a key derived from the secret the replicas
 * already share and carries a per-sender sequence, so a client that can merely
 * publish to the Valkey server can neither forge a replica's message nor
 * replay one; the channels are namespaced by that key. A replica that has
 * never heard a sender learns that sender's broadcast sequence from a message
 * addressed to it (its id is new per process, so no such message can predate
 * it) before it accepts any broadcast — so even a brand-new replica cannot be
 * fed a broadcast captured earlier (see `ValkeyRelayBus`). Payloads are never
 * logged.
 */

export const RELAY_BUS = 'RELAY_BUS' as const;

export type RelayBusMode = 'valkey' | 'single-replica';

/** `up` — every peer can be reached; `degraded` — the bus is configured but its connection is down. */
export type RelayBusStatus = 'up' | 'degraded';

/** What `GET /api/health/ready` reports as `fleet_relay`. */
export interface RelayBusHealth {
    configured: boolean;
    mode: RelayBusMode;
    status: RelayBusStatus;
}

/** A message for `topic` from another replica. */
export type RelayBusHandler = (body: string, fromReplicaId: string) => void;

export interface RelayBus {
    readonly mode: RelayBusMode;
    /** This process on the bus (random per process; never reused). */
    readonly replicaId: string;
    /**
     * Send `body` under `topic` to every OTHER replica. Never loops back.
     * False when nothing went out (no peer, or the bus is down).
     */
    publish(topic: string, body: string): boolean;
    /** Send `body` under `topic` to one replica. False when it could not go out. */
    sendTo(replicaId: string, topic: string, body: string): boolean;
    /** Messages under `topic` from other replicas, broadcast or addressed to this one. Returns the unsubscribe. */
    subscribe(topic: string, handler: RelayBusHandler): () => void;
    /** Replicas heard on the bus within the presence window (this one excluded). */
    peers(): string[];
    /** A replica joined (`true`) or went quiet (`false`). Returns the unsubscribe. */
    onPeerChange(listener: (replicaId: string, present: boolean) => void): () => void;
    health(): RelayBusHealth;
    /**
     * Claim `key` fleet-wide for `ttlMs`: true the first time, false while it
     * is held. Throws when the bus cannot answer — callers fail closed.
     */
    claimOnce(key: string, ttlMs: number): Promise<boolean>;
    close(): Promise<void>;
}

/** How often a replica says it is alive on the bus. */
export const RELAY_BUS_PRESENCE_INTERVAL_MS = 5_000;

/** A replica not heard from for this long is gone. */
export const RELAY_BUS_PRESENCE_TTL_MS = 15_000;

/** Topic of the presence beacon (never handed to subscribers). */
export const RELAY_BUS_PRESENCE_TOPIC = 'relay.presence';

/** Topic a replica sends once when it shuts down. */
export const RELAY_BUS_LEAVE_TOPIC = 'relay.leave';

/** Prefix of every key and channel this bus uses on Valkey. */
export const RELAY_BUS_KEY_PREFIX = 'ew:relay:';

/** Topics: lower-case dotted words — the bus refuses anything else rather than build a channel name from it. */
const TOPIC_PATTERN = /^[a-z][a-z0-9-]{0,31}(?:\.[a-z][a-z0-9-]{0,31}){0,3}$/;

export function isRelayBusTopic(value: unknown): value is string {
    return typeof value === 'string' && TOPIC_PATTERN.test(value);
}

/** Replica ids: what {@link newRelayReplicaId} makes. */
const REPLICA_PATTERN = /^r-[0-9a-f-]{36}$/;

export function isRelayReplicaId(value: unknown): value is string {
    return typeof value === 'string' && REPLICA_PATTERN.test(value);
}

/** Separator of the envelope fields; never inside a replica id, a topic or a number. */
const SEPARATOR = '';
/**
 * `3`: a replica accepts a sender's broadcasts only once it holds that
 * sender's broadcast sequence from an addressed presence message (the
 * handshake). A `2` replica, which trusted the first broadcast it heard, is
 * not understood.
 */
const ENVELOPE_VERSION = '3';

/** One message on the bus, as the receiving replica sees it once its signature checked out. */
export interface RelayEnvelope {
    from: string;
    /** `all`, or the one replica it is addressed to. */
    to: string;
    topic: string;
    /** Per sender and per destination, strictly increasing — a replayed message is refused. */
    seq: number;
    body: string;
}

/**
 * The key every replica signs and checks bus messages with: derived from the
 * attach-token secret the replicas already share (`TERMINAL_ATTACH_SECRET`,
 * else the Better Auth secret). Null without one — the bus then refuses to
 * carry anything (fail-closed), because an unsigned bus would let anyone who
 * can publish to the server command the fleet's links.
 */
export function relayBusKey(secret: string | null | undefined): Buffer | null {
    if (!secret || secret.length < 16) return null;
    return createHmac('sha256', Buffer.from(secret, 'utf8'))
        .update('ever-works relay bus v2')
        .digest();
}

/** The secret the key is derived from, read the way the attach signer reads it. */
export function relayBusSecretFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
    return env.TERMINAL_ATTACH_SECRET || env.BETTER_AUTH_SECRET || env.AUTH_SECRET || null;
}

/**
 * The channel namespace of a key: deployments that do not share the secret
 * never share channels or claims, even on one Valkey server (a stage and a
 * production on the same server cannot hear each other).
 */
export function relayBusNamespace(key: Buffer): string {
    return createHash('sha256').update(key).digest('hex').slice(0, 12);
}

function macOf(key: Buffer, fields: string): string {
    return createHmac('sha256', key).update(fields).digest('base64url');
}

/** `3␟from␟to␟topic␟seq␟mac␟body`, the MAC over every other field. */
export function encodeRelayEnvelope(key: Buffer, envelope: RelayEnvelope): string {
    const head = [
        ENVELOPE_VERSION,
        envelope.from,
        envelope.to,
        envelope.topic,
        String(envelope.seq),
    ].join(SEPARATOR);
    const mac = macOf(key, `${head}${SEPARATOR}${envelope.body}`);
    return `${head}${SEPARATOR}${mac}${SEPARATOR}${envelope.body}`;
}

/** The envelope's fields when it is well-formed AND signed with `key`; null for anything else. */
export function decodeRelayEnvelope(key: Buffer, raw: unknown): RelayEnvelope | null {
    if (typeof raw !== 'string') return null;
    const cuts: number[] = [];
    let at = -1;
    for (let i = 0; i < 6; i += 1) {
        at = raw.indexOf(SEPARATOR, at + 1);
        if (at < 0) return null;
        cuts.push(at);
    }
    const field = (index: number) => raw.slice(index === 0 ? 0 : cuts[index - 1] + 1, cuts[index]);
    if (field(0) !== ENVELOPE_VERSION) return null;
    const from = field(1);
    const to = field(2);
    const topic = field(3);
    const seqText = field(4);
    const mac = field(5);
    const body = raw.slice(cuts[5] + 1);
    if (
        !isRelayReplicaId(from) ||
        !(to === 'all' || isRelayReplicaId(to)) ||
        !isRelayBusTopic(topic)
    ) {
        return null;
    }
    if (!/^[0-9]{1,15}$/.test(seqText)) return null;
    const expected = Buffer.from(macOf(key, `${raw.slice(0, cuts[4])}${SEPARATOR}${body}`));
    const provided = Buffer.from(mac);
    if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) return null;
    return { from, to, topic, seq: Number(seqText), body };
}

export function newRelayReplicaId(uuid: string): string {
    return `r-${uuid.toLowerCase()}`;
}
