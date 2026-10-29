import { Injectable, Logger, Optional, UnprocessableEntityException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, type Repository } from 'typeorm';
import type { GitPullRequestStatus } from '@ever-works/plugin';
import {
    APP_DELIVERY_RECONCILE_BATCH,
    TASK_DELIVERY_CLOSABLE_STATES,
    TASK_DELIVERY_CLOSE_NOTE_MAX,
    TASK_DELIVERY_OPEN_STATES,
    TASK_DELIVERY_STATES,
    isAppWorkKind,
    normalizeCommitSha,
    type TaskDeliveryState,
    type TaskDeliveryView,
} from '@ever-works/contracts';
import { Task, TaskStatus } from '../entities/task.entity';
import { WorkBuild } from '../entities/work-build.entity';
import { DeploymentEnvironment, WorkDeployment } from '../entities/work-deployment.entity';
import { WorkAppRuntimeState } from '../entities/work-app-runtime-state.entity';
import type { Work } from '../entities/work.entity';
import { ActivityActionType, ActivityStatus } from '../entities/activity-log.types';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { WorkRepository } from '../database/repositories/work.repository';
import { WorkAppSpecStateRepository } from '../database/repositories/work-app-spec-state.repository';
import type { OwnershipScope } from '../database/ownership-scope';
import { AgentEscalationService } from '../agents/agent-escalation.service';
import { AppSpecService, isUsableAppSpecStatus } from '../app-spec/app-spec.service';
import { GitFacadeService } from '../facades/git.facade';
import { TaskTransitionService } from '../tasks-domain/task-transition.service';
import { pickOwnerRepo, requireTaskRepository } from '../tasks-domain/task-repository';
import type { TaskDeliveryTracker } from '../tasks-domain/task-delivery.port';
import { readAppWorkSwitches } from './app-work-switches';
import { readAppDeliveryDefaults } from './app-delivery-defaults';
import { AppChangeTelemetry } from './app-change.telemetry';
import {
    ancestryQuestions,
    decideDelivery,
    deploymentFailureOutcome,
    deploymentHasWarnings,
    type DeliveryDecision,
} from './task-delivery.rules';
import { DeliveryFollowUpService, type DeliveryFailure } from './delivery-follow-up.service';

/**
 * APW-08 T21 — the delivery chain: a merged App Work change followed through Build and
 * Deployment until it is live, then the Task closed (spec FR-29…FR-40; plan §2.4, §6).
 *
 * ## Three entry points
 *
 * - **The merge hook** (`isDeliveryTracked` / `recordMerge`, through `TASK_DELIVERY_TRACKER`): the
 *   PR-status sweep asks, for a pull request it just saw merged, whether the merge is one this
 *   chain follows — an App Work whose pull request merged INTO its tracked source branch, with a
 *   merge commit the provider reported. Tracked → the merge is recorded (`deliveryState =
 *   'merged'`, one `app.change.merged` Activity row) and the sweep does NOT complete the Task.
 *   Anything else completes on merge exactly as before (FR-33, S19): another branch, a non-App
 *   Work, a provider that reports no merge commit, an App Work whose tracked branch is unknown.
 * - **The reconciler** (`reconcile`, the `app-change-delivery` schedule every two minutes): each
 *   tracked Task in an open state, stalest first, ≤ 200 a tick, decided by the pure
 *   `decideDelivery` (plan §2.4's table) over the App Work's newest Builds and Deployments, the
 *   provider's ancestry answers (cached per `(workId, merge, candidate)` for 24 hours), the deploy
 *   target, the auto-deploy switch and the App spec's build strategy. Per-Task isolation: one
 *   Task's error is counted and the tick moves on, its `deliveryUpdatedAt` untouched so it is
 *   retried first.
 * - **The routes** (`getView`, `closeWithoutDeploy`, `requestFollowUp`): the Task page's chain.
 *
 * ## Writes are compare-and-set on `deliveryState` (plan §6, APW08-G17)
 *
 * Every state write is `UPDATE … WHERE id = :id AND deliveryState = :from` — or `IS NULL` when the
 * Task had no state — built per call rather than with the `IS NOT DISTINCT FROM` / `<=>` spelling,
 * so the same predicate runs on Postgres, SQLite, MySQL and MariaDB without a driver branch and
 * without binding a NULL parameter Postgres cannot type. A lost race is a no-op the next tick
 * repeats. `recordMerge` writes only from `deliveryState IS NULL`, and the unique
 * `(workId, mergeCommitSha)` index makes "a merge is recorded once" (S29) a database guarantee.
 * These writes do not bump `updatedAt` (machine state, like the PR cache).
 *
 * ## Closing goes through the state machine
 *
 * `live`, a green Build on a target-None App Work and `build.strategy: none` close the Task through
 * `TaskTransitionService.transition(task, DONE, { actorType: 'agent' })` — the same gates the
 * merge completion passes (approvers, blockers). A refusal leaves the Task where it is and is
 * retried on the next tick.
 *
 * ## The operator's switches (T49) and the owner's defaults (APW08-G25)
 *
 * `EVER_WORKS_APP_AUTO_DEPLOY_ENABLED` off: the chain still reads (states, chips and history stay
 * honest) but no follow-up is opened — an operator stop is not a failure. The three APW08-G25
 * defaults the chain decides come from `app-delivery-defaults.ts`.
 */

export interface DeliverySweepSummary {
    scanned: number;
    changed: number;
    closed: number;
    failed: number;
    followUpsOpened: number;
    escalated: number;
    durationMs: number;
}

/** How many of a Work's newest Builds and Deployments one decision reads. */
const CANDIDATE_ROWS = 20;
/** How many ancestry questions one Task may ask the provider per tick. */
const ANCESTRY_QUESTIONS_MAX = 10;
/** Plan §2.4 — ancestry answers are cached for 24 hours. */
const ANCESTRY_TTL_MS = 24 * 60 * 60 * 1000;
const ANCESTRY_CACHE_MAX = 5_000;

/** CONTRACTS §6 dotted actions of the `app_change` family (+ `progressed`, the timeline's other states). */
export const APP_CHANGE_ACTIONS = Object.freeze({
    merged: 'app.change.merged',
    progressed: 'app.change.progressed',
    live: 'app.change.live',
    failed: 'app.change.failed',
    closed: 'app.change.closed',
    followUpOpened: 'app.change.follow_up_opened',
} as const);

@Injectable()
export class TaskDeliveryService implements TaskDeliveryTracker {
    private readonly logger = new Logger(TaskDeliveryService.name);
    private readonly ancestryCache = new Map<string, { answer: boolean | null; at: number }>();

    constructor(
        @InjectRepository(Task) private readonly tasks: Repository<Task>,
        @InjectRepository(WorkBuild) private readonly builds: Repository<WorkBuild>,
        @InjectRepository(WorkDeployment) private readonly deployments: Repository<WorkDeployment>,
        @InjectRepository(WorkAppRuntimeState)
        private readonly runtimeStates: Repository<WorkAppRuntimeState>,
        private readonly works: WorkRepository,
        @Optional() private readonly specStates?: WorkAppSpecStateRepository,
        @Optional() private readonly specs?: AppSpecService,
        @Optional() private readonly git?: GitFacadeService,
        @Optional() private readonly transitions?: TaskTransitionService,
        @Optional() private readonly followUps?: DeliveryFollowUpService,
        @Optional() private readonly escalations?: AgentEscalationService,
        @Optional() private readonly activityLog?: ActivityLogService,
        @Optional() private readonly telemetry?: AppChangeTelemetry,
    ) {}

    // ── The merge hook ────────────────────────────────────────────────

    /**
     * Is this merge one the delivery chain follows? Only for an App Work whose pull request merged
     * INTO its tracked source branch, with a merge commit the provider reported. A Task already
     * carrying a delivery state stays tracked (the hook must never complete it on a re-read).
     */
    async isDeliveryTracked(task: Task, status: GitPullRequestStatus | null): Promise<boolean> {
        if (task.deliveryState) return true;
        if (!status || status.state !== 'merged' || !task.workId) return false;
        if (!normalizeCommitSha(status.mergeCommitSha ?? null)) return false;
        const work = await this.works.findById(task.workId);
        if (!work || !isAppWorkKind(work.kind)) return false;
        const branch = await this.sourceBranch(work);
        if (!branch) return false;
        return (status.baseRef ?? '').trim() === branch;
    }

    /** Record the merge once (S29): `deliveryState = 'merged'` and one Activity row. */
    async recordMerge(task: Task, status: GitPullRequestStatus): Promise<{ recorded: boolean }> {
        const mergeCommitSha = normalizeCommitSha(status.mergeCommitSha ?? null);
        if (!mergeCommitSha || !task.workId) return { recorded: false };
        if (task.deliveryState) return { recorded: false };
        const now = new Date();
        let landed = false;
        try {
            landed = await this.compareAndSet(task.id, null, {
                mergeCommitSha,
                deliveryState: 'merged',
                deliveryBuildId: null,
                deliveryDeploymentId: null,
                deliveryUpdatedAt: now,
            });
        } catch (error) {
            // The unique (workId, mergeCommitSha) index: this merge is already recorded.
            this.logger.warn(
                `Task ${task.id}: the merge ${mergeCommitSha} was not recorded (${errorText(error)}).`,
            );
            return { recorded: false };
        }
        if (!landed) return { recorded: false };
        Object.assign(task, {
            mergeCommitSha,
            deliveryState: 'merged',
            deliveryBuildId: null,
            deliveryDeploymentId: null,
            deliveryUpdatedAt: now,
        });
        await this.recordActivity(task, APP_CHANGE_ACTIONS.merged, ActivityStatus.IN_PROGRESS, {
            summary: `Change merged (${mergeCommitSha.slice(0, 7)}) — waiting for a build`,
            state: 'merged',
            extra: {
                mergeCommitSha,
                pullRequestNumber: task.prNumber ?? null,
                branch: status.baseRef ?? null,
            },
        });
        this.telemetry?.track(
            'app.change.merged',
            { workId: task.workId, taskId: task.id },
            task.userId,
        );
        return { recorded: true };
    }

    // ── The reconciler ────────────────────────────────────────────────

    /** One `app-change-delivery` tick. Never throws for one Task. */
    async reconcile(opts: { limit?: number } = {}): Promise<DeliverySweepSummary> {
        const started = Date.now();
        const summary: DeliverySweepSummary = {
            scanned: 0,
            changed: 0,
            closed: 0,
            failed: 0,
            followUpsOpened: 0,
            escalated: 0,
            durationMs: 0,
        };
        const limit = Math.max(1, Math.min(opts.limit ?? APP_DELIVERY_RECONCILE_BATCH, APP_DELIVERY_RECONCILE_BATCH));
        const due = await this.tasks.find({
            where: { deliveryState: In([...TASK_DELIVERY_OPEN_STATES]) },
            order: { deliveryUpdatedAt: 'ASC' },
            take: limit,
        });
        summary.scanned = due.length;
        for (const task of due) {
            try {
                const outcome = await this.reconcileTask(task);
                if (outcome.changed) summary.changed += 1;
                if (outcome.closed) summary.closed += 1;
                if (outcome.followUp === 'opened') summary.followUpsOpened += 1;
                if (outcome.followUp === 'escalated') summary.escalated += 1;
            } catch (error) {
                summary.failed += 1;
                this.logger.warn(`Delivery reconcile failed for task ${task.id}: ${errorText(error)}`);
            }
        }
        summary.durationMs = Date.now() - started;
        this.telemetry?.track('app.change.delivery.sweep', {
            scanned: summary.scanned,
            changed: summary.changed,
            failed: summary.failed,
            durationMs: summary.durationMs,
        });
        return summary;
    }

    /** Decide and apply one Task. Exposed for the reconciler and its spec. */
    async reconcileTask(task: Task): Promise<{
        changed: boolean;
        closed: boolean;
        followUp: 'opened' | 'escalated' | null;
        decision: DeliveryDecision | null;
    }> {
        const none = { changed: false, closed: false, followUp: null, decision: null } as const;
        const from = (task.deliveryState ?? null) as TaskDeliveryState | null;
        const mergeCommitSha = normalizeCommitSha(task.mergeCommitSha ?? null);
        if (!from || !mergeCommitSha || !task.workId) return none;

        const work = await this.works.findById(task.workId);
        if (!work) {
            await this.touch(task, from);
            return none;
        }
        const branch = await this.sourceBranch(work);
        if (!branch) {
            await this.touch(task, from);
            return none;
        }

        const [builds, deployments, runtime, buildStrategy] = await Promise.all([
            this.builds.find({
                where: { workId: work.id },
                order: { createdAt: 'DESC' },
                take: CANDIDATE_ROWS,
            }),
            this.deployments.find({
                where: { workId: work.id, environment: DeploymentEnvironment.PRODUCTION },
                order: { createdAt: 'DESC' },
                take: CANDIDATE_ROWS,
            }),
            this.runtimeStates.findOne({ where: { workId: work.id } }),
            this.buildStrategy(work.id),
        ]);

        const decisionInput = {
            mergeCommitSha,
            sourceBranch: branch,
            builds: builds.map((row) => ({
                id: row.id,
                number: row.number,
                status: row.status,
                deployable: row.deployable === true,
                trigger: row.trigger,
                branch: row.branch,
                commitSha: row.commitSha,
                createdAt: row.createdAt,
            })),
            deployments: deployments.map((row) => ({
                id: row.id,
                buildId: row.buildId ?? null,
                commitSha: row.commitSha ?? null,
                state: row.state,
                createdAt: row.createdAt,
                smokeResult: row.smokeResult ?? null,
                appRender: row.appRender ?? null,
                website: row.website ?? null,
            })),
        };
        const ancestry = await this.ancestry(work, mergeCommitSha, ancestryQuestions(decisionInput));
        const switches = readAppWorkSwitches();
        const defaults = readAppDeliveryDefaults();
        const decision = decideDelivery({
            ...decisionInput,
            currentState: from,
            ancestry,
            target: runtime?.target ?? null,
            autoDeploy: runtime?.targetSettings?.autoDeploy !== false && switches.autoDeployEnabled,
            buildStrategy,
            liveWithWarningsCloses: defaults.liveWithWarningsCloses,
        });

        if (decision.kind === 'unchanged') {
            await this.touch(task, from);
            return { ...none, decision };
        }

        let changed = false;
        const sameState =
            decision.state === from &&
            (decision.buildId ?? null) === (task.deliveryBuildId ?? null) &&
            (decision.deploymentId ?? null) === (task.deliveryDeploymentId ?? null);
        if (sameState) {
            await this.touch(task, from);
        } else {
            const now = new Date();
            const landed = await this.compareAndSet(task.id, from, {
                deliveryState: decision.state,
                deliveryBuildId: decision.buildId,
                deliveryDeploymentId: decision.deploymentId,
                deliveryUpdatedAt: now,
            });
            if (!landed) return { ...none, decision };
            changed = true;
            Object.assign(task, {
                deliveryState: decision.state,
                deliveryBuildId: decision.buildId,
                deliveryDeploymentId: decision.deploymentId,
                deliveryUpdatedAt: now,
            });
            if (decision.state !== from) {
                await this.recordStateChange(task, decision, mergeCommitSha);
            }
        }

        let closed = false;
        if (decision.close) {
            closed = await this.closeTask(task);
        }
        if (decision.state === 'live' && this.followUps) {
            await this.followUps.cancelObsolete(task).catch((error: unknown) => {
                this.logger.warn(
                    `Task ${task.id}: cancelling obsolete follow-ups failed (${errorText(error)}).`,
                );
                return 0;
            });
        }

        let followUp: 'opened' | 'escalated' | null = null;
        if (
            (decision.state === 'build_failed' || decision.state === 'deploy_failed') &&
            switches.autoDeployEnabled &&
            this.followUps
        ) {
            const failure = this.failureOf(task, work, decision, builds, deployments);
            if (failure) {
                const result = await this.followUps.open(failure);
                if (result.kind === 'opened') {
                    followUp = 'opened';
                    await this.recordActivity(
                        task,
                        APP_CHANGE_ACTIONS.followUpOpened,
                        ActivityStatus.COMPLETED,
                        {
                            summary: `Follow-up Task opened for the failed ${failure.phase}`,
                            state: decision.state,
                            extra: { followUpTaskId: result.taskId, failureId: failure.failureId },
                        },
                    );
                } else if (result.kind === 'escalated') {
                    followUp = 'escalated';
                }
                if (changed && decision.state !== from) {
                    this.telemetry?.track(
                        'app.change.delivery_failed',
                        {
                            workId: work.id,
                            taskId: task.id,
                            phase: failure.phase,
                            followUp: result.kind === 'opened',
                        },
                        task.userId,
                    );
                }
            }
        }

        return { changed, closed, followUp, decision };
    }

    // ── The routes ────────────────────────────────────────────────────

    /** `GET /api/tasks/:id/delivery`. The caller has already checked access to `task`. */
    async getView(task: Task): Promise<TaskDeliveryView> {
        const state = isDeliveryState(task.deliveryState) ? task.deliveryState : null;
        const [build, deployment, work, followUps, history] = await Promise.all([
            task.deliveryBuildId
                ? this.builds.findOne({ where: { id: task.deliveryBuildId } })
                : Promise.resolve(null),
            task.deliveryDeploymentId
                ? this.deployments.findOne({ where: { id: task.deliveryDeploymentId } })
                : Promise.resolve(null),
            task.workId ? this.works.findById(task.workId) : Promise.resolve(null),
            this.followUps ? this.followUps.listFollowUps(task.id) : Promise.resolve([] as Task[]),
            this.history(task),
        ]);
        const merge = (task.mergeCommitSha ?? '').trim();
        const decidingSha = (deployment?.commitSha ?? build?.commitSha ?? '').trim();
        const liveWithWarnings =
            state === 'live' && deployment ? deploymentHasWarnings(deployment) : false;
        const mergedAt = history.find((entry) => entry.state === 'merged')?.at ?? null;
        const base = work ? await this.sourceBranch(work) : null;
        return {
            taskId: task.id,
            state,
            mergeCommitSha: task.mergeCommitSha ?? null,
            pullRequest: task.prNumber
                ? {
                      number: task.prNumber,
                      url: task.prUrl ?? '',
                      base: base ?? '',
                      mergedAt,
                  }
                : null,
            build: build
                ? {
                      id: build.id,
                      number: build.number ?? null,
                      status: build.status,
                      commitSha: build.commitSha,
                      logsUrl: build.logsUrl ?? null,
                  }
                : null,
            deployment: deployment
                ? {
                      id: deployment.id,
                      number: null,
                      status: deployment.state,
                      outcome: deploymentFailureOutcome(deployment),
                  }
                : null,
            liveUrl: state === 'live' ? (deployment?.website ?? null) : null,
            liveWithWarnings,
            carriedByLaterChange: Boolean(merge && decidingSha && decidingSha !== merge),
            followUps: followUps.map((row) => ({
                taskId: row.id,
                slug: row.slug,
                status: row.status,
                automatic: Boolean(row.followUpKey),
            })),
            history,
        };
    }

    /**
     * `POST /api/tasks/:id/delivery/close` — **Close anyway** / **Close without deploying** (S9,
     * S20). The Task moves to Done through the state machine as the person (the approver and
     * blocker gates still hold — a refusal throws and nothing changes), then the chain reads
     * **Closed without deploying** and no further follow-up is opened (FR-40).
     */
    async closeWithoutDeploy(
        userId: string,
        task: Task,
        note?: string | null,
    ): Promise<TaskDeliveryView> {
        const from = (task.deliveryState ?? null) as TaskDeliveryState | null;
        if (!from || !(TASK_DELIVERY_CLOSABLE_STATES as readonly string[]).includes(from)) {
            throw new UnprocessableEntityException({
                code: 'notClosable',
                state: from,
                message: 'Only a merged change that is not live and not deploying can be closed this way.',
            });
        }
        if (
            this.transitions &&
            (task.status === TaskStatus.IN_PROGRESS || task.status === TaskStatus.IN_REVIEW)
        ) {
            await this.transitions.transition(task, TaskStatus.DONE, { actorType: 'user' });
        }
        const now = new Date();
        const landed = await this.compareAndSet(task.id, from, {
            deliveryState: 'closed_without_deploy',
            deliveryClosedById: userId,
            deliveryUpdatedAt: now,
        });
        if (!landed) {
            // The reconciler moved it in between (e.g. it went live) — answer what is true now.
            const fresh = await this.tasks.findOne({ where: { id: task.id } });
            return this.getView(fresh ?? task);
        }
        Object.assign(task, {
            deliveryState: 'closed_without_deploy',
            deliveryClosedById: userId,
            deliveryUpdatedAt: now,
        });
        const trimmed = (note ?? '').trim().slice(0, TASK_DELIVERY_CLOSE_NOTE_MAX);
        await this.recordActivity(task, APP_CHANGE_ACTIONS.closed, ActivityStatus.COMPLETED, {
            summary: trimmed
                ? `Closed without deploying: ${trimmed}`
                : 'Closed without deploying — the failure stays on record',
            state: 'closed_without_deploy',
            extra: { from, closedById: userId },
        });
        if (task.workId) {
            this.telemetry?.track(
                'app.change.closed_without_deploy',
                { workId: task.workId, taskId: task.id },
                userId,
            );
        }
        return this.getView(task);
    }

    /**
     * `POST /api/tasks/:id/delivery/follow-up` — the S22 Inbox item's **Try once more**. The
     * `delivery-failed` escalation of THIS Task is the one-shot token: it is consumed
     * (resolved, compare-and-set on `open`) before the follow-up is opened, so a double click or a
     * replay opens nothing more. Every refusal is `422 { code: 'followUpLimit' }` (plan §4).
     */
    async requestFollowUp(
        userId: string,
        task: Task,
        escalationId: string,
        scope: OwnershipScope,
    ): Promise<{ taskId: string }> {
        const refuse = (message: string) =>
            new UnprocessableEntityException({ code: 'followUpLimit', message });
        const state = task.deliveryState ?? null;
        if (state !== 'build_failed' && state !== 'deploy_failed') {
            throw refuse('Only a change that failed to build or deploy can be tried again.');
        }
        if (!this.escalations || !this.followUps || !task.workId) {
            throw refuse('Follow-ups are not available in this process.');
        }
        const escalation = await this.escalations.getForUser(escalationId, userId);
        if (
            !escalation ||
            escalation.reasonCode !== 'delivery-failed' ||
            escalation.taskId !== task.id ||
            escalation.status !== 'open'
        ) {
            throw refuse('That Inbox item has already been used, or belongs to another Task.');
        }
        const consumed = await this.escalations.resolveForTask(
            escalationId,
            userId,
            task.id,
            scope,
            'Try once more',
        );
        if (!consumed) throw refuse('That Inbox item has already been used.');

        const work = await this.works.findById(task.workId);
        if (!work) throw refuse('The App Work of this Task no longer exists.');
        const [build, deployment] = await Promise.all([
            task.deliveryBuildId
                ? this.builds.findOne({ where: { id: task.deliveryBuildId } })
                : Promise.resolve(null),
            task.deliveryDeploymentId
                ? this.deployments.findOne({ where: { id: task.deliveryDeploymentId } })
                : Promise.resolve(null),
        ]);
        const decision: DeliveryDecision = {
            kind: 'state',
            state: state as TaskDeliveryState,
            buildId: task.deliveryBuildId ?? null,
            deploymentId: task.deliveryDeploymentId ?? null,
            close: false,
            liveWithWarnings: false,
            outcome: deployment ? deploymentFailureOutcome(deployment) : null,
            failurePhase: state === 'build_failed' ? 'build' : 'deploy',
            carried: false,
            reason: 'try once more',
        };
        const failure = this.failureOf(
            task,
            work,
            decision,
            build ? [build] : [],
            deployment ? [deployment] : [],
        );
        if (!failure) throw refuse('The failure behind this change is no longer on record.');
        const result = await this.followUps.open(failure, { manual: true });
        if (result.kind === 'opened' || result.kind === 'exists') {
            if (result.kind === 'opened') {
                await this.recordActivity(
                    task,
                    APP_CHANGE_ACTIONS.followUpOpened,
                    ActivityStatus.COMPLETED,
                    {
                        summary: `Follow-up Task opened (try once more) for the failed ${failure.phase}`,
                        state: state as TaskDeliveryState,
                        extra: { followUpTaskId: result.taskId, failureId: failure.failureId, manual: true },
                    },
                );
            }
            return { taskId: result.taskId };
        }
        throw refuse('The follow-up Task could not be opened.');
    }

    // ── Internals ─────────────────────────────────────────────────────

    /**
     * The App Work's tracked source branch (APW08-G07): the Work's isolation base branch when set,
     * else APW-03's tracked branch (which already resolves the repository default when the spec
     * names none), else the applied spec's `source.branch`. `null` = unknown, and the merge is not
     * tracked (it completes as before).
     */
    async sourceBranch(work: Pick<Work, 'id' | 'taskIsolationBaseBranch'>): Promise<string | null> {
        const own = (work.taskIsolationBaseBranch ?? '').trim();
        if (own) return own;
        const state = await this.specStates?.findByWorkId(work.id).catch(() => null);
        const tracked = (state?.trackedBranch ?? '').trim();
        if (tracked) return tracked;
        const read = await this.specs?.getEffectiveSpec(work.id).catch(() => null);
        const fromSpec = (read?.spec?.source?.branch ?? '').trim();
        return fromSpec || null;
    }

    /** `build.strategy` of the effective spec; `none` when the spec has no components; `null` = unknown. */
    private async buildStrategy(workId: string): Promise<string | null> {
        const read = await this.specs?.getEffectiveSpec(workId).catch(() => null);
        if (!read || !isUsableAppSpecStatus(read.status) || !read.spec) return null;
        const strategy = read.spec.build?.strategy;
        if (strategy) return strategy;
        const components = read.spec.components ?? [];
        return components.length === 0 ? 'none' : null;
    }

    /** `isAncestorCommit(merge, sha)` for each question, cached 24 h per `(work, merge, sha)`. */
    private async ancestry(
        work: Work,
        mergeCommitSha: string,
        questions: readonly string[],
    ): Promise<Record<string, boolean | null>> {
        const answers: Record<string, boolean | null> = {};
        if (questions.length === 0 || !this.git) return answers;
        let target: { owner: string; repo: string } | null = null;
        try {
            target = pickOwnerRepo(requireTaskRepository(work, 'delivery ancestry'));
        } catch {
            return answers;
        }
        const now = Date.now();
        for (const sha of questions.slice(0, ANCESTRY_QUESTIONS_MAX)) {
            const key = `${work.id}:${mergeCommitSha}:${sha}`;
            const cached = this.ancestryCache.get(key);
            if (cached && now - cached.at < ANCESTRY_TTL_MS) {
                answers[sha] = cached.answer;
                continue;
            }
            let answer: boolean | null = null;
            try {
                answer = await this.git.isAncestorCommit(target.owner, target.repo, mergeCommitSha, sha, {
                    userId: work.userId,
                    providerId: work.gitProvider,
                    workId: work.id,
                });
            } catch (error) {
                // A broken read is "cannot say" for this tick and is NOT cached.
                this.logger.warn(
                    `Work ${work.id}: ancestry ${mergeCommitSha.slice(0, 7)}..${sha.slice(0, 7)} failed (${errorText(error)}).`,
                );
                answers[sha] = null;
                continue;
            }
            answers[sha] = answer;
            if (this.ancestryCache.size >= ANCESTRY_CACHE_MAX) this.ancestryCache.clear();
            this.ancestryCache.set(key, { answer, at: now });
        }
        return answers;
    }

    private failureOf(
        task: Task,
        work: Work,
        decision: DeliveryDecision,
        builds: readonly WorkBuild[],
        deployments: readonly WorkDeployment[],
    ): DeliveryFailure | null {
        if (decision.kind !== 'state' || !decision.failurePhase) return null;
        const build = decision.buildId ? (builds.find((row) => row.id === decision.buildId) ?? null) : null;
        const deployment = decision.deploymentId
            ? (deployments.find((row) => row.id === decision.deploymentId) ?? null)
            : null;
        const failureId = decision.failurePhase === 'deploy' ? deployment?.id : build?.id;
        if (!failureId) return null;
        return {
            task,
            work: {
                id: work.id,
                userId: work.userId,
                name: work.name ?? null,
                tenantId: work.tenantId ?? null,
                organizationId: work.organizationId ?? null,
            },
            phase: decision.failurePhase,
            failureId,
            failedSha:
                decision.failurePhase === 'deploy'
                    ? (deployment?.commitSha ?? build?.commitSha ?? task.mergeCommitSha ?? null)
                    : (build?.commitSha ?? task.mergeCommitSha ?? null),
            outcome: decision.outcome,
            build: build
                ? {
                      id: build.id,
                      number: build.number,
                      status: build.status,
                      logsUrl: build.logsUrl ?? null,
                      failureClass: build.failureClass ?? null,
                      notDeployableReason: build.notDeployableReason ?? null,
                      blockedReason: build.blockedReason ?? null,
                      failureExcerpt: build.failureExcerpt ?? null,
                  }
                : null,
            deployment: deployment
                ? {
                      id: deployment.id,
                      state: deployment.state,
                      lastError: deployment.lastError ?? null,
                      appRender: deployment.appRender ?? null,
                  }
                : null,
        };
    }

    /** Close the Task through the state machine, as `completeOnMerge` does. Refusal = retry later. */
    private async closeTask(task: Task): Promise<boolean> {
        if (!this.transitions) return false;
        if (task.status !== TaskStatus.IN_PROGRESS && task.status !== TaskStatus.IN_REVIEW) {
            return false;
        }
        try {
            await this.transitions.transition(task, TaskStatus.DONE, {
                actorType: 'agent',
                ownRunTask: true,
                livePullRequestHeadSha: task.prHeadSha ?? null,
            });
            return true;
        } catch (error) {
            this.logger.log(
                `Task ${task.id}: delivered (${task.deliveryState}) but the Task stays in ${task.status}: ${errorText(error)}`,
            );
            return false;
        }
    }

    private async recordStateChange(
        task: Task,
        decision: Extract<DeliveryDecision, { kind: 'state' }>,
        mergeCommitSha: string,
    ): Promise<void> {
        const extra = {
            buildId: decision.buildId,
            deploymentId: decision.deploymentId,
            mergeCommitSha,
            carried: decision.carried,
            ...(decision.outcome ? { outcome: decision.outcome } : {}),
            ...(decision.liveWithWarnings ? { liveWithWarnings: true } : {}),
        };
        if (decision.state === 'live') {
            await this.recordActivity(task, APP_CHANGE_ACTIONS.live, ActivityStatus.COMPLETED, {
                summary: decision.liveWithWarnings
                    ? 'Change live (with warnings)'
                    : decision.carried
                      ? 'Change live (with a later change)'
                      : 'Change live',
                state: 'live',
                extra,
            });
            const mergedAt = await this.mergedAt(task);
            this.telemetry?.track(
                'app.change.delivered',
                {
                    workId: task.workId as string,
                    taskId: task.id,
                    minutesMergeToLive:
                        mergedAt === null ? 0 : Math.max(0, Math.round((Date.now() - mergedAt) / 60_000)),
                    carried: decision.carried,
                },
                task.userId,
            );
            return;
        }
        if (decision.state === 'build_failed' || decision.state === 'deploy_failed') {
            await this.recordActivity(task, APP_CHANGE_ACTIONS.failed, ActivityStatus.FAILED, {
                summary:
                    decision.state === 'build_failed'
                        ? 'The build of the merged change failed'
                        : `The deployment of the merged change ${decision.outcome === 'rolled_back' ? 'was rolled back' : decision.outcome === 'rollback_failed' ? 'failed and its rollback failed' : 'failed'}`,
                state: decision.state,
                extra,
            });
            return;
        }
        await this.recordActivity(task, APP_CHANGE_ACTIONS.progressed, ActivityStatus.IN_PROGRESS, {
            summary: PROGRESS_SUMMARY[decision.state] ?? `Change ${decision.state}`,
            state: decision.state,
            extra,
        });
    }

    private async mergedAt(task: Task): Promise<number | null> {
        const history = await this.history(task);
        const merged = history.find((entry) => entry.state === 'merged');
        return merged ? new Date(merged.at).getTime() : null;
    }

    /** FR-35 — the chain's timeline, oldest first, from the per-Task Activity feed. */
    private async history(task: Task): Promise<TaskDeliveryView['history']> {
        if (!this.activityLog) return [];
        try {
            const { activities } = await this.activityLog.findResourceEvents({
                userId: task.userId,
                resourceType: 'task',
                resourceId: task.id,
                limit: 100,
            });
            return activities
                .filter((row) => row.actionType === ActivityActionType.APP_CHANGE)
                .map((row) => {
                    const details = (row.details ?? {}) as Record<string, unknown>;
                    return {
                        state: details.state as TaskDeliveryState,
                        at: new Date(row.createdAt).toISOString(),
                        activityId: row.id,
                    };
                })
                .filter((entry) => isDeliveryState(entry.state))
                .reverse();
        } catch {
            return [];
        }
    }

    private async recordActivity(
        task: Task,
        action: string,
        status: ActivityStatus,
        input: { summary: string; state: TaskDeliveryState; extra?: Record<string, unknown> },
    ): Promise<void> {
        if (!this.activityLog) return;
        try {
            await this.activityLog.log({
                userId: task.userId,
                ...(task.workId ? { workId: task.workId } : {}),
                actionType: ActivityActionType.APP_CHANGE,
                action,
                status,
                summary: input.summary,
                details: {
                    resourceType: 'task',
                    resourceId: task.id,
                    taskId: task.id,
                    state: input.state,
                    ...(input.extra ?? {}),
                },
                tenantId: task.tenantId ?? null,
                organizationId: task.organizationId ?? null,
            });
        } catch (error) {
            this.logger.warn(
                `Task ${task.id}: the ${action} Activity row could not be written (${errorText(error)}).`,
            );
        }
    }

    /** Move `deliveryUpdatedAt` forward without changing the state (fair, stalest-first order). */
    private async touch(task: Task, from: TaskDeliveryState): Promise<void> {
        const now = new Date();
        const landed = await this.compareAndSet(task.id, from, { deliveryUpdatedAt: now }).catch(
            () => false,
        );
        if (landed) Object.assign(task, { deliveryUpdatedAt: now });
    }

    /**
     * `UPDATE tasks SET … WHERE id = :id AND deliveryState = :from` (or `IS NULL`). Portable on
     * every driver (see the class docstring); never bumps `updatedAt`.
     */
    private async compareAndSet(
        taskId: string,
        from: TaskDeliveryState | null,
        patch: Partial<
            Pick<
                Task,
                | 'mergeCommitSha'
                | 'deliveryState'
                | 'deliveryBuildId'
                | 'deliveryDeploymentId'
                | 'deliveryUpdatedAt'
                | 'deliveryClosedById'
            >
        >,
    ): Promise<boolean> {
        const escape = (name: string) => this.tasks.manager.connection.driver.escape(name);
        const keepUpdatedAt = escape('updatedAt');
        const qb = this.tasks
            .createQueryBuilder()
            .update(Task)
            .set({ ...patch, updatedAt: () => keepUpdatedAt })
            .where(`${escape('id')} = :taskId`, { taskId });
        if (from === null) {
            qb.andWhere(`${escape('deliveryState')} IS NULL`);
        } else {
            qb.andWhere(`${escape('deliveryState')} = :fromState`, { fromState: from });
        }
        const result = await qb.execute();
        return (result.affected ?? 0) > 0;
    }
}

const PROGRESS_SUMMARY: Partial<Record<TaskDeliveryState, string>> = {
    merged: 'Change merged — waiting for a build',
    building: 'Building the merged change',
    built: 'Merged change built — waiting for a deployment',
    deploying: 'Deploying the merged change',
};

function isDeliveryState(value: unknown): value is TaskDeliveryState {
    return typeof value === 'string' && (TASK_DELIVERY_STATES as readonly string[]).includes(value);
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
