import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { config } from '../config';
import { WorkAgentGoal, WorkAgentGoalStatus } from '../entities/work-agent-goal.entity';
import { WorkAgentRun, WorkAgentRunStatus } from '../entities/work-agent-run.entity';
import { WorkAgentRunLog, WorkAgentRunLogLevel } from '../entities/work-agent-run-log.entity';
import { WorkProposalRepository } from '../user-research/work-proposal.repository';
import { WorkProposalService, type AutoRetryPolicy } from '../user-research/work-proposal.service';
import { WorkAgentService } from './work-agent.service';

/**
 * Synthetic Goal outcome used by the dry-run executor. Mirrors the
 * `outcome` shape `WorkProposalService.handleGoalCompletion` accepts,
 * so the dry-run path drives the exact same completion state machine a
 * real build would.
 */
export type SyntheticBuildOutcome =
    | { kind: 'success'; workId: string }
    | { kind: 'failure'; error: unknown };

export type IdeaBuildExecuteResult =
    | { status: 'skipped'; reason: string }
    | { status: 'not-implemented'; reason: 'real-generation-stub' }
    | {
          status: 'completed';
          goalId: string;
          ideaId: string;
          decision: string;
          workId: string | null;
          dryRun: boolean;
      }
    | {
          status: 'failed';
          goalId: string;
          ideaId: string;
          decision: 'failed' | 'noop';
          dryRun: boolean;
      };

const TERMINAL_GOAL_STATUSES = [
    WorkAgentGoalStatus.COMPLETED,
    WorkAgentGoalStatus.CANCELED,
    WorkAgentGoalStatus.REJECTED,
    WorkAgentGoalStatus.FAILED,
];

const ACTIVE_RUN_STATUSES = [
    WorkAgentRunStatus.QUEUED,
    WorkAgentRunStatus.PLANNING,
    WorkAgentRunStatus.RESEARCHING,
    WorkAgentRunStatus.GENERATING,
    WorkAgentRunStatus.WRITING,
    WorkAgentRunStatus.WAITING_FOR_APPROVAL,
];

/**
 * PR-4 (domain-model evolution) — the Idea → Work build executor.
 *
 * This is the production caller the dormant build pipeline was always
 * missing: `WorkProposalService.handleGoalCompletion` and
 * `WorkProposalRepository.markBuilding` had NO callers on `develop`, so
 * a `WorkAgentGoal` created by the build/retry/rebuild endpoints (or by
 * Mission auto-build) sat at WAITING_FOR_APPROVAL forever and the Idea
 * stayed QUEUED. This service, invoked by the `idea-build-execute`
 * Trigger.dev task, advances that Goal and completes the cycle.
 *
 * SAFETY MODEL (see `config.ideaBuildExecutor`):
 *   - The whole thing is gated by `EVER_WORKS_IDEA_BUILD_EXECUTOR_ENABLED`
 *     (default OFF). When off, `executeBuild` short-circuits — a
 *     defense-in-depth re-check on top of the enqueue-site guard.
 *   - `EVER_WORKS_IDEA_BUILD_EXECUTOR_DRY_RUN` (default ON): the
 *     executor synthesizes a deterministic Goal outcome and drives the
 *     full completion state machine (accept → `acceptedWorkId`, retry,
 *     or failed) WITHOUT generating or deploying a real Work — zero AI
 *     / deploy spend. The dry-run success outcome sets the Idea's
 *     `acceptedWorkId` to the Goal id (a real uuid, deterministic,
 *     and obviously traceable to the synthetic run — there is no
 *     DB-level FK on `work_proposals.acceptedWorkId`, only the
 *     entity-level `@ManyToOne`, so a synthetic value is safe).
 *   - Non-dry-run is a DOCUMENTED not-implemented stub. It performs the
 *     budget-guard precondition check and then returns a telemetry
 *     no-op WITHOUT mutating Goal/Idea state, so it can never strand an
 *     Idea in BUILDING. The real generation path is intentionally left
 *     as a wiring point (see `runRealGeneration`).
 *
 * APPROVAL GATE: `WorkAgentService.createGoal` seeds Idea-build Goals at
 * WAITING_FOR_APPROVAL. When the executor is enabled it auto-approves
 * them (→ RUNNING) — enabling the flag is the operator's approval. This
 * is scoped to Goals with `ideaId` set; power-user direct Goals never
 * reach this executor.
 */
@Injectable()
export class IdeaBuildExecutorService {
    private readonly logger = new Logger(IdeaBuildExecutorService.name);

    constructor(
        @InjectRepository(WorkAgentGoal)
        private readonly goals: Repository<WorkAgentGoal>,
        @InjectRepository(WorkAgentRun)
        private readonly runs: Repository<WorkAgentRun>,
        @InjectRepository(WorkAgentRunLog)
        private readonly logs: Repository<WorkAgentRunLog>,
        private readonly workAgent: WorkAgentService,
        private readonly workProposals: WorkProposalService,
        private readonly workProposalRepo: WorkProposalRepository,
    ) {}

    /**
     * Execute one Idea-build Goal. Idempotent: a Goal already in a
     * terminal state is skipped, so a Trigger.dev retry / double-fire
     * doesn't re-run the completion machine.
     *
     * `opts.syntheticOutcome` lets tests (and future callers) inject the
     * dry-run outcome directly; when omitted the outcome is derived
     * deterministically from `config.ideaBuildExecutor.getDryRunOutcome()`.
     */
    async executeBuild(
        payload: { goalId: string; userId: string; ideaId?: string | null },
        opts: { syntheticOutcome?: SyntheticBuildOutcome } = {},
    ): Promise<IdeaBuildExecuteResult> {
        // Defense-in-depth: never execute when the master flag is off,
        // even if a stale enqueue slipped through.
        if (!config.ideaBuildExecutor.isEnabled()) {
            return { status: 'skipped', reason: 'executor-disabled' };
        }

        const goal = await this.goals.findOne({
            where: { id: payload.goalId, userId: payload.userId },
        });
        if (!goal) {
            return { status: 'skipped', reason: 'goal-not-found' };
        }
        // Only Idea-build Goals (ideaId set) are our concern. Power-user
        // direct Goals have a null ideaId and a different lifecycle.
        const ideaId = goal.ideaId ?? payload.ideaId ?? null;
        if (!ideaId) {
            return { status: 'skipped', reason: 'not-an-idea-goal' };
        }
        // Idempotency: a terminal Goal has already been executed.
        if (TERMINAL_GOAL_STATUSES.includes(goal.status)) {
            return { status: 'skipped', reason: `goal-${goal.status}` };
        }

        const dryRun = config.ideaBuildExecutor.isDryRun() || goal.dryRun;

        if (!dryRun) {
            // Non-dry-run REAL path — documented not-implemented stub.
            // We check the budget guard precondition and then no-op
            // WITHOUT mutating any Goal/Idea state, so an operator who
            // flips dry-run off can't accidentally strand Ideas or spend.
            return this.runRealGeneration(goal, ideaId);
        }

        return this.runDryRun(goal, ideaId, opts.syntheticOutcome);
    }

    // ─── dry-run path ───────────────────────────────────────────────

    private async runDryRun(
        goal: WorkAgentGoal,
        ideaId: string,
        injectedOutcome?: SyntheticBuildOutcome,
    ): Promise<IdeaBuildExecuteResult> {
        // 1. Auto-approve + start: WAITING_FOR_APPROVAL/PENDING/PLANNING → RUNNING.
        goal.status = WorkAgentGoalStatus.RUNNING;
        await this.goals.save(goal);
        await this.startActiveRun(goal, 'Dry-run build executor started (auto-approved).');

        // 2. Mark the Idea BUILDING (QUEUED/BUILDING → BUILDING). Mirrors
        //    the transition a real goal-execution path would make.
        await this.workProposalRepo.markBuilding(ideaId, goal.userId);

        // 3. Synthesize a deterministic outcome and drive the FULL
        //    completion state machine — the whole point of dry-run.
        const outcome =
            injectedOutcome ??
            this.computeSyntheticOutcome(config.ideaBuildExecutor.getDryRunOutcome(), goal.id);

        const attempts = await this.goals.count({ where: { ideaId, userId: goal.userId } });
        const policy = await this.resolveAutoRetryPolicy(goal.userId);

        const decision = await this.workProposals.handleGoalCompletion({
            userId: goal.userId,
            ideaId,
            outcome,
            attempts,
            policy,
        });

        // 4. Reflect the decision on the Goal + Run so it's observable.
        switch (decision.outcome) {
            case 'accepted':
            case 'rebuild-accepted': {
                await this.finishGoal(goal, WorkAgentGoalStatus.COMPLETED, null);
                await this.completeActiveRun(
                    goal,
                    `Dry-run: Idea accepted (workId=${decision.workId}).`,
                );
                return {
                    status: 'completed',
                    goalId: goal.id,
                    ideaId,
                    decision: decision.outcome,
                    workId: decision.workId,
                    dryRun: true,
                };
            }
            case 'retry': {
                // Dry-run does NOT loop — a real executor would enqueue a
                // fresh Goal after `retryDelaySeconds`. We mark this Goal
                // completed and record that a retry WOULD have been
                // scheduled, so the decision is observable without a loop.
                await this.finishGoal(goal, WorkAgentGoalStatus.COMPLETED, null);
                await this.completeActiveRun(
                    goal,
                    `Dry-run: retry decision (attempt ${decision.attempts}, ` +
                        `delay ${decision.retryDelaySeconds}s) — not scheduled in dry-run.`,
                );
                return {
                    status: 'completed',
                    goalId: goal.id,
                    ideaId,
                    decision: 'retry',
                    workId: null,
                    dryRun: true,
                };
            }
            case 'failed': {
                await this.finishGoal(
                    goal,
                    WorkAgentGoalStatus.FAILED,
                    `Dry-run build failed: ${decision.message}`,
                );
                await this.failActiveRun(goal, `Dry-run: Idea failed (${decision.kind}).`);
                return {
                    status: 'failed',
                    goalId: goal.id,
                    ideaId,
                    decision: 'failed',
                    dryRun: true,
                };
            }
            case 'noop':
            default: {
                await this.finishGoal(goal, WorkAgentGoalStatus.COMPLETED, null);
                await this.completeActiveRun(goal, `Dry-run: no-op decision (${decision.reason}).`);
                return {
                    status: 'failed',
                    goalId: goal.id,
                    ideaId,
                    decision: 'noop',
                    dryRun: true,
                };
            }
        }
    }

    /**
     * Non-dry-run REAL generation path — DOCUMENTED not-implemented
     * stub. This is the single wiring point where the real
     * work-generation pipeline (see `packages/tasks` work-generation
     * task / `TriggerGenerationOrchestrator`) will be invoked to
     * produce an actual Work, then hand the resulting workId to
     * `handleGoalCompletion` as a `success` outcome.
     *
     * It is deliberately inert today:
     *   - We CANNOT safely enable real spend from this PR, so the path
     *     stays a stub gated behind `dryRun === false`.
     *   - The budget guard MUST run before any real generation — that
     *     precondition is enforced structurally here: no generation
     *     happens, so no spend can occur without a guard. When the real
     *     path lands, `BudgetGuardService.checkBudget(workId, userId,
     *     'ai-generation', pluginId, { owner })` must gate it before the
     *     first token is spent.
     *   - Crucially it does NOT mutate Goal/Idea state, so flipping
     *     dry-run off can never strand an Idea in BUILDING.
     */
    private async runRealGeneration(
        goal: WorkAgentGoal,
        ideaId: string,
    ): Promise<IdeaBuildExecuteResult> {
        this.logger.warn(
            `idea-build-executor: real (non-dry-run) generation is not implemented; ` +
                `no Work generated for goal=${goal.id} idea=${ideaId}. ` +
                `Enable dry-run (EVER_WORKS_IDEA_BUILD_EXECUTOR_DRY_RUN=true) to exercise ` +
                `the completion state machine without spend.`,
        );
        return { status: 'not-implemented', reason: 'real-generation-stub' };
    }

    // ─── helpers ────────────────────────────────────────────────────

    private computeSyntheticOutcome(
        mode: 'success' | 'failure',
        goalId: string,
    ): SyntheticBuildOutcome {
        if (mode === 'failure') {
            return {
                kind: 'failure',
                error: new Error('dry-run executor: synthetic build failure (no Work generated)'),
            };
        }
        // Deterministic synthetic workId = the Goal id (a valid uuid,
        // obviously traceable to this synthetic run; no DB FK on
        // acceptedWorkId — see class JSDoc).
        return { kind: 'success', workId: goalId };
    }

    private async resolveAutoRetryPolicy(userId: string): Promise<AutoRetryPolicy> {
        const prefs = await this.workAgent.getPreferences(userId);
        return {
            maxAutoRetries: prefs.maxAutoRetries,
            backoffSeconds: prefs.backoffSeconds,
            exponentialBackoffFactor: prefs.exponentialBackoffFactor,
        };
    }

    private async startActiveRun(goal: WorkAgentGoal, message: string): Promise<void> {
        const run = await this.findActiveRun(goal);
        if (!run) return;
        // The run entity has no dedicated RUNNING state — GENERATING is
        // the closest active phase (see WorkAgentRunStatus). The GOAL
        // carries RUNNING; the run mirrors it as GENERATING.
        run.status = WorkAgentRunStatus.GENERATING;
        run.startedAt = new Date();
        run.progressPercent = 40;
        await this.runs.save(run);
        await this.writeLog(goal.userId, run.id, 'running', message);
    }

    private async completeActiveRun(goal: WorkAgentGoal, message: string): Promise<void> {
        const run = await this.findActiveRun(goal, [WorkAgentRunStatus.GENERATING]);
        if (!run) return;
        run.status = WorkAgentRunStatus.COMPLETED;
        run.finishedAt = new Date();
        run.progressPercent = 100;
        await this.runs.save(run);
        await this.writeLog(goal.userId, run.id, 'completed', message);
    }

    private async failActiveRun(goal: WorkAgentGoal, message: string): Promise<void> {
        const run = await this.findActiveRun(goal, [WorkAgentRunStatus.GENERATING]);
        if (!run) return;
        run.status = WorkAgentRunStatus.FAILED;
        run.finishedAt = new Date();
        run.error = message;
        await this.runs.save(run);
        await this.writeLog(goal.userId, run.id, 'failed', message);
    }

    private async findActiveRun(
        goal: WorkAgentGoal,
        statuses: WorkAgentRunStatus[] = ACTIVE_RUN_STATUSES,
    ): Promise<WorkAgentRun | null> {
        return this.runs.findOne({
            where: { goalId: goal.id, userId: goal.userId, status: In(statuses) },
            order: { createdAt: 'DESC' },
        });
    }

    private async finishGoal(
        goal: WorkAgentGoal,
        status: WorkAgentGoalStatus,
        error: string | null,
    ): Promise<void> {
        goal.status = status;
        if (error) {
            goal.approvalSummary = error;
        }
        await this.goals.save(goal);
    }

    private async writeLog(
        userId: string,
        runId: string,
        step: string,
        message: string,
    ): Promise<void> {
        await this.logs.save(
            this.logs.create({
                userId,
                runId,
                level: WorkAgentRunLogLevel.INFO,
                step,
                message,
            }),
        );
    }
}
