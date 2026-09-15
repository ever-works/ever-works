import { Injectable, Logger, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
    COMPUTER_MAX_CONTROL_SPANS,
    type ComputerControlDecision,
    type ComputerControlReleaseReason,
    type ComputerControlRefusal,
    type ComputerControlSpan,
    type ComputerControlStateView,
} from '@ever-works/contracts';
import type { ComputerSession } from '../entities/computer-session.entity';
import { FleetAuditService } from '../fleet/fleet-audit.service';
import { computerAuditDetails } from './computer-audit';
import {
    ComputerControlRepository,
    type ComputerControlLockRow,
    type ComputerControlReleaseCondition,
} from './computer-control.repository';
import { ComputerSessionRepository } from './computer-session.repository';
import {
    canControl,
    controlGrantDeadlines,
    controlIdleDeadline,
    controlRequestExpiresAt,
    extendedControlExpiry,
    isControlRequestPending,
    resolveComputerControlLimits,
    resolveControlLockExpiry,
    viewerRoleForNode,
    type ComputerControlLimits,
} from './control-policy';

/** What changed about control of one live view. The relay and the Activity Log listen for it. */
export interface ComputerControlChange {
    nodeId: string;
    /** The live view whose control changed. */
    sessionId: string;
    /** The machine's owner. */
    ownerUserId: string;
    agentId: string;
    /** Who caused it; null for an automatic release. */
    actorUserId: string | null;
    /** True when this view now holds control. */
    held: boolean;
    /** While held: the instant the lock frees itself if nothing else happens (epoch ms). */
    untilMs: number | null;
    /** When released: why. */
    reason: ComputerControlReleaseReason | null;
    /** When released: how long it was held. */
    heldMs: number | null;
}

export class ComputerControlChangedEvent {
    static EVENT_NAME = 'computer.control.changed';

    constructor(public readonly change: ComputerControlChange) {}
}

/** The owner's view and session a control act is made from. */
export interface ComputerControlActor {
    userId: string;
    agentId: string;
    sessionId: string;
}

export type ComputerControlOutcome =
    | { state: ComputerControlStateView }
    | { refused: ComputerControlRefusal; state: ComputerControlStateView };

/** What the live gateway needs to know about one view's hold. */
export interface ComputerControlHold {
    held: boolean;
    /** When held: when the lock frees itself unless input or a keep-alive arrives (epoch ms). */
    untilMs: number | null;
}

const LIVE_STATUSES: ReadonlySet<string> = new Set(['live', 'stalled']);

/** Browser keep-alives closer together than this are not written again. */
const ACK_WRITE_INTERVAL_MS = 10_000;

/**
 * Agent computers, take-over — the control arbiter.
 *
 * One person holds a machine at a time, across every live view of it. The
 * lock is on the machine's own row (`fleet_nodes.controlHolder*` and the
 * columns beside it), and every act on it is ONE compare-and-set through
 * `ComputerControlRepository` — so the answer to "who holds this machine" is
 * decided by the database, never by which request happened to run first on
 * which replica:
 *
 *  - **take** wins only while the lock is free; the loser reads the holder;
 *  - **give back** and every automatic release (idle, ceiling, a browser that
 *    went away, the view ending) are scoped by the holding view AND by the
 *    deadline that expired, so a late timer never evicts a newer holder;
 *  - **request / hand over** park one request on the row; the hand-over moves
 *    the lock to that requester in the same statement that clears the
 *    request, and only while that request is still pending — a request that
 *    declined on its own, or a holder that already lost the lock, makes the
 *    hand-over lose instead of producing two holders.
 *
 * Expired locks and requests are settled INLINE on every read and act, so
 * nothing depends on a background sweep having run. Every grant, release and
 * refusal writes the fleet audit ledger through its one writer, and every
 * grant and release is published as a {@link ComputerControlChangedEvent} so
 * the relay can gate input and tell the machine to pause or resume the Agent.
 *
 * Every refusal is a typed value, never a bare throw.
 */
@Injectable()
export class ComputerControlArbiter {
    private readonly logger = new Logger(ComputerControlArbiter.name);
    /** Overridable clock, for tests. */
    clock: () => Date = () => new Date();

    constructor(
        private readonly locks: ComputerControlRepository,
        private readonly sessions: ComputerSessionRepository,
        @Optional() private readonly audit?: FleetAuditService,
        @Optional() private readonly events?: EventEmitter2,
    ) {}

    /** Limits are read per call so an operator change needs no restart. */
    limits(): ComputerControlLimits {
        return resolveComputerControlLimits(process.env);
    }

    // ── Owner acts ────────────────────────────────────────────────────────

    /** Control as `actor`'s view sees it. Null when the view is not theirs. */
    async getState(actor: ComputerControlActor): Promise<ComputerControlStateView | null> {
        const session = await this.sessions.findForOwner(
            actor.sessionId,
            actor.userId,
            actor.agentId,
        );
        if (!session) return null;
        const now = this.clock();
        const lock = await this.settle(session, now);
        if (!lock) return null;
        if (lock.controlHolderSessionId === session.id && ackIsDue(lock, now)) {
            await this.locks.acknowledge(lock.id, session.id, now);
        }
        return this.view(session.id, actor.userId, lock, now);
    }

    /** Take control of the machine from `actor`'s view. */
    async take(actor: ComputerControlActor): Promise<ComputerControlOutcome | null> {
        const session = await this.sessions.findForOwner(
            actor.sessionId,
            actor.userId,
            actor.agentId,
        );
        if (!session) return null;
        const now = this.clock();
        const lock = await this.settle(session, now);
        if (!lock) return null;
        const refuse = async (refused: ComputerControlRefusal, current = lock) => {
            if (refused === 'policy' || refused === 'held') {
                await this.recordRefusal(session, actor.userId, current);
            }
            return { refused, state: await this.view(session.id, actor.userId, current, now) };
        };

        if (session.status === 'ended') return refuse('session-ended');
        if (!canControl(lock.controlPolicy ?? 'owner', viewerRoleForNode(lock, actor))) {
            return refuse('policy');
        }
        if (lock.controlHolderSessionId === session.id) {
            return { state: await this.view(session.id, actor.userId, lock, now) };
        }
        if (lock.controlHolderSessionId) return refuse('held');
        if (!LIVE_STATUSES.has(session.status)) return refuse('not-live');

        const limits = this.limits();
        const deadlines = controlGrantDeadlines(now, limits);
        const won = await this.locks.take(lock.id, lock.userId, {
            userId: actor.userId,
            sessionId: session.id,
            now,
            ...deadlines,
        });
        const current = (await this.locks.findLock(lock.id, lock.userId)) ?? lock;
        if (!won) return refuse('held', current);
        await this.afterGrant(session, actor.userId, current, now);
        return { state: await this.view(session.id, actor.userId, current, now) };
    }

    /** Give control back from `actor`'s view. Idempotent: a view that does not hold it has nothing to give back. */
    async giveBack(actor: ComputerControlActor): Promise<ComputerControlOutcome | null> {
        const session = await this.sessions.findForOwner(
            actor.sessionId,
            actor.userId,
            actor.agentId,
        );
        if (!session) return null;
        const now = this.clock();
        const lock = await this.settle(session, now);
        if (!lock) return null;
        if (lock.controlHolderSessionId === session.id) {
            await this.releaseLock(lock, { kind: 'holder' }, 'given-back', actor.userId, now);
        }
        return this.stateOutcome(session, actor.userId, now);
    }

    /** Ask whoever holds the machine to hand control over to `actor`'s view. */
    async request(actor: ComputerControlActor): Promise<ComputerControlOutcome | null> {
        const session = await this.sessions.findForOwner(
            actor.sessionId,
            actor.userId,
            actor.agentId,
        );
        if (!session) return null;
        const now = this.clock();
        const lock = await this.settle(session, now);
        if (!lock) return null;
        const limits = this.limits();
        const refuse = async (refused: ComputerControlRefusal, current = lock) => ({
            refused,
            state: await this.view(session.id, actor.userId, current, now),
        });

        if (session.status === 'ended') return refuse('session-ended');
        if (!canControl(lock.controlPolicy ?? 'owner', viewerRoleForNode(lock, actor))) {
            await this.recordRefusal(session, actor.userId, lock);
            return refuse('policy');
        }
        if (!LIVE_STATUSES.has(session.status)) return refuse('not-live');
        const holder = lock.controlHolderSessionId;
        if (!holder) return refuse('not-held');
        if (holder === session.id)
            return { state: await this.view(session.id, actor.userId, lock, now) };
        if (isControlRequestPending(lock, now, limits)) {
            return lock.controlRequestSessionId === session.id
                ? { state: await this.view(session.id, actor.userId, lock, now) }
                : refuse('already-requested');
        }
        const won = await this.locks.request(
            lock.id,
            holder,
            { userId: actor.userId, sessionId: session.id },
            now,
            new Date(now.getTime() - limits.requestTimeoutMs),
        );
        const current = (await this.locks.findLock(lock.id, lock.userId)) ?? lock;
        if (!won)
            return refuse(
                current.controlHolderSessionId ? 'already-requested' : 'not-held',
                current,
            );
        return { state: await this.view(session.id, actor.userId, current, now) };
    }

    /** The holding view answers a request: hand over, or keep control. */
    async answer(
        actor: ComputerControlActor,
        requestId: string,
        decision: ComputerControlDecision,
    ): Promise<ComputerControlOutcome | null> {
        const session = await this.sessions.findForOwner(
            actor.sessionId,
            actor.userId,
            actor.agentId,
        );
        if (!session) return null;
        const now = this.clock();
        const lock = await this.settle(session, now);
        if (!lock) return null;
        const limits = this.limits();
        const refuse = async (refused: ComputerControlRefusal) => ({
            refused,
            state: await this.view(
                session.id,
                actor.userId,
                (await this.locks.findLock(lock.id, lock.userId)) ?? lock,
                now,
            ),
        });

        if (lock.controlHolderSessionId !== session.id) return refuse('not-holder');
        if (
            lock.controlRequestSessionId !== requestId ||
            !isControlRequestPending(lock, now, limits)
        ) {
            return refuse('no-request');
        }
        if (decision === 'keep') {
            await this.locks.clearRequest(lock.id, requestId);
            return this.stateOutcome(session, actor.userId, now);
        }

        const requester = await this.sessions.findById(requestId);
        const requesterUserId = lock.controlRequestUserId;
        if (
            !requester ||
            requester.status === 'ended' ||
            requester.nodeId !== lock.id ||
            !requesterUserId
        ) {
            await this.locks.clearRequest(lock.id, requestId);
            return refuse('no-request');
        }
        const deadlines = controlGrantDeadlines(now, limits);
        const won = await this.locks.handOver(
            lock.id,
            session.id,
            { userId: requesterUserId, sessionId: requester.id, now, ...deadlines },
            new Date(now.getTime() - limits.requestTimeoutMs),
        );
        if (!won) return refuse('no-request');
        const current = (await this.locks.findLock(lock.id, lock.userId)) ?? lock;
        await this.afterRelease(lock, 'handed-over', actor.userId, now);
        await this.afterGrant(requester, actor.userId, current, now);
        return this.stateOutcome(session, actor.userId, now);
    }

    /** "Keep control" on the idle warning: push the idle deadline from `actor`'s holding view. */
    async keep(actor: ComputerControlActor): Promise<ComputerControlOutcome | null> {
        const session = await this.sessions.findForOwner(
            actor.sessionId,
            actor.userId,
            actor.agentId,
        );
        if (!session) return null;
        const now = this.clock();
        const lock = await this.settle(session, now);
        if (!lock) return null;
        if (lock.controlHolderSessionId !== session.id) {
            return {
                refused: 'not-holder',
                state: await this.view(session.id, actor.userId, lock, now),
            };
        }
        const idleAt = controlIdleDeadline(lock, now, this.limits());
        if (!(await this.locks.recordActivity(lock.id, session.id, now, idleAt))) {
            return {
                refused: 'not-holder',
                state: await this.view(session.id, actor.userId, lock, now),
            };
        }
        await this.sessions.recordInput(session.id, now);
        const current = (await this.locks.findLock(lock.id, lock.userId)) ?? lock;
        this.emitHeld(session, actor.userId, current);
        return { state: await this.view(session.id, actor.userId, current, now) };
    }

    /** Extend the current stretch of control, once. */
    async extend(actor: ComputerControlActor): Promise<ComputerControlOutcome | null> {
        const session = await this.sessions.findForOwner(
            actor.sessionId,
            actor.userId,
            actor.agentId,
        );
        if (!session) return null;
        const now = this.clock();
        const lock = await this.settle(session, now);
        if (!lock) return null;
        if (lock.controlHolderSessionId !== session.id) {
            return {
                refused: 'not-holder',
                state: await this.view(session.id, actor.userId, lock, now),
            };
        }
        if (lock.controlExtendedAt) {
            return {
                refused: 'already-extended',
                state: await this.view(session.id, actor.userId, lock, now),
            };
        }
        const expiresAt = extendedControlExpiry(lock, now, this.limits());
        const won = await this.locks.extend(lock.id, session.id, now, expiresAt);
        const current = (await this.locks.findLock(lock.id, lock.userId)) ?? lock;
        if (!won) {
            return {
                refused:
                    current.controlHolderSessionId === session.id
                        ? 'already-extended'
                        : 'not-holder',
                state: await this.view(session.id, actor.userId, current, now),
            };
        }
        this.emitHeld(session, actor.userId, current);
        return { state: await this.view(session.id, actor.userId, current, now) };
    }

    // ── Gateway (live socket) ─────────────────────────────────────────────

    /** Does this view hold control right now, and until when? Settles an expired lock on the way. */
    async holdOf(sessionId: string): Promise<ComputerControlHold> {
        const session = await this.sessions.findById(sessionId);
        if (!session) return { held: false, untilMs: null };
        const lock = await this.settle(session, this.clock());
        return holdFor(lock, sessionId);
    }

    /** Input arrived from the holding view's socket: push the idle deadline. */
    async recordInput(sessionId: string): Promise<ComputerControlHold> {
        const session = await this.sessions.findById(sessionId);
        if (!session) return { held: false, untilMs: null };
        const now = this.clock();
        const lock = await this.settle(session, now);
        if (!lock || lock.controlHolderSessionId !== sessionId)
            return { held: false, untilMs: null };
        const idleAt = controlIdleDeadline(lock, now, this.limits());
        if (!(await this.locks.recordActivity(lock.id, sessionId, now, idleAt))) {
            return holdFor(await this.settle(session, now), sessionId);
        }
        await this.sessions.recordInput(sessionId, now);
        return holdFor({ ...lock, controlIdleAt: idleAt, controlAckAt: now }, sessionId);
    }

    /** The holding view's socket answered a heartbeat. Moves no deadline. */
    async acknowledge(sessionId: string): Promise<void> {
        const session = await this.sessions.findById(sessionId);
        if (!session) return;
        const lock = await this.locks.findLock(session.nodeId, session.userId);
        const now = this.clock();
        if (lock?.controlHolderSessionId === sessionId && ackIsDue(lock, now)) {
            await this.locks.acknowledge(lock.id, sessionId, now);
        }
    }

    /**
     * The platform takes control away from a view: its socket went away
     * (`disconnected`), the view ended (`session-ended`) or its person lost
     * access (`revoked`). Also withdraws a request that view had pending.
     * True when a hold was released.
     */
    async releaseForSession(
        sessionId: string,
        reason: Extract<ComputerControlReleaseReason, 'disconnected' | 'session-ended' | 'revoked'>,
    ): Promise<boolean> {
        const session = await this.sessions.findById(sessionId);
        if (!session) return false;
        const lock = await this.locks.findLock(session.nodeId, session.userId);
        if (!lock) return false;
        if (lock.controlRequestSessionId === sessionId) {
            await this.locks.clearRequest(lock.id, sessionId);
        }
        if (lock.controlHolderSessionId !== sessionId) return false;
        return this.releaseLock(lock, { kind: 'holder' }, reason, null, this.clock());
    }

    // ── Internals ─────────────────────────────────────────────────────────

    /**
     * Read the machine's lock and settle whatever has already expired: a hold
     * past its ceiling, idle deadline or acknowledgement floor, a hold whose
     * view has ended, and a request that declined on its own or whose view
     * has ended. Returns the lock as it stands afterwards.
     */
    private async settle(
        session: ComputerSession,
        now: Date,
    ): Promise<ComputerControlLockRow | null> {
        let lock = await this.locks.findLock(session.nodeId, session.userId);
        if (!lock) return null;
        const limits = this.limits();
        let changed = false;

        const holder = lock.controlHolderSessionId;
        if (holder) {
            const expiry = resolveControlLockExpiry(lock, now, limits);
            if (expiry) {
                changed =
                    (await this.releaseLock(
                        lock,
                        expiryCondition(expiry, now, limits),
                        expiry,
                        null,
                        now,
                    )) || changed;
            } else {
                const holding =
                    holder === session.id ? session : await this.sessions.findById(holder);
                if (!holding || holding.status === 'ended') {
                    changed =
                        (await this.releaseLock(
                            lock,
                            { kind: 'holder' },
                            'session-ended',
                            null,
                            now,
                        )) || changed;
                }
            }
        }
        if (changed) lock = (await this.locks.findLock(session.nodeId, session.userId)) ?? lock;

        const requester = lock.controlRequestSessionId;
        if (requester) {
            let stale = !lock.controlHolderSessionId || !isControlRequestPending(lock, now, limits);
            if (!stale) {
                const asking =
                    requester === session.id ? session : await this.sessions.findById(requester);
                stale = !asking || asking.status === 'ended';
            }
            if (stale && (await this.locks.clearRequest(lock.id, requester))) {
                lock = (await this.locks.findLock(session.nodeId, session.userId)) ?? lock;
            }
        }
        return lock;
    }

    /** Release a hold under `condition`; on a win, close its span, audit it and publish it. */
    private async releaseLock(
        lock: ComputerControlLockRow,
        condition: ComputerControlReleaseCondition,
        reason: ComputerControlReleaseReason,
        actorUserId: string | null,
        now: Date,
    ): Promise<boolean> {
        const holder = lock.controlHolderSessionId;
        if (!holder) return false;
        if (!(await this.locks.release(lock.id, holder, condition))) return false;
        await this.afterRelease(lock, reason, actorUserId, now);
        return true;
    }

    private async afterRelease(
        lock: ComputerControlLockRow,
        reason: ComputerControlReleaseReason,
        actorUserId: string | null,
        now: Date,
    ): Promise<void> {
        const sessionId = lock.controlHolderSessionId as string;
        const since = lock.controlHeldSince ? new Date(lock.controlHeldSince).getTime() : NaN;
        const heldMs = Number.isFinite(since) ? Math.max(0, now.getTime() - since) : 0;
        const session = await this.sessions.findById(sessionId);
        if (session) {
            await this.writeSpans(session, closeSpan(session.controlSpans, now, reason));
        }
        await this.audit?.tryRecord({
            action: 'computer.control-release',
            actorUserId,
            ownerUserId: lock.userId,
            nodeId: lock.id,
            details: computerAuditDetails('computer.control-release', {
                sessionId,
                releaseReason: reason,
                heldMs,
            }),
        });
        this.emit({
            nodeId: lock.id,
            sessionId,
            ownerUserId: lock.userId,
            agentId: session?.agentId ?? '',
            actorUserId,
            held: false,
            untilMs: null,
            reason,
            heldMs,
        });
    }

    private async afterGrant(
        session: ComputerSession,
        actorUserId: string,
        lock: ComputerControlLockRow,
        now: Date,
    ): Promise<void> {
        const holderUserId = lock.controlHolderUserId ?? actorUserId;
        await this.writeSpans(session, openSpan(session.controlSpans, holderUserId, now));
        await this.audit?.tryRecord({
            action: 'computer.control-grant',
            actorUserId,
            ownerUserId: lock.userId,
            nodeId: lock.id,
            details: computerAuditDetails('computer.control-grant', {
                sessionId: session.id,
                agentId: session.agentId,
            }),
        });
        this.emitHeld(session, actorUserId, lock);
    }

    private emitHeld(
        session: ComputerSession,
        actorUserId: string,
        lock: ComputerControlLockRow,
    ): void {
        this.emit({
            nodeId: lock.id,
            sessionId: session.id,
            ownerUserId: lock.userId,
            agentId: session.agentId,
            actorUserId,
            held: true,
            untilMs: holdFor(lock, session.id).untilMs,
            reason: null,
            heldMs: null,
        });
    }

    private async recordRefusal(
        session: ComputerSession,
        actorUserId: string,
        lock: ComputerControlLockRow,
    ): Promise<void> {
        await this.audit?.tryRecord({
            action: 'computer.control-refused',
            actorUserId,
            ownerUserId: lock.userId,
            nodeId: lock.id,
            details: computerAuditDetails('computer.control-refused', {
                sessionId: session.id,
                policy: lock.controlPolicy ?? 'owner',
                holderPresent: Boolean(lock.controlHolderSessionId),
            }),
        });
    }

    private async writeSpans(
        session: ComputerSession,
        spans: ComputerControlSpan[] | null,
    ): Promise<void> {
        if (!spans) return;
        try {
            await this.sessions.setControlSpans(session.id, spans);
            session.controlSpans = spans;
        } catch (error) {
            // The lock and the audit row are the record; a span is the receipt's convenience.
            this.logger.warn(
                `computer session ${session.id}: control span not written: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }

    private async stateOutcome(
        session: ComputerSession,
        userId: string,
        now: Date,
    ): Promise<ComputerControlOutcome> {
        const lock = await this.locks.findLock(session.nodeId, session.userId);
        return { state: await this.view(session.id, userId, lock, now) };
    }

    private async view(
        sessionId: string,
        userId: string,
        lock: ComputerControlLockRow | null,
        now: Date,
    ): Promise<ComputerControlStateView> {
        const limits = this.limits();
        const session = await this.sessions.findById(sessionId);
        const policy = lock?.controlPolicy ?? 'owner';
        const holder = lock?.controlHolderSessionId && lock.controlHolderUserId ? lock : null;
        const pending = lock && isControlRequestPending(lock, now, limits) ? lock : null;
        const last = lastClosedSpan(session?.controlSpans);
        return {
            nodeId: lock?.id ?? session?.nodeId ?? '',
            sessionId,
            policy,
            canControl: lock ? canControl(policy, viewerRoleForNode(lock, { userId })) : false,
            mode: holder?.controlHolderSessionId === sessionId ? 'controlling' : 'watching',
            holder: holder
                ? {
                      userId: holder.controlHolderUserId as string,
                      sessionId: holder.controlHolderSessionId as string,
                      since: iso(holder.controlHeldSince),
                      expiresAt: iso(holder.controlExpiresAt),
                      idleAt: iso(holder.controlIdleAt),
                      extended: Boolean(holder.controlExtendedAt),
                      you: holder.controlHolderUserId === userId,
                      thisView: holder.controlHolderSessionId === sessionId,
                  }
                : null,
            request:
                pending?.controlRequestSessionId && pending.controlRequestUserId
                    ? {
                          requestId: pending.controlRequestSessionId,
                          userId: pending.controlRequestUserId,
                          sessionId: pending.controlRequestSessionId,
                          requestedAt: iso(pending.controlRequestedAt),
                          expiresAt: iso(controlRequestExpiresAt(pending, limits)),
                          you: pending.controlRequestSessionId === sessionId,
                      }
                    : null,
            lastRelease: last?.reason ? { reason: last.reason, at: last.endedAt } : null,
            serverTime: now.toISOString(),
        };
    }

    private emit(change: ComputerControlChange): void {
        try {
            this.events?.emit(
                ComputerControlChangedEvent.EVENT_NAME,
                new ComputerControlChangedEvent(change),
            );
        } catch (error) {
            this.logger.warn(
                `computer session ${change.sessionId}: control event failed: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }
}

function iso(value?: Date | string | null): string | null {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function ackIsDue(lock: ComputerControlLockRow, now: Date): boolean {
    const ack = lock.controlAckAt ? new Date(lock.controlAckAt).getTime() : NaN;
    return !Number.isFinite(ack) || now.getTime() - ack >= ACK_WRITE_INTERVAL_MS;
}

/** The hold of `sessionId` on `lock`: held, and the earlier of its ceiling and idle deadline. */
export function holdFor(
    lock: ComputerControlLockRow | null,
    sessionId: string,
): ComputerControlHold {
    if (!lock || lock.controlHolderSessionId !== sessionId) return { held: false, untilMs: null };
    const deadlines = [lock.controlExpiresAt, lock.controlIdleAt]
        .map((value) => (value ? new Date(value).getTime() : NaN))
        .filter((value) => Number.isFinite(value));
    return { held: true, untilMs: deadlines.length > 0 ? Math.min(...deadlines) : null };
}

function expiryCondition(
    expiry: 'ceiling' | 'idle' | 'disconnected',
    now: Date,
    limits: Pick<ComputerControlLimits, 'ackFloorMs'>,
): ComputerControlReleaseCondition {
    if (expiry === 'ceiling') return { kind: 'ceiling', now };
    if (expiry === 'idle') return { kind: 'idle', now };
    return { kind: 'unacknowledged', before: new Date(now.getTime() - limits.ackFloorMs) };
}

/** Append an open span, keeping the newest {@link COMPUTER_MAX_CONTROL_SPANS}. */
export function openSpan(
    spans: ComputerControlSpan[] | null | undefined,
    userId: string,
    now: Date,
): ComputerControlSpan[] {
    const next = [...(Array.isArray(spans) ? spans : [])];
    next.push({ userId, startedAt: now.toISOString(), endedAt: null, reason: null });
    return next.slice(-COMPUTER_MAX_CONTROL_SPANS);
}

/** Close the newest open span, or null when there is none to close. */
export function closeSpan(
    spans: ComputerControlSpan[] | null | undefined,
    now: Date,
    reason: ComputerControlReleaseReason,
): ComputerControlSpan[] | null {
    const next = [...(Array.isArray(spans) ? spans : [])];
    for (let index = next.length - 1; index >= 0; index -= 1) {
        if (next[index].endedAt === null) {
            next[index] = { ...next[index], endedAt: now.toISOString(), reason };
            return next;
        }
    }
    return null;
}

function lastClosedSpan(
    spans: ComputerControlSpan[] | null | undefined,
): ComputerControlSpan | null {
    if (!Array.isArray(spans) || spans.length === 0) return null;
    const last = spans[spans.length - 1];
    return last.endedAt ? last : null;
}
