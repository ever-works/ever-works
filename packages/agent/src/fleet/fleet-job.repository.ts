import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, LessThan, Not, Repository } from 'typeorm';
import type { FleetJobKind, FleetJobStatus } from '@ever-works/contracts';
import { FLEET_JOB_ACTIVE_STATUSES } from '@ever-works/contracts';
import { FleetJob } from '../entities/fleet-job.entity';

export interface CreateFleetJobData {
    userId: string;
    organizationId?: string | null;
    targetNodeId?: string | null;
    kind: FleetJobKind;
    payload?: Record<string, unknown> | null;
    requiredCapabilities?: string[];
    maxAttempts?: number;
    idempotencyKey?: string | null;
    /**
     * Why this job is queued without a runner able to take it (today
     * only `waiting-for-runner`). NULL means "queued normally".
     */
    queuedReason?: string | null;
}

/** Columns the lease CAS is allowed to stamp alongside the claim flip. */
export interface ClaimJobPatch {
    nodeId: string;
    status: FleetJobStatus;
    leaseExpiresAt: Date;
    attempts: number;
    /**
     * Always written as null by the claim: a job that has just been
     * claimed is by definition no longer waiting for a runner, and the
     * CAS is the exact moment that stops being true. Clearing it HERE
     * rather than in a second writer is what keeps the token from going
     * stale.
     */
    queuedReason: null;
}

/** Exact claim snapshot observed by an expiry scan. */
export interface ObservedFleetJobLease {
    status: FleetJobStatus;
    nodeId: string;
    leaseExpiresAt: Date;
}

/**
 * Feature-owned repository (provided by `FleetModule`, not
 * `DatabaseModule` — same split as `FleetNodeRepository`).
 *
 * Every state transition a NODE can trigger goes through a conditional
 * UPDATE whose WHERE clause restates the precondition, so correctness
 * does not depend on read-then-write ordering. Two nodes racing the
 * same row produce exactly one `affected: 1`.
 */
@Injectable()
export class FleetJobRepository {
    constructor(
        @InjectRepository(FleetJob)
        private readonly repository: Repository<FleetJob>,
    ) {}

    async create(data: CreateFleetJobData): Promise<FleetJob> {
        return this.repository.save(
            this.repository.create({
                ...data,
                status: 'queued' as FleetJobStatus,
                requiredCapabilities: data.requiredCapabilities ?? [],
                attempts: 0,
                maxAttempts: data.maxAttempts ?? 3,
            }),
        );
    }

    async findById(id: string): Promise<FleetJob | null> {
        return this.repository.findOne({ where: { id } });
    }

    async findByIdempotencyKey(key: string): Promise<FleetJob | null> {
        return this.repository.findOne({ where: { idempotencyKey: key } });
    }

    /**
     * Lease candidates for one owner: queued, oldest first. Capability
     * filtering happens in the service (the tag set is a JSON column, so
     * an over-fetch + in-memory filter beats a driver-specific JSON
     * predicate that would not work on both Postgres and sqlite).
     */
    async findQueuedForUser(userId: string, limit: number): Promise<FleetJob[]> {
        return this.repository.find({
            where: { userId, status: 'queued' },
            order: { createdAt: 'ASC' },
            take: limit,
        });
    }

    /**
     * Owner-scoped lease scan that excludes work explicitly targeted at
     * another node before applying the result limit. Without this predicate,
     * another PC's targeted backlog could fill the over-fetch window and hide
     * later unbound work from an otherwise idle node.
     */
    async findQueuedForNode(userId: string, nodeId: string, limit: number): Promise<FleetJob[]> {
        return this.repository.find({
            where: [
                { userId, status: 'queued', targetNodeId: IsNull() },
                { userId, status: 'queued', targetNodeId: nodeId },
            ],
            order: { createdAt: 'ASC' },
            take: limit,
        });
    }

    /**
     * CAS-claim one queued job for a node. The row must STILL be
     * `queued` — a raced second lease matches zero rows and returns
     * false, so exactly one node ever wins a given job.
     *
     * `cancelRequestedAt IS NULL` is part of the same predicate, not a
     * separate read. A cancelled job must never be leased, and the status
     * column alone cannot express that: `reclaim()` returns a lapsed claim
     * to `queued` without clearing the flag, so a flagged row can legally
     * BE `queued`. `FleetJobService.reclaimExpired` now settles those
     * instead of requeuing them, but this is the invariant itself rather
     * than one caller remembering it — any future path that queues a
     * flagged row is refused here.
     */
    async claim(id: string, patch: ClaimJobPatch): Promise<boolean> {
        const result = await this.repository.update(
            { id, status: 'queued', cancelRequestedAt: IsNull() },
            patch,
        );
        return (result.affected ?? 0) === 1;
    }

    /**
     * Extend the lease of a job this node still holds. The WHERE clause
     * pins both the node id and the active statuses, so a node cannot
     * extend someone else's claim or resurrect a terminal job.
     */
    async extendLease(
        id: string,
        nodeId: string,
        leaseExpiresAt: Date,
        startedAt?: Date,
    ): Promise<boolean> {
        const patch: Partial<FleetJob> = { leaseExpiresAt, status: 'running' };
        if (startedAt) {
            patch.startedAt = startedAt;
        }
        const result = await this.repository.update(
            { id, nodeId, status: In([...FLEET_JOB_ACTIVE_STATUSES]) },
            patch,
        );
        return (result.affected ?? 0) === 1;
    }

    /**
     * Terminal transition for a job this node still holds. Same pinned
     * WHERE clause as `extendLease` — completing a job twice, or
     * completing another node's job, matches zero rows.
     */
    async complete(
        id: string,
        nodeId: string,
        patch: {
            status: Extract<FleetJobStatus, 'done' | 'failed'>;
            result?: Record<string, unknown> | null;
            error?: string | null;
            completedAt: Date;
        },
    ): Promise<boolean> {
        const updated = await this.repository.update(
            { id, nodeId, status: In([...FLEET_JOB_ACTIVE_STATUSES]) },
            { ...patch, leaseExpiresAt: null },
        );
        return (updated.affected ?? 0) === 1;
    }

    /**
     * Jobs whose claim has lapsed. Scoped to a single owner when
     * `userId` is supplied (the inline reclaim on the lease path) and
     * global when it is not (the cron sweep).
     */
    /**
     * Agent execution v2 (slice B) — fail a job NO node has claimed yet.
     * Pinned to `queued`, so a claim that lands first wins and the caller
     * falls through to the active-cancel path.
     */
    async cancelQueued(id: string, error: string, completedAt: Date): Promise<boolean> {
        const updated = await this.repository.update(
            { id, status: 'queued' },
            {
                status: 'failed',
                error,
                completedAt,
                cancelRequestedAt: completedAt,
                leaseExpiresAt: null,
                queuedReason: null,
            },
        );
        return (updated.affected ?? 0) === 1;
    }

    /**
     * Agent execution v2 (slice B) — flag an ACTIVE job for cancellation.
     * The node holding it is never contacted directly (outbound-only
     * transport); `FleetJobService.heartbeatJob` refuses its next beat
     * instead. Pinned to the active statuses and to rows not yet flagged,
     * so a repeated request is a no-op rather than a fresh timestamp.
     */
    async requestCancel(id: string, at: Date): Promise<boolean> {
        const updated = await this.repository.update(
            { id, status: In([...FLEET_JOB_ACTIVE_STATUSES]), cancelRequestedAt: IsNull() },
            { cancelRequestedAt: at },
        );
        return (updated.affected ?? 0) === 1;
    }

    async findExpiredLeases(cutoff: Date, limit: number, userId?: string): Promise<FleetJob[]> {
        return this.repository.find({
            where: {
                ...(userId ? { userId } : {}),
                status: In([...FLEET_JOB_ACTIVE_STATUSES]),
                leaseExpiresAt: LessThan(cutoff),
            },
            order: { leaseExpiresAt: 'ASC' },
            take: limit,
        });
    }

    /**
     * Return one lapsed claim to the pool. Pins the previous status so a
     * job that completed between the scan and the write is never
     * resurrected.
     */
    async reclaim(id: string, observed: ObservedFleetJobLease): Promise<boolean> {
        const result = await this.repository.update(
            {
                id,
                status: observed.status,
                nodeId: observed.nodeId,
                leaseExpiresAt: observed.leaseExpiresAt,
            },
            // Reclaim returns the row to the pool as an ORDINARY queued
            // job: the reason it originally waited (no free runner) is
            // not necessarily why it is waiting now, and carrying a
            // stale token forward would misreport a lapsed lease as a
            // capacity problem.
            { status: 'queued', nodeId: null, leaseExpiresAt: null, queuedReason: null },
        );
        return (result.affected ?? 0) === 1;
    }

    /** Fail a lapsed claim that has exhausted its attempt budget. */
    async failExhausted(
        id: string,
        observed: ObservedFleetJobLease,
        error: string,
        completedAt: Date,
    ): Promise<boolean> {
        const result = await this.repository.update(
            {
                id,
                status: observed.status,
                nodeId: observed.nodeId,
                leaseExpiresAt: observed.leaseExpiresAt,
            },
            { status: 'failed', leaseExpiresAt: null, error, completedAt },
        );
        return (result.affected ?? 0) === 1;
    }

    /** Every live claim held by any of this owner's nodes (Fleet UI load). */
    async findActiveForUser(userId: string): Promise<FleetJob[]> {
        return this.repository.find({
            where: {
                userId,
                status: In([...FLEET_JOB_ACTIVE_STATUSES]),
                nodeId: Not(IsNull()),
            },
            order: { createdAt: 'ASC' },
        });
    }

    /** Owner-scoped job listing, newest first. */
    async findByUser(userId: string, limit: number): Promise<FleetJob[]> {
        return this.repository.find({
            where: { userId },
            order: { createdAt: 'DESC' },
            take: limit,
        });
    }

    /**
     * One node's job history, newest first — what the node-detail drawer
     * renders (including the failures an operator is usually there for).
     *
     * `userId` is in the WHERE clause and not merely assumed from the
     * caller: this is the only read keyed by a node id, and a node id is
     * exactly the kind of value that travels. Owner-scoping it here
     * means a mistake at the edge cannot turn into a cross-owner read.
     */
    async findByNodeForUser(userId: string, nodeId: string, limit: number): Promise<FleetJob[]> {
        return this.repository.find({
            where: { userId, nodeId },
            order: { createdAt: 'DESC' },
            take: limit,
        });
    }

    /**
     * Return every live claim held by one node to the pool — the write
     * half of DRAINING a node.
     *
     * Draining without this leaves the node's in-flight work stranded
     * until each lease lapses: the machine is already refusing to
     * heartbeat, so nothing will ever complete those jobs, and the fleet
     * sits idle for up to a full lease TTL per job. Requeuing them makes
     * the drain immediate. `attempts` is deliberately NOT incremented —
     * the operator withdrew the node, the job did not fail.
     */
    async releaseClaimsForNode(userId: string, nodeId: string): Promise<number> {
        const result = await this.repository.update(
            { userId, nodeId, status: In([...FLEET_JOB_ACTIVE_STATUSES]) },
            { status: 'queued', nodeId: null, leaseExpiresAt: null },
        );
        return result.affected ?? 0;
    }
}
