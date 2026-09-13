import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
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
 *  - **Reclaim.** Memory is released only when no client is attached AND
 *    the session ended AND at least one attach saw it (`force` overrides).
 *
 * A picture's bytes live only in this map and on the wire. Nothing here
 * writes a picture anywhere.
 */

/** A socket adapter or test double — the terminal relay's client shape, unchanged. */
export type ComputerRelayClient = TerminalRelayClient;

export const COMPUTER_FANOUT_BUS = 'COMPUTER_FANOUT_BUS' as const;
export const COMPUTER_BANNERS_CAP_DEFAULT = 16;

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

interface ComputerRelaySession {
    clients: Map<string, ComputerRelayClient>;
    banners: ComputerErrorFrame[];
    keyframe: ComputerScreenFrame | null;
    stats: ComputerStatsFrame | null;
    seenSeqMax: number;
    end: ComputerEndFrame | null;
    everAttached: boolean;
}

const INPUT_KINDS: ReadonlySet<string> = new Set(COMPUTER_INPUT_KINDS);

@Injectable()
export class ComputerRelayRegistry {
    private readonly logger = new Logger(ComputerRelayRegistry.name);
    private readonly sessions = new Map<string, ComputerRelaySession>();
    private readonly bus: TerminalFanoutBus;

    constructor(@Optional() @Inject(COMPUTER_FANOUT_BUS) bus?: TerminalFanoutBus) {
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
                if (session.clients.size === 0) {
                    session.banners.push(frame);
                    while (session.banners.length > COMPUTER_BANNERS_CAP_DEFAULT) {
                        session.banners.shift();
                    }
                }
                break;
            case 'end':
                session.end = frame;
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
     * then join the live set.
     */
    attach(sessionId: string, client: ComputerRelayClient): ComputerSessionRelayStatus {
        const session = this.getOrCreate(sessionId);
        const keyframeBeforeReplay = session.keyframe;
        const endBeforeReplay = session.end;

        const replay: ComputerFrame[] = [...session.banners];
        if (session.keyframe) replay.push(session.keyframe);
        if (session.stats) replay.push(session.stats);
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
        this.sessions.get(sessionId)?.clients.delete(clientId);
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
        } else if (frame.kind === 'control') {
            this.answer(session, sender, 'Taking control of this computer is not available yet.');
            return false;
        } else if (frame.kind !== 'quality' && frame.kind !== 'refresh') {
            return false;
        }
        return this.deliverToNode(sessionId, frame);
    }

    /**
     * A platform-originated request for the machine (`quality`, `refresh`),
     * e.g. from the owner's REST call. False when no machine leg is attached
     * on this replica and no peer could be told.
     */
    deliverToNode(sessionId: string, frame: ComputerFrame): boolean {
        const session = this.sessions.get(sessionId);
        if (!session || session.end) return false;
        const wire = encodeComputerFrame(frame);
        if (wire === null) return false;
        const delivered = this.sendToRole(session, wire, 'worker');
        this.safePublishRemote(sessionId, wire);
        return delivered > 0;
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

    private getOrCreate(sessionId: string): ComputerRelaySession {
        let session = this.sessions.get(sessionId);
        if (!session) {
            session = {
                clients: new Map(),
                banners: [],
                keyframe: null,
                stats: null,
                seenSeqMax: -1,
                end: null,
                everAttached: false,
            };
            this.sessions.set(sessionId, session);
        }
        return session;
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

    private safePublishRemote(sessionId: string, wire: string): void {
        try {
            this.bus.publishRemote(sessionId, wire);
        } catch (error) {
            this.logger.warn(
                `Computer fan-out bus publish failed for session ${sessionId}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }
}
