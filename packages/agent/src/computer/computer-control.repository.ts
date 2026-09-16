import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, LessThanOrEqual, MoreThan, Repository } from 'typeorm';
import { FleetNode } from '../entities/fleet-node.entity';

/** The lock columns, and nothing else a control act needs from a machine row. */
export type ComputerControlLockRow = Pick<
    FleetNode,
    | 'id'
    | 'userId'
    | 'controlPolicy'
    | 'controlHolderUserId'
    | 'controlHolderSessionId'
    | 'controlHeldSince'
    | 'controlExpiresAt'
    | 'controlIdleAt'
    | 'controlAckAt'
    | 'controlExtendedAt'
    | 'controlRequestUserId'
    | 'controlRequestSessionId'
    | 'controlRequestedAt'
>;

/** Why a held lock is being released, as the conditional that must still hold when it is. */
export type ComputerControlReleaseCondition =
    | { kind: 'holder' }
    | { kind: 'ceiling'; now: Date }
    | { kind: 'idle'; now: Date }
    | { kind: 'unacknowledged'; before: Date };

export interface ComputerControlGrant {
    userId: string;
    sessionId: string;
    now: Date;
    expiresAt: Date;
    idleAt: Date;
}

const CLEARED_REQUEST = {
    controlRequestUserId: null,
    controlRequestSessionId: null,
    controlRequestedAt: null,
} as const;

const CLEARED_LOCK = {
    controlHolderUserId: null,
    controlHolderSessionId: null,
    controlHeldSince: null,
    controlExpiresAt: null,
    controlIdleAt: null,
    controlAckAt: null,
    controlExtendedAt: null,
    ...CLEARED_REQUEST,
} as const;

/**
 * Data access for the machine control lock on `fleet_nodes`.
 *
 * Every write is ONE conditional UPDATE that restates its precondition and
 * reports whether it won (`affected === 1`) — never read, decide, write. So
 * on every driver, with any number of API replicas:
 *
 *  - two takes of a free machine produce exactly one holder;
 *  - a release is scoped by the HOLDING VIEW (and, for an automatic release,
 *    by the deadline that expired), so a stale releaser — or a timer that
 *    fired late — can never evict the view that holds the lock now;
 *  - a hand-over moves the lock to the requester only while that exact
 *    request is still pending, in the same statement that clears it.
 *
 * Several conditions are separate UPDATEs rather than one `OR`, the same
 * choice `FleetNodeRepository.casTripDailyCeiling` documents: each is an
 * atomic compare-and-set on both engines without a driver-specific predicate.
 */
@Injectable()
export class ComputerControlRepository {
    constructor(
        @InjectRepository(FleetNode)
        private readonly repository: Repository<FleetNode>,
    ) {}

    /** The lock of one machine the owner has, or null (a foreign machine reads like an unknown one). */
    async findLock(nodeId: string, ownerUserId: string): Promise<ComputerControlLockRow | null> {
        return this.repository.findOne({
            where: { id: nodeId, userId: ownerUserId },
            select: {
                id: true,
                userId: true,
                controlPolicy: true,
                controlHolderUserId: true,
                controlHolderSessionId: true,
                controlHeldSince: true,
                controlExpiresAt: true,
                controlIdleAt: true,
                controlAckAt: true,
                controlExtendedAt: true,
                controlRequestUserId: true,
                controlRequestSessionId: true,
                controlRequestedAt: true,
            },
        });
    }

    /** Take a FREE lock. False when anyone holds it (an expired holder is released first). */
    async take(nodeId: string, ownerUserId: string, grant: ComputerControlGrant): Promise<boolean> {
        const result = await this.repository.update(
            { id: nodeId, userId: ownerUserId, controlHolderSessionId: IsNull() },
            {
                controlHolderUserId: grant.userId,
                controlHolderSessionId: grant.sessionId,
                controlHeldSince: grant.now,
                controlExpiresAt: grant.expiresAt,
                controlIdleAt: grant.idleAt,
                controlAckAt: grant.now,
                controlExtendedAt: null,
                ...CLEARED_REQUEST,
            },
        );
        return (result.affected ?? 0) === 1;
    }

    /** Release the lock `sessionId` holds, only while `condition` still holds. */
    async release(
        nodeId: string,
        sessionId: string,
        condition: ComputerControlReleaseCondition,
    ): Promise<boolean> {
        const where: Record<string, unknown> = { id: nodeId, controlHolderSessionId: sessionId };
        if (condition.kind === 'ceiling') where.controlExpiresAt = LessThanOrEqual(condition.now);
        if (condition.kind === 'idle') where.controlIdleAt = LessThanOrEqual(condition.now);
        if (condition.kind === 'unacknowledged') {
            where.controlAckAt = LessThanOrEqual(condition.before);
        }
        const result = await this.repository.update(where, { ...CLEARED_LOCK });
        return (result.affected ?? 0) === 1;
    }

    /**
     * Input (or "Keep control") from the holding view: push the idle deadline
     * and acknowledge. Only while the stretch is still within its ceiling and
     * its idle deadline — an input that arrives after either is too late.
     */
    async recordActivity(
        nodeId: string,
        sessionId: string,
        now: Date,
        idleAt: Date,
    ): Promise<boolean> {
        const result = await this.repository.update(
            {
                id: nodeId,
                controlHolderSessionId: sessionId,
                controlExpiresAt: MoreThan(now),
                controlIdleAt: MoreThan(now),
            },
            { controlIdleAt: idleAt, controlAckAt: now },
        );
        return (result.affected ?? 0) === 1;
    }

    /** The holding browser is still there (its socket answered). Moves no deadline. */
    async acknowledge(nodeId: string, sessionId: string, now: Date): Promise<boolean> {
        const result = await this.repository.update(
            { id: nodeId, controlHolderSessionId: sessionId, controlExpiresAt: MoreThan(now) },
            { controlAckAt: now },
        );
        return (result.affected ?? 0) === 1;
    }

    /** Extend the stretch `sessionId` holds, once. */
    async extend(nodeId: string, sessionId: string, now: Date, expiresAt: Date): Promise<boolean> {
        const result = await this.repository.update(
            {
                id: nodeId,
                controlHolderSessionId: sessionId,
                controlExtendedAt: IsNull(),
                controlExpiresAt: MoreThan(now),
            },
            { controlExpiresAt: expiresAt, controlExtendedAt: now },
        );
        return (result.affected ?? 0) === 1;
    }

    /**
     * Ask the view that holds the lock to hand it over. Wins when no request
     * is pending, or the pending one has already declined on its own
     * (`staleBefore`). Never while `requester` is itself the holder.
     */
    async request(
        nodeId: string,
        holderSessionId: string,
        requester: { userId: string; sessionId: string },
        now: Date,
        staleBefore: Date,
    ): Promise<boolean> {
        const patch = {
            controlRequestUserId: requester.userId,
            controlRequestSessionId: requester.sessionId,
            controlRequestedAt: now,
        };
        const fresh = await this.repository.update(
            {
                id: nodeId,
                controlHolderSessionId: holderSessionId,
                controlRequestSessionId: IsNull(),
            },
            patch,
        );
        if ((fresh.affected ?? 0) === 1) return true;
        const replaced = await this.repository.update(
            {
                id: nodeId,
                controlHolderSessionId: holderSessionId,
                controlRequestedAt: LessThanOrEqual(staleBefore),
            },
            patch,
        );
        return (replaced.affected ?? 0) === 1;
    }

    /** Clear the pending request of `requestSessionId` (declined, withdrawn or timed out). */
    async clearRequest(nodeId: string, requestSessionId: string): Promise<boolean> {
        const result = await this.repository.update(
            { id: nodeId, controlRequestSessionId: requestSessionId },
            { ...CLEARED_REQUEST },
        );
        return (result.affected ?? 0) === 1;
    }

    /**
     * Hand the lock from `holderSessionId` to the view whose request is
     * pending — one statement, only while the holder still holds it and that
     * request was made after `freshAfter`.
     */
    async handOver(
        nodeId: string,
        holderSessionId: string,
        grant: ComputerControlGrant,
        freshAfter: Date,
    ): Promise<boolean> {
        const result = await this.repository.update(
            {
                id: nodeId,
                controlHolderSessionId: holderSessionId,
                controlRequestSessionId: grant.sessionId,
                controlRequestUserId: grant.userId,
                controlRequestedAt: MoreThan(freshAfter),
            },
            {
                controlHolderUserId: grant.userId,
                controlHolderSessionId: grant.sessionId,
                controlHeldSince: grant.now,
                controlExpiresAt: grant.expiresAt,
                controlIdleAt: grant.idleAt,
                controlAckAt: grant.now,
                controlExtendedAt: null,
                ...CLEARED_REQUEST,
            },
        );
        return (result.affected ?? 0) === 1;
    }
}
