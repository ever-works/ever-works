import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
    encodeTerminalFrame,
    isTerminalServerToClientFrame,
    decodeTerminalFrame,
    type TerminalErrorFrame,
    type TerminalExitFrame,
    type TerminalFrame,
    type TerminalStdoutFrame,
} from '@ever-works/contracts';

/**
 * Streaming-terminal relay — in-memory session registry.
 *
 * Transport-agnostic core of the terminal relay: it never imports `ws`
 * and knows nothing about sockets — a "client" is anything with an id,
 * a role, and a `send(wire)` function, which is what makes the whole
 * replay/fan-out/reclaim matrix unit-testable without a network. The
 * WebSocket gateway (follow-up PR) adapts real sockets onto this
 * interface; the internal publish endpoint calls {@link publish}.
 *
 * Semantics (kept deliberately boring and explicit):
 *
 *  - **Scrollback** — every accepted `stdout` frame lands in a
 *    byte-bounded rolling window (default 512 KiB), evicted oldest-first.
 *    This is what any attach replays.
 *  - **Banners** — `error` frames published while NO client is attached
 *    (the pre-spawn preamble: "provider not configured", "starting …")
 *    are retained (count-capped) and replayed to EVERY future attach —
 *    a session that failed before producing output must still explain
 *    itself to a viewer arriving late. Errors published while clients
 *    are attached are transient banners: fanned out live, not retained.
 *  - **Pinned exit** — the terminal `exit` frame is stored on the
 *    session (never evictable) and replayed LAST to every current and
 *    future attach: a viewer can always learn the session is over.
 *  - **Seq discipline** — `stdout` frames carry a per-session monotonic
 *    seq; stale/duplicate seqs (publisher retries) are dropped at the
 *    door so no client ever renders the same bytes twice.
 *  - **Inbound fan-out** — `stdin`/`resize` from an attached client is
 *    delivered to every OTHER attached client after a role check;
 *    viewer input is refused with an `error` frame answered to the
 *    sender only.
 *  - **Reclaim** — a session's memory is released only when it has no
 *    clients AND has ended AND at least one attach saw its history
 *    (`force` overrides for the sweeper's abandoned-session TTL path).
 *
 * Multi-replica: this registry is per-process. Cross-replica fan-out is
 * fenced behind {@link TerminalFanoutBus} — the default in-process bus
 * is a no-op, which is correct for the current single-API-replica
 * deployments; a Redis pub/sub implementation can be injected later
 * (via {@link TERMINAL_FANOUT_BUS}) with zero changes to registry
 * semantics. BOTH directions traverse the bus: server frames take the
 * publish path on peers, and role-checked inbound stdin/resize fans to
 * peers' local clients — a driver and worker attached to different
 * replicas still form a complete loop. Bus delivery is best-effort;
 * local truth never depends on it.
 */

export type TerminalClientRole = 'driver' | 'viewer' | 'worker';

/** Anything attachable: a socket adapter, or a test double. */
export interface TerminalRelayClient {
    readonly id: string;
    readonly role: TerminalClientRole;
    /** Deliver one encoded wire frame. Throws are tolerated: a client
     *  whose send throws is dropped from the session. */
    send(wire: string): void;
}

/**
 * Cross-replica fan-out seam. `publishRemote` must NOT loop back to the
 * publishing replica; `onRemote` registers the handler for frames
 * published by peer replicas.
 */
export interface TerminalFanoutBus {
    publishRemote(runId: string, wire: string): void;
    onRemote(handler: (runId: string, wire: string) => void): void;
}

/** Single-replica default: no peers, nothing to do. */
export class InProcessTerminalFanoutBus implements TerminalFanoutBus {
    publishRemote(): void {
        // no peers in-process
    }
    onRemote(): void {
        // no peers in-process
    }
}

export interface TerminalRelayRegistryOptions {
    /** Rolling scrollback budget per session, in DECODED terminal bytes. */
    scrollbackMaxBytes?: number;
    /** Max retained pre-attach banner frames per session. */
    bannersCap?: number;
}

export interface TerminalSessionStatus {
    exists: boolean;
    ended: boolean;
    exitReason: TerminalExitFrame['reason'] | null;
    clientCount: number;
    viewerCount: number;
    lastSeq: number | null;
}

interface TerminalSession {
    clients: Map<string, TerminalRelayClient>;
    /** Pre-attach `error` banners, replayed to every attach. */
    banners: TerminalErrorFrame[];
    /** Rolling stdout window, ascending seq. */
    scrollback: TerminalStdoutFrame[];
    scrollbackBytes: number;
    /** Highest stdout seq accepted (dup/stale gate). -1 = none yet. */
    seenSeqMax: number;
    exit: TerminalExitFrame | null;
    ended: boolean;
    /** At least one attach replayed this session's history. */
    everAttached: boolean;
}

export const TERMINAL_SCROLLBACK_MAX_BYTES_DEFAULT = 512 * 1024;
export const TERMINAL_BANNERS_CAP_DEFAULT = 64;

/**
 * Injection tokens — the constructor parameters are interface-typed, and
 * TypeScript interfaces are erased at runtime, so without explicit tokens
 * Nest could never actually supply a configured bus or options object
 * (the registry would silently fall back to the no-op defaults).
 */
export const TERMINAL_FANOUT_BUS = 'TERMINAL_FANOUT_BUS' as const;
export const TERMINAL_RELAY_REGISTRY_OPTIONS = 'TERMINAL_RELAY_REGISTRY_OPTIONS' as const;

/**
 * Decoded size of a canonical base64 payload. Frame data is validated
 * canonical by the codec, so padding is exactly the trailing `=` count.
 * The scrollback budget counts REAL terminal bytes — wire characters
 * would silently shrink the promised window by a third.
 */
function decodedBase64Bytes(data: string): number {
    if (data.length === 0) return 0;
    let padding = 0;
    if (data.endsWith('==')) padding = 2;
    else if (data.endsWith('=')) padding = 1;
    return (data.length / 4) * 3 - padding;
}

@Injectable()
export class TerminalRelayRegistry {
    private readonly logger = new Logger(TerminalRelayRegistry.name);
    private readonly sessions = new Map<string, TerminalSession>();
    private readonly scrollbackMaxBytes: number;
    private readonly bannersCap: number;
    private readonly bus: TerminalFanoutBus;

    constructor(
        @Optional() @Inject(TERMINAL_FANOUT_BUS) bus?: TerminalFanoutBus,
        @Optional() @Inject(TERMINAL_RELAY_REGISTRY_OPTIONS) options?: TerminalRelayRegistryOptions,
    ) {
        this.bus = bus ?? new InProcessTerminalFanoutBus();
        this.scrollbackMaxBytes =
            options?.scrollbackMaxBytes ?? TERMINAL_SCROLLBACK_MAX_BYTES_DEFAULT;
        this.bannersCap = options?.bannersCap ?? TERMINAL_BANNERS_CAP_DEFAULT;
        // Frames from peer replicas fan out locally but are never
        // re-broadcast (fromRemote) — no bus loops. Server-direction
        // frames take the full publish path; inbound stdin/resize from a
        // driver attached to a PEER replica fans to all local clients
        // (the role check already ran on the origin replica, and the
        // sender is not local so nobody is excluded).
        this.bus.onRemote((runId, wire) => {
            const frame = decodeTerminalFrame(wire);
            if (!frame) {
                return;
            }
            if (frame.kind === 'stdin' || frame.kind === 'resize') {
                const session = this.sessions.get(runId);
                if (session) {
                    this.fanOut(session, wire, null);
                }
                return;
            }
            this.publish(runId, frame, { fromRemote: true });
        });
    }

    /**
     * Worker-side publish leg (stdout / exit / error). Returns whether
     * the frame was accepted. Client-direction kinds are refused here
     * regardless of shape validity — output can only originate from the
     * publisher, never from an attached browser.
     */
    publish(runId: string, frame: TerminalFrame, opts: { fromRemote?: boolean } = {}): boolean {
        if (!isTerminalServerToClientFrame(frame)) {
            return false;
        }
        const session = this.getOrCreate(runId);

        if (session.ended) {
            // The pinned exit is final; late output from a dying process
            // is dropped rather than rendered after "session ended".
            return false;
        }

        if (frame.kind === 'stdout') {
            if (frame.seq <= session.seenSeqMax) {
                return false; // publisher retry / duplicate
            }
            session.seenSeqMax = frame.seq;
            session.scrollback.push(frame);
            session.scrollbackBytes += decodedBase64Bytes(frame.data);
            while (
                session.scrollbackBytes > this.scrollbackMaxBytes &&
                session.scrollback.length > 0
            ) {
                const evicted = session.scrollback.shift() as TerminalStdoutFrame;
                session.scrollbackBytes -= decodedBase64Bytes(evicted.data);
            }
        } else if (frame.kind === 'exit') {
            session.ended = true;
            session.exit = frame;
        } else if (frame.kind === 'error' && session.clients.size === 0) {
            // Pre-attach preamble — retained so a late viewer still sees
            // why a session never produced output.
            session.banners.push(frame);
            while (session.banners.length > this.bannersCap) {
                session.banners.shift();
            }
        }

        const wire = encodeTerminalFrame(frame);
        if (wire === null) {
            return false;
        }

        this.fanOut(session, wire, null);

        if (!opts.fromRemote) {
            this.safePublishRemote(runId, wire);
        }
        return true;
    }

    /**
     * Attach a client: replay history (banners → scrollback in seq order
     * → pinned exit), then join the live fan-out set. Replay is sent
     * only to the attaching client.
     */
    attach(runId: string, client: TerminalRelayClient): TerminalSessionStatus {
        const session = this.getOrCreate(runId);

        // Snapshot for the reentrancy guard below: the replay loop is
        // synchronous, but a client.send that synchronously triggers a
        // publish (a same-process worker adapter) would land frames in
        // scrollback AFTER this snapshot and BEFORE this client joins
        // the fan-out set — invisible to both paths without the catch-up.
        const seqBeforeReplay = session.seenSeqMax;
        const exitBeforeReplay = session.exit;

        const replay: TerminalFrame[] = [...session.banners, ...session.scrollback];
        if (session.exit) {
            replay.push(session.exit);
        }
        for (const frame of replay) {
            const wire = encodeTerminalFrame(frame);
            if (wire !== null) {
                try {
                    client.send(wire);
                } catch {
                    // A client that dies mid-replay simply never joins.
                    return this.getStatus(runId);
                }
            }
        }

        session.everAttached = true;
        session.clients.set(client.id, client);

        // Reentrancy catch-up: deliver anything published during replay.
        if (session.seenSeqMax > seqBeforeReplay) {
            for (const frame of session.scrollback) {
                if (frame.seq <= seqBeforeReplay) continue;
                const wire = encodeTerminalFrame(frame);
                if (wire !== null) {
                    try {
                        client.send(wire);
                    } catch {
                        session.clients.delete(client.id);
                        return this.getStatus(runId);
                    }
                }
            }
        }
        if (session.exit && session.exit !== exitBeforeReplay) {
            const wire = encodeTerminalFrame(session.exit);
            if (wire !== null) {
                try {
                    client.send(wire);
                } catch {
                    session.clients.delete(client.id);
                }
            }
        }
        return this.getStatus(runId);
    }

    detach(runId: string, clientId: string): void {
        this.sessions.get(runId)?.clients.delete(clientId);
    }

    /**
     * Inbound leg (stdin / resize from an attached client). Role-checked:
     * viewers are read-only — their input is refused with an `error`
     * frame answered to the sender alone. Accepted frames fan out to
     * every attached client EXCEPT the sender (the worker consumes
     * stdin; other viewers observe the driver's resize).
     */
    deliverInbound(runId: string, senderId: string, frame: TerminalFrame): boolean {
        const session = this.sessions.get(runId);
        if (!session) {
            return false;
        }
        const sender = session.clients.get(senderId);
        if (!sender) {
            return false;
        }
        if (frame.kind !== 'stdin' && frame.kind !== 'resize') {
            // Auth is consumed by the gateway during handshake; every
            // server-direction kind is refused here — an echoed replay
            // can never re-enter the session as input.
            return false;
        }
        if (sender.role === 'viewer') {
            const refusal = encodeTerminalFrame({
                kind: 'error',
                message: 'read-only session: viewer input is not delivered',
            });
            if (refusal !== null) {
                try {
                    sender.send(refusal);
                } catch {
                    session.clients.delete(senderId);
                }
            }
            return false;
        }
        const wire = encodeTerminalFrame(frame);
        if (wire === null) {
            return false;
        }
        this.fanOut(session, wire, senderId);
        // A worker for this run may be attached to a PEER replica —
        // inbound traverses the bus too, or cross-replica stdin would
        // silently reach nobody. The origin replica already role-checked.
        this.safePublishRemote(runId, wire);
        return true;
    }

    /**
     * Bus delivery is best-effort: local truth (scrollback, seq, local
     * fan-out) is already committed by the time the bus is invoked, and a
     * publisher retry would be rejected by the seq gate — so a throwing
     * bus implementation must degrade to a logged warning, never to an
     * exception that makes the local replica look failed while it is not.
     * Cross-replica catch-up on bus outage is the bus implementation's
     * concern (e.g. Redis client retry), not the registry's.
     */
    private safePublishRemote(runId: string, wire: string): void {
        try {
            this.bus.publishRemote(runId, wire);
        } catch (error) {
            this.logger.warn(
                `Terminal fan-out bus publish failed for run ${runId}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }

    getStatus(runId: string): TerminalSessionStatus {
        const session = this.sessions.get(runId);
        if (!session) {
            return {
                exists: false,
                ended: false,
                exitReason: null,
                clientCount: 0,
                viewerCount: 0,
                lastSeq: null,
            };
        }
        let viewerCount = 0;
        for (const client of session.clients.values()) {
            if (client.role === 'viewer') viewerCount++;
        }
        return {
            exists: true,
            ended: session.ended,
            exitReason: session.exit?.reason ?? null,
            clientCount: session.clients.size,
            viewerCount,
            lastSeq: session.seenSeqMax >= 0 ? session.seenSeqMax : null,
        };
    }

    /**
     * May this session's memory be released? True when nothing is
     * attached, the session has ended, and at least one attach saw its
     * history — so a failed session's explanation is never reclaimed
     * unseen. The sweeper's abandoned-session TTL path uses `force`.
     */
    canReclaim(runId: string, opts: { force?: boolean } = {}): boolean {
        const session = this.sessions.get(runId);
        if (!session) {
            return true;
        }
        if (session.clients.size > 0) {
            return false;
        }
        if (opts.force === true) {
            return session.ended;
        }
        return session.ended && session.everAttached;
    }

    /** Release the session if {@link canReclaim} allows it. */
    reclaim(runId: string, opts: { force?: boolean } = {}): boolean {
        if (!this.sessions.has(runId)) {
            return false;
        }
        if (!this.canReclaim(runId, opts)) {
            return false;
        }
        this.sessions.delete(runId);
        return true;
    }

    private getOrCreate(runId: string): TerminalSession {
        let session = this.sessions.get(runId);
        if (!session) {
            session = {
                clients: new Map(),
                banners: [],
                scrollback: [],
                scrollbackBytes: 0,
                seenSeqMax: -1,
                exit: null,
                ended: false,
                everAttached: false,
            };
            this.sessions.set(runId, session);
        }
        return session;
    }

    /** Send to every attached client except `excludeId`; a client whose
     *  send throws is dropped so one dead socket can't poison fan-out. */
    private fanOut(session: TerminalSession, wire: string, excludeId: string | null): void {
        for (const [id, client] of session.clients) {
            if (id === excludeId) continue;
            try {
                client.send(wire);
            } catch (error) {
                session.clients.delete(id);
                this.logger.debug(
                    `Dropped terminal client ${id} after send failure: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                );
            }
        }
    }
}
