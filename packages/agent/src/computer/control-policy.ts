import {
    COMPUTER_CONTROL_CEILING_MS_DEFAULT,
    COMPUTER_CONTROL_DISCONNECT_MS,
    COMPUTER_CONTROL_IDLE_MS_DEFAULT,
    COMPUTER_CONTROL_REQUEST_TIMEOUT_MS,
    type ComputerControlPolicy,
    type ComputerControlReleaseReason,
    type ComputerViewerRole,
} from '@ever-works/contracts';
import { clampComputerLimit } from './computer-session.policy';

/**
 * Agent computers, take-over — the control rules, as pure functions.
 *
 * Who may take control of a machine, how long a stretch of control lasts,
 * and when a held lock has freed itself are the decisions a race can make
 * subtly wrong, so each one lives here with no NestJS or TypeORM import and
 * the arbiter only moves rows according to them.
 */

/**
 * May a person in `role` take control of a machine whose policy is `policy`?
 *
 *                 owner   org-admin   org-member   stranger
 *   owner          yes       no           no          no
 *   org-admins     yes       yes          no          no
 *   org-members    yes       yes          yes         no
 *
 * The machine's owner may always take control of their own machine; a
 * policy only ever widens who else may, never narrows the owner out.
 */
export function canControl(policy: ComputerControlPolicy, role: ComputerViewerRole): boolean {
    if (role === 'owner') return true;
    if (role === 'org-admin') return policy === 'org-admins' || policy === 'org-members';
    if (role === 'org-member') return policy === 'org-members';
    return false;
}

/**
 * The role of a person relative to a machine. Live views are opened on the
 * owner's own machines only, so today this is `owner` or `stranger`; the
 * Organization roles are resolved here once views are shared.
 */
export function viewerRoleForNode(
    node: { userId: string },
    viewer: { userId: string },
): ComputerViewerRole {
    return node.userId === viewer.userId ? 'owner' : 'stranger';
}

export interface ComputerControlLimits {
    /** No input for this long gives control back. Default 10 min, clamp 1–60 min. */
    idleMs: number;
    /** Longest stretch of control. Default 60 min, clamp 5–240 min; extendable once by the same. */
    ceilingMs: number;
    /** The gateway gives control back this long after the controlling socket is gone. */
    disconnectMs: number;
    /** A request declines on its own after this. */
    requestTimeoutMs: number;
    /**
     * The database floor under the disconnect release: a lock nobody has
     * acknowledged for this long is free even if no gateway noticed (a
     * replica that went away). Two socket heartbeats plus the disconnect
     * grace, so a live browser in a background tab never trips it.
     */
    ackFloorMs: number;
}

export const COMPUTER_CONTROL_ACK_FLOOR_MS = COMPUTER_CONTROL_DISCONNECT_MS + 60_000;

/**
 * Operator-tunable control limits, clamped.
 *
 *   `COMPUTER_CONTROL_IDLE_MINUTES`   1–60
 *   `COMPUTER_CONTROL_MAX_MINUTES`    5–240
 */
export function resolveComputerControlLimits(
    env: Readonly<Record<string, string | undefined>>,
): ComputerControlLimits {
    return {
        idleMs:
            clampComputerLimit(
                env.COMPUTER_CONTROL_IDLE_MINUTES,
                COMPUTER_CONTROL_IDLE_MS_DEFAULT / 60_000,
                1,
                60,
            ) * 60_000,
        ceilingMs:
            clampComputerLimit(
                env.COMPUTER_CONTROL_MAX_MINUTES,
                COMPUTER_CONTROL_CEILING_MS_DEFAULT / 60_000,
                5,
                240,
            ) * 60_000,
        disconnectMs: COMPUTER_CONTROL_DISCONNECT_MS,
        requestTimeoutMs: COMPUTER_CONTROL_REQUEST_TIMEOUT_MS,
        ackFloorMs: COMPUTER_CONTROL_ACK_FLOOR_MS,
    };
}

/** The lock columns of a machine row the rules read. */
export interface ComputerControlLock {
    controlHolderUserId?: string | null;
    controlHolderSessionId?: string | null;
    controlHeldSince?: Date | string | null;
    controlExpiresAt?: Date | string | null;
    controlIdleAt?: Date | string | null;
    controlAckAt?: Date | string | null;
    controlExtendedAt?: Date | string | null;
    controlRequestUserId?: string | null;
    controlRequestSessionId?: string | null;
    controlRequestedAt?: Date | string | null;
}

function ms(value: Date | string | null | undefined): number {
    if (!value) return NaN;
    return new Date(value).getTime();
}

/** Is `at` at or before `now`? Unknown instants never count as passed. */
function passed(at: number, now: number): boolean {
    return Number.isFinite(at) && at <= now;
}

/**
 * Has a held lock freed itself, and why? Checked in a fixed order so the
 * reason recorded is the one that bit first in the owner's terms: the
 * ceiling on the stretch, then inactivity, then a browser that went away.
 * Null when nobody holds the lock or it is still in force.
 */
export function resolveControlLockExpiry(
    lock: ComputerControlLock,
    now: Date,
    limits: Pick<ComputerControlLimits, 'ackFloorMs'>,
): Extract<ComputerControlReleaseReason, 'ceiling' | 'idle' | 'disconnected'> | null {
    if (!lock.controlHolderSessionId) return null;
    const at = now.getTime();
    if (passed(ms(lock.controlExpiresAt), at)) return 'ceiling';
    if (passed(ms(lock.controlIdleAt), at)) return 'idle';
    const ack = ms(lock.controlAckAt);
    if (Number.isFinite(ack) && at - ack >= limits.ackFloorMs) return 'disconnected';
    return null;
}

/** Is there a request for control still waiting for an answer at `now`? */
export function isControlRequestPending(
    lock: ComputerControlLock,
    now: Date,
    limits: Pick<ComputerControlLimits, 'requestTimeoutMs'>,
): boolean {
    if (!lock.controlRequestSessionId) return false;
    const requested = ms(lock.controlRequestedAt);
    return Number.isFinite(requested) && now.getTime() - requested < limits.requestTimeoutMs;
}

/** When a pending request declines on its own. */
export function controlRequestExpiresAt(
    lock: ComputerControlLock,
    limits: Pick<ComputerControlLimits, 'requestTimeoutMs'>,
): Date | null {
    const requested = ms(lock.controlRequestedAt);
    return Number.isFinite(requested) ? new Date(requested + limits.requestTimeoutMs) : null;
}

/** The deadlines of a fresh grant at `now`. */
export function controlGrantDeadlines(
    now: Date,
    limits: Pick<ComputerControlLimits, 'idleMs' | 'ceilingMs'>,
): { expiresAt: Date; idleAt: Date } {
    return {
        expiresAt: new Date(now.getTime() + limits.ceilingMs),
        idleAt: new Date(now.getTime() + limits.idleMs),
    };
}

/**
 * The idle deadline after input at `now` — never past the ceiling, so a
 * stretch cannot be kept alive beyond its own end by moving the mouse.
 */
export function controlIdleDeadline(
    lock: ComputerControlLock,
    now: Date,
    limits: Pick<ComputerControlLimits, 'idleMs'>,
): Date {
    const idle = now.getTime() + limits.idleMs;
    const ceiling = ms(lock.controlExpiresAt);
    return new Date(Number.isFinite(ceiling) ? Math.min(idle, ceiling) : idle);
}

/** The ceiling after the one allowed extension: one more full stretch on top of the current one. */
export function extendedControlExpiry(
    lock: ComputerControlLock,
    now: Date,
    limits: Pick<ComputerControlLimits, 'ceilingMs'>,
): Date {
    const current = ms(lock.controlExpiresAt);
    const base = Number.isFinite(current) ? Math.max(current, now.getTime()) : now.getTime();
    return new Date(base + limits.ceilingMs);
}
