import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { config } from '../config';
import { WorkBuildRequest, WorkBuildRequestStatus } from '../entities/work-build-request.entity';
import { WorkAgentRun, WorkAgentRunStatus } from '../entities/work-agent-run.entity';
import { WorkAgentRunLog, WorkAgentRunLogLevel } from '../entities/work-agent-run-log.entity';
import type { User } from '../entities/user.entity';
import type { WorkProposal } from '../entities/work-proposal.entity';
import { WorkProposalRepository } from '../user-research/work-proposal.repository';
import { WorkProposalService, type AutoRetryPolicy } from '../user-research/work-proposal.service';
import { UserRepository } from '../database/repositories/user.repository';
import { WorkRepository } from '../database/repositories/work.repository';
import { WorkLifecycleService } from '../services/work-lifecycle.service';
import { WorkGenerationService } from '../services/work-generation.service';
import { slugifyText } from '../utils/text.utils';
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
    WorkBuildRequestStatus.COMPLETED,
    WorkBuildRequestStatus.CANCELED,
    WorkBuildRequestStatus.REJECTED,
    WorkBuildRequestStatus.FAILED,
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
 * a `WorkBuildRequest` created by the build/retry/rebuild endpoints (or by
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
 *   - Non-dry-run (Wave 0.3) REALLY builds: CREATE a Work from the
 *     Idea, or RE-RUN generation on `idea.targetWorkId` with the
 *     description (+ `extraPrompt`) as the prompt override. Every AI
 *     call rides `AiFacadeService`, which enforces the EW-602 budget
 *     guard per call; precondition failures skip without mutation, and
 *     post-start failures flow through `handleGoalCompletion` — an
 *     Idea can never be stranded in BUILDING (see `runRealGeneration`).
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
        @InjectRepository(WorkBuildRequest)
        private readonly goals: Repository<WorkBuildRequest>,
        @InjectRepository(WorkAgentRun)
        private readonly runs: Repository<WorkAgentRun>,
        @InjectRepository(WorkAgentRunLog)
        private readonly logs: Repository<WorkAgentRunLog>,
        private readonly workAgent: WorkAgentService,
        private readonly workProposals: WorkProposalService,
        private readonly workProposalRepo: WorkProposalRepository,
        // Real-generation dependencies (Wave 0.3). Optional so existing
        // unit-test fixtures (and any context wiring only the dry-run
        // path) keep constructing; the real path degrades to a failure
        // outcome — never a crash — when they're absent.
        @Optional() private readonly users?: UserRepository,
        @Optional() private readonly workRepo?: WorkRepository,
        @Optional() private readonly workLifecycle?: WorkLifecycleService,
        @Optional() private readonly workGeneration?: WorkGenerationService,
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
        goal: WorkBuildRequest,
        ideaId: string,
        injectedOutcome?: SyntheticBuildOutcome,
    ): Promise<IdeaBuildExecuteResult> {
        // 1. Auto-approve + start: WAITING_FOR_APPROVAL/PENDING/PLANNING → RUNNING.
        goal.status = WorkBuildRequestStatus.RUNNING;
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

        const decision = await this.completeGoal(goal, ideaId, outcome);
        return this.applyDecision(goal, ideaId, decision, true);
    }

    /**
     * Non-dry-run REAL generation path (Wave 0.3 — replaces the
     * documented not-implemented stub).
     *
     * Two shapes, selected by the Idea:
     *   - `targetWorkId` set → RE-RUN: generation re-executes on that
     *     existing Work with the Idea description (+ `extraPrompt`) as
     *     the per-run prompt override. Ownership enforced by
     *     `updateItemsGenerator`'s `ensureCanEdit`.
     *   - otherwise → CREATE: a new Work is created from the Idea
     *     (collision-safe slug) and initial generation runs with the
     *     Idea description as the prompt.
     *
     * Spend safety: every AI call inside generation goes through
     * `AiFacadeService`, which enforces the EW-602 budget guard
     * (hard-stop + alerts) per call — a blocked budget surfaces here as
     * a failure outcome and drives the SAME completion state machine.
     * Precondition failures (missing deps, missing idea/user) return
     * `skipped` WITHOUT mutating Goal/Idea state, preserving the
     * original never-strand invariant; failures AFTER execution begins
     * flow through `handleGoalCompletion`, which owns the retry/fail
     * transitions — nothing is left in BUILDING.
     */
    private async runRealGeneration(
        goal: WorkBuildRequest,
        ideaId: string,
    ): Promise<IdeaBuildExecuteResult> {
        if (!this.users || !this.workLifecycle || !this.workGeneration) {
            this.logger.warn(
                `idea-build-executor: real generation dependencies are not wired in this ` +
                    `context; goal=${goal.id} idea=${ideaId} left untouched.`,
            );
            return { status: 'skipped', reason: 'real-generation-dependencies-unwired' };
        }
        const idea = await this.workProposalRepo.findByIdForUser(ideaId, goal.userId);
        if (!idea) {
            return { status: 'skipped', reason: 'idea-not-found' };
        }
        const user = await this.users.findById(goal.userId);
        if (!user) {
            return { status: 'skipped', reason: 'user-not-found' };
        }

        // Begin execution — the same transitions the dry-run makes.
        goal.status = WorkBuildRequestStatus.RUNNING;
        await this.goals.save(goal);
        await this.startActiveRun(goal, 'Build executor started (auto-approved).');
        await this.workProposalRepo.markBuilding(ideaId, goal.userId);

        let outcome: SyntheticBuildOutcome;
        try {
            const workId = await this.produceWork(idea, user);
            outcome = { kind: 'success', workId };
        } catch (error) {
            this.logger.warn(
                `idea-build-executor: real generation failed for goal=${goal.id} ` +
                    `idea=${ideaId}: ${error instanceof Error ? error.message : String(error)}`,
            );
            outcome = { kind: 'failure', error };
        }

        const decision = await this.completeGoal(goal, ideaId, outcome);
        return this.applyDecision(goal, ideaId, decision, false);
    }

    /**
     * Produce (or re-generate) the Work for an Idea and return its id.
     * Throws on any failure — the caller converts throws into a
     * `failure` outcome for the completion state machine.
     */
    private async produceWork(idea: WorkProposal, user: User): Promise<string> {
        const prompt = this.composeBuildPrompt(idea);

        if (idea.targetWorkId) {
            await this.workGeneration!.updateItemsGenerator({
                workId: idea.targetWorkId,
                updateDto: { prompt } as never,
                user,
                awaitCompletion: true,
                context: { triggeredBy: 'api' },
            });
            return idea.targetWorkId;
        }

        const slug = await this.deriveAvailableSlug(idea);
        const created = await this.workLifecycle!.createWork(
            {
                slug,
                name: idea.title.slice(0, 120),
                description: idea.description.slice(0, 500),
            } as never,
            user,
        );
        const workId = created?.work?.id;
        if (!workId) {
            throw new Error('createWork returned no work id');
        }
        await this.workGeneration!.generateItems(
            workId,
            { name: idea.title.slice(0, 120), prompt } as never,
            user,
            true,
            { triggeredBy: 'api' },
        );
        return workId;
    }

    /** Idea description (+ optional extraPrompt) → the per-run prompt. */
    private composeBuildPrompt(idea: WorkProposal): string {
        const base = (idea.generatedPrompt?.trim() || idea.description.trim()).slice(0, 4000);
        const extra = idea.extraPrompt?.trim();
        return extra ? `${base}\n\nAdditional instruction:\n${extra.slice(0, 900)}` : base;
    }

    /**
     * Collision-safe slug from the Idea's suggestion: try the suggestion
     * verbatim, then suffix with the Idea id's first hex block. The
     * suffix attempt is not re-checked — the uuid block makes a second
     * collision for the same user practically impossible, and
     * `createWork` still fails safely (→ failure outcome) if it happens.
     */
    private async deriveAvailableSlug(idea: WorkProposal): Promise<string> {
        const base = (idea.slugSuggestion || slugifyText(idea.title) || 'idea-work').slice(0, 60);
        const taken = this.workRepo
            ? await this.workRepo.existsByUserAndSlug(idea.userId, base)
            : false;
        if (!taken) {
            return base;
        }
        return `${base}-${idea.id.split('-')[0]}`;
    }

    /** Run the shared completion state machine for a build outcome. */
    private async completeGoal(
        goal: WorkBuildRequest,
        ideaId: string,
        outcome: SyntheticBuildOutcome,
    ) {
        const attempts = await this.goals.count({ where: { ideaId, userId: goal.userId } });
        const policy = await this.resolveAutoRetryPolicy(goal.userId);
        return this.workProposals.handleGoalCompletion({
            userId: goal.userId,
            ideaId,
            outcome,
            attempts,
            policy,
        });
    }

    /**
     * Reflect a completion decision on the Goal + Run (shared by the
     * dry-run and real paths — the decisions and transitions are
     * identical; only the log labels differ).
     */
    private async applyDecision(
        goal: WorkBuildRequest,
        ideaId: string,
        decision: Awaited<ReturnType<WorkProposalService['handleGoalCompletion']>>,
        dryRun: boolean,
    ): Promise<IdeaBuildExecuteResult> {
        const label = dryRun ? 'Dry-run' : 'Build';
        switch (decision.outcome) {
            case 'accepted':
            case 'rebuild-accepted': {
                await this.finishGoal(goal, WorkBuildRequestStatus.COMPLETED, null);
                await this.completeActiveRun(
                    goal,
                    `${label}: Idea accepted (workId=${decision.workId}).`,
                );
                return {
                    status: 'completed',
                    goalId: goal.id,
                    ideaId,
                    decision: decision.outcome,
                    workId: decision.workId,
                    dryRun,
                };
            }
            case 'retry': {
                // Neither path loops in-process — a retry decision marks
                // this Goal completed and records that a retry was decided
                // (the retry Goal is enqueued by the completion handler's
                // own machinery when wired; observable either way).
                await this.finishGoal(goal, WorkBuildRequestStatus.COMPLETED, null);
                await this.completeActiveRun(
                    goal,
                    `${label}: retry decision (attempt ${decision.attempts}, ` +
                        `delay ${decision.retryDelaySeconds}s).`,
                );
                return {
                    status: 'completed',
                    goalId: goal.id,
                    ideaId,
                    decision: 'retry',
                    workId: null,
                    dryRun,
                };
            }
            case 'failed': {
                await this.finishGoal(
                    goal,
                    WorkBuildRequestStatus.FAILED,
                    `${label} failed: ${decision.message}`,
                );
                await this.failActiveRun(goal, `${label}: Idea failed (${decision.kind}).`);
                return {
                    status: 'failed',
                    goalId: goal.id,
                    ideaId,
                    decision: 'failed',
                    dryRun,
                };
            }
            case 'noop':
            default: {
                await this.finishGoal(goal, WorkBuildRequestStatus.COMPLETED, null);
                await this.completeActiveRun(
                    goal,
                    `${label}: no-op decision (${decision.reason}).`,
                );
                return {
                    status: 'failed',
                    goalId: goal.id,
                    ideaId,
                    decision: 'noop',
                    dryRun,
                };
            }
        }
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

    private async startActiveRun(goal: WorkBuildRequest, message: string): Promise<void> {
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

    private async completeActiveRun(goal: WorkBuildRequest, message: string): Promise<void> {
        const run = await this.findActiveRun(goal, [WorkAgentRunStatus.GENERATING]);
        if (!run) return;
        run.status = WorkAgentRunStatus.COMPLETED;
        run.finishedAt = new Date();
        run.progressPercent = 100;
        await this.runs.save(run);
        await this.writeLog(goal.userId, run.id, 'completed', message);
    }

    private async failActiveRun(goal: WorkBuildRequest, message: string): Promise<void> {
        const run = await this.findActiveRun(goal, [WorkAgentRunStatus.GENERATING]);
        if (!run) return;
        run.status = WorkAgentRunStatus.FAILED;
        run.finishedAt = new Date();
        run.error = message;
        await this.runs.save(run);
        await this.writeLog(goal.userId, run.id, 'failed', message);
    }

    private async findActiveRun(
        goal: WorkBuildRequest,
        statuses: WorkAgentRunStatus[] = ACTIVE_RUN_STATUSES,
    ): Promise<WorkAgentRun | null> {
        return this.runs.findOne({
            where: { buildRequestId: goal.id, userId: goal.userId, status: In(statuses) },
            order: { createdAt: 'DESC' },
        });
    }

    private async finishGoal(
        goal: WorkBuildRequest,
        status: WorkBuildRequestStatus,
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
