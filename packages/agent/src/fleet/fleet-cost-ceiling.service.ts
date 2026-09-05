import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { FleetCostCeilingView } from '@ever-works/contracts';
import { config } from '../config';
import type { FleetNode } from '../entities/fleet-node.entity';
import { INBOX_PRODUCER, type InboxProducer } from '../inbox/inbox-producer.port';
import { normalizeDailyCeilingCents, utcDay, utcDayStart } from './fleet-cost-ceiling.shared';
import { FleetCostPolicyRepository } from './fleet-cost-policy.repository';
import { FleetJobRepository } from './fleet-job.repository';
import { FleetJobService } from './fleet-job.service';
import { FleetNodeRepository } from './fleet-node.repository';
import { FleetService } from './fleet.service';

export { normalizeDailyCeilingCents, utcDay, utcDayStart } from './fleet-cost-ceiling.shared';

/** What the reconciler hands over once a fleet job's cost has been stamped. */
export interface FleetCostCeilingCompletion {
    userId: string;
    /** The node that reported, when one did. */
    nodeId: string | null;
    jobId: string;
    /**
     * Cents this completion cost. `0` when no model ran; `null` when a
     * model RAN and its spend is unobservable (the CLI printed no price) —
     * which a configured ceiling treats as a crossing, never as free.
     */
    costCents: number | null;
    runId?: string | null;
    taskId?: string | null;
    agentId?: string | null;
    workId?: string | null;
    organizationId?: string | null;
    /** Injectable clock — the UTC day is derived from it. */
    now?: Date;
}

export type FleetCostCeilingOutcome =
    /** No ceiling configured for this scope. */
    | 'none'
    /** Below the ceiling. */
    | 'ok'
    /** At or above the ceiling — drained. */
    | 'crossed'
    /** A ceiling is configured but the spend could not be evaluated — drained (fail closed). */
    | 'unevaluable';

export interface FleetCostCeilingScopeVerdict {
    ceilingCents: number | null;
    spendCents: number | null;
    outcome: FleetCostCeilingOutcome;
    /** Why an `unevaluable` verdict could not be evaluated. */
    reason?: string;
}

export interface FleetCostCeilingVerdict {
    /** UTC day (`YYYY-MM-DD`) the sums cover. */
    day: string;
    node: FleetCostCeilingScopeVerdict;
    fleet: FleetCostCeilingScopeVerdict;
    /** Every node this evaluation drained (deduplicated). */
    drainedNodeIds: string[];
    /** Inbox notices filed by THIS evaluation (0 on a repeat crossing). */
    noticesFiled: number;
}

const NONE: FleetCostCeilingScopeVerdict = {
    ceilingCents: null,
    spendCents: null,
    outcome: 'none',
};

/**
 * Fleet cost accounting (EW-777) — the per-node and fleet-wide DAILY
 * model-spend ceilings.
 *
 * Evaluated by the API-side reconciler after every `agent-task` job
 * completion, once the job's cost has been stamped on `fleet_jobs`:
 *
 *   1. resolve the ceilings — the node's own column, else the deployment
 *      default (`FLEET_NODE_DAILY_COST_CEILING_USD`); the owner's policy
 *      row, else `FLEET_DAILY_COST_CEILING_USD`. Neither configured (the
 *      shipped default) ⇒ nothing happens, which is the point: enabling
 *      a ceiling is an explicit decision;
 *   2. sum `fleet_jobs.costCents` since the start of the UTC day — per
 *      node, and across every job of the owner;
 *   3. at or above a ceiling ⇒ DRAIN through the exact pair the drain
 *      endpoint composes (`FleetService.setDisabledForUser` +
 *      `FleetJobService.releaseClaimsForNode`) — for the fleet-wide
 *      ceiling, every enrolled node of the owner — and file ONE Inbox
 *      notice per (scope, day), through the CAS on the trip columns.
 *
 * **Fail closed.** A configured ceiling that cannot be evaluated — the
 * spend lookup threw, the sum is not a number, or the completing job's
 * own cost is `null` because its CLI reported no price — is treated as a
 * crossing: the node is drained and the notice says why. A ceiling that
 * silently permitted whenever it could not count would not be a ceiling.
 *
 * `disabled`, not `paused`, deliberately: a node can lift its own pause
 * (`FleetService.setPausedByCredential`) but not an owner-level disable,
 * and the drained node stays disabled past midnight until the owner
 * re-enables it — a ceiling is a stop, not a rate limit.
 *
 * Only `fleet_jobs.costCents` is summed: the spend the owner's own
 * machines reported. The account's cloud spend and BYOK usage rows have
 * their own budgets and are never folded in.
 */
@Injectable()
export class FleetCostCeilingService {
    private readonly logger = new Logger(FleetCostCeilingService.name);

    constructor(
        private readonly nodes: FleetNodeRepository,
        private readonly jobs: FleetJobRepository,
        private readonly policies: FleetCostPolicyRepository,
        private readonly fleet: FleetService,
        private readonly jobService: FleetJobService,
        @Optional() @Inject(INBOX_PRODUCER) private readonly inbox?: InboxProducer,
    ) {}

    /** The owner's fleet-wide ceiling as the settings page shows it. */
    async describeForUser(userId: string, now: Date = new Date()): Promise<FleetCostCeilingView> {
        const policy = await this.policies.findByUser(userId);
        const owned = policy?.dailyCeilingCents ?? null;
        const fallback = config.fleet.getDefaultFleetDailyCostCeilingCents();
        const effective = owned ?? fallback;
        const day = utcDay(now);
        const todaySpendCents = await this.jobs.sumCostCentsForUserSince(userId, utcDayStart(now));
        return {
            dailyCeilingCents: owned,
            effectiveDailyCeilingCents: effective,
            source: owned !== null ? 'owner' : fallback !== null ? 'default' : 'none',
            trippedOn: policy?.trippedOn ?? null,
            todaySpendCents: Number.isFinite(todaySpendCents) ? todaySpendCents : 0,
            day,
        };
    }

    /** Set (or clear) the owner's fleet-wide ceiling; validated like the per-node one. */
    async setFleetCeilingForUser(
        userId: string,
        dailyCeilingCents: unknown,
    ): Promise<FleetCostCeilingView> {
        await this.policies.upsertCeiling(userId, normalizeDailyCeilingCents(dailyCeilingCents));
        return this.describeForUser(userId);
    }

    /**
     * Evaluate both ceilings for a completion whose cost is already
     * stamped on the job. Never throws: an evaluation failure is a
     * fail-closed drain, and a drain failure is logged at error level —
     * the reconciler that called us has a run to settle either way.
     */
    async evaluateAfterCompletion(
        input: FleetCostCeilingCompletion,
    ): Promise<FleetCostCeilingVerdict> {
        const now = input.now ?? new Date();
        const day = utcDay(now);
        const dayStart = utcDayStart(now);
        const verdict: FleetCostCeilingVerdict = {
            day,
            node: NONE,
            fleet: NONE,
            drainedNodeIds: [],
            noticesFiled: 0,
        };

        let node: FleetNode | null = null;
        let nodeCeiling: number | null = null;
        let fleetCeiling: number | null = null;
        try {
            if (input.nodeId) {
                const row = await this.nodes.findById(input.nodeId);
                node = row && row.userId === input.userId ? row : null;
            }
            nodeCeiling = node
                ? (node.dailyCostCeilingCents ?? config.fleet.getDefaultNodeDailyCostCeilingCents())
                : null;
            const policy = await this.policies.findByUser(input.userId);
            fleetCeiling =
                policy?.dailyCeilingCents ?? config.fleet.getDefaultFleetDailyCostCeilingCents();
        } catch (error) {
            // Cannot even tell whether a ceiling applies. Fail closed on the
            // reporting node: draining a machine for a lookup hiccup is
            // recoverable in one click; running unbounded is not.
            const reason = `ceiling lookup failed: ${describeError(error)}`;
            this.logger.error(
                `Fleet cost ceiling: ${reason} (user ${input.userId}) — draining node ${input.nodeId}`,
            );
            verdict.node = { ceilingCents: null, spendCents: null, outcome: 'unevaluable', reason };
            if (input.nodeId) {
                await this.tripNode(
                    input,
                    node ?? { id: input.nodeId, name: input.nodeId },
                    verdict,
                    day,
                );
            }
            return verdict;
        }

        if (nodeCeiling === null && fleetCeiling === null) return verdict;

        if (node && nodeCeiling !== null) {
            const nodeId = node.id;
            verdict.node = await this.evaluateScope(nodeCeiling, input.costCents, () =>
                this.jobs.sumCostCentsForNodeSince(nodeId, dayStart),
            );
        }
        if (fleetCeiling !== null) {
            verdict.fleet = await this.evaluateScope(fleetCeiling, input.costCents, () =>
                this.jobs.sumCostCentsForUserSince(input.userId, dayStart),
            );
        }

        if (node && tripped(verdict.node)) {
            await this.tripNode(input, node, verdict, day);
        }
        if (tripped(verdict.fleet)) {
            await this.tripFleet(input, verdict, day);
        }
        return verdict;
    }

    private async evaluateScope(
        ceilingCents: number,
        costCents: number | null,
        sum: () => Promise<number>,
    ): Promise<FleetCostCeilingScopeVerdict> {
        if (costCents === null) {
            return {
                ceilingCents,
                spendCents: null,
                outcome: 'unevaluable',
                reason: 'the CLI reported no price for this run, so its spend cannot be counted',
            };
        }
        try {
            const spendCents = await sum();
            if (!Number.isFinite(spendCents)) {
                return {
                    ceilingCents,
                    spendCents: null,
                    outcome: 'unevaluable',
                    reason: 'the daily spend sum is not a number',
                };
            }
            return {
                ceilingCents,
                spendCents,
                outcome: spendCents >= ceilingCents ? 'crossed' : 'ok',
            };
        } catch (error) {
            return {
                ceilingCents,
                spendCents: null,
                outcome: 'unevaluable',
                reason: `the daily spend lookup failed: ${describeError(error)}`,
            };
        }
    }

    /** Drain one node (idempotent) and file its notice iff this is the day's first trip. */
    private async tripNode(
        input: FleetCostCeilingCompletion,
        node: Pick<FleetNode, 'id' | 'name'> & Partial<Pick<FleetNode, 'modelIdentity'>>,
        verdict: FleetCostCeilingVerdict,
        day: string,
    ): Promise<void> {
        await this.drain(input.userId, node.id, verdict);
        let first = false;
        try {
            first = await this.nodes.casTripDailyCeiling(node.id, day);
        } catch (error) {
            this.logger.warn(
                `Fleet cost ceiling: trip CAS failed for node ${node.id}: ${describeError(error)}`,
            );
        }
        if (!first) return;
        const filed = await this.notify(input, {
            title: `Fleet daily cost ceiling reached: ${node.name}`,
            body: composeNoticeBody({
                scope: `Node "${node.name}"`,
                verdict: verdict.node,
                day,
                jobId: input.jobId,
                drainedCount: 1,
                billedTo: node.modelIdentity ?? null,
            }),
        });
        if (filed) verdict.noticesFiled += 1;
    }

    /** Drain every enrolled node of the owner and file ONE notice iff this is the day's first fleet trip. */
    private async tripFleet(
        input: FleetCostCeilingCompletion,
        verdict: FleetCostCeilingVerdict,
        day: string,
    ): Promise<void> {
        let rows: FleetNode[] = [];
        try {
            rows = await this.nodes.findByUser(input.userId);
        } catch (error) {
            this.logger.error(
                `Fleet cost ceiling: could not list nodes of user ${input.userId} for the fleet-wide drain: ${describeError(error)}`,
            );
            // At least the reporting node stops.
            if (input.nodeId) await this.drain(input.userId, input.nodeId, verdict);
        }
        for (const row of rows) {
            // An `enrolling` row is a token, not a machine — disabling it
            // would revoke an enrollment in progress for a ceiling it
            // could not have contributed to.
            if (row.status === 'enrolling') continue;
            await this.drain(input.userId, row.id, verdict);
        }
        let first = false;
        try {
            first = await this.policies.casTrip(input.userId, day);
        } catch (error) {
            this.logger.warn(
                `Fleet cost ceiling: fleet trip CAS failed for user ${input.userId}: ${describeError(error)}`,
            );
        }
        if (!first) return;
        const filed = await this.notify(input, {
            title: 'Fleet-wide daily cost ceiling reached',
            body: composeNoticeBody({
                scope: 'Your fleet',
                verdict: verdict.fleet,
                day,
                jobId: input.jobId,
                drainedCount: verdict.drainedNodeIds.length,
                billedTo: null,
            }),
        });
        if (filed) verdict.noticesFiled += 1;
    }

    /**
     * The drain endpoint's exact pair, in its order: disable FIRST (the
     * node stops being leasable the instant its status flips), then
     * requeue the claims it holds so the work is picked up elsewhere.
     */
    private async drain(
        userId: string,
        nodeId: string,
        verdict: FleetCostCeilingVerdict,
    ): Promise<void> {
        try {
            await this.fleet.setDisabledForUser(userId, nodeId, true);
            await this.jobService.releaseClaimsForNode(userId, nodeId);
            if (!verdict.drainedNodeIds.includes(nodeId)) verdict.drainedNodeIds.push(nodeId);
        } catch (error) {
            this.logger.error(
                `Fleet cost ceiling: draining node ${nodeId} failed: ${describeError(error)}`,
            );
        }
    }

    /** File the notice; true only when it actually reached the Inbox. */
    private async notify(
        input: FleetCostCeilingCompletion,
        message: { title: string; body: string },
    ): Promise<boolean> {
        if (!this.inbox) {
            this.logger.warn(
                `Fleet cost ceiling: no Inbox producer bound — "${message.title}" was not filed`,
            );
            return false;
        }
        try {
            await this.inbox.notice(input.userId, {
                title: message.title,
                body: message.body,
                agentId: input.agentId ?? null,
                agentRunId: input.runId ?? null,
                taskId: input.taskId ?? null,
                workId: input.workId ?? null,
                organizationId: input.organizationId ?? null,
            });
            return true;
        } catch (error) {
            this.logger.warn(`Fleet cost ceiling: Inbox notice failed: ${describeError(error)}`);
            return false;
        }
    }
}

function tripped(scope: FleetCostCeilingScopeVerdict): boolean {
    return scope.outcome === 'crossed' || scope.outcome === 'unevaluable';
}

function formatUsd(cents: number | null): string {
    return cents === null ? 'an unknown amount' : `$${(cents / 100).toFixed(2)}`;
}

function composeNoticeBody(input: {
    scope: string;
    verdict: FleetCostCeilingScopeVerdict;
    day: string;
    jobId: string;
    drainedCount: number;
    billedTo: string | null;
}): string {
    const { scope, verdict, day, jobId, drainedCount, billedTo } = input;
    const ceiling = formatUsd(verdict.ceilingCents);
    const drained =
        drainedCount === 1
            ? 'The node has been drained: no new work will be leased onto it, and the claims it held were returned to the queue.'
            : `${drainedCount} nodes have been drained: no new work will be leased onto them, and the claims they held were returned to the queue.`;
    const lines: string[] = [];
    if (verdict.outcome === 'unevaluable') {
        lines.push(
            `${scope} has a daily model-spend ceiling of ${ceiling}, but the spend of fleet job ${jobId} could not be evaluated: ${verdict.reason ?? 'unknown reason'}.`,
            'A ceiling that cannot count fails closed rather than permitting.',
        );
    } else {
        lines.push(
            `${scope} reported ${formatUsd(verdict.spendCents)} of model spend on ${day} (UTC), at or above the daily ceiling of ${ceiling}.`,
        );
    }
    lines.push(
        drained,
        "It stays disabled until you re-enable it in Fleet settings — the ceiling is a stop, not a rate limit — so raise the ceiling first if today's spend was expected. The day boundary is midnight UTC.",
        "The figure is the CLI's own estimate (Claude Code prices at API list rates even on a subscription seat; Codex reports no price at all). Nothing was debited from platform credits.",
    );
    if (billedTo) lines.push(`Billed to: ${billedTo}.`);
    return lines.join('\n');
}

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
