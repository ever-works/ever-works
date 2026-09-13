import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { config } from '../config';
import { TaskStatus, type Task } from '../entities/task.entity';
import { TaskRepository } from '../database/repositories/task.repository';
import { AgentRunRepository } from '../database/repositories/agent-run.repository';
import { TaskCiAutoResumeAttemptRepository } from '../database/repositories/task-ci-auto-resume-attempt.repository';
import { TaskReviewRejectionRepository } from '../database/repositories/task-review-rejection.repository';
import { RUN_KILL_SWITCH, type RunKillSwitch } from '../agents/run-kill-switch';
import { INBOX_PRODUCER, type InboxProducer } from '../inbox/inbox-producer.port';
import {
    MAX_REPLAYED_REJECTIONS,
    RUN_STEERING_PORT,
    type RunSteeringPort,
} from './run-steering-port';
import { TaskGitLinkService } from './task-git-link.service';
import {
    ciAutoResumeClaimKey,
    composeBudgetSpentNotice,
    composeCiFailureFeedback,
    decideCiHead,
    isPullRequestFinished,
    reviewAutoResumeClaimKey,
    type AutoResumeOutcome,
    type AutoResumeOutcomeReason,
    type CheckVerdict,
    type CiHeadDecision,
} from './task-ci-auto-resume';
import type { TaskAutoResumeTrigger } from '../entities/task-ci-auto-resume-attempt.entity';

/** One completed (or in-flight) check result, already normalized. */
export interface CiCheckResultInput {
    /**
     * The platform user the VERIFIED install binding resolved to. Used
     * ONLY to scope the repo→Work→Task walk. The owner the resume runs
     * as is `task.userId`, read back from the Task row — never anything
     * the webhook body said.
     */
    userId: string;
    owner: string;
    repo: string;
    /** Head commit the provider reported these checks against. */
    headSha: string;
    /** `null` for fork pull requests — the PR numbers then carry the link. */
    headBranch?: string | null;
    /** `check_run.pull_requests[].number`; empty for forks. */
    prNumbers?: readonly number[];
    /**
     * `pull_requests[]`, each with the head the PROVIDER says that pull
     * request is at RIGHT NOW. This is what makes head staleness decidable
     * without commit ancestry — see {@link decideCiHead}. Empty for forks
     * and for push-triggered workflow runs.
     */
    prHeads?: readonly { number: number; headSha: string | null }[];
    /**
     * When the PROVIDER says this result happened, or `null` when the
     * delivery carried no usable timestamp.
     *
     * Deliberately nullable: the ingest layer substitutes `now` for a
     * missing provider timestamp so the envelope is never rejected, and a
     * substituted `now` is always the newest thing in any comparison — a
     * delivery that reported no time at all would otherwise read as a
     * brand-new push every single time.
     */
    observedAt: Date | null;
    verdict: CheckVerdict;
    /** Which vendor delivery this came from, for the audit trail. */
    granularity: 'check_run' | 'check_suite' | 'workflow_run';
    checkName: string;
    conclusion: string;
    url?: string | null;
    outputTitle?: string | null;
    outputSummary?: string | null;
    /** Fingerprint of the failure — see `computeCiFailureKey`. */
    failureKey?: string | null;
}

/**
 * How many pending rejections the reviewer doorbell scans before giving
 * up. `findPendingForTask` returns them oldest-first and caps at 20; the
 * doorbell wants the oldest row that is genuinely about this delivery, so
 * it has to look past the ones that are not.
 */
export const REVIEW_PENDING_SCAN = 20;

/**
 * How stale an unconsumed reviewer rejection may be and still buy a
 * resume when a later comment rings the doorbell.
 *
 * Seven days. A rejection that nothing consumed for a week was answered
 * by a human, or abandoned; replaying it costs a full model run and tells
 * the agent to fix something that is very likely already fixed.
 */
export const REVIEW_PENDING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** A provider-side review that slice AB has ALREADY recorded a row for. */
export interface ReviewRejectionSignalInput {
    userId: string;
    owner: string;
    repo: string;
    prNumber: number;
}

/**
 * CI feedback and the autonomous fix loop (self-build slice AC, EW-806,
 * closes finding R17) — the decision layer.
 *
 * ## The defect
 *
 * The fleet opened a pull request, CI went red, and six PCs sat idle
 * waiting for a human who might not be watching. Check results were not
 * ingested at all (the webhook receiver had no `check_run` /
 * `check_suite` / `workflow_run` handling), `tasks.ciState` was written
 * by a poll and read only by the board, and nothing anywhere resumed a
 * run without a person pressing a button.
 *
 * ## The failure this class is shaped around: a RESUME STORM
 *
 * One push to a twelve-job matrix emits roughly thirty deliveries
 * (`created` + `completed` per job, plus suite and workflow events), and
 * GitHub redelivers everything it did not get a 2xx for. Each spurious
 * resume is a full model run on one of six PCs — real money, real machine
 * time. So:
 *
 *  1. **The budget is rows, not a counter, and not events.** One row in
 *     `task_ci_auto_resume_attempts` is one attempt. `countForTask` IS the
 *     budget read, and it is durable across crashes and replicas.
 *  2. **The claim is the unique index**, keyed `ci:<headSha>` — one
 *     attempt per Task per HEAD COMMIT. Twelve red jobs and every
 *     redelivery of them collapse into the one thing there is to fix.
 *  3. **If the ledger cannot be read, the loop STOPS.** A budget nobody
 *     can count is not a budget; continuing would be unbounded spend.
 *  4. **An unchanged failure is not progress.** A failure fingerprint
 *     that has already bought an attempt refuses the next one even on a
 *     new head, and files the notice instead.
 *
 * ## What refuses to resume, and why
 *
 *  * a **green / pending / cancelled** result — only a completed failure
 *    is actionable, and a green re-run arriving after a red one refuses
 *    because it is not a failure;
 *  * a **stale head** — CI catching up on a revision that has already been
 *    replaced would fix code nobody has;
 *  * a **superseded run** — the target is always the Task's LATEST run, so
 *    an older one is never resumed, and a run that is queued or running
 *    means the fix may already be in flight;
 *  * a run **parked on a question** — that is the owner's to answer, and
 *    resuming would consume their Inbox item with CI feedback;
 *  * a **done or cancelled** Task, checked here because the cloud dispatch
 *    path has no such guard of its own (only the fleet planner does);
 *  * the **global stop flag**, read fail-closed.
 *
 * ## Tenancy
 *
 * The Task comes from `TaskGitLinkService`, which walks the binding
 * owner's Works with the shared repo matcher; the resume then runs as
 * `task.userId` and `RunSteeringService` re-scopes the run by that owner.
 * Nothing in a webhook body chooses an account.
 *
 * ## Cost
 *
 * `TASK_CI_AUTO_RESUME_MAX_ATTEMPTS` (default **2**, `0` = off) is the
 * per-Task lifetime ceiling. Each attempt is one `agent-task-execute`
 * run — the same order of model spend as the run that opened the pull
 * request. See `docs/features/ci-auto-resume.md`.
 */
@Injectable()
export class TaskCiAutoResumeService {
    private readonly logger = new Logger(TaskCiAutoResumeService.name);

    constructor(
        private readonly tasks: TaskRepository,
        private readonly attempts: TaskCiAutoResumeAttemptRepository,
        private readonly links: TaskGitLinkService,
        private readonly runs: AgentRunRepository,
        private readonly rejections: TaskReviewRejectionRepository,
        // Every collaborator below is @Optional() and appended in a stable
        // order — the house positional convention, so hand-rolled
        // positional test constructions keep working.
        //
        // Without the steering port there is no dispatch path and the loop
        // refuses rather than inventing one.
        @Optional()
        @Inject(RUN_STEERING_PORT)
        private readonly steering?: RunSteeringPort,
        @Optional()
        @Inject(INBOX_PRODUCER)
        private readonly inbox?: InboxProducer,
        // The GLOBAL STOP FLAG. Read fail-closed: a stopped (or
        // unreadable) platform resumes nothing.
        @Optional()
        @Inject(RUN_KILL_SWITCH)
        private readonly killSwitch?: RunKillSwitch,
    ) {}

    /**
     * A check result arrived from the provider.
     *
     * Never throws: the caller is a webhook consumer that must answer 200
     * fast, and every refusal is an ordinary outcome with a machine-
     * readable reason.
     */
    async onCheckResult(input: CiCheckResultInput): Promise<AutoResumeOutcome> {
        try {
            return await this.handleCheckResult(input);
        } catch (error) {
            // Fail CLOSED on anything unexpected: stop the loop, say so.
            this.logger.warn(
                `CI auto-resume aborted for ${input.owner}/${input.repo}@${input.headSha}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return { reason: 'error' };
        }
    }

    /**
     * A reviewer rejection was recorded for a pull request (slice AB
     * already wrote the durable row; this acts on it).
     *
     * Reads the recorded STATE rather than the delivery: if the Task has
     * no unconsumed rejection there is nothing to answer, whatever the
     * payload said.
     */
    async onReviewRejection(input: ReviewRejectionSignalInput): Promise<AutoResumeOutcome> {
        try {
            return await this.handleReviewRejection(input);
        } catch (error) {
            this.logger.warn(
                `Review auto-resume aborted for ${input.owner}/${input.repo}#${input.prNumber}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return { reason: 'error' };
        }
    }

    // ── entry points ───────────────────────────────────────────────

    private async handleCheckResult(input: CiCheckResultInput): Promise<AutoResumeOutcome> {
        const headSha = (input.headSha ?? '').trim();
        if (!headSha) return { reason: 'no-task' };

        const resolved = await this.resolveTask(input);
        if (!resolved) return { reason: 'no-task' };
        const { task, prNumber } = resolved;

        const failing = input.verdict === 'failing';
        const decision = decideCiHead(task, {
            headSha,
            // The pull request THIS Task owns, never simply the first entry
            // in the delivery: a commit that heads two pull requests lists
            // both, and the other one's head says nothing about this Task.
            prHeadSha: this.prHeadFor(input, prNumber ?? task.prNumber ?? null),
            reportedAt: input.observedAt,
        });

        // ── the ingest half: the provider's own verdict, onto the Task ──
        // Runs for every delivery whose head is not stale, red or green,
        // and BEFORE any budget question. Recording the head on a GREEN
        // push is what makes the staleness rule work at all: without it a
        // later red on the previous commit would still look current.
        if (decision !== 'stale') {
            await this.recordHead(task, headSha, input.observedAt ?? new Date(), failing, decision);
        }

        if (!failing) return { reason: 'not-a-failure', taskId: task.id };
        if (decision === 'stale') return { reason: 'stale-head', taskId: task.id };

        const feedback = composeCiFailureFeedback({
            repoFullName: `${input.owner}/${input.repo}`,
            headSha,
            checkName: input.checkName,
            conclusion: input.conclusion,
            prNumber: prNumber ?? task.prNumber ?? null,
            url: input.url ?? null,
            outputTitle: input.outputTitle ?? null,
            outputSummary: input.outputSummary ?? null,
        });

        return this.evaluate({
            task,
            trigger: 'ci',
            claimKey: ciAutoResumeClaimKey(headSha),
            headSha,
            failureKey: input.failureKey ?? null,
            detail: `${input.granularity}:${input.checkName}`,
            feedback: {
                text: feedback,
                reviewerLabel: input.checkName,
                prNumber: prNumber ?? task.prNumber ?? null,
                prUrl: input.url ?? null,
            },
            notice: {
                repoFullName: `${input.owner}/${input.repo}`,
                prNumber: prNumber ?? task.prNumber ?? null,
                headSha,
            },
        });
    }

    private async handleReviewRejection(
        input: ReviewRejectionSignalInput,
    ): Promise<AutoResumeOutcome> {
        const link = await this.links.findByPullRequest({
            userId: input.userId,
            owner: input.owner,
            repo: input.repo,
            prNumber: input.prNumber,
        });
        // Only the repository this Work's Tasks live in — see `resolveTask`.
        if (!link || link.isTaskRepo === false) return { reason: 'no-task' };
        const task = await this.tasks.findById(link.taskId);
        if (!task) return { reason: 'no-task' };

        // The durable state, not the payload: slice AB has already
        // decided whether this delivery was a rejection worth keeping.
        //
        // But a delivery is only a DOORBELL — `issue_comment` carries no
        // link to the row it is meant to answer — so the row it rings for
        // has to be checked, not merely fetched. Taking `findPendingForTask
        // (task.id, 1)` at face value let any created comment on the pull
        // request cash in whatever unconsumed row happened to be oldest:
        // a months-old `task-review` rejection a human recorded in the web
        // UI, or a `gate` row THIS service left pending after its own
        // dispatch failed — a full model run replaying a CI failure that no
        // longer exists. Three filters, all of them about the row rather
        // than the delivery:
        const oldest = (await this.rejections.findPendingForTask(task.id, REVIEW_PENDING_SCAN))
            .filter((row) => {
                //  1. a `gate` row is this loop's OWN CI failure record. The
                //     CI half owns it, and it is replayed by `resume`
                //     anyway; the reviewer doorbell must never spend an
                //     attempt on one.
                if (row.source === 'gate') return false;
                //  2. it has to be about THIS pull request. A row that names
                //     a different PR belongs to a different conversation.
                if (typeof row.prNumber === 'number' && row.prNumber !== input.prNumber) {
                    return false;
                }
                //  3. and it has to be recent enough to still be what the
                //     reviewer is waiting on. A rejection nobody consumed
                //     for a week was handled by a human, or abandoned.
                const createdAt = row.createdAt instanceof Date ? row.createdAt.getTime() : null;
                if (createdAt !== null && Date.now() - createdAt > REVIEW_PENDING_MAX_AGE_MS) {
                    return false;
                }
                return true;
            })
            .at(0);
        if (!oldest) return { reason: 'no-feedback', taskId: task.id };

        return this.evaluate({
            task,
            trigger: 'review',
            claimKey: reviewAutoResumeClaimKey(oldest.id),
            headSha: task.ciHeadSha ?? null,
            failureKey: null,
            detail: `review:${oldest.reviewerLabel ?? 'reviewer'}`.slice(0, 200),
            // Nothing to record — the row EXISTS, and `resume` claims it.
            feedback: null,
            notice: {
                repoFullName: `${input.owner}/${input.repo}`,
                prNumber: input.prNumber,
                headSha: task.ciHeadSha ?? null,
            },
        });
    }

    // ── the one decision path both entry points share ──────────────

    private async evaluate(ctx: {
        task: Task;
        trigger: TaskAutoResumeTrigger;
        claimKey: string;
        headSha: string | null;
        failureKey: string | null;
        detail: string;
        feedback: {
            text: string;
            reviewerLabel: string;
            prNumber: number | null;
            prUrl: string | null;
        } | null;
        notice: { repoFullName: string; prNumber: number | null; headSha: string | null };
    }): Promise<AutoResumeOutcome> {
        const { task } = ctx;
        const maxAttempts = config.agents.getCiAutoResumeMaxAttempts();
        if (maxAttempts <= 0) {
            return { reason: 'disabled', taskId: task.id, maxAttempts };
        }
        if (task.status === TaskStatus.DONE || task.status === TaskStatus.CANCELLED) {
            return { reason: 'task-finished', taskId: task.id };
        }
        // The loop already gave up on this Task and told the owner so.
        // Read from the row the caller already holds, so the terminal
        // steady state stays a pure READ: a Task's pull request keeps
        // receiving check deliveries for as long as it is open, and
        // re-issuing the notice CAS for every one of them was a
        // guaranteed-zero-row UPDATE against the busiest table in the
        // schema, forever, per Task, across six machines.
        if (task.ciAutoResumeNoticedAt) {
            return { reason: 'stopped', taskId: task.id, maxAttempts };
        }
        // A merged or closed pull request has nothing left to push a fix
        // to. `TaskStatus` alone does not cover this: the merged -> DONE
        // transition is poll-driven, conditional (only from in_progress /
        // in_review) and up to two minutes late, and a pull request the
        // owner closed WITHOUT merging is never transitioned at all — so
        // without this guard every red straggler on a dead PR keeps
        // resuming until the budget is gone.
        if (isPullRequestFinished(task)) {
            return { reason: 'pr-closed', taskId: task.id };
        }
        if (await this.isHalted()) {
            return { reason: 'halted', taskId: task.id };
        }
        if (!this.steering?.resumeRun) {
            this.logger.warn(
                `Task ${task.id}: CI is red but no run-steering port is bound on this install — nothing resumed.`,
            );
            return { reason: 'no-steering', taskId: task.id };
        }

        // ── the budget, from durable state, counted per ATTEMPT ──────
        let attemptsUsed: number;
        try {
            attemptsUsed = await this.attempts.countForTask(task.id);
        } catch (error) {
            // A budget nobody can count is not a budget. STOP.
            this.logger.warn(
                `Task ${task.id}: auto-resume budget unreadable — stopping the loop: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return { reason: 'budget-unreadable', taskId: task.id };
        }

        if (attemptsUsed >= maxAttempts) {
            return {
                reason: 'budget-spent',
                taskId: task.id,
                attemptsUsed,
                maxAttempts,
                noticeFiled: await this.fileStopNotice(
                    ctx,
                    'budget-spent',
                    attemptsUsed,
                    maxAttempts,
                ),
            };
        }

        if (ctx.failureKey) {
            let repeated: boolean;
            try {
                repeated = await this.attempts.hasFailureKey(task.id, ctx.failureKey);
            } catch (error) {
                this.logger.warn(
                    `Task ${task.id}: failure-fingerprint lookup failed — stopping the loop: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                );
                return { reason: 'budget-unreadable', taskId: task.id };
            }
            if (repeated) {
                return {
                    reason: 'repeat-failure',
                    taskId: task.id,
                    attemptsUsed,
                    maxAttempts,
                    noticeFiled: await this.fileStopNotice(
                        ctx,
                        'repeat-failure',
                        attemptsUsed,
                        maxAttempts,
                    ),
                };
            }
        }

        // ── which run, and is it ours to touch? ─────────────────────
        const run = await this.runs.findLatestForTask(task.id);
        if (!run) return { reason: 'no-run', taskId: task.id };
        // Status literals rather than `RunSteeringService.isLive`: this
        // package's import direction is agents → tasks-domain, never back.
        if (run.status === 'queued' || run.status === 'running') {
            return { reason: 'run-in-flight', taskId: task.id };
        }
        if (run.awaitingInput === true) {
            // Parked on a QUESTION. Resuming would clear `awaitingInput`
            // and spend the owner's Inbox item on CI feedback.
            return { reason: 'awaiting-human', taskId: task.id };
        }
        if (run.status !== 'completed') {
            return { reason: 'run-not-resumable', taskId: task.id };
        }

        // ── the claim. Everything above is a read; this is the act. ──
        const claimed = await this.attempts.claim({
            taskId: task.id,
            trigger: ctx.trigger,
            claimKey: ctx.claimKey,
            headSha: ctx.headSha,
            failureKey: ctx.failureKey,
            sourceRunId: run.id,
            detail: ctx.detail,
            workId: task.workId ?? null,
            tenantId: task.tenantId ?? null,
            organizationId: task.organizationId ?? null,
        });
        if (!claimed) {
            // A redelivery, another failing job on the same push, or the
            // loser of two replicas racing one delivery.
            return { reason: 'already-claimed', taskId: task.id, attemptsUsed, maxAttempts };
        }

        // ── the budget race ────────────────────────────────────────
        // The count above and the claim just made are two statements, so
        // deliveries for DIFFERENT heads can all read "1 of 2 used" and
        // all claim: their coordinates genuinely differ, so the unique
        // index cannot help, and the overshoot would be paid in model
        // runs. Re-reading the ledger AFTER the claim settles it — the
        // row is in the count now, so a claim that pushed the Task past
        // its budget refuses to dispatch.
        //
        // The claimed row is deliberately left in place: deleting it
        // would re-open the coordinate to the next redelivery, which is
        // the far more expensive mistake. So a lost race costs one
        // attempt slot and no model run — this fails toward NOT spending,
        // which is the direction that matters here.
        let settled: number;
        try {
            settled = await this.attempts.countForTask(task.id);
        } catch (error) {
            this.logger.warn(
                `Task ${task.id}: budget unreadable after claiming attempt ${claimed.id} — not dispatching: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return { reason: 'budget-unreadable', taskId: task.id };
        }
        if (settled > maxAttempts) {
            this.logger.warn(
                `Task ${task.id}: auto-resume attempt ${claimed.id} lost the budget race (${settled} claimed, budget ${maxAttempts}) — not dispatching.`,
            );
            return {
                reason: 'budget-spent',
                taskId: task.id,
                attemptsUsed: settled,
                maxAttempts,
                noticeFiled: await this.fileStopNotice(ctx, 'budget-spent', settled, maxAttempts),
            };
        }

        // Persist the failure as durable rejection feedback so `resume`'s
        // existing replay path seeds it into the new run's FIRST turn —
        // and so it survives if the dispatch fails. If the write fails,
        // fall back to handing the same text to `resume` as its message:
        // a resumed run that does not know what broke is the one outcome
        // worth avoiding here.
        let fallbackMessage: string | null = null;
        if (ctx.feedback) {
            // Will `resume` actually replay it?  `claimRejectionFeedback`
            // takes the MAX_REPLAYED_REJECTIONS OLDEST unconsumed rows, and
            // the row about to be written is the newest — so a Task already
            // carrying that many unconsumed reviewer findings would spend a
            // full model run seeded with three stale review comments and
            // never be told CI is red at all. When the row will fall
            // outside the window, hand the same text to `resume` as its
            // message instead (it is appended after the replayed block, so
            // nothing is lost or reordered).
            let replayWindowHasRoom = true;
            try {
                const alreadyPending = await this.rejections.findPendingForTask(
                    task.id,
                    MAX_REPLAYED_REJECTIONS,
                );
                replayWindowHasRoom = alreadyPending.length < MAX_REPLAYED_REJECTIONS;
            } catch {
                // Cannot tell — assume it will NOT be replayed. Duplicating
                // the failure text costs prompt tokens; losing it costs a
                // whole run that does not know what broke.
                replayWindowHasRoom = false;
            }
            if (!replayWindowHasRoom) fallbackMessage = ctx.feedback.text;
            try {
                await this.rejections.record({
                    taskId: task.id,
                    source: 'gate',
                    feedback: ctx.feedback.text,
                    workId: task.workId ?? null,
                    runId: run.id,
                    reviewerLabel: ctx.feedback.reviewerLabel,
                    reviewerKind: 'bot',
                    // A red gate blocks the merge; nothing about it is a nit.
                    severity: 'critical',
                    prNumber: ctx.feedback.prNumber,
                    prUrl: ctx.feedback.prUrl,
                    organizationId: task.organizationId ?? null,
                });
            } catch (error) {
                this.logger.warn(
                    `Task ${task.id}: could not persist CI failure feedback, seeding it directly: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                );
                fallbackMessage = ctx.feedback.text;
            }
        }

        try {
            const outcome = await this.steering.resumeRun({
                runId: run.id,
                // Platform state, never the webhook body.
                userId: task.userId,
                message: fallbackMessage,
                allowCompleted: true,
            });
            await this.attempts
                .stampResumedRun(claimed.id, outcome.runId)
                .catch((error: unknown) =>
                    this.logger.warn(
                        `Task ${task.id}: attempt ${claimed.id} resumed as ${outcome.runId} but the pointer did not stamp: ${error}`,
                    ),
                );
            this.logger.log(
                `Task ${task.id}: auto-resumed as run ${outcome.runId} (${ctx.trigger}, attempt ${
                    attemptsUsed + 1
                }/${maxAttempts}).`,
            );
            return {
                reason: 'resumed',
                taskId: task.id,
                runId: outcome.runId,
                attemptsUsed: attemptsUsed + 1,
                maxAttempts,
            };
        } catch (error) {
            // The attempt stays spent. That is the deliberate trade: a
            // claim that could be retried by a redelivery is exactly the
            // resume storm this ledger exists to stop.
            this.logger.warn(
                `Task ${task.id}: auto-resume dispatch failed (attempt spent): ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return {
                reason: 'dispatch-failed',
                taskId: task.id,
                attemptsUsed: attemptsUsed + 1,
                maxAttempts,
            };
        }
    }

    // ── internals ──────────────────────────────────────────────────

    /**
     * Repo + PR number (or branch) → the Task, through platform state only.
     *
     * Two rules that are easy to get wrong and expensive when they are:
     *
     *  * **The Work's TASK repository only.** A Work declares up to three
     *    repositories (`work`, `website`, `data`) and the shared matcher
     *    matches all three, but Task worktrees and Task pull requests are
     *    opened in the DATA repo (`TaskWorkspaceService`), so
     *    `tasks.prNumber` and `tasks.branchRef` are only unique there.
     *    Without the role check, a red check on pull request #7 of the
     *    Work's WEBSITE repo resolves to whatever Task opened #7 in the
     *    data repo, overwrites that Task's `ciHeadSha` with a commit from
     *    another repository, and spends an attempt telling an agent to
     *    fix a repository the failure is not in.
     *  * **One Works scan per delivery.** A commit that heads several pull
     *    requests lists all of them, and resolving each through
     *    `findByPullRequest` re-loaded the owner's entire Works list every
     *    time. The Task's own `prNumber` is tried FIRST so a stacked chain
     *    resolves to this Task rather than to whichever entry GitHub
     *    happened to order first.
     */
    private async resolveTask(
        input: CiCheckResultInput,
    ): Promise<{ task: Task; prNumber: number | null } | null> {
        const base = { userId: input.userId, owner: input.owner, repo: input.repo };
        const prNumbers = [...(input.prNumbers ?? [])];
        if (prNumbers.length > 0) {
            const link = await this.links.findByPullRequests(base, prNumbers);
            if (link) {
                if (link.isTaskRepo === false) return null;
                const task = await this.tasks.findById(link.taskId);
                return task ? { task, prNumber: link.prNumber } : null;
            }
        }
        // Fork pull requests report an EMPTY `pull_requests[]`, so the
        // branch is the only remaining coordinate — and it is `null` for
        // forks too, which is why both are tried and neither is assumed.
        const branch = (input.headBranch ?? '').trim();
        if (!branch) return null;
        const link = await this.links.findByBranch({ ...base, branch });
        if (!link || link.isTaskRepo === false) return null;
        const task = await this.tasks.findById(link.taskId);
        return task ? { task, prNumber: null } : null;
    }

    /**
     * The head the provider says THIS Task's pull request is at, from the
     * delivery's own `pull_requests[]`.
     *
     * Prefers the entry for the pull request the Task resolved through;
     * falls back to the Task's recorded `prNumber`, and finally to a lone
     * entry. Never guesses between two entries — an unrelated pull
     * request's head is not evidence about this one, so `null` (fall back
     * to the clock) is the honest answer.
     */
    private prHeadFor(input: CiCheckResultInput, prNumber: number | null): string | null {
        const heads = input.prHeads ?? [];
        if (heads.length === 0) return null;
        const wanted = prNumber;
        const match =
            (wanted !== null ? heads.find((entry) => entry.number === wanted) : undefined) ??
            (heads.length === 1 ? heads[0] : undefined);
        const sha = (match?.headSha ?? '').trim();
        return sha.length > 0 ? sha : null;
    }

    /**
     * Write the provider's head commit (and a RED verdict) onto the Task.
     *
     * Best-effort: this is the board's decoration plus the input to the
     * staleness rule, and losing one write costs freshness, not safety.
     */
    private async recordHead(
        task: Task,
        headSha: string,
        seenAt: Date,
        failing: boolean,
        decision: CiHeadDecision,
    ): Promise<void> {
        // Nothing new to say: same head, still not red.
        if (decision === 'current' && !failing) return;
        try {
            await this.tasks.recordCiHead({
                taskId: task.id,
                expectedHeadSha: decision === 'first-seen' ? null : (task.ciHeadSha ?? null),
                headSha,
                seenAt,
                failing,
            });
        } catch (error) {
            this.logger.warn(
                `Task ${task.id}: CI head write failed (ignored): ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }

    /**
     * File the ONE "automatic retries stopped" Inbox notice for this Task.
     *
     * The CAS marker on the Task is claimed BEFORE the notice is filed, so
     * exactly one of the dozens of deliveries that all rediscover a spent
     * budget can file — `InboxService.notice` has no dedup of its own and
     * would happily insert one row per `check_run`. At-most-once is the
     * deliberate direction: a marker that cannot be written files nothing
     * rather than everything.
     */
    private async fileStopNotice(
        ctx: {
            task: Task;
            notice: { repoFullName: string; prNumber: number | null; headSha: string | null };
        },
        reason: Extract<AutoResumeOutcomeReason, 'budget-spent' | 'repeat-failure'>,
        attemptsUsed: number,
        maxAttempts: number,
    ): Promise<boolean> {
        // Already stopped — nothing to claim and nothing to file. Checked
        // against the row in hand so the post-stop steady state issues no
        // write at all (`evaluate` short-circuits on the same field; this
        // is the belt for callers that reach here another way).
        if (ctx.task.ciAutoResumeNoticedAt) return false;
        let won: boolean;
        try {
            won = await this.tasks.casMarkCiAutoResumeNoticed(ctx.task.id, new Date());
        } catch (error) {
            this.logger.warn(
                `Task ${ctx.task.id}: notice marker CAS failed, filing nothing: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return false;
        }
        if (!won) return false;
        // The marker IS the stop flag, so it is claimed whether or not an
        // Inbox producer is bound: an install with no Inbox must still stop
        // the loop rather than re-deciding the same terminal condition on
        // every future delivery.
        ctx.task.ciAutoResumeNoticedAt = new Date();
        if (!this.inbox) return false;

        const { title, body } = composeBudgetSpentNotice({
            taskTitle: ctx.task.title,
            reason,
            attemptsUsed,
            maxAttempts,
            repoFullName: ctx.notice.repoFullName,
            prNumber: ctx.notice.prNumber,
            headSha: ctx.notice.headSha,
        });
        try {
            await this.inbox.notice(ctx.task.userId, {
                title,
                body,
                taskId: ctx.task.id,
                workId: ctx.task.workId ?? null,
                organizationId: ctx.task.organizationId ?? null,
            });
            return true;
        } catch (error) {
            this.logger.warn(
                `Task ${ctx.task.id}: auto-resume stop notice could not be filed: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return false;
        }
    }

    /** Fail-closed read of the global stop flag, mirroring the fan-out driver. */
    private async isHalted(): Promise<boolean> {
        if (!this.killSwitch) return false;
        try {
            return await this.killSwitch.shouldHaltDispatch();
        } catch (error) {
            this.logger.warn(
                `CI auto-resume: global stop flag unreadable — refusing to resume (fail-closed): ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return true;
        }
    }
}
