import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import {
    TASK_AGENT_REVIEW_CLAIM_KEY_MAX_CHARS,
    TaskAgentReview,
    type TaskAgentReviewState,
} from '../../entities/task-agent-review.entity';

export interface ClaimAgentReviewInput {
    taskId: string;
    reviewerAgentId: string;
    approverId: string;
    /** Idempotency coordinate — UNIQUE per Task. See the entity doc. */
    claimKey: string;
    headSha: string;
    prNumber?: number | null;
    ciState?: string | null;
    workId?: string | null;
    tenantId?: string | null;
    organizationId?: string | null;
}

/**
 * Reviewer agent stage (slice AD, EW-811) — the review ledger's
 * operations, and no more.
 *
 * Every method here is on the money path or the authorization path:
 * `countForTask` IS the lifetime budget, `claim` IS the idempotency
 * guard, `bindRun` + `findOpenForRun` ARE the proof that the platform
 * dispatched THIS run for this review. All of them are allowed to THROW, and the
 * caller depends on it — a budget nobody can count is not a budget, a
 * claim that cannot be written must not be treated as won, and an
 * authorization lookup that fails must refuse rather than admit.
 * Nothing in this file swallows an error into a permissive default.
 */
@Injectable()
export class TaskAgentReviewRepository {
    constructor(
        @InjectRepository(TaskAgentReview)
        private readonly repository: Repository<TaskAgentReview>,
    ) {}

    /**
     * How many review runs this Task has already bought, over its whole
     * life. Rows, not transitions. THROWS on a read failure.
     */
    async countForTask(taskId: string): Promise<number> {
        return this.repository.count({ where: { taskId } });
    }

    /**
     * Claim ONE review, or lose the race.
     *
     * Returns the row this caller inserted, or `null` when the
     * `(taskId, claimKey)` unique index says a review for this
     * coordinate already exists — the outcome for a retried transition,
     * a Task that left and re-entered `in_review` on the same commit, and
     * the loser of two API replicas handling one transition.
     *
     * Check-then-insert is not atomic, so the constraint violation is the
     * real guard; the pre-read only saves an INSERT in the common case
     * (same convention as `TaskCiAutoResumeAttemptRepository.claim`).
     */
    async claim(input: ClaimAgentReviewInput): Promise<TaskAgentReview | null> {
        const claimKey = input.claimKey.slice(0, TASK_AGENT_REVIEW_CLAIM_KEY_MAX_CHARS);
        const existing = await this.repository.findOne({
            where: { taskId: input.taskId, claimKey },
        });
        if (existing) return null;
        try {
            return await this.repository.save(
                this.repository.create({
                    taskId: input.taskId,
                    reviewerAgentId: input.reviewerAgentId,
                    approverId: input.approverId,
                    claimKey,
                    headSha: input.headSha,
                    prNumber: input.prNumber ?? null,
                    ciState: input.ciState ?? null,
                    state: 'dispatched',
                    workId: input.workId ?? null,
                    tenantId: input.tenantId ?? null,
                    organizationId: input.organizationId ?? null,
                }),
            );
        } catch (error) {
            if (this.isUniqueViolation(error)) return null;
            throw error;
        }
    }

    /**
     * Every claim key this Task's ledger holds, whatever the row's state.
     *
     * The cheap pre-check `planReviews` runs BEFORE any provider call: when
     * every eligible reviewer already holds a claim for the head the Task
     * last recorded, a re-entry into `in_review` (a flip-flop, a retried
     * transition) costs no pull-request read and no diff download. Bounded
     * by the lifetime budget, which caps rows per Task.
     */
    async listClaimKeysForTask(taskId: string): Promise<string[]> {
        const rows = await this.repository.find({
            where: { taskId },
            select: ['id', 'claimKey'],
        });
        return rows.map((row) => row.claimKey);
    }

    /**
     * The OPEN review bound to this RUN, or `null`.
     *
     * THIS is the authorization the verdict path runs on. The run id comes
     * from platform state (the tool loop's own run context), never from a
     * model, and the binding was written by `bindRun` BEFORE the run was
     * handed to a job runtime. So a later run of the same agent — a chat
     * reply, a run on another Task, a run started after this review's own
     * run died — holds no binding and can record no verdict, and a model
     * cannot point a verdict at a Task other than the one this run was
     * dispatched to review.
     *
     * THROWS on a read failure — see the class doc.
     */
    async findOpenForRun(runId: string): Promise<TaskAgentReview | null> {
        return this.repository.findOne({ where: { runId, state: 'dispatched' } });
    }

    /**
     * Bind a freshly created run to its review — BEFORE the enqueue.
     *
     * Compare-and-set: only an OPEN row with no run yet (or already bound
     * to this very run, so a retry is idempotent) accepts the binding.
     * THROWS when it does not land, so the dispatch that called it rolls
     * the run back instead of starting a review run nothing is bound to.
     */
    async bindRun(id: string, runId: string): Promise<void> {
        const result = await this.repository.update(
            { id, state: 'dispatched', runId: IsNull() },
            { runId },
        );
        if ((result.affected ?? 0) > 0) return;
        // Idempotent retry: the same run binding the same open review again.
        const already = await this.repository.findOne({
            where: { id, state: 'dispatched', runId },
        });
        if (already) return;
        throw new Error(`agent-review-binding-refused: review ${id} is not open for run ${runId}`);
    }

    /**
     * The OPEN review this agent holds on this Task, newest first, or
     * `null`.
     *
     * Reporting only. It is NOT an authorization: an agent can hold an
     * open row whose run has already died, and any other run of that agent
     * would pass a (task, agent) check. The verdict path authorizes on
     * {@link findOpenForRun}.
     *
     * THROWS on a read failure — see the class doc.
     */
    async findOpenForReviewer(
        taskId: string,
        reviewerAgentId: string,
    ): Promise<TaskAgentReview | null> {
        return this.repository.findOne({
            where: { taskId, reviewerAgentId, state: 'dispatched' },
            order: { createdAt: 'DESC', id: 'DESC' },
        });
    }

    /**
     * Every run id this Task's reviews were bound to.
     *
     * CANDIDATES for exclusion from the Task's authorship evidence, not
     * the exclusion itself: `TaskAgentReviewService` leaves a run out only
     * when its own row ALSO proves it was admitted with the review-only
     * tool scope, i.e. when it provably could not author anything. Without
     * any exclusion a reviewer would disqualify ITSELF the moment it
     * started, and no second-round review could ever happen.
     */
    async listRunIdsForTask(taskId: string): Promise<string[]> {
        const rows = await this.repository.find({
            where: { taskId },
            select: ['id', 'runId'],
        });
        return rows.map((row) => row.runId).filter((id): id is string => Boolean(id));
    }

    /**
     * Attach the dispatched run after the fact. Best-effort bookkeeping —
     * the AUTHORITATIVE binding is {@link bindRun}, written before the
     * enqueue.
     */
    async stampRunId(id: string, runId: string): Promise<void> {
        await this.repository.update({ id }, { runId });
    }

    /**
     * Write the ONE terminal state.
     *
     * Compare-and-set from `dispatched`, so a second verdict submission
     * for the same review (a retried tool call, a model that calls the
     * tool twice) affects zero rows and is reported as such — the
     * approver row is written by the caller only when this returns true.
     */
    async casSettle(
        id: string,
        state: Exclude<TaskAgentReviewState, 'dispatched'>,
        patch: { refusalCode?: string | null; summary?: string | null } = {},
    ): Promise<boolean> {
        const result = await this.repository.update(
            { id, state: 'dispatched' },
            {
                state,
                refusalCode: patch.refusalCode ?? null,
                summary: patch.summary ?? null,
                decidedAt: new Date(),
            },
        );
        return (result.affected ?? 0) > 0;
    }

    /** Reviews for one Task, oldest first. Reporting and tests. */
    async listForTask(taskId: string): Promise<TaskAgentReview[]> {
        return this.repository.find({
            where: { taskId },
            order: { createdAt: 'ASC', id: 'ASC' },
        });
    }

    private isUniqueViolation(error: unknown): boolean {
        if (!error || typeof error !== 'object') return false;
        const driverCode = (error as { driverError?: { code?: string } }).driverError?.code;
        const topCode = (error as { code?: string }).code;
        // Postgres 23505 / MySQL ER_DUP_ENTRY / SQLite SQLITE_CONSTRAINT*.
        // The sqlite arm is a PREFIX match: better-sqlite3 reports the
        // EXTENDED result code (`SQLITE_CONSTRAINT_UNIQUE`), so an exact
        // comparison misses a real unique hit and `claim()` throws instead
        // of losing the race gracefully. Same reasoning as
        // `TaskCiAutoResumeAttemptRepository.isUniqueViolation`.
        const codes = ['23505', 'ER_DUP_ENTRY'];
        for (const code of [driverCode, topCode]) {
            if (typeof code !== 'string') continue;
            if (codes.includes(code) || code.startsWith('SQLITE_CONSTRAINT')) return true;
        }
        return false;
    }
}
