import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import {
    TASK_REVIEW_REJECTION_MAX_FEEDBACK_CHARS,
    TaskReviewRejection,
    type TaskReviewRejectionSource,
} from '../../entities/task-review-rejection.entity';

export interface RecordTaskReviewRejectionInput {
    taskId: string;
    source: TaskReviewRejectionSource;
    feedback: string;
    workId?: string | null;
    runId?: string | null;
    reviewerUserId?: string | null;
    reviewerLabel?: string | null;
    prNumber?: number | null;
    prUrl?: string | null;
    organizationId?: string | null;
}

/**
 * Orchestration M9 — durable rejection feedback.
 *
 * Two operations only, because the record has two moments: it is written
 * when a human says no, and it is claimed exactly once by the next
 * resumed run. Everything else (listing, resolving) is deliberately
 * absent — an unread rejection is not a queue item, it is context for the
 * run that has not happened yet.
 */
@Injectable()
export class TaskReviewRejectionRepository {
    constructor(
        @InjectRepository(TaskReviewRejection)
        private readonly repository: Repository<TaskReviewRejection>,
    ) {}

    /**
     * Persist one rejection. Feedback is capped here rather than at the
     * call sites: the writers are a webhook bridge, a chat tool and a
     * worker, and a text column with no ceiling is a DoS surface no
     * matter which one is careless.
     *
     * Returns `null` for an empty/whitespace-only body — "rejected with no
     * words" carries nothing for the next run and must not create a row
     * that would later be prepended as an empty block.
     */
    async record(input: RecordTaskReviewRejectionInput): Promise<TaskReviewRejection | null> {
        const feedback = (input.feedback ?? '').trim();
        if (feedback.length === 0) return null;
        const row = this.repository.create({
            taskId: input.taskId,
            source: input.source,
            feedback: feedback.slice(0, TASK_REVIEW_REJECTION_MAX_FEEDBACK_CHARS),
            workId: input.workId ?? null,
            runId: input.runId ?? null,
            reviewerUserId: input.reviewerUserId ?? null,
            reviewerLabel: input.reviewerLabel ?? null,
            prNumber: input.prNumber ?? null,
            prUrl: input.prUrl ?? null,
            ...(input.organizationId !== undefined ? { organizationId: input.organizationId } : {}),
        });
        return this.repository.save(row);
    }

    /**
     * The pending rejections for a Task, oldest first.
     *
     * Oldest-first matters: when two reviewers rejected before anyone
     * resumed, the agent should read them in the order they were written,
     * the same way it would read a comment thread. Bounded by `limit` so
     * a Task that accumulated a rejection storm cannot blow the prompt.
     */
    async findPendingForTask(taskId: string, limit = 3): Promise<TaskReviewRejection[]> {
        return this.repository.find({
            where: { taskId, consumedByRunId: IsNull() },
            order: { createdAt: 'ASC' },
            take: Math.max(1, Math.min(20, limit)),
        });
    }

    /**
     * Claim rows for a resumed run. CAS-guarded on `consumedByRunId IS
     * NULL` so two concurrent resumes cannot both seed the same feedback:
     * the loser's UPDATE matches nothing and its run starts without it,
     * which is the correct outcome (the feedback IS being acted on, by
     * the other run).
     *
     * Returns how many rows this caller actually claimed.
     */
    async markConsumed(ids: string[], runId: string): Promise<number> {
        if (ids.length === 0) return 0;
        const result = await this.repository
            .createQueryBuilder()
            .update(TaskReviewRejection)
            .set({ consumedByRunId: runId, consumedAt: new Date() })
            .where('id IN (:...ids)', { ids })
            .andWhere('consumedByRunId IS NULL')
            .execute();
        return result.affected ?? 0;
    }
}
