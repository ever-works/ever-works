import {
    Inject,
    Injectable,
    Logger,
    OnModuleDestroy,
    OnModuleInit,
    Optional,
} from '@nestjs/common';
import {
    COMPUTER_INPUT_KINDS,
    decodeComputerFrame,
    encodeComputerFrame,
    isComputerNodeToServerFrame,
    makeComputerErrorFrame,
    type ComputerCloseReason,
    type ComputerEndFrame,
    type ComputerErrorFrame,
    type ComputerFrame,
    type ComputerScreenFrame,
    type ComputerStatsFrame,
} from '@ever-works/contracts';
import {
    InProcessTerminalFanoutBus,
    type TerminalFanoutBus,
    type TerminalRelayClient,
} from '../terminal/terminal-relay.registry';

/**
 * Agent computers — the live-view relay, in memory, per session.
 *
 * The streaming terminal's relay one level over, and deliberately the same
 * shape: transport-agnostic (a client is anything with an id, a role and a
 * `send`), the same client and role model (`viewer` / `driver` / `worker`,
 * see `computer-attach.service.ts`), and the same cross-replica seam
 * ({@link TerminalFanoutBus}, default no-op, injected under its own token).
 * What differs is what is worth keeping for a viewer who arrives late:
 *
 *  - **One retained keyframe, not a scrollback.** A stale picture is what a
 *    re-attaching viewer needs; a history of pictures is bandwidth nobody
 *    asked for. The latest keyframe replaces the previous one.
 *  - **Latest stats.** The identity strip shows the machine's own clock and
 *    quality from the first paint, not after the next tick.
 *  - **Banners.** `error` frames published while nobody is attached
 *    ("starting the capture…", "no browser found") are retained, capped,
 *    and replayed to every attach — so a view that failed before producing a
 *    picture still explains itself.
 *  - **Pinned end.** The `end` frame is stored and replayed LAST to every
 *    current and future attach.
 *  - **Seq discipline.** Pictures carry a per-session monotonic seq; a
 *    duplicate or stale seq (a publisher retry) is dropped at the door.
 *  - **Role-checked inbound.** `quality` and `refresh` from a watching or
 *    controlling socket reach the machine's own leg (`worker`) only. Input
 *    (`pointer`, `key`, `text`, `scroll`) is accepted only from a `driver`;
 *    from a `viewer` it is answered with an `error` frame to that sender and
 *    NEVER forwarded. Nothing inbound is ever fanned out to other viewers.
 *  - **Control-checked input.** Where the API wires the control arbiter
 *    ({@link COMPUTER_RELAY_REQUIRES_CONTROL}), a `driver` token is not
 *    enough: input is forwarded only while THIS view holds control of the
 *    machine and its hold has not run out
 *    ({@link ComputerRelayRegistry.applyControl} keeps that current). Anything
 *    else is answered with an `error` frame and never forwarded. A change of
 *    control is told to the view's sockets and to the machine's own leg as a
 *    `mode` frame, which is how the machine knows to pause the Agent's own
 *    input and when to resume it.
 *  - **Reclaim.** Memory is released only when no client is attached AND
 *    the session ended AND at least one attach saw it (`force` overrides).
 *    A periodic {@link ComputerRelayRegistry.sweep} is what applies that in
 *    production: an ended view someone saw goes on the next pass, an ended
 *    view nobody saw is kept {@link COMPUTER_RELAY_ENDED_RETENTION_MS} for a
 *    late viewer and then dropped, and a view with no client and no traffic
 *    for {@link COMPUTER_RELAY_IDLE_RETENTION_MS} is dropped whatever its
 *    state — so the map is bounded by live views, never by lifetime views.
 *
 * A picture's bytes live only in this map and on the wire. Nothing here
 * writes a picture anywhere.
 */

/** A socket adapter or test double — the terminal relay's client shape, unchanged. */
export type ComputerRelayClient = TerminalRelayClient;

export const COMPUTER_FANOUT_BUS = 'COMPUTER_FANOUT_BUS' as const;
/**
 * Bound to `true` by the API module: input is forwarded only from the view
 * that holds control. Unbound, the relay keeps its Phase 1 rule (a `driver`
 * token is enough), which is all a relay used on its own — without the
 * arbiter that decides who holds control — can honestly enforce.
 */
export const COMPUTER_RELAY_REQUIRES_CONTROL = 'COMPUTER_RELAY_REQUIRES_CONTROL' as const;
export const COMPUTER_BANNERS_CAP_DEFAULT = 16;
/** An ended view nobody attached to is kept this long for a late viewer. */
export const COMPUTER_RELAY_ENDED_RETENTION_MS = 5 * 60_000;
/** A view with no client attached and no traffic is dropped after this, ended or not. */
export const COMPUTER_RELAY_IDLE_RETENTION_MS = 60 * 60_000;
/** How often {@link ComputerRelayRegistry.sweep} runs. */
export const COMPUTER_RELAY_SWEEP_INTERVAL_MS = 60_000;

/**
 * The terminal relay's cross-replica seam, with one addition: `publishRemote`
 * MAY answer whether a peer replica accepted the frame (a pub/sub publish
 * reports its receiver count). `true` lets a platform request to the machine
 * report delivery when the machine's leg is attached to another replica; a
 * bus that answers nothing (`void`, the terminal bus shape) is treated as
 * "no peer took it", exactly as before.
 */
export interface ComputerFanoutBus extends TerminalFanoutBus {
    publishRemote(sessionId: string, wire: string): boolean | void;
}

export interface ComputerSessionRelayStatus {
    exists: boolean;
    ended: boolean;
    endReason: ComputerCloseReason | null;
    clientCount: number;
    /** Browser sockets (watching or controlling). */
    viewerCount: number;
    /** Whether the machine's own inbound leg is attached. */
    nodeAttached: boolean;
    hasKeyframe: boolean;
    lastSeq: number | null;
}

/** A view's hold on control, as this replica last heard it. */
export interface ComputerRelayControlHold {
    held: boolean;
    /** When the hold runs out unless renewed (epoch ms); null = no deadline known. */
    untilMs: number | null;
}

interface ComputerRelaySession {
    clients: Map<string, ComputerRelayClient>;
    /** This view's hold on control, null until the arbiter said anything about it. */
    control: ComputerRelayControlHold | null;
    banners: ComputerErrorFrame[];
    keyframe: ComputerScreenFrame | null;
    stats: ComputerStatsFrame | null;
    seenSeqMax: number;
    end: ComputerEndFrame | null;
    everAttached: boolean;
    /** When the `end` frame was pinned (epoch ms), null while the view is open. */
    endedAtMs: number | null;
    /** Last publish, attach or detach (epoch ms) — what the idle sweep measures. */
    lastActivityMs: number;
}

const INPUT_KINDS: ReadonlySet<string> = new Set(COMPUTER_INPUT_KINDS);

@Injectable()
export class ComputerRelayRegistry implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(ComputerRelayRegistry.name);
    private readonly sessions = new Map<string, ComputerRelaySession>();
    private readonly bus: ComputerFanoutBus;
    private sweeper: NodeJS.Timeout | null = null;

    private readonly requiresControl: boolean;

    constructor(
        @Optional() @Inject(COMPUTER_FANOUT_BUS) bus?: ComputerFanoutBus,
        // Appended LAST + @Optional(): see COMPUTER_RELAY_REQUIRES_CONTROL.
        @Optional() @Inject(COMPUTER_RELAY_REQUIRES_CONTROL) requiresControl?: boolean,
    ) {
        this.requiresControl = requiresControl === true;
        this.bus = bus ?? new InProcessTerminalFanoutBus();
        this.bus.onRemote((sessionId, wire) => {
            const frame = decodeComputerFrame(wire);
            if (!frame) return;
            if (isComputerNodeToServerFrame(frame)) {
                this.publish(sessionId, frame, { fromRemote: true });
                return;
            }
            // Inbound already role-checked on the origin replica.
            const session = this.sessions.get(sessionId);
            if (session) this.sendToRole(session, wire, 'worker');
        });
    }

    onModuleInit(): void {
        if (this.sweeper) return;
        this.sweeper = setInterval(() => this.sweep(), COMPUTER_RELAY_SWEEP_INTERVAL_MS);
        this.sweeper.unref?.();
    }

    onModuleDestroy(): void {
        if (this.sweeper) clearInterval(this.sweeper);
        this.sweeper = null;
    }

    /**
     * The machine's publish leg (pictures, terminal frames, stats, banners,
     * end). Anything a browser could send is refused regardless of shape.
     */
    publish(sessionId: string, frame: ComputerFrame, opts: { fromRemote?: boolean } = {}): boolean {
        if (!isComputerNodeToServerFrame(frame)) {
            return false;
        }
        const session = this.getOrCreate(sessionId);
        if (session.end) {
            return false;
        }
        session.lastActivityMs = Date.now();
        switch (frame.kind) {
            case 'frame':
                if (frame.seq <= session.seenSeqMax) return false;
                session.seenSeqMax = frame.seq;
                if (frame.keyframe) session.keyframe = frame;
                break;
            case 'stats':
                session.stats = frame;
                break;
            case 'error':
                // Retained while no BROWSER is watching. The machine's own
                // leg is attached from the start of a view, so counting it
                // would drop exactly the startup banner a first viewer needs.
                if (!hasBrowser(session)) {
                    session.banners.push(frame);
                    while (session.banners.length > COMPUTER_BANNERS_CAP_DEFAULT) {
                        session.banners.shift();
                    }
                }
                break;
            case 'end':
                session.end = frame;
                session.endedAtMs = session.lastActivityMs;
                session.control = null;
                break;
            default:
                break;
        }
        const wire = encodeComputerFrame(frame);
        if (wire === null) return false;
        this.fanOut(session, wire);
        if (!opts.fromRemote) this.safePublishRemote(sessionId, wire);
        return true;
    }

    /** End a session from the platform side: pin the `end` frame and tell every attached socket. */
    end(sessionId: string, reason: ComputerCloseReason): boolean {
        return this.publish(sessionId, { kind: 'end', reason });
    }

    /**
     * Attach a socket: replay banners → keyframe → stats → end to it alone,
     * then join the live set. The replay is browser-directed output, so the
     * machine's own leg (`worker`) is never sent it — it joins silently.
     */
    attach(sessionId: string, client: ComputerRelayClient): ComputerSessionRelayStatus {
        const session = this.getOrCreate(sessionId);
        session.lastActivityMs = Date.now();
        if (client.role === 'worker') {
            session.clients.set(client.id, client);
            // A machine leg that (re)joins while this view holds control must
            // keep the Agent's own input paused.
            if (session.control?.held && !session.end) {
                if (!this.trySend(client, { kind: 'mode', mode: 'controlling' })) {
                    session.clients.delete(client.id);
                }
            }
            return this.getStatus(sessionId);
        }
        const keyframeBeforeReplay = session.keyframe;
        const endBeforeReplay = session.end;

        const replay: ComputerFrame[] = [...session.banners];
        if (session.keyframe) replay.push(session.keyframe);
        if (session.stats) replay.push(session.stats);
        if (session.control?.held && !session.end)
            replay.push({ kind: 'mode', mode: 'controlling' });
        if (session.end) replay.push(session.end);
        for (const frame of replay) {
            if (!this.trySend(client, frame)) {
                return this.getStatus(sessionId);
            }
        }
        session.everAttached = true;
        session.clients.set(client.id, client);

        // Reentrancy catch-up: a send that synchronously triggered a publish
        // landed after the snapshot and before this client joined.
        if (session.keyframe && session.keyframe !== keyframeBeforeReplay) {
            if (!this.trySend(client, session.keyframe)) session.clients.delete(client.id);
        }
        if (session.end && session.end !== endBeforeReplay && session.clients.has(client.id)) {
            if (!this.trySend(client, session.end)) session.clients.delete(client.id);
        }
        return this.getStatus(sessionId);
    }

    detach(sessionId: string, clientId: string): void {
        const session = this.sessions.get(sessionId);
        if (!session) return;
        session.clients.delete(clientId);
        session.lastActivityMs = Date.now();
    }

    /**
     * An attached socket's frame. Returns whether it was delivered to the
     * machine's leg. See the class comment for the role rules.
     */
    deliverInbound(sessionId: string, senderId: string, frame: ComputerFrame): boolean {
        const session = this.sessions.get(sessionId);
        const sender = session?.clients.get(senderId);
        if (!session || !sender) return false;
        if (sender.role === 'worker') {
            // The machine publishes through its authenticated HTTP leg.
            return false;
        }
        if (INPUT_KINDS.has(frame.kind)) {
            if (sender.role !== 'driver') {
                this.answer(session, sender, 'Watching only — input is not sent to this computer.');
                return false;
            }
            if (this.requiresControl && !this.holdsControl(session)) {
                this.answer(session, sender, 'You do not have control of this computer.');
                return false;
            }
        } else if (frame.kind === 'control') {
            // Control is taken, handed over and given back through the owner's
            // routes (throttled, authorized and audited), never over this socket.
            this.answer(
                session,
                sender,
                'Take over and give back control from the page, not over this socket.',
            );
            return false;
        } else if (frame.kind !== 'quality' && frame.kind !== 'refresh') {
            return false;
        }
        return this.deliverToNode(sessionId, frame);
    }

    /**
     * A platform-originated request for the machine (`quality`, `refresh`),
     * e.g. from the owner's REST call. True when a machine leg attached on
     * this replica took it, or the bus reports that a peer replica accepted
     * it; false when neither happened.
     *
     * A replica with no local state for the view still tells its peers: the
     * owner's REST call can land on any replica, and the machine's leg may be
     * attached to another one. No local entry is created for that.
     */
    deliverToNode(sessionId: string, frame: ComputerFrame): boolean {
        const session = this.sessions.get(sessionId);
        if (session?.end) return false;
        const wire = encodeComputerFrame(frame);
        if (wire === null) return false;
        const delivered = session ? this.sendToRole(session, wire, 'worker') : 0;
        const acceptedByPeer = this.safePublishRemote(sessionId, wire);
        return delivered > 0 || acceptedByPeer;
    }

    /**
     * The arbiter's latest word on this view's hold on control. A change of
     * held / not held is told, as a `mode` frame, to the view's browser
     * sockets and to the machine's own leg (and to peer replicas, where the
     * machine's leg may be attached); a renewed deadline alone is only
     * recorded. A view this replica has never seen gets local state only
     * when it holds control.
     */
    applyControl(sessionId: string, hold: ComputerRelayControlHold): void {
        const existing = this.sessions.get(sessionId);
        if (existing?.end) return;
        const wire = encodeComputerFrame({
            kind: 'mode',
            mode: hold.held ? 'controlling' : 'watching',
        });
        if (!existing && !hold.held) {
            if (wire !== null) this.safePublishRemote(sessionId, wire);
            return;
        }
        const session = existing ?? this.getOrCreate(sessionId);
        const changed = (session.control?.held === true) !== hold.held;
        session.control = { held: hold.held, untilMs: hold.untilMs };
        if (!changed || wire === null) return;
        session.lastActivityMs = Date.now();
        this.fanOut(session, wire);
        this.sendToRole(session, wire, 'worker');
        this.safePublishRemote(sessionId, wire);
    }

    /** This view's hold on control as this replica knows it, or null when it has heard nothing. */
    getControl(sessionId: string): ComputerRelayControlHold | null {
        return this.sessions.get(sessionId)?.control ?? null;
    }

    getStatus(sessionId: string): ComputerSessionRelayStatus {
        const session = this.sessions.get(sessionId);
        if (!session) {
            return {
                exists: false,
                ended: false,
                endReason: null,
                clientCount: 0,
                viewerCount: 0,
                nodeAttached: false,
                hasKeyframe: false,
                lastSeq: null,
            };
        }
        let viewerCount = 0;
        let nodeAttached = false;
        for (const client of session.clients.values()) {
            if (client.role === 'worker') nodeAttached = true;
            else viewerCount += 1;
        }
        return {
            exists: true,
            ended: session.end !== null,
            endReason: session.end?.reason ?? null,
            clientCount: session.clients.size,
            viewerCount,
            nodeAttached,
            hasKeyframe: session.keyframe !== null,
            lastSeq: session.seenSeqMax >= 0 ? session.seenSeqMax : null,
        };
    }

    canReclaim(sessionId: string, opts: { force?: boolean } = {}): boolean {
        const session = this.sessions.get(sessionId);
        if (!session) return true;
        if (session.clients.size > 0) return false;
        if (opts.force === true) return session.end !== null;
        return session.end !== null && session.everAttached;
    }

    reclaim(sessionId: string, opts: { force?: boolean } = {}): boolean {
        if (!this.sessions.has(sessionId) || !this.canReclaim(sessionId, opts)) return false;
        this.sessions.delete(sessionId);
        return true;
    }

    /**
     * Release the memory of views nothing is using any more. Never touches a
     * view with a client attached. Drops an ended view someone saw
     * ({@link canReclaim}); an ended view nobody saw once
     * {@link COMPUTER_RELAY_ENDED_RETENTION_MS} has passed; and any view idle
     * for {@link COMPUTER_RELAY_IDLE_RETENTION_MS} — the floor for a view whose
     * end was recorded on a replica this one never heard from. Runs on a
     * timer in production; returns how many views it dropped.
     */
    sweep(now: number = Date.now()): number {
        let dropped = 0;
        for (const [sessionId, session] of this.sessions) {
            if (session.clients.size > 0) continue;
            const endedAndSeen = session.end !== null && session.everAttached;
            const endedLongAgo =
                session.endedAtMs !== null &&
                now - session.endedAtMs >= COMPUTER_RELAY_ENDED_RETENTION_MS;
            const idle = now - session.lastActivityMs >= COMPUTER_RELAY_IDLE_RETENTION_MS;
            if (endedAndSeen || endedLongAgo || idle) {
                this.sessions.delete(sessionId);
                dropped += 1;
            }
        }
        return dropped;
    }

    /** How many views this replica holds in memory. */
    size(): number {
        return this.sessions.size;
    }

    private getOrCreate(sessionId: string): ComputerRelaySession {
        let session = this.sessions.get(sessionId);
        if (!session) {
            session = {
                clients: new Map(),
                control: null,
                banners: [],
                keyframe: null,
                stats: null,
                seenSeqMax: -1,
                end: null,
                everAttached: false,
                endedAtMs: null,
                lastActivityMs: Date.now(),
            };
            this.sessions.set(sessionId, session);
        }
        return session;
    }

    private holdsControl(session: ComputerRelaySession, now: number = Date.now()): boolean {
        const control = session.control;
        if (!control?.held) return false;
        return control.untilMs === null || now < control.untilMs;
    }

    private trySend(client: ComputerRelayClient, frame: ComputerFrame): boolean {
        const wire = encodeComputerFrame(frame);
        if (wire === null) return true;
        try {
            client.send(wire);
            return true;
        } catch {
            return false;
        }
    }

    private answer(
        session: ComputerRelaySession,
        sender: ComputerRelayClient,
        message: string,
    ): void {
        if (!this.trySend(sender, makeComputerErrorFrame(message))) {
            session.clients.delete(sender.id);
        }
    }

    /** Fan a server-direction frame out to every attached browser socket (never to the machine's leg). */
    private fanOut(session: ComputerRelaySession, wire: string): void {
        for (const [id, client] of session.clients) {
            if (client.role === 'worker') continue;
            this.sendOrDrop(session, id, client, wire);
        }
    }

    private sendToRole(
        session: ComputerRelaySession,
        wire: string,
        role: ComputerRelayClient['role'],
    ): number {
        let delivered = 0;
        for (const [id, client] of session.clients) {
            if (client.role !== role) continue;
            if (this.sendOrDrop(session, id, client, wire)) delivered += 1;
        }
        return delivered;
    }

    private sendOrDrop(
        session: ComputerRelaySession,
        id: string,
        client: ComputerRelayClient,
        wire: string,
    ): boolean {
        try {
            client.send(wire);
            return true;
        } catch (error) {
            session.clients.delete(id);
            this.logger.debug(
                `Dropped computer client ${id} after send failure: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return false;
        }
    }

    /** True only when the bus says a peer replica accepted the frame. Never throws. */
    private safePublishRemote(sessionId: string, wire: string): boolean {
        try {
            return this.bus.publishRemote(sessionId, wire) === true;
        } catch (error) {
            this.logger.warn(
                `Computer fan-out bus publish failed for session ${sessionId}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return false;
        }
    }
}

/** Is a browser (a watching or controlling socket) attached? The machine's own leg does not count. */
function hasBrowser(session: ComputerRelaySession): boolean {
    for (const client of session.clients.values()) {
        if (client.role !== 'worker') return true;
    }
    return false;
}
