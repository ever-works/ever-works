import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type {
    FleetJobKind,
    FleetJobStatus,
    FleetJobView,
    FleetNodeLoadView,
} from '@ever-works/contracts';
import {
    clampLeaseTtlSec,
    clampMaxAttempts,
    FLEET_JOB_MAX_ERROR_LENGTH,
    FLEET_JOB_MAX_LEASE_BATCH,
    FLEET_JOB_MAX_PAYLOAD_BYTES,
    FLEET_JOB_MAX_REQUIRED_CAPABILITIES,
    FLEET_JOB_MAX_RESULT_BYTES,
    isFleetJobKind,
    nodeSatisfiesCapabilities,
} from '@ever-works/contracts';
import { FleetJob } from '../entities/fleet-job.entity';
import { FleetJobRepository } from './fleet-job.repository';
import { FleetNodeRepository } from './fleet-node.repository';
import { verifyNodeSecret } from './fleet-node-credential';

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
 * undifferentiated 401. Disabled and still-enrolling nodes are refused
 * — a drained node stops getting work immediately.
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

        const created = await this.jobs.create({
            userId: input.userId,
            organizationId: input.organizationId ?? null,
            kind: input.kind,
            payload,
            requiredCapabilities,
            maxAttempts: clampMaxAttempts(input.maxAttempts),
            idempotencyKey,
        });
        return toJobView(created);
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

        const capabilities = Array.isArray(input.capabilities)
            ? normalizeCapabilities(input.capabilities, FLEET_JOB_MAX_REQUIRED_CAPABILITIES * 4)
            : (node.capabilities ?? []);
        const max = clampBatch(input.max);
        const ttlSec = clampLeaseTtlSec(input.leaseTtlSec);

        // Over-fetch: capability filtering is in-memory (the tag set is a
        // JSON column and must behave identically on Postgres and sqlite),
        // and CAS losses to a racing node also consume candidates.
        const candidates = await this.jobs.findQueuedForUser(
            node.userId,
            Math.max(max * 4, FLEET_JOB_MAX_LEASE_BATCH),
        );

        const leased: FleetJobView[] = [];
        for (const candidate of candidates) {
            if (leased.length >= max) break;
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
            });
            if (!won) {
                // Another node won the race. Not an error — just skip it.
                continue;
            }
            leased.push(
                toJobView({
                    ...candidate,
                    nodeId: node.id,
                    status: 'leased',
                    leaseExpiresAt,
                    attempts,
                } as FleetJob),
            );
        }

        return leased;
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
        const node = await this.authenticateNode(nodeId, secret);
        if (!node) return null;

        const job = await this.jobs.findById(jobId);
        if (!job || job.nodeId !== node.id) return null;
        if (job.status !== 'leased' && job.status !== 'running') return null;

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
        const node = await this.authenticateNode(input.nodeId, input.secret);
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

        return toJobView({
            ...job,
            status,
            result,
            error,
            completedAt,
            leaseExpiresAt: null,
        } as FleetJob);
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
                if ((job.attempts ?? 0) >= (job.maxAttempts ?? 1)) {
                    const failed = await this.jobs.failExhausted(
                        job.id,
                        job.status,
                        `Lease expired ${job.attempts} time(s) without a result; attempt budget exhausted`,
                        now,
                    );
                    if (failed) summary.failed += 1;
                    continue;
                }
                const requeued = await this.jobs.reclaim(job.id, job.status);
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
     * Resolve + verify a node credential. Fail-closed on every path:
     * malformed ids, unknown nodes, disabled nodes (drained — they must
     * stop receiving work immediately), still-enrolling nodes (whose
     * hash column holds a token, not a secret), and bad secrets all
     * return null.
     */
    private async authenticateNode(
        nodeId: unknown,
        secret: unknown,
    ): Promise<{ id: string; userId: string; capabilities: string[] } | null> {
        const verified = verifyNodeSecret(nodeId, secret);
        if (!verified) return null;

        const node = await this.nodes.findById(verified.nodeId);
        if (!node) return null;
        if (node.status === 'disabled' || node.status === 'enrolling') return null;
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
        requiredCapabilities: job.requiredCapabilities ?? [],
        payload: job.payload ?? null,
        leaseExpiresAt: job.leaseExpiresAt ? toIso(job.leaseExpiresAt) : null,
        attempts: job.attempts ?? 0,
        maxAttempts: job.maxAttempts ?? 0,
        createdAt: job.createdAt ? toIso(job.createdAt) : null,
        startedAt: job.startedAt ? toIso(job.startedAt) : null,
        completedAt: job.completedAt ? toIso(job.completedAt) : null,
    };
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
