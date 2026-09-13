import { Injectable, Logger } from '@nestjs/common';
import { TaskRepository } from '../database/repositories/task.repository';
import { WorkRepository } from '../database/repositories/work.repository';
import {
    WORK_TASK_REPO_ROLE,
    matchWorkRepoRole,
    type WorkRepoRole,
} from '../works/work-repo-match';

/** What a git ref resolved to inside the platform, when it resolved at all. */
export interface TaskGitLink {
    workId: string;
    taskId: string;
    /** The Task's human slug — cheap context for the Activity row. */
    taskSlug?: string | null;
    /**
     * WHICH of the Work's repo roles the delivery's repository fills —
     * all of them, since two roles can resolve to the same repository.
     */
    repoRoles?: readonly WorkRepoRole[];
    /**
     * True when the repository is the one this Work's TASKS live in (the
     * data repo — see {@link WORK_TASK_REPO_ROLE}), i.e. the one
     * `tasks.prNumber` and `tasks.branchRef` are unique within.
     *
     * A consumer that merely decorates an ingested event can ignore this.
     * A consumer that ACTS on the Task it resolved — rewriting its CI
     * head, resuming its run — must not, or a pull request #7 in the
     * Work's website repo resolves to the Task that opened #7 in the data
     * repo.
     */
    isTaskRepo?: boolean;
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

    /**
     * The Task behind ANY of several pull request numbers reported for one
     * commit, resolving the owner's Works exactly ONCE.
     *
     * A commit can head several pull requests (a stacked chain, a shared
     * branch), and a provider delivery lists all of them. Calling
     * {@link findByPullRequest} per number re-loads the owner's entire
     * Works list every time — on a webhook hot path, for the busiest
     * account on the platform, discarding every scan before the matching
     * one. This does the repo→Work walk once and then asks only the Task
     * query per number.
     *
     * `prNumbers` is tried in order and the first hit wins; the caller
     * should put its preferred number first. Returns the matched number
     * alongside the link so the caller can line the result up with the
     * delivery's per-pull-request data.
     */
    async findByPullRequests(
        base: TaskGitLookupBase,
        prNumbers: readonly number[],
    ): Promise<(TaskGitLink & { prNumber: number }) | null> {
        const wanted = prNumbers.filter((n) => Number.isInteger(n));
        if (wanted.length === 0) return null;
        const matched = await this.matchWork(base);
        if (!matched) return null;
        try {
            for (const prNumber of wanted) {
                const task = await this.tasks.findByWorkAndPrNumber(matched.work.id, prNumber);
                if (task) {
                    return {
                        workId: matched.work.id,
                        taskId: task.id,
                        taskSlug: task.slug ?? null,
                        repoRoles: matched.roles,
                        isTaskRepo: matched.roles.includes(WORK_TASK_REPO_ROLE),
                        prNumber,
                    };
                }
            }
        } catch (error) {
            this.logger.warn(
                `Task link lookup failed for ${base.owner}/${base.repo}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
        return null;
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
        const matched = await this.matchWork(base);
        if (!matched) return null;
        try {
            const task = await findTask(matched.work.id);
            if (!task) return null;
            return {
                workId: matched.work.id,
                taskId: task.id,
                taskSlug: task.slug ?? null,
                repoRoles: matched.roles,
                isTaskRepo: matched.roles.includes(WORK_TASK_REPO_ROLE),
            };
        } catch (error) {
            this.logger.warn(
                `Task link lookup failed for ${base.owner}/${base.repo}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return null;
        }
    }

    /** Owner-scoped repo→Work walk. One `findByUser` per call, never more. */
    private async matchWork(
        base: TaskGitLookupBase,
    ): Promise<{ work: { id: string }; roles: readonly WorkRepoRole[] } | null> {
        if (!base.userId || !base.owner || !base.repo) return null;
        try {
            const candidates = await this.works.findByUser(base.userId);
            return matchWorkRepoRole(candidates ?? [], base.owner, base.repo);
        } catch (error) {
            this.logger.warn(
                `Work lookup failed for ${base.owner}/${base.repo}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return null;
        }
    }
}
