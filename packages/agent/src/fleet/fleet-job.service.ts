import { BadRequestException, Injectable, Logger, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { isUUID } from 'class-validator';
import type {
    FleetJobKind,
    FleetJobStatus,
    FleetJobView,
    FleetNodeLoadView,
} from '@ever-works/contracts';
import {
    clampLeaseTtlSec,
    clampMaxAttempts,
    FLEET_JOB_KINDS,
    FLEET_JOB_MAX_ERROR_LENGTH,
    FLEET_JOB_MAX_LEASE_BATCH,
    FLEET_JOB_MAX_PAYLOAD_BYTES,
    FLEET_JOB_MAX_REQUIRED_CAPABILITIES,
    FLEET_JOB_MAX_RESULT_BYTES,
    FLEET_JOB_QUEUE_EXPIRED_REASON,
    isFleetJobKind,
    nodeSatisfiesCapabilities,
} from '@ever-works/contracts';
import { config } from '../config';
import { FleetJob } from '../entities/fleet-job.entity';
import { FleetJobCompletedEvent, FleetJobLeasedEvent } from '../events/fleet-job.events';
import { FleetJobRepository } from './fleet-job.repository';
import { FleetNodeRepository } from './fleet-node.repository';
import { verifyNodeSecret } from './fleet-node-credential';
import { FleetAgentNodeAffinityRepository } from './fleet-agent-node-affinity.repository';

/** Batch ceiling on one reclaim pass, so a huge backlog can't stall a poll. */
export const FLEET_JOB_RECLAIM_BATCH = 200;

export interface EnqueueFleetJobInput {
    userId: string;
    organizationId?: string | null;
    kind: FleetJobKind;
    payload?: Record<string, unknown> | null;
    requiredCapabilities?: string[];
    maxAttempts?: number;
    idempotencyKey?: string | null;
    /**
     * Stamped when the job is accepted with no runner able to take it —
     * today only `waiting-for-runner`, written by the fleet run router.
     * Cleared by the lease CAS, so it can never outlive the condition.
     */
    queuedReason?: string | null;
}

export interface LeaseFleetJobsInput {
    nodeId: unknown;
    secret: unknown;
    max?: number;
    leaseTtlSec?: number;
    /** Overrides the node's last-reported tags for this poll only. */
    capabilities?: string[];
}

export interface CompleteFleetJobInput {
    nodeId: unknown;
    secret: unknown;
    jobId: string;
    success: boolean;
    result?: Record<string, unknown> | null;
    error?: string | null;
}

export interface ReclaimSummary {
    scanned: number;
    requeued: number;
    failed: number;
}

/** What one queue-SLA pass did (see {@link FleetJobService.expireQueued}). */
export interface QueueExpirySummary {
    /** Queued rows older than their kind's max age that the scan returned. */
    scanned: number;
    /** Of those, the rows this pass actually settled `failed`. */
    expired: number;
}

/** Error text a job settles with when an operator cancels it before any node claimed it. */
export const FLEET_JOB_CANCELLED_ERROR = 'Cancelled by the operator before a node claimed it';

/**
 * Settled reason for an ACTIVE job that was cancelled and whose node then
 * died without reporting. Distinct from {@link FLEET_JOB_CANCELLED_ERROR},
 * which only covers a job no node had claimed yet.
 */
export const FLEET_JOB_CANCELLED_LEASE_LAPSED_ERROR =
    'Cancelled by the operator; the node holding it stopped reporting';

/** What `cancel` did (or could not do) — see {@link FleetJobService.cancel}. */
export interface CancelFleetJobOutcome {
    /** True when the request changed the job's course (dropped, or flagged for the node). */
    cancelled: boolean;
    state: /** Queued row failed outright; nothing ever ran. */
        | 'queued-dropped'
        /** A node holds it; flagged, and its next job heartbeat will be refused. */
        | 'cancel-requested'
        /** Already `done` / `failed` — nothing to cancel. */
        | 'terminal'
        /** No such job (an id from another runtime, or a stale stamp). */
        | 'not-found';
}

/**
 * Fleet job runtime (Desktop PRD §6.2 / M4) — the lease protocol.
 *
 * This is the server half of `job-runtime-node`: the provider's "queue"
 * is the owner's fleet, so enqueue writes a row here and enrolled nodes
 * poll for it. Everything a node can do is expressed as a conditional
 * UPDATE whose WHERE clause restates the precondition, so:
 *
 *   - two nodes racing the same job produce exactly ONE winner
 *     (`FleetJobRepository.claim` pins `status:'queued'`);
 *   - a node can only heartbeat/complete a job it still holds
 *     (both pin `nodeId` AND the active statuses);
 *   - a lapsed claim is reclaimable without the node's cooperation
 *     (the lease is a deadline, never a lock).
 *
 * Auth posture is the Fleet posture, unchanged: the SAME node secret
 * minted at enrollment, verified constant-time against the stored
 * sha256, every invalid path returning `null` so the edge maps it to one
 * undifferentiated 401. Still-enrolling nodes are refused outright;
 * paused and disabled nodes are refused a LEASE (no new work, effective
 * on the next poll) but may still heartbeat and complete the jobs they
 * already hold — that is what makes pausing a drain rather than a cut.
 *
 * Reclaim runs inline on every lease poll (bounded, owner-scoped) AND on
 * the `fleet-job-lease-sweeper` cron (global), so a fleet whose nodes
 * all died still converges without anyone polling.
 */
@Injectable()
export class FleetJobService {
    private readonly logger = new Logger(FleetJobService.name);

    constructor(
        private readonly jobs: FleetJobRepository,
        private readonly nodes: FleetNodeRepository,
        private readonly affinities: FleetAgentNodeAffinityRepository,
        // Agent execution v2 (slice B) — lifecycle events for the API-side
        // reconciler. Appended LAST and @Optional() per the positional-
        // arity rule, so every existing spec that builds this service
        // positionally keeps compiling; absent, the lease protocol is
        // byte-for-byte what it was (no consumer, no event).
        @Optional() private readonly events?: EventEmitter2,
    ) {}

    /**
     * Write a lease-able job. Re-enqueuing the same `idempotencyKey`
     * returns the existing row rather than doubling the work onto the
     * fleet — the platform-canonical `JobEnqueueOptions.idempotencyKey`
     * semantic every sibling runtime honours.
     */
    async enqueue(input: EnqueueFleetJobInput): Promise<FleetJobView> {
        if (!isFleetJobKind(input.kind)) {
            throw new BadRequestException(`Unsupported fleet job kind: ${String(input.kind)}`);
        }
        if (typeof input.userId !== 'string' || !input.userId) {
            throw new BadRequestException('Fleet job requires an owner');
        }

        const payload = normalizePayload(input.payload, FLEET_JOB_MAX_PAYLOAD_BYTES, 'payload');
        const requiredCapabilities = normalizeCapabilities(input.requiredCapabilities);
        const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);

        if (idempotencyKey) {
            const existing = await this.jobs.findByIdempotencyKey(idempotencyKey);
            if (existing) {
                return toJobView(existing);
            }
        }

        const targetNodeId = await this.resolveTargetNodeId(input.kind, input.userId, payload);

        const created = await this.jobs.create({
            userId: input.userId,
            organizationId: input.organizationId ?? null,
            targetNodeId,
            kind: input.kind,
            payload,
            requiredCapabilities,
            maxAttempts: clampMaxAttempts(input.maxAttempts),
            idempotencyKey,
            queuedReason: normalizeQueuedReason(input.queuedReason),
        });
        return toJobView(created);
    }

    /**
     * The node an `agent-task` for this Agent is pinned to, or null when
     * the Agent is unbound (or not a well-formed owned Agent id). The
     * binding is resolved through the AGENT's own Organization — never
     * through the scope a particular job or Task happens to carry, which
     * is null for cron-spawned recurrence instances and can differ for a
     * Task created under another of the owner's Organizations. Keying on
     * the job would silently un-pin exactly the runs the owner bound.
     *
     * Public because the run router asks the same question BEFORE the
     * job exists (`FleetRunRouterService.routeAgentTask`, self-build
     * slice S), to judge availability against the bound node instead of
     * the whole fleet; both callers must agree on the answer.
     */
    async resolveAgentTaskTarget(userId: string, agentId: unknown): Promise<string | null> {
        if (typeof agentId !== 'string' || !isUUID(agentId)) {
            return null;
        }
        const affinity = await this.affinities.findForOwnedAgent(userId, agentId);
        return affinity?.nodeId ?? null;
    }

    private async resolveTargetNodeId(
        kind: FleetJobKind,
        userId: string,
        payload: Record<string, unknown> | null,
    ): Promise<string | null> {
        if (kind !== 'agent-task') {
            return null;
        }
        return this.resolveAgentTaskTarget(userId, payload?.agentId);
    }

    /**
     * Claim up to `max` queued jobs for an authenticated node.
     *
     * Returns null on ANY invalid credential path so the edge answers
     * one undifferentiated 401. A valid node with nothing to do gets an
     * empty array — "no work" and "bad credential" are never the same
     * response.
     */
    async lease(input: LeaseFleetJobsInput): Promise<FleetJobView[] | null> {
        const node = await this.authenticateNode(input.nodeId, input.secret);
        if (!node) {
            return null;
        }

        // Inline reclaim before the scan: a job whose holder died is
        // eligible again on the very next poll, with no cron in the loop.
        await this.reclaimExpired(node.userId);
        // Queue SLA on the same poll (owner-scoped, bounded): a job nobody
        // eligible ever took must not be re-offered forever. Best-effort —
        // an SLA scan that fails must never refuse a healthy node its work.
        try {
            await this.expireQueued(node.userId);
        } catch (error) {
            this.logger.warn(
                `fleet queue expiry skipped on lease for owner ${node.userId}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }

        const capabilities = Array.isArray(input.capabilities)
            ? normalizeCapabilities(input.capabilities, FLEET_JOB_MAX_REQUIRED_CAPABILITIES * 4)
            : (node.capabilities ?? []);
        const max = clampBatch(input.max);
        const ttlSec = clampLeaseTtlSec(input.leaseTtlSec);

        // Over-fetch: capability filtering is in-memory (the tag set is a
        // JSON column and must behave identically on Postgres and sqlite),
        // and CAS losses to a racing node also consume candidates.
        const candidates = await this.jobs.findQueuedForNode(
            node.userId,
            node.id,
            Math.max(max * 4, FLEET_JOB_MAX_LEASE_BATCH),
        );

        const leased: FleetJobView[] = [];
        for (const candidate of candidates) {
            if (leased.length >= max) break;
            if (candidate.targetNodeId && candidate.targetNodeId !== node.id) {
                continue;
            }
            if (!nodeSatisfiesCapabilities(capabilities, candidate.requiredCapabilities)) {
                continue;
            }
            const leaseExpiresAt = new Date(Date.now() + ttlSec * 1000);
            const attempts = (candidate.attempts ?? 0) + 1;
            const won = await this.jobs.claim(candidate.id, {
                nodeId: node.id,
                status: 'leased',
                leaseExpiresAt,
                attempts,
                // The claim IS the moment "waiting for a runner" stops
                // being true, so it is the claim that clears the token.
                queuedReason: null,
            });
            if (!won) {
                // Another node won the race. Not an error — just skip it.
                continue;
            }
            const view = toJobView({
                ...candidate,
                nodeId: node.id,
                status: 'leased',
                leaseExpiresAt,
                attempts,
                queuedReason: null,
            } as FleetJob);
            leased.push(view);
            this.emit(
                FleetJobLeasedEvent.EVENT_NAME,
                new FleetJobLeasedEvent(view, node.id, node.userId),
            );
        }

        return leased;
    }

    /**
     * Agent execution v2 (slice B) — cancel a job from the platform side.
     *
     * Two honest answers, because a node may already hold the job:
     *
     *   - **queued** — nothing ran; the row settles `failed` with
     *     {@link FLEET_JOB_CANCELLED_ERROR} and a completion event fires
     *     (source `cancelled`) so anything waiting on the job learns it
     *     will never run;
     *   - **leased / running** — the node is mid-job and cannot be
     *     reached (transport is outbound-only). The request is recorded
     *     as `cancelRequestedAt`; the node's next job heartbeat is REFUSED
     *     — the same "lease lost" signal a dead server produces, which the
     *     node already aborts on — and its report then settles the row.
     *
     * Never throws for an unknown id: the caller (the composite run
     * canceller) uses `not-found` to fall through to the next runtime.
     */
    async cancel(jobId: string): Promise<CancelFleetJobOutcome> {
        if (typeof jobId !== 'string' || !isUUID(jobId)) {
            return { cancelled: false, state: 'not-found' };
        }
        const job = await this.jobs.findById(jobId);
        if (!job) {
            return { cancelled: false, state: 'not-found' };
        }
        if (job.status === 'done' || job.status === 'failed') {
            return { cancelled: false, state: 'terminal' };
        }
        const now = new Date();
        if (job.status === 'queued') {
            const dropped = await this.jobs.cancelQueued(job.id, FLEET_JOB_CANCELLED_ERROR, now);
            if (!dropped) {
                // Lost the race to a node's claim — fall through to the
                // active path on a fresh read rather than reporting a
                // cancel that did not happen.
                const fresh = await this.jobs.findById(job.id);
                if (!fresh || fresh.status === 'done' || fresh.status === 'failed') {
                    return { cancelled: false, state: 'terminal' };
                }
                return this.requestCancelOnActive(fresh, now);
            }
            const view = toJobView({
                ...job,
                status: 'failed',
                error: FLEET_JOB_CANCELLED_ERROR,
                completedAt: now,
                leaseExpiresAt: null,
                cancelRequestedAt: now,
            } as FleetJob);
            this.emit(
                FleetJobCompletedEvent.EVENT_NAME,
                new FleetJobCompletedEvent(
                    view,
                    job.userId,
                    'cancelled',
                    null,
                    null,
                    FLEET_JOB_CANCELLED_ERROR,
                ),
            );
            return { cancelled: true, state: 'queued-dropped' };
        }
        return this.requestCancelOnActive(job, now);
    }

    private async requestCancelOnActive(job: FleetJob, now: Date): Promise<CancelFleetJobOutcome> {
        if (job.cancelRequestedAt) {
            // Already flagged — idempotent, and still "cancelled" from the
            // operator's point of view.
            return { cancelled: true, state: 'cancel-requested' };
        }
        const flagged = await this.jobs.requestCancel(job.id, now);
        if (!flagged) {
            const fresh = await this.jobs.findById(job.id);
            if (fresh?.cancelRequestedAt) return { cancelled: true, state: 'cancel-requested' };
            return { cancelled: false, state: 'terminal' };
        }
        this.logger.log(
            `Fleet job ${job.id} flagged for cancellation; node ${job.nodeId} aborts on its next heartbeat`,
        );
        return { cancelled: true, state: 'cancel-requested' };
    }

    /** Best-effort event emission — a listener failure must never fail the lease protocol. */
    private emit(name: string, event: FleetJobLeasedEvent | FleetJobCompletedEvent): void {
        if (!this.events) return;
        try {
            this.events.emit(name, event);
        } catch (error) {
            this.logger.warn(
                `fleet event ${name} for job ${event.job.id} failed: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }

    /**
     * Extend the claim on a job this node still holds, and flip the
     * first beat `leased` → `running` (the node acknowledged the work).
     * Null on any invalid path — bad credential, foreign job, terminal
     * job — so the edge cannot leak which.
     */
    async heartbeatJob(
        nodeId: unknown,
        secret: unknown,
        jobId: string,
        leaseTtlSec?: number,
    ): Promise<FleetJobView | null> {
        // 'report': a draining (paused/disabled) node must keep the
        // claim on work it is already running.
        const node = await this.authenticateNode(nodeId, secret, 'report');
        if (!node) return null;

        const job = await this.jobs.findById(jobId);
        if (!job || job.nodeId !== node.id) return null;
        if (job.status !== 'leased' && job.status !== 'running') return null;
        // Agent execution v2 (slice B) — an operator cancel is delivered
        // as a REFUSED heartbeat: the node reads it as "lease lost" and
        // aborts the job, exactly as it would for a dead server. Its
        // report is still accepted below (`completeJob` does not check
        // the flag), so the row settles with the node's own verdict.
        if (job.cancelRequestedAt) {
            this.logger.log(`Fleet job ${job.id}: heartbeat refused — cancellation requested`);
            return null;
        }

        const ttlSec = clampLeaseTtlSec(leaseTtlSec);
        const leaseExpiresAt = new Date(Date.now() + ttlSec * 1000);
        const startedAt = job.startedAt ?? new Date();
        const extended = await this.jobs.extendLease(job.id, node.id, leaseExpiresAt, startedAt);
        if (!extended) return null;

        return toJobView({
            ...job,
            status: 'running',
            leaseExpiresAt,
            startedAt,
        } as FleetJob);
    }

    /**
     * Record the terminal outcome of a job this node still holds. A
     * failure is recorded as `failed` and NOT auto-requeued here: the
     * node reported a real verdict, and silently re-running a check that
     * legitimately went red would be worse than surfacing it. Only
     * LAPSED claims (no verdict at all) are retried, by the reclaim path.
     */
    async completeJob(input: CompleteFleetJobInput): Promise<FleetJobView | null> {
        // 'report': the whole point of a drain is that in-flight work
        // still reaches a verdict.
        const node = await this.authenticateNode(input.nodeId, input.secret, 'report');
        if (!node) return null;

        const job = await this.jobs.findById(input.jobId);
        if (!job || job.nodeId !== node.id) return null;
        if (job.status !== 'leased' && job.status !== 'running') return null;

        const completedAt = new Date();
        const status: Extract<FleetJobStatus, 'done' | 'failed'> = input.success
            ? 'done'
            : 'failed';
        const result = input.success
            ? normalizePayload(input.result, FLEET_JOB_MAX_RESULT_BYTES, 'result')
            : null;
        const error = input.success ? null : truncate(input.error, FLEET_JOB_MAX_ERROR_LENGTH);

        const applied = await this.jobs.complete(job.id, node.id, {
            status,
            result,
            error,
            completedAt,
        });
        if (!applied) return null;

        const view = toJobView({
            ...job,
            status,
            result,
            error,
            completedAt,
            leaseExpiresAt: null,
        } as FleetJob);
        this.emit(
            FleetJobCompletedEvent.EVENT_NAME,
            new FleetJobCompletedEvent(view, job.userId, 'node-report', node.id, result, error),
        );
        return view;
    }

    /**
     * Return lapsed claims to the pool (or fail them once the attempt
     * budget is spent). Scoped to one owner on the lease path, global on
     * the cron. Best-effort per row: one bad row must not abort the sweep.
     */
    async reclaimExpired(userId?: string): Promise<ReclaimSummary> {
        const now = new Date();
        const expired = await this.jobs.findExpiredLeases(now, FLEET_JOB_RECLAIM_BATCH, userId);
        const summary: ReclaimSummary = { scanned: expired.length, requeued: 0, failed: 0 };

        for (const job of expired) {
            try {
                // A scan is only a snapshot. Pin the exact claim so a
                // successful heartbeat between this read and the UPDATE wins.
                if (!job.nodeId || !job.leaseExpiresAt) continue;
                const observed = {
                    status: job.status,
                    nodeId: job.nodeId,
                    leaseExpiresAt: job.leaseExpiresAt,
                };
                // A cancelled job must never go back in the pool.
                //
                // `reclaim()` resets status / nodeId / leaseExpiresAt /
                // queuedReason but leaves `cancelRequestedAt` set, and
                // `claim()` CASes on `{ id, status: 'queued' }` only — it does
                // not exclude a flagged row. So a job the operator cancelled,
                // whose node then aborted on the refused heartbeat without
                // calling `complete()` (or simply crashed), was requeued still
                // carrying the flag and re-leased to a fresh node, which began
                // re-executing the cancelled Task for real — CLI work, git
                // work — until the attempt budget ran out.
                //
                // Settle it instead, with the same observed-lease CAS the
                // exhausted path uses so a heartbeat landing between the scan
                // and this write still wins. `source: 'cancelled'` routes the
                // reconciler to its board-mirror branch, which is exactly
                // right: nothing was produced that anyone should act on.
                if (job.cancelRequestedAt) {
                    const error = FLEET_JOB_CANCELLED_LEASE_LAPSED_ERROR;
                    const settled = await this.jobs.failExhausted(job.id, observed, error, now);
                    if (settled) {
                        summary.failed += 1;
                        this.emit(
                            FleetJobCompletedEvent.EVENT_NAME,
                            new FleetJobCompletedEvent(
                                toJobView({
                                    ...job,
                                    status: 'failed',
                                    error,
                                    completedAt: now,
                                    leaseExpiresAt: null,
                                } as FleetJob),
                                job.userId,
                                'cancelled',
                                job.nodeId ?? null,
                                null,
                                error,
                            ),
                        );
                    }
                    continue;
                }
                if ((job.attempts ?? 0) >= (job.maxAttempts ?? 1)) {
                    const error = `Lease expired ${job.attempts} time(s) without a result; attempt budget exhausted`;
                    const failed = await this.jobs.failExhausted(job.id, observed, error, now);
                    if (failed) {
                        summary.failed += 1;
                        // The run behind this job would otherwise wait on
                        // a verdict that is never coming.
                        this.emit(
                            FleetJobCompletedEvent.EVENT_NAME,
                            new FleetJobCompletedEvent(
                                toJobView({
                                    ...job,
                                    status: 'failed',
                                    error,
                                    completedAt: now,
                                    leaseExpiresAt: null,
                                } as FleetJob),
                                job.userId,
                                'lease-exhausted',
                                job.nodeId ?? null,
                                null,
                                error,
                            ),
                        );
                    }
                    continue;
                }
                const requeued = await this.jobs.reclaim(job.id, observed);
                if (requeued) summary.requeued += 1;
            } catch (error) {
                this.logger.warn(
                    `fleet job reclaim failed for ${job.id}: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                );
            }
        }

        if (summary.requeued > 0 || summary.failed > 0) {
            this.logger.log(
                `fleet job reclaim: requeued=${summary.requeued} failed=${summary.failed} scanned=${summary.scanned}`,
            );
        }
        return summary;
    }

    /**
     * Queue SLA (self-build slice S / EW-775) — fail every `queued` job
     * that has waited longer than its kind's max queued age
     * (`config.fleetNode.getQueuedMaxAgeSeconds`) for an eligible runner.
     *
     * Why this exists: reclaim only ever looks at ACTIVE statuses, so a
     * job no node could take — pinned to a machine that never came back,
     * or requiring a tag no node advertises — sat `queued` forever, and
     * its AgentRun with it. Eligibility-aware routing stops the common
     * case at the door; this is the backstop for everything that slips
     * past (a runner that went offline between the decision and the
     * lease, a `local-wait` job whose machine never returns).
     *
     * Per row: the `failQueuedExpired` CAS pins `queued` + `queuedAt`
     * still older than the kind's cutoff + not-cancelled, so a claim, a
     * reclaim (which re-stamps the clock to now) or a cancel that lands
     * first wins and NO event fires here. A row settled here emits
     * exactly one `fleet.job.completed` with source `queue-expired` and
     * the stable {@link FLEET_JOB_QUEUE_EXPIRED_REASON} prefix, which is
     * what lets the API-side reconciler settle the run and file the one
     * Inbox notice. Rows with an unknown age (`queuedAt IS NULL`, written
     * before the column existed) are never touched.
     *
     * Scoped to one owner on the lease path, global on the cron, and
     * best-effort per row — one bad row must not abort the sweep.
     */
    async expireQueued(userId?: string): Promise<QueueExpirySummary> {
        const now = new Date();
        const summary: QueueExpirySummary = { scanned: 0, expired: 0 };

        for (const kind of FLEET_JOB_KINDS) {
            const maxAgeSec = config.fleetNode.getQueuedMaxAgeSeconds(kind);
            const cutoff = new Date(now.getTime() - maxAgeSec * 1000);
            const stale = await this.jobs.findQueuedOlderThan(
                kind,
                cutoff,
                FLEET_JOB_RECLAIM_BATCH,
                userId,
            );
            summary.scanned += stale.length;

            for (const job of stale) {
                try {
                    // Belt on top of the query: an unknown age is not an
                    // old age, and this transition is destructive.
                    if (!job.queuedAt || job.cancelRequestedAt) continue;
                    const error = describeQueueExpiry(job, maxAgeSec);
                    // The CAS re-checks the AGE against the same cutoff the
                    // scan used, not the exact instant the driver read back
                    // (see `FleetJobRepository.failQueuedExpired`).
                    const settled = await this.jobs.failQueuedExpired(job.id, cutoff, error, now);
                    if (!settled) continue;
                    summary.expired += 1;
                    this.emit(
                        FleetJobCompletedEvent.EVENT_NAME,
                        new FleetJobCompletedEvent(
                            toJobView({
                                ...job,
                                status: 'failed',
                                error,
                                completedAt: now,
                                leaseExpiresAt: null,
                                queuedReason: null,
                            } as FleetJob),
                            job.userId,
                            'queue-expired',
                            null,
                            null,
                            error,
                        ),
                    );
                } catch (error) {
                    this.logger.warn(
                        `fleet queue expiry failed for ${job.id}: ${
                            error instanceof Error ? error.message : String(error)
                        }`,
                    );
                }
            }
        }

        if (summary.expired > 0) {
            this.logger.log(
                `fleet queue expiry: expired=${summary.expired} scanned=${summary.scanned}`,
            );
        }
        return summary;
    }

    /**
     * Heartbeat promotion (self-build slice S) — clear `waiting-for-runner`
     * on the owner's queued jobs that `nodeId` can now take, because it
     * just beat as ONLINE and holds no claim.
     *
     * The token is what the Fleet UI reads. The lease CAS already clears
     * it when the node's next poll claims the job, so promotion buys no
     * correctness — it buys honesty in the window between "the laptop
     * woke up" and "it polled", and it must never make the UI lie the
     * other way: a node that is online but BUSY is not "able to take it"
     * (the token stays true), and `queuedAt` is left alone (a promotion
     * does not make the job younger, so a node that is online but never
     * leases is still bounded by the SLA).
     *
     * Eligibility is judged the way the lease scan judges it — unbound
     * or pinned to this node, every required tag advertised — from the
     * node ROW (owner, status, tags), never from a caller-supplied
     * shape, so a node id that travelled cannot promote another owner's
     * work. Never throws: a promotion failure must not fail the beat.
     */
    async promoteWaitingForNode(nodeId: string): Promise<number> {
        try {
            if (typeof nodeId !== 'string' || !isUUID(nodeId)) return 0;
            const node = await this.nodes.findById(nodeId);
            if (!node || node.status !== 'online') return 0;

            const active = await this.jobs.findActiveForUser(node.userId);
            if (active.some((job) => job.nodeId === node.id)) return 0;

            const waiting = await this.jobs.findWaitingForNode(
                node.userId,
                node.id,
                FLEET_JOB_RECLAIM_BATCH,
            );
            const capabilities = node.capabilities ?? [];
            let promoted = 0;
            for (const job of waiting) {
                if (job.cancelRequestedAt) continue;
                if (!nodeSatisfiesCapabilities(capabilities, job.requiredCapabilities)) continue;
                if (await this.jobs.promoteWaiting(job.id)) promoted += 1;
            }
            if (promoted > 0) {
                this.logger.log(
                    `fleet node ${node.id} back online: ${promoted} waiting job(s) promoted for owner ${node.userId}`,
                );
            }
            return promoted;
        } catch (error) {
            this.logger.warn(
                `fleet waiting-job promotion failed for node ${nodeId}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return 0;
        }
    }

    /**
     * Per-node load for the Fleet settings page: how many live claims
     * each node holds and what the oldest one is. Keyed by node id;
     * nodes with nothing in flight are simply absent (the UI renders
     * "idle" for a missing entry).
     */
    async loadByNodeForUser(userId: string): Promise<Record<string, FleetNodeLoadView>> {
        const active = await this.jobs.findActiveForUser(userId);
        const byNode: Record<string, FleetNodeLoadView> = {};
        for (const job of active) {
            const nodeId = job.nodeId;
            if (!nodeId) continue;
            const existing = byNode[nodeId];
            if (existing) {
                existing.activeJobCount += 1;
                continue;
            }
            // `findActiveForUser` orders oldest-first, so the first job
            // seen for a node IS its current job.
            byNode[nodeId] = {
                activeJobCount: 1,
                currentJobKind: job.kind,
                currentJobId: job.id,
            };
        }
        return byNode;
    }

    /** Owner-scoped job listing (chat tool / future job history UI). */
    async listForUser(userId: string, limit = 50): Promise<FleetJobView[]> {
        const rows = await this.jobs.findByUser(userId, Math.min(Math.max(limit, 1), 200));
        return rows.map(toJobView);
    }

    /**
     * One node's recent job history, newest first (node-detail drawer).
     * Owner-scoped in the query itself, not just by convention at the
     * edge — a node id is a travelling value.
     */
    async historyForNode(userId: string, nodeId: string, limit = 20): Promise<FleetJobView[]> {
        const rows = await this.jobs.findByNodeForUser(
            userId,
            nodeId,
            Math.min(Math.max(limit, 1), 100),
        );
        return rows.map(toJobView);
    }

    /**
     * Requeue everything a node currently holds — the work half of a
     * DRAIN. Returns how many claims went back to the pool.
     *
     * Best-effort by contract: the caller has already disabled the node
     * (which is what actually stops it receiving work), so a failure
     * here must degrade to "the leases lapse on their own" rather than
     * un-draining the node.
     */
    async releaseClaimsForNode(userId: string, nodeId: string): Promise<number> {
        try {
            return await this.jobs.releaseClaimsForNode(userId, nodeId);
        } catch (error) {
            this.logger.warn(
                `fleet drain could not requeue claims for node ${nodeId}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return 0;
        }
    }

    /**
     * Resolve + verify a node credential. Fail-closed on every path:
     * malformed ids, unknown nodes, still-enrolling nodes (whose hash
     * column holds a token, not a secret), and bad secrets all return
     * null.
     *
     * `intent` is what makes pausing a DRAIN rather than a cut
     * (audit A29):
     *
     *   - `'lease'`  — a paused or disabled node is refused. Draining
     *                  means no NEW work, effective on the very next poll.
     *   - `'report'` — a paused or disabled node is ACCEPTED, so the
     *                  jobs it already holds can keep their claims alive
     *                  and deliver a verdict. Severing them instead
     *                  would throw away completed work, let the lease
     *                  lapse, and re-run the same job somewhere else —
     *                  the exact opposite of draining.
     *
     * A still-enrolling node is refused for both: it has no secret yet.
     */
    private async authenticateNode(
        nodeId: unknown,
        secret: unknown,
        intent: 'lease' | 'report' = 'lease',
    ): Promise<{ id: string; userId: string; capabilities: string[] } | null> {
        const verified = verifyNodeSecret(nodeId, secret);
        if (!verified) return null;

        const node = await this.nodes.findById(verified.nodeId);
        if (!node) return null;
        if (node.status === 'enrolling') return null;
        if (intent === 'lease' && (node.status === 'disabled' || node.status === 'paused')) {
            return null;
        }
        if (!verified.matches(node.enrollmentTokenHash)) return null;

        return {
            id: node.id,
            userId: node.userId,
            capabilities: node.capabilities ?? [],
        };
    }
}

/** Entity → wire view. Credentials never enter this shape. */
export function toJobView(job: FleetJob): FleetJobView {
    return {
        id: job.id,
        kind: job.kind,
        status: job.status,
        nodeId: job.nodeId ?? null,
        targetNodeId: job.targetNodeId ?? null,
        requiredCapabilities: job.requiredCapabilities ?? [],
        payload: job.payload ?? null,
        leaseExpiresAt: job.leaseExpiresAt ? toIso(job.leaseExpiresAt) : null,
        attempts: job.attempts ?? 0,
        maxAttempts: job.maxAttempts ?? 0,
        createdAt: job.createdAt ? toIso(job.createdAt) : null,
        startedAt: job.startedAt ? toIso(job.startedAt) : null,
        completedAt: job.completedAt ? toIso(job.completedAt) : null,
        queuedAt: job.queuedAt ? toIso(job.queuedAt) : null,
        queuedReason: job.queuedReason ?? null,
        cancelRequestedAt: job.cancelRequestedAt ? toIso(job.cancelRequestedAt) : null,
    };
}

/**
 * The error a queue-SLA failure settles with: the stable machine token
 * first, then the human sentence, then the facts an owner needs to fix
 * it (which node it was pinned to, which tags it needed). Length-capped
 * like every other stored error.
 */
function describeQueueExpiry(job: FleetJob, maxAgeSec: number): string {
    const parts = [
        `${FLEET_JOB_QUEUE_EXPIRED_REASON}: no eligible runner took the job within ${formatDuration(maxAgeSec)}`,
    ];
    if (job.targetNodeId) {
        parts.push(`(pinned to node ${job.targetNodeId})`);
    }
    if (Array.isArray(job.requiredCapabilities) && job.requiredCapabilities.length > 0) {
        parts.push(`[requires ${job.requiredCapabilities.join(', ')}]`);
    }
    return truncate(parts.join(' '), FLEET_JOB_MAX_ERROR_LENGTH) ?? FLEET_JOB_QUEUE_EXPIRED_REASON;
}

function formatDuration(seconds: number): string {
    if (seconds % 3600 === 0) return `${seconds / 3600}h`;
    if (seconds % 60 === 0) return `${seconds / 60}m`;
    return `${seconds}s`;
}

/**
 * Queued reasons are short machine tokens, never free text — the same
 * discipline `agent_runs.queuedReason` follows. Anything that is not a
 * short token collapses to null rather than being stored and later
 * rendered.
 */
function normalizeQueuedReason(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 64) return null;
    return trimmed;
}

function clampBatch(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 1;
    return Math.min(Math.max(Math.trunc(value), 1), FLEET_JOB_MAX_LEASE_BATCH);
}

/**
 * Size-guard a JSON column value. Rejects (rather than truncates)
 * oversize payloads — a silently-clipped executor input would produce a
 * job that fails for reasons nobody can see.
 */
function normalizePayload(
    value: unknown,
    maxBytes: number,
    label: string,
): Record<string, unknown> | null {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'object' || Array.isArray(value)) {
        throw new BadRequestException(`Fleet job ${label} must be an object`);
    }
    const serialized = JSON.stringify(value);
    if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
        throw new BadRequestException(`Fleet job ${label} exceeds ${maxBytes} bytes`);
    }
    return value as Record<string, unknown>;
}

function normalizeCapabilities(
    value: unknown,
    max: number = FLEET_JOB_MAX_REQUIRED_CAPABILITIES,
): string[] {
    if (!Array.isArray(value)) return [];
    const out: string[] = [];
    for (const entry of value) {
        if (typeof entry !== 'string') continue;
        const tag = entry.trim().slice(0, 32);
        if (!tag || out.includes(tag)) continue;
        out.push(tag);
        if (out.length >= max) break;
    }
    return out;
}

function normalizeIdempotencyKey(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed ? trimmed.slice(0, 200) : null;
}

function truncate(value: unknown, max: number): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed ? trimmed.slice(0, max) : null;
}

function toIso(value: Date | string): string {
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
