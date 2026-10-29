import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Not, type Repository } from 'typeorm';
import {
    APP_FAILURE_LOG_TAIL_LINES,
    redactSecrets,
    type TaskDeliveryDeployOutcome,
} from '@ever-works/contracts';
import { ownershipScopeOf } from '../database/ownership-scope';
import { Task, TaskPriority, TaskStatus } from '../entities/task.entity';
import { TaskRelation } from '../entities/task-relation.entity';
import { AgentEscalation } from '../entities/agent-escalation.entity';
import { AgentEscalationService } from '../agents/agent-escalation.service';
import { heuristicConfidence } from '../agents/escalation-confidence';
import { TasksService } from '../tasks-domain/tasks.service';
import { TaskTransitionService } from '../tasks-domain/task-transition.service';
import { fenceUntrusted } from '../utils/untrusted-content';
import { ActivityActionType, ActivityStatus } from '../entities/activity-log.types';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { readAppDeliveryDefaults } from './app-delivery-defaults';

/**
 * APW-08 T21 / T55 — the automatic follow-up Task of a merged App Work change that failed to
 * build or deploy (spec FR-36…FR-40, S7, S22, S24; plan §6).
 *
 * ## One follow-up per failure record, keyed on a server-written column (APW08-G23)
 *
 * `followUpKey = followup:<originalTaskId>:<failedBuildOrDeploymentId>` is written on the new Task
 * INSIDE its create transaction (`TasksService.create`'s `withinCreate`), and
 * `uq_tasks_follow_up_key` is UNIQUE — so two reconcilers racing on the same failure create one
 * Task (the loser's whole create rolls back), and nothing a user does to labels changes it. The
 * lineage is the ordinary `follow-up` Task relation (the follow-up → the original).
 *
 * ## The budget (FR-37, FR-38; APW08-G25 `CL-08-5`)
 *
 * At most `EVER_WORKS_APP_FOLLOW_UPS_PER_CHANGE` (2) automatic follow-ups per merged change,
 * counted along the follow-up chain (the original, its follow-up, the follow-up's follow-up …),
 * and at most `EVER_WORKS_APP_FOLLOW_UPS_OPEN_PER_WORK` (3) OPEN automatic follow-ups per App Work.
 * Past either, the failure raises a `delivery-failed` escalation (the S22 Inbox item, with **Try
 * once more**) instead — and so does a follow-up that could not be created: a failure must reach
 * a person (plan §8.2). **Try once more** (`manual: true`) is a person's decision and skips both
 * counters; the escalation row is its one-shot token (plan §4, APW08-G21), consumed by the caller
 * before this runs.
 *
 * ## What the follow-up carries (FR-36)
 *
 * Title **"Fix failed build of {shortSha}"** / **"Fix failed deployment of {shortSha}"**, on the
 * same App Work, assigned to the original Task's Agent, priority High (`p1`), and a description
 * naming the phase, the outcome, the Build / Deployment and — inside an untrusted-content fence,
 * secret-redacted — the last {@link APP_FAILURE_LOG_TAIL_LINES} lines of what APW-05/06 recorded
 * (`work_builds.failureExcerpt`, already redacted by APW-05; the Deployment's `lastError` and
 * failure message). No log is fetched here (APW-05 FR-38). When the original Task has an Agent the
 * follow-up is started through the ordinary dispatch path (`TasksService.runTask`), which reads
 * the operator's change switch itself (T49).
 *
 * Every method is best-effort toward its caller (the reconciler): a throw here is logged and the
 * reconciler moves on.
 */

/** The S24 note on an automatic follow-up that a later live Deployment made unnecessary. */
export const FOLLOW_UP_NO_LONGER_NEEDED_NOTE =
    'No longer needed — a later deployment containing this change is live.';

/** FR-36 — `followup:<originalTaskId>:<failureId>`. 82 characters for two uuids. */
export function followUpKeyOf(originalTaskId: string, failureId: string): string {
    return `followup:${originalTaskId}:${failureId}`;
}

/** The escalation dedup key for one failure record of one change. */
export function deliveryEscalationKeyOf(taskId: string, failureId: string): string {
    return `delivery-failed:${taskId}:${failureId}`;
}

/** The 7-character commit id the follow-up title names (FR-36). */
export function shortSha(sha: string | null | undefined): string {
    return (sha ?? '').trim().slice(0, 7) || 'unknown';
}

export function followUpTitle(phase: 'build' | 'deploy', sha: string | null | undefined): string {
    return phase === 'build'
        ? `Fix failed build of ${shortSha(sha)}`
        : `Fix failed deployment of ${shortSha(sha)}`;
}

const OUTCOME_LABEL: Record<TaskDeliveryDeployOutcome, string> = {
    failed: 'failed',
    rolled_back: 'rolled back',
    rollback_failed: 'rollback failed',
    live_with_warnings: 'live with warnings (treated as a failure by the operator setting)',
};

/** What failed, as the reconciler saw it. Ids and already-recorded text only. */
export interface DeliveryFailure {
    /** The Task whose merged change failed. */
    readonly task: Task;
    readonly work: {
        readonly id: string;
        readonly userId: string;
        readonly name?: string | null;
        readonly tenantId?: string | null;
        readonly organizationId?: string | null;
    };
    readonly phase: 'build' | 'deploy';
    /** The Build or Deployment id whose failure this is — the dedup key's second half. */
    readonly failureId: string;
    /** The commit that failed (the Build's / Deployment's), for the title. */
    readonly failedSha: string | null;
    readonly outcome: TaskDeliveryDeployOutcome | null;
    readonly build?: {
        readonly id: string;
        readonly number?: number | null;
        readonly status: string;
        readonly logsUrl?: string | null;
        readonly failureClass?: string | null;
        readonly notDeployableReason?: string | null;
        readonly blockedReason?: string | null;
        readonly failureExcerpt?: readonly string[] | null;
    } | null;
    readonly deployment?: {
        readonly id: string;
        readonly state: string;
        readonly lastError?: string | null;
        readonly appRender?: Record<string, unknown> | null;
    } | null;
}

export type FollowUpResult =
    | { readonly kind: 'opened'; readonly taskId: string; readonly dispatched: boolean }
    | { readonly kind: 'exists'; readonly taskId: string }
    | {
          readonly kind: 'escalated';
          readonly reason: 'chain-limit' | 'work-limit' | 'create-failed';
          readonly escalationId: string | null;
      }
    | { readonly kind: 'skipped'; readonly reason: string };

/** How far up / down a follow-up chain is walked, at most (a chain is 3 deep by default). */
const CHAIN_WALK_MAX = 50;

@Injectable()
export class DeliveryFollowUpService {
    private readonly logger = new Logger(DeliveryFollowUpService.name);

    constructor(
        @InjectRepository(Task) private readonly tasks: Repository<Task>,
        @InjectRepository(TaskRelation) private readonly relations: Repository<TaskRelation>,
        @Optional()
        @InjectRepository(AgentEscalation)
        private readonly escalationRows?: Repository<AgentEscalation>,
        @Optional() private readonly tasksService?: TasksService,
        @Optional() private readonly escalations?: AgentEscalationService,
        @Optional() private readonly transitions?: TaskTransitionService,
        @Optional() private readonly activityLog?: ActivityLogService,
    ) {}

    /**
     * Open the follow-up for one failure record — or the escalation, past the budget. Idempotent:
     * the reconciler may call it on every tick while the change is failed.
     */
    async open(failure: DeliveryFailure, opts: { manual?: boolean } = {}): Promise<FollowUpResult> {
        const { task } = failure;
        const key = followUpKeyOf(task.id, failure.failureId);

        const existing = await this.tasks.findOne({ where: { followUpKey: key } });
        if (existing) return { kind: 'exists', taskId: existing.id };

        if (!opts.manual) {
            // An escalation already raised for this failure record answers for it; a person
            // decides (Close anyway / Try once more), and the tick does not ask again.
            const escalationKey = deliveryEscalationKeyOf(task.id, failure.failureId);
            if (this.escalationRows) {
                const raised = await this.escalationRows.findOne({ where: { dedupKey: escalationKey } });
                if (raised) return { kind: 'skipped', reason: 'escalated' };
            }

            const limits = readAppDeliveryDefaults();
            const inChain = await this.countChain(task);
            if (inChain >= limits.followUpsPerChange) {
                return this.escalate(failure, 'chain-limit', inChain);
            }
            const openForWork = await this.countOpenForWork(failure.work.id);
            if (openForWork >= limits.followUpsOpenPerWork) {
                return this.escalate(failure, 'work-limit', inChain);
            }
        }

        if (!this.tasksService) return this.escalate(failure, 'create-failed', 0);

        const scope = ownershipScopeOf(failure.work);
        let created: Task;
        try {
            created = await this.tasksService.create(
                failure.work.userId,
                {
                    title: followUpTitle(failure.phase, failure.failedSha),
                    description: describeFailure(failure),
                    priority: TaskPriority.P1,
                    status: TaskStatus.TODO,
                    workId: failure.work.id,
                    agentId: task.agentId ?? null,
                    createdByType: 'user',
                    createdById: failure.work.userId,
                },
                scope,
                {
                    // Inside the create transaction: a unique violation (a racing reconciler won)
                    // rolls this Task back instead of leaving a duplicate behind.
                    withinCreate: async (row, manager) => {
                        const repository = manager ? manager.getRepository(Task) : this.tasks;
                        await repository.update({ id: row.id }, { followUpKey: key });
                        Object.assign(row, { followUpKey: key });
                    },
                },
            );
        } catch (error) {
            const winner = await this.tasks.findOne({ where: { followUpKey: key } }).catch(() => null);
            if (winner) return { kind: 'exists', taskId: winner.id };
            this.logger.warn(
                `Delivery follow-up for task ${task.id} could not be created (${errorText(error)}); escalating.`,
            );
            return this.escalate(failure, 'create-failed', 0);
        }

        try {
            await this.tasksService.addRelation(
                failure.work.userId,
                created.id,
                task.id,
                'follow-up',
                scope,
            );
        } catch (error) {
            this.logger.warn(
                `Delivery follow-up ${created.id}: the follow-up relation to ${task.id} failed (${errorText(error)}).`,
            );
        }

        let dispatched = false;
        if (created.agentId) {
            try {
                const run = await this.tasksService.runTask(
                    failure.work.userId,
                    created.id,
                    { agentId: created.agentId },
                    scope,
                );
                dispatched = run.dispatched === true;
            } catch (error) {
                // The Task exists and is assigned; a refused dispatch (a switch, credits) leaves
                // it for a person to run — never rolled back.
                this.logger.warn(
                    `Delivery follow-up ${created.id}: dispatch failed (${errorText(error)}).`,
                );
            }
        }
        return { kind: 'opened', taskId: created.id, dispatched };
    }

    /**
     * FR-39 / S24 — cancel the original Task's OPEN automatic follow-ups once a Deployment that
     * contains its change is live. A follow-up whose own change has already merged is left to
     * its own delivery (S8: it closes when its Deployment goes live). Returns how many moved.
     */
    async cancelObsolete(original: Task): Promise<number> {
        if (!this.transitions) return 0;
        const children = await this.automaticChildren(original.id);
        let cancelled = 0;
        for (const child of children) {
            if (child.status === TaskStatus.DONE || child.status === TaskStatus.CANCELLED) continue;
            if (child.deliveryState || child.prState === 'merged') continue;
            try {
                await this.transitions.transition(child, TaskStatus.CANCELLED, {});
                cancelled += 1;
                await this.recordCancelled(child, original);
            } catch (error) {
                this.logger.warn(
                    `Delivery follow-up ${child.id} could not be cancelled (${errorText(error)}).`,
                );
            }
        }
        return cancelled;
    }

    /** The S24 note, on the cancelled follow-up's own feed. Best-effort. */
    private async recordCancelled(child: Task, original: Task): Promise<void> {
        if (!this.activityLog) return;
        try {
            await this.activityLog.log({
                userId: child.userId,
                ...(child.workId ? { workId: child.workId } : {}),
                actionType: ActivityActionType.APP_CHANGE,
                action: 'app.change.closed',
                status: ActivityStatus.CANCELLED,
                summary: FOLLOW_UP_NO_LONGER_NEEDED_NOTE,
                details: {
                    resourceType: 'task',
                    resourceId: child.id,
                    taskId: child.id,
                    originalTaskId: original.id,
                    outcome: 'follow_up_cancelled',
                },
                tenantId: child.tenantId ?? null,
                organizationId: child.organizationId ?? null,
            });
        } catch (error) {
            this.logger.warn(
                `Delivery follow-up ${child.id}: the cancellation note was not recorded (${errorText(error)}).`,
            );
        }
    }

    /** The follow-up Tasks filed for `originalTaskId` (automatic or by hand), newest first. */
    async listFollowUps(originalTaskId: string): Promise<Task[]> {
        const rows = await this.relations.find({
            where: { relatedTaskId: originalTaskId, kind: 'follow-up' },
            take: CHAIN_WALK_MAX,
        });
        if (rows.length === 0) return [];
        const tasks = await this.tasks.find({ where: { id: In(rows.map((row) => row.taskId)) } });
        return tasks.sort((a, b) => time(b.createdAt) - time(a.createdAt));
    }

    /**
     * FR-37 — the automatic follow-ups already opened for this change's chain: walk up to the
     * chain's root (through automatic follow-ups only), then count every automatic follow-up below
     * it. Bounded by {@link CHAIN_WALK_MAX}.
     */
    async countChain(task: Task): Promise<number> {
        let root: Task = task;
        for (let step = 0; step < CHAIN_WALK_MAX && root.followUpKey; step += 1) {
            const up = await this.relations.findOne({ where: { taskId: root.id, kind: 'follow-up' } });
            if (!up) break;
            const parent = await this.tasks.findOne({ where: { id: up.relatedTaskId } });
            if (!parent) break;
            root = parent;
        }

        let count = 0;
        const queue = [root.id];
        const seen = new Set<string>(queue);
        while (queue.length > 0 && seen.size < CHAIN_WALK_MAX) {
            const id = queue.shift() as string;
            for (const child of await this.automaticChildren(id)) {
                if (seen.has(child.id)) continue;
                seen.add(child.id);
                count += 1;
                queue.push(child.id);
            }
        }
        return count;
    }

    /** FR-38 — open automatic follow-ups on one App Work. */
    async countOpenForWork(workId: string): Promise<number> {
        return this.tasks.count({
            where: {
                workId,
                followUpKey: Not(IsNull()),
                status: Not(In([TaskStatus.DONE, TaskStatus.CANCELLED])),
            },
        });
    }

    private async automaticChildren(taskId: string): Promise<Task[]> {
        const rows = await this.relations.find({
            where: { relatedTaskId: taskId, kind: 'follow-up' },
            take: CHAIN_WALK_MAX,
        });
        if (rows.length === 0) return [];
        return this.tasks.find({
            where: { id: In(rows.map((row) => row.taskId)), followUpKey: Not(IsNull()) },
        });
    }

    private async escalate(
        failure: DeliveryFailure,
        reason: 'chain-limit' | 'work-limit' | 'create-failed',
        inChain: number,
    ): Promise<FollowUpResult> {
        if (!this.escalations) return { kind: 'escalated', reason, escalationId: null };
        const name = failure.work.name?.trim() || 'This app';
        const what = failure.phase === 'build' ? 'builds' : 'deployments';
        const attempts = inChain + 1;
        const summary =
            reason === 'chain-limit'
                ? `${name}: ${attempts} ${what} of this change failed. An agent has tried ${triedText(inChain)}.`
                : reason === 'work-limit'
                  ? `${name}: a merged change failed to ${failure.phase === 'build' ? 'build' : 'deploy'}, and this app already has the most open fix Tasks allowed.`
                  : `${name}: a merged change failed to ${failure.phase === 'build' ? 'build' : 'deploy'}, and the fix Task could not be opened.`;
        const attempted = [
            {
                label: failure.phase,
                outcome: failure.outcome ? OUTCOME_LABEL[failure.outcome] : `${failure.phase} failed`,
            },
        ];
        const row = await this.escalations.record({
            userId: failure.work.userId,
            reasonCode: 'delivery-failed',
            summary,
            decisionNeeded: 'Open the Task, close it anyway, or try once more.',
            taskId: failure.task.id,
            workId: failure.work.id,
            agentId: failure.task.agentId ?? null,
            attempted,
            tenantId: failure.task.tenantId ?? null,
            organizationId: failure.task.organizationId ?? null,
            dedupKey: deliveryEscalationKeyOf(failure.task.id, failure.failureId),
            // The deterministic table — a reconciler tick never spends a model call on scoring.
            confidence: heuristicConfidence({ reasonCode: 'delivery-failed', attempted }),
            confidenceSource: 'heuristic',
        });
        return { kind: 'escalated', reason, escalationId: row?.id ?? null };
    }
}

/** FR-36's description: phase, outcome, links, and the fenced, redacted log tail. */
export function describeFailure(failure: DeliveryFailure): string {
    const lines: string[] = [];
    const sha = shortSha(failure.failedSha);
    if (failure.phase === 'build') {
        const build = failure.build;
        lines.push(
            `The build of ${sha} failed after this App Work's change was merged (follow-up of ${failure.task.slug ?? failure.task.id}).`,
            '',
            `- Phase: build`,
            `- Outcome: ${build?.status ?? 'failed'}${build?.failureClass ? ` (${build.failureClass})` : ''}`,
        );
        if (build?.notDeployableReason) lines.push(`- Not deployable: ${build.notDeployableReason}`);
        if (build?.blockedReason) lines.push(`- Blocked: ${build.blockedReason}`);
        if (build) lines.push(`- Build: #${build.number ?? '?'} (${build.id})`);
        if (build?.logsUrl) lines.push(`- Logs: ${build.logsUrl}`);
    } else {
        const deployment = failure.deployment;
        lines.push(
            `The deployment of ${sha} did not go live after this App Work's change was merged (follow-up of ${failure.task.slug ?? failure.task.id}).`,
            '',
            `- Phase: deploy`,
            `- Outcome: ${failure.outcome ? OUTCOME_LABEL[failure.outcome] : 'failed'}`,
        );
        if (deployment) lines.push(`- Deployment: ${deployment.id}`);
    }

    const tail = failureLogTail(failure);
    if (tail.length > 0) {
        lines.push(
            '',
            `Last ${tail.length} line${tail.length === 1 ? '' : 's'} of the failure log (untrusted; secrets redacted):`,
            '',
            fenceUntrusted('failure_log', tail.join('\n')),
        );
    }
    lines.push('', 'Find the cause, fix it on a branch and open a pull request.');
    return lines.join('\n');
}

/** The recorded failure text, capped to the last {@link APP_FAILURE_LOG_TAIL_LINES} lines, redacted. */
export function failureLogTail(failure: DeliveryFailure): string[] {
    const raw: string[] = [];
    if (failure.phase === 'build') {
        raw.push(...(failure.build?.failureExcerpt ?? []).map((line) => String(line ?? '')));
    } else {
        const render = failure.deployment?.appRender;
        const recorded =
            render && typeof render === 'object' && render.failure && typeof render.failure === 'object'
                ? (render.failure as Record<string, unknown>)
                : null;
        if (typeof recorded?.message === 'string' && recorded.message.trim()) {
            raw.push(...recorded.message.split(/\r?\n/));
        }
        const lastError = failure.deployment?.lastError;
        if (typeof lastError === 'string' && lastError.trim()) raw.push(...lastError.split(/\r?\n/));
    }
    // Redact the WHOLE recorded text first, then split and take the tail (review of #3030): a PEM
    // private key spans lines, so a per-line pass leaves its body lines untouched, and a tail cut
    // first can drop the header that marks them. A key whose footer was cut off is removed from its
    // header to the end — the body lines carry no marker of their own.
    const joined = raw
        .join('\n')
        .replace(UNTERMINATED_PEM_PRIVATE_KEY, '[REDACTED:pem_private_key]');
    return redactSecrets(joined).cleaned.split('\n').slice(-APP_FAILURE_LOG_TAIL_LINES);
}

/** A PEM private-key header with no matching footer after it, through the end of the text. */
const UNTERMINATED_PEM_PRIVATE_KEY =
    /-----BEGIN ((?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY)-----(?![\s\S]*-----END \1-----)[\s\S]*$/;

function triedText(count: number): string {
    if (count <= 1) return 'once';
    if (count === 2) return 'twice';
    return `${count} times`;
}

function time(value: Date | string | null | undefined): number {
    const ms = value ? new Date(value).getTime() : 0;
    return Number.isFinite(ms) ? ms : 0;
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
