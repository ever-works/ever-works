import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { TaskRepository } from '../database/repositories/task.repository';
import { TaskReviewRejectionRepository } from '../database/repositories/task-review-rejection.repository';
import { TaskReviewerRepository } from '../database/repositories/task-side.repositories';
import { WorkRepository } from '../database/repositories/work.repository';
import { matchWorkByRepo } from '../works/work-repo-match';
import type {
    TaskReviewRejection,
    TaskReviewRejectionReviewerKind,
    TaskReviewRejectionSeverity,
} from '../entities/task-review-rejection.entity';

/**
 * Orchestration M9 — the write half of the rejection loop.
 *
 * The plan's mechanism is "when a reviewer rejects, the rejection text is
 * persisted and prepended to the resumed session's context". The READ
 * half already exists (`RunSteeringService.resume` claims pending rows);
 * this service is every way a rejection can be produced.
 *
 * ## The review record this feature had to define
 *
 * There was no durable rejection anywhere in the codebase before this.
 * `task_reviewers.reviewState` carries a three-value enum
 * (`pending | requested-changes | approved`) and **no feedback text**, and
 * nothing in product code ever wrote it — `TaskReviewerRepository.setState`
 * had zero non-test callers. The PR review loop posted its verdict to the
 * git provider and kept nothing locally.
 *
 * So the minimal record is `task_review_rejections`: Task-scoped (the run
 * that was rejected is already terminal and the next run is a new row, so
 * the Task is the only stable join), append-only, with `consumedByRunId`
 * as its entire state machine. Two existing signals feed it:
 *
 *  1. **Task review** — {@link rejectTask}. This is also where
 *     `task_reviewers.reviewState` finally gets written: rejecting flips
 *     the caller's reviewer row to `requested-changes`, so the pre-existing
 *     advisory signal and the new durable one can never disagree.
 *  2. **Pull-request state** — {@link recordPullRequestRejection}, called
 *     from the GitHub webhook bridge on a `changes_requested` review. The
 *     PR is resolved to a Work through the SAME `matchWorkByRepo` matcher
 *     the PR reviewer uses, then to a Task by `(workId, prNumber)`.
 */
@Injectable()
export class TaskReviewRejectionService {
    private readonly logger = new Logger(TaskReviewRejectionService.name);

    constructor(
        private readonly tasks: TaskRepository,
        private readonly rejections: TaskReviewRejectionRepository,
        private readonly reviewers: TaskReviewerRepository,
        private readonly works: WorkRepository,
    ) {}

    /**
     * A human rejected the agent's work on a Task.
     *
     * Owner-scoped through `findByIdAndUser`, so a Task belonging to
     * someone else is indistinguishable from a missing one (no existence
     * oracle — architecture/security §9).
     */
    async rejectTask(
        userId: string,
        taskId: string,
        feedback: string,
        opts: { runId?: string | null } = {},
    ): Promise<TaskReviewRejection> {
        const trimmed = (feedback ?? '').trim();
        if (trimmed.length === 0) {
            // A rejection with no words gives the next run nothing to act
            // on. Refuse loudly rather than persisting an empty prepend.
            throw new ForbiddenException('Rejection feedback is required.');
        }
        const task = await this.tasks.findByIdAndUser(taskId, userId);
        if (!task) throw new NotFoundException(`Task ${taskId} not found.`);

        const row = await this.rejections.record({
            taskId: task.id,
            source: 'task-review',
            feedback: trimmed,
            workId: task.workId ?? null,
            runId: opts.runId ?? null,
            reviewerUserId: userId,
            organizationId: task.organizationId ?? null,
        });
        // `record` only returns null for empty feedback, which is already
        // refused above — but the type is honest, so satisfy it honestly.
        if (!row) throw new ForbiddenException('Rejection feedback is required.');

        // Wire the PRE-EXISTING advisory signal: if this user is a
        // declared reviewer on the Task, their row now says what they
        // actually did. Best-effort — the durable rejection is the record
        // that matters, and a missing reviewer row is normal (anyone with
        // access can reject).
        await this.syncReviewerState(task.id, userId);

        this.logger.log(`Task ${task.id}: rejection recorded by user ${userId}.`);
        return row;
    }

    /**
     * A human — or a trusted reviewer bot (R16) — rejected the agent's
     * PULL REQUEST on the git provider.
     *
     * Best-effort by contract and returns `null` on every miss: the caller
     * is a webhook handler that must answer 200 quickly, and "we could not
     * map this PR to a Task" is an ordinary outcome (the PR may belong to
     * a repo that is not a Work, or to a Task that was deleted). It is
     * never an error the delivery should fail on.
     *
     * `reviewerKind` and `severity` are the bridge's classification of the
     * author and of the bot's own marker; they are stored verbatim so the
     * resumed run can tell a CodeRabbit "Major" from a nit.
     */
    async recordPullRequestRejection(input: {
        userId: string;
        owner: string;
        repo: string;
        prNumber: number;
        feedback: string;
        reviewerLabel?: string | null;
        prUrl?: string | null;
        reviewerKind?: TaskReviewRejectionReviewerKind | null;
        severity?: TaskReviewRejectionSeverity | null;
    }): Promise<TaskReviewRejection | null> {
        const trimmed = (input.feedback ?? '').trim();
        if (trimmed.length === 0) return null;
        try {
            const candidates = await this.works.findByUser(input.userId);
            const work = matchWorkByRepo(candidates ?? [], input.owner, input.repo);
            if (!work) return null;
            const task = await this.tasks.findByWorkAndPrNumber(work.id, input.prNumber);
            if (!task) return null;
            const row = await this.rejections.record({
                taskId: task.id,
                source: 'pull-request',
                feedback: trimmed,
                workId: work.id,
                reviewerLabel: input.reviewerLabel ?? null,
                prNumber: input.prNumber,
                prUrl: input.prUrl ?? null,
                reviewerKind: input.reviewerKind ?? null,
                severity: input.severity ?? null,
                organizationId: task.organizationId ?? null,
            });
            if (row) {
                this.logger.log(
                    `Task ${task.id}: PR rejection recorded from ${input.owner}/${input.repo}#${input.prNumber}.`,
                );
            }
            return row;
        } catch (error) {
            this.logger.warn(
                `PR rejection record failed for ${input.owner}/${input.repo}#${input.prNumber}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return null;
        }
    }

    /**
     * The gate gave up. Machine-authored feedback, recorded so a LATER
     * resume replays it — the iterate loop already fed it to the run that
     * was executing, but that run is terminal and its context is gone.
     */
    async recordGateRejection(input: {
        taskId: string;
        workId?: string | null;
        runId?: string | null;
        feedback: string;
        organizationId?: string | null;
    }): Promise<TaskReviewRejection | null> {
        return this.rejections.record({
            taskId: input.taskId,
            source: 'gate',
            feedback: input.feedback,
            workId: input.workId ?? null,
            runId: input.runId ?? null,
            organizationId: input.organizationId ?? null,
        });
    }

    // ── internals ──────────────────────────────────────────────────

    private async syncReviewerState(taskId: string, userId: string): Promise<void> {
        try {
            const rows = await this.reviewers.findByTaskId(taskId);
            const mine = rows.find(
                (row) => row.reviewerType === 'user' && row.reviewerId === userId,
            );
            if (!mine) return;
            await this.reviewers.setState(mine.id, 'requested-changes', taskId);
        } catch (error) {
            this.logger.warn(
                `Task ${taskId}: reviewer-state sync failed (rejection still recorded): ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }
}
