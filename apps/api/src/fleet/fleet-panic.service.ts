import { Injectable, Logger } from '@nestjs/common';
import { AgentRunRepository } from '@ever-works/agent/database';
import { FleetAuditService, FleetJobService, FleetService } from '@ever-works/agent/fleet';
import type {
    FleetAuditAction,
    FleetCancelInFlightResult,
    FleetDrainAllResult,
    FleetJobCancelState,
    FleetJobView,
    FleetNodeDrainResult,
    FleetNodeView,
} from '@ever-works/contracts';
import { FLEET_CANCEL_IN_FLIGHT_MAX_IDS, FLEET_JOB_CANCEL_STATES } from '@ever-works/contracts';
import { correlateAgentTaskJob } from './fleet-agent-task.correlation';

export interface CancelInFlightOptions {
    /** Also fail every job still `queued` for the owner. Default false. */
    includeQueued?: boolean;
}

/**
 * Panic controls (EW-778) — the OWNER-scoped controls: drain everything,
 * and — as an explicit, separate second step — cancel everything that
 * is running.
 *
 * ## One drain, two routes
 *
 * `drainNodeForUser` IS the per-node drain `POST /api/fleet/nodes/:id/drain`
 * has always performed (it moved here verbatim). `drainAllForUser` calls
 * it once per node, so the two routes cannot drift on what "drain" means
 * — in particular on the ORDER: disable FIRST, so the node stops being
 * able to lease the instant its status flips, and only then requeue its
 * claims, which the same machine can therefore never re-claim.
 *
 * ## Owner scoping
 *
 * Every read and write is keyed by the SESSION user: the node list comes
 * from `FleetService.listEnrolledForUser`, each drain goes through the
 * owner-scoped `setDisabledForUser` (404 for a foreign id), the job set
 * comes from the owner-scoped job reads, and the run cancel is
 * `AgentRunRepository.cancel(runId, userId)`, which re-checks ownership
 * in its own WHERE clause. No id supplied by anyone else is ever trusted.
 *
 * ## Audit posture
 *
 * Act first, then audit. A drain or a cancel must never be reverted
 * because bookkeeping failed, so an audit write failure is logged at
 * error level and reported as `auditFailed: true` on the result — the
 * opposite of `TenantJobRuntimeService.emitAudit`, where the audited
 * write can be rolled back, and deliberately so.
 */
@Injectable()
export class FleetPanicService {
    private readonly logger = new Logger(FleetPanicService.name);

    constructor(
        private readonly fleet: FleetService,
        private readonly jobs: FleetJobService,
        private readonly agentRuns: AgentRunRepository,
        private readonly audit: FleetAuditService,
    ) {}

    /**
     * Drain (or return to service) ONE node. Disable first, requeue
     * second — see the class docblock for why the order is load-bearing.
     */
    async drainNodeForUser(
        userId: string,
        nodeId: string,
        drain: boolean,
    ): Promise<FleetNodeDrainResult> {
        const node = await this.fleet.setDisabledForUser(userId, nodeId, drain);
        const releasedJobs = drain ? await this.jobs.releaseClaimsForNode(userId, nodeId) : 0;
        return { node, releasedJobs };
    }

    /**
     * Drain EVERY enrolled node the caller owns. Nodes still `enrolling`
     * (no credential yet, nothing to drain) and nodes already `disabled`
     * are skipped; a node whose drain throws is skipped too and the rest
     * still drain — one bad row must not leave five machines running.
     */
    async drainAllForUser(userId: string): Promise<FleetDrainAllResult> {
        const nodes = await this.fleet.listEnrolledForUser(userId);
        const views: FleetNodeView[] = [];
        const drainedIds: string[] = [];
        const failedIds: string[] = [];
        let skippedNodes = 0;
        let releasedJobs = 0;

        for (const node of nodes) {
            if (node.status === 'enrolling' || node.status === 'disabled') {
                skippedNodes += 1;
                views.push(node);
                continue;
            }
            try {
                const result = await this.drainNodeForUser(userId, node.id, true);
                drainedIds.push(node.id);
                releasedJobs += result.releasedJobs;
                views.push(result.node);
            } catch (error) {
                skippedNodes += 1;
                failedIds.push(node.id);
                views.push(node);
                this.logger.error(
                    `drain-all: node ${node.id} could not be drained for ${userId}: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                );
            }
        }

        this.logger.warn(
            `drain-all by ${userId}: drained ${drainedIds.length} node(s), skipped ${skippedNodes}, requeued ${releasedJobs} job(s)`,
        );
        const auditFailed = !(await this.tryAudit('drain-all', userId, {
            drainedNodes: drainedIds.length,
            skippedNodes,
            releasedJobs,
            nodeIds: drainedIds,
            failedNodeIds: failedIds,
        }));

        return {
            drainedNodes: drainedIds.length,
            skippedNodes,
            releasedJobs,
            nodes: views,
            auditFailed,
        };
    }

    /**
     * Cancel the caller's in-flight fleet work: every `leased` /
     * `running` job (plus the `queued` ones when asked) and the agent run
     * behind each. Per job the order is the one `AgentsController.cancelRun`
     * uses — DB run row FIRST, then the remote job — so a node that
     * reports after this can never resurrect a row.
     *
     * Deliberately does NOT drain the concurrency queue afterwards: a
     * panic must not promote parked work into the slots it just freed.
     * And it is never called by the stop flag — cancelling is its own
     * decision, on its own route.
     */
    async cancelInFlightForUser(
        userId: string,
        options: CancelInFlightOptions = {},
    ): Promise<FleetCancelInFlightResult> {
        const includeQueued = options.includeQueued === true;
        const active = await this.jobs.activeForUser(userId);
        const queued = includeQueued ? await this.jobs.queuedForUser(userId) : [];

        const seen = new Set<string>();
        const candidates: FleetJobView[] = [];
        for (const job of [...active, ...queued]) {
            if (seen.has(job.id)) continue;
            seen.add(job.id);
            candidates.push(job);
        }

        const byState = Object.fromEntries(
            FLEET_JOB_CANCEL_STATES.map((state) => [state, 0]),
        ) as Record<FleetJobCancelState, number>;
        const jobIds: string[] = [];
        let cancelled = 0;
        let runsCancelled = 0;

        for (const job of candidates) {
            const ctx = correlateAgentTaskJob(job);
            if (ctx?.runId) {
                try {
                    // Owner re-checked by the repository's own WHERE clause.
                    const outcome = await this.agentRuns.cancel(ctx.runId, userId);
                    if (
                        outcome.found &&
                        (outcome.previousStatus === 'queued' ||
                            outcome.previousStatus === 'running')
                    ) {
                        runsCancelled += 1;
                    }
                } catch (error) {
                    this.logger.error(
                        `cancel-in-flight: run ${ctx.runId} for job ${job.id} could not be cancelled: ${
                            error instanceof Error ? error.message : String(error)
                        }`,
                    );
                }
            }
            try {
                const outcome = await this.jobs.cancel(job.id);
                byState[outcome.state] += 1;
                if (outcome.cancelled) cancelled += 1;
                if (jobIds.length < FLEET_CANCEL_IN_FLIGHT_MAX_IDS) jobIds.push(job.id);
            } catch (error) {
                this.logger.error(
                    `cancel-in-flight: job ${job.id} could not be cancelled: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                );
            }
        }

        this.logger.warn(
            `cancel-in-flight by ${userId}: requested ${candidates.length}, cancelled ${cancelled}, runs ${runsCancelled}, includeQueued=${includeQueued}`,
        );
        const auditFailed = !(await this.tryAudit('cancel-in-flight', userId, {
            includeQueued,
            requested: candidates.length,
            cancelled,
            runsCancelled,
            byState,
            jobIds,
        }));

        return {
            requested: candidates.length,
            cancelled,
            runsCancelled,
            byState,
            jobIds,
            auditFailed,
        };
    }

    /** Audit after the action; a failure is logged and reported, never thrown. */
    private async tryAudit(
        action: FleetAuditAction,
        userId: string,
        details: Record<string, unknown>,
    ): Promise<boolean> {
        try {
            await this.audit.record({
                action,
                actorUserId: userId,
                ownerUserId: userId,
                details,
            });
            return true;
        } catch (error) {
            this.logger.error(
                `fleet audit row for ${action} by ${userId} could not be written: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return false;
        }
    }
}
