import { Injectable, Logger } from '@nestjs/common';
import { TaskRepository } from '../database/repositories/task.repository';
import { WorkRepository } from '../database/repositories/work.repository';
import { matchWorkByRepo } from '../works/work-repo-match';

/** What a git ref resolved to inside the platform, when it resolved at all. */
export interface TaskGitLink {
    workId: string;
    taskId: string;
    /** The Task's human slug — cheap context for the Activity row. */
    taskSlug?: string | null;
}

/** Coordinates every lookup starts from: the repo the delivery named. */
export interface TaskGitLookupBase {
    userId: string;
    owner: string;
    repo: string;
}

/**
 * Git activity ingestion (audit item j) — the read-only "which Task does
 * this git ref belong to?" resolver.
 *
 * A push carries a branch and a merged pull request carries a number.
 * Both are Task coordinates: the worktree-per-Task path writes
 * `tasks.branchRef` when it provisions a workspace and `tasks.prNumber`
 * when it opens the PR. This service is the ONE place that turns either
 * back into a Task, so the webhook bridge does not grow its own copy of
 * the repo→Work→Task walk that {@link TaskReviewRejectionService} already
 * performs for `changes_requested` reviews.
 *
 * Three rules, mirroring the rejection recorder and the ingest spine:
 *
 *   1. **Owner-scoped, always.** Candidate Works come from
 *      `WorkRepository.findByUser(userId)` and the repo is matched with
 *      the shared `matchWorkByRepo`, so a delivery can never resolve into
 *      another tenant's Task.
 *   2. **`null` is a normal outcome.** A repository that is not a Work, a
 *      branch nobody's Task owns, a PR opened by a human — all ordinary.
 *      The event still gets ingested; it just carries no `taskId`.
 *   3. **Never throws.** The caller is a webhook handler that must answer
 *      200 fast. A repository failure logs and resolves to `null`.
 */
@Injectable()
export class TaskGitLinkService {
    private readonly logger = new Logger(TaskGitLinkService.name);

    constructor(
        private readonly tasks: TaskRepository,
        private readonly works: WorkRepository,
    ) {}

    /** The Task that opened `prNumber` in `owner/repo`, or null. */
    async findByPullRequest(
        input: TaskGitLookupBase & { prNumber: number },
    ): Promise<TaskGitLink | null> {
        if (!Number.isInteger(input.prNumber)) return null;
        return this.resolve(input, (workId) =>
            this.tasks.findByWorkAndPrNumber(workId, input.prNumber),
        );
    }

    /** The Task whose isolated worktree branch is `branch`, or null. */
    async findByBranch(input: TaskGitLookupBase & { branch: string }): Promise<TaskGitLink | null> {
        const branch = (input.branch ?? '').trim();
        if (!branch) return null;
        return this.resolve(input, (workId) => this.tasks.findByWorkAndBranchRef(workId, branch));
    }

    /**
     * Shared walk: owner-scoped Works → repo match → per-lookup Task
     * query.
     *
     * A matched Work with no matching Task resolves to `null` rather than
     * to a Work-only link: the ingest spine already routes the event to
     * that same Work through its own `workHint`, so a half-link here would
     * only be a second, staler copy of information the row already has.
     */
    private async resolve(
        base: TaskGitLookupBase,
        findTask: (workId: string) => Promise<{ id: string; slug?: string | null } | null>,
    ): Promise<TaskGitLink | null> {
        if (!base.userId || !base.owner || !base.repo) return null;
        try {
            const candidates = await this.works.findByUser(base.userId);
            const work = matchWorkByRepo(candidates ?? [], base.owner, base.repo);
            if (!work) return null;
            const task = await findTask(work.id);
            if (!task) return null;
            return { workId: work.id, taskId: task.id, taskSlug: task.slug ?? null };
        } catch (error) {
            this.logger.warn(
                `Task link lookup failed for ${base.owner}/${base.repo}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return null;
        }
    }
}
