import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, LessThan, Not, Repository } from 'typeorm';
import type { FleetJobKind, FleetJobStatus } from '@ever-works/contracts';
import { FLEET_JOB_ACTIVE_STATUSES, QUEUED_REASON_WAITING_FOR_RUNNER } from '@ever-works/contracts';
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
    /**
     * The generation being MINTED by this claim — always the value the
     * service observed on the candidate plus one. `claim()` pins the
     * observed value (`leaseGeneration - 1`) in its WHERE clause, so a
     * read-then-claim that straddles another node's lease-and-lapse of
     * the same row matches zero rows instead of minting a duplicate.
     */
    leaseGeneration: number;
}

/** Exact claim snapshot observed by an expiry scan. */
export interface ObservedFleetJobLease {
    status: FleetJobStatus;
    nodeId: string;
    leaseExpiresAt: Date;
    /** Generation of the claim being reclaimed; a newer claim is never touched. */
    leaseGeneration: number;
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
                // The queue SLA clock starts here (see `queuedAt`).
                queuedAt: new Date(),
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
     *
     * `leaseGeneration` is pinned to the value this claim advances FROM
     * (suspend-safe leases): the service reads the candidate, computes
     * `previous + 1`, and this CAS refuses to mint that value unless the
     * row still carries `previous`. Without it, a candidate read before
     * another node leased and lost the same row would stamp a generation
     * the platform had already issued once.
     */
    async claim(id: string, patch: ClaimJobPatch): Promise<boolean> {
        const result = await this.repository.update(
            {
                id,
                status: 'queued',
                cancelRequestedAt: IsNull(),
                leaseGeneration: patch.leaseGeneration - 1,
            },
            patch,
        );
        return (result.affected ?? 0) === 1;
    }

    /**
     * Extend the lease of a job this node still holds UNDER THIS CLAIM.
     * The WHERE clause pins the node id, the active statuses AND the
     * lease generation: it identifies the claim, not merely the holder.
     * A node cannot extend someone else's claim, resurrect a terminal
     * job, or — the suspend case — renew a NEWER claim on the same job
     * from an older run that never learned it lost the first one.
     *
     * `leaseGeneration` is required, positioned last so every earlier
     * positional caller stays readable; there is no fail-open form.
     */
    async extendLease(
        id: string,
        nodeId: string,
        leaseExpiresAt: Date,
        startedAt: Date | undefined,
        leaseGeneration: number,
    ): Promise<boolean> {
        const patch: Partial<FleetJob> = { leaseExpiresAt, status: 'running' };
        if (startedAt) {
            patch.startedAt = startedAt;
        }
        const result = await this.repository.update(
            { id, nodeId, status: In([...FLEET_JOB_ACTIVE_STATUSES]), leaseGeneration },
            patch,
        );
        return (result.affected ?? 0) === 1;
    }

    /**
     * Terminal transition for a job this node still holds UNDER THIS
     * CLAIM. Same pinned WHERE clause as `extendLease` — completing a job
     * twice, completing another node's job, or completing a claim that
     * has since been re-issued (even to this node) matches zero rows, so
     * a stale holder can never write a status, result or error over the
     * current holder's.
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
        leaseGeneration: number,
    ): Promise<boolean> {
        const updated = await this.repository.update(
            { id, nodeId, status: In([...FLEET_JOB_ACTIVE_STATUSES]), leaseGeneration },
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
     * Queue SLA (self-build slice S) — `queued` rows of one `kind` that
     * entered the queue before `cutoff`. One query per kind because each
     * kind has its own max age; ordered oldest-first so the batch limit
     * never starves the rows that have waited longest. Owner-scoped on
     * the lease path, global on the cron — the same split as
     * {@link findExpiredLeases}.
     *
     * A row with `queuedAt IS NULL` (written before the column existed)
     * never matches: an unknown age is not an old age.
     */
    async findQueuedOlderThan(
        kind: FleetJobKind,
        cutoff: Date,
        limit: number,
        userId?: string,
    ): Promise<FleetJob[]> {
        return this.repository.find({
            where: {
                ...(userId ? { userId } : {}),
                kind,
                status: 'queued',
                queuedAt: LessThan(cutoff),
                cancelRequestedAt: IsNull(),
            },
            order: { queuedAt: 'ASC' },
            take: limit,
        });
    }

    /**
     * Queue SLA — fail a job NO node ever took. The WHERE clause pins the
     * row to `queued`, to "still older than the scan's cutoff" and to
     * "not cancelled", so a claim, a reclaim (which re-stamps `queuedAt`
     * to now, which is never older than the cutoff) or a cancel that
     * lands between the scan and this write wins and the caller sees
     * `false`. Exactly one writer ever settles the row, which is what
     * makes the completion event fire exactly once.
     *
     * Pinned with `LessThan(cutoff)` rather than equality on the
     * `queuedAt` the scan read back, on purpose: the migration backfills
     * `queuedAt` from `createdAt`, whose default is the DATABASE clock
     * (Postgres `now()` carries microseconds; sqlite `datetime('now')`
     * carries no fraction at all), and a JS `Date` cannot round-trip
     * either exactly — an equality pin would silently never match the
     * very rows the backfill exists to settle.
     */
    async failQueuedExpired(
        id: string,
        cutoff: Date,
        error: string,
        completedAt: Date,
    ): Promise<boolean> {
        const result = await this.repository.update(
            { id, status: 'queued', queuedAt: LessThan(cutoff), cancelRequestedAt: IsNull() },
            { status: 'failed', error, completedAt, leaseExpiresAt: null, queuedReason: null },
        );
        return (result.affected ?? 0) === 1;
    }

    /**
     * Heartbeat promotion (self-build slice S) — the owner's queued rows
     * still stamped `waiting-for-runner` that THIS node could lease:
     * unbound, or pinned to it. Capability filtering happens in the
     * service, for the same JSON-column reason as the lease scan.
     */
    async findWaitingForNode(userId: string, nodeId: string, limit: number): Promise<FleetJob[]> {
        return this.repository.find({
            where: [
                {
                    userId,
                    status: 'queued',
                    queuedReason: QUEUED_REASON_WAITING_FOR_RUNNER,
                    targetNodeId: IsNull(),
                },
                {
                    userId,
                    status: 'queued',
                    queuedReason: QUEUED_REASON_WAITING_FOR_RUNNER,
                    targetNodeId: nodeId,
                },
            ],
            order: { createdAt: 'ASC' },
            take: limit,
        });
    }

    /**
     * Clear `waiting-for-runner` on a row an eligible runner can now take.
     * Pinned to `queued` + the token, so a claim that already cleared it
     * (or a row that moved on) is a no-op rather than a stale write.
     * `queuedAt` is deliberately NOT touched: a promotion does not make
     * the job younger, and the SLA still bounds a node that is online but
     * never actually leases.
     */
    async promoteWaiting(id: string): Promise<boolean> {
        const result = await this.repository.update(
            { id, status: 'queued', queuedReason: QUEUED_REASON_WAITING_FOR_RUNNER },
            { queuedReason: null },
        );
        return (result.affected ?? 0) === 1;
    }

    /**
     * Return one lapsed claim to the pool. Pins the previous status so a
     * job that completed between the scan and the write is never
     * resurrected, and the observed generation so a claim re-issued
     * between the scan and the write is never requeued underneath its
     * new holder. The generation itself is left as it is: the NEXT claim
     * advances it, which is what invalidates the lapsed run.
     */
    async reclaim(id: string, observed: ObservedFleetJobLease): Promise<boolean> {
        const result = await this.repository.update(
            {
                id,
                status: observed.status,
                nodeId: observed.nodeId,
                leaseExpiresAt: observed.leaseExpiresAt,
                leaseGeneration: observed.leaseGeneration,
            },
            // Reclaim returns the row to the pool as an ORDINARY queued
            // job: the reason it originally waited (no free runner) is
            // not necessarily why it is waiting now, and carrying a
            // stale token forward would misreport a lapsed lease as a
            // capacity problem. The row re-ENTERS `queued`, so the queue
            // SLA clock restarts too.
            {
                status: 'queued',
                nodeId: null,
                leaseExpiresAt: null,
                queuedReason: null,
                queuedAt: new Date(),
            },
        );
        return (result.affected ?? 0) === 1;
    }

    /** Fail a lapsed claim that has exhausted its attempt budget (same pinned tuple as `reclaim`). */
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
                leaseGeneration: observed.leaseGeneration,
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
     *
     * Note what this does to a node that is still RUNNING the work: its
     * claim is gone here while its own copy of `leaseExpiresAt` is still
     * minutes in the future, so no deadline it holds locally can tell it
     * to stop. Nothing on this side can fix that — the safety comes from
     * the node re-asking (`heartbeat` → 401 → abort) immediately before
     * any irreversible write, which is why `apps/node` confirms the claim
     * at the moment it publishes rather than trusting its own deadline.
     *
     * `leaseGeneration` is deliberately NOT advanced here: a drain is not
     * a claim. The next `claim()` advances it, and that is the moment the
     * drained node's in-flight run — should it ever report — is refused
     * even if the same node is re-enabled and re-leases the job itself.
     */
    async releaseClaimsForNode(userId: string, nodeId: string): Promise<number> {
        const result = await this.repository.update(
            { userId, nodeId, status: In([...FLEET_JOB_ACTIVE_STATUSES]) },
            // Re-enters `queued`: the SLA clock restarts with it.
            { status: 'queued', nodeId: null, leaseExpiresAt: null, queuedAt: new Date() },
        );
        return result.affected ?? 0;
    }

    /**
     * Fleet cost accounting (EW-777) — record the model spend a job's run
     * reported. Written by the API-side reconciler once per completion,
     * BEFORE the daily ceilings are evaluated, so the sums below include
     * the job that just finished.
     */
    async stampCostCents(id: string, costCents: number): Promise<void> {
        await this.repository.update({ id }, { costCents });
    }

    /**
     * Cents one node's jobs reported since `since` — the per-node DAILY
     * ceiling's input when `since` is the start of the UTC day. Completed
     * jobs keep their `nodeId` (a drain only requeues ACTIVE claims), so
     * the sum survives the drain it may trigger. Uses
     * `idx_fleet_jobs_node_completed`. NULL costs (no model ran, or the CLI
     * printed no price) sum as 0 here — the ceiling service fails closed on
     * the current job's own null cost separately.
     */
    async sumCostCentsForNodeSince(nodeId: string, since: Date): Promise<number> {
        const row = await this.repository
            .createQueryBuilder('j')
            .select('COALESCE(SUM(j.costCents), 0)', 'total')
            .where('j.nodeId = :nodeId', { nodeId })
            .andWhere('j.completedAt >= :since', { since })
            .getRawOne<{ total: string | number | null }>();
        return Number(row?.total ?? 0);
    }

    /** Cents every job of one owner reported since `since` — the FLEET-WIDE daily ceiling's input. */
    async sumCostCentsForUserSince(userId: string, since: Date): Promise<number> {
        const row = await this.repository
            .createQueryBuilder('j')
            .select('COALESCE(SUM(j.costCents), 0)', 'total')
            .where('j.userId = :userId', { userId })
            .andWhere('j.completedAt >= :since', { since })
            .getRawOne<{ total: string | number | null }>();
        return Number(row?.total ?? 0);
    }
}
