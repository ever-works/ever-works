import { Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import type { GitDiffResult, GitPullRequestStatus } from '@ever-works/plugin';
import { DEFAULT_DIFF_MAX_BYTES, DEFAULT_DIFF_MAX_FILES, capChecks } from '@ever-works/plugin';
import { Task, TaskStatus } from '../entities/task.entity';
import { TaskRepository } from '../database/repositories/task.repository';
import { WorkRepository } from '../database/repositories/work.repository';
import { GitFacadeService } from '../facades/git.facade';
import { TaskTransitionService } from './task-transition.service';

/**
 * PR insights (kanban run cockpit, plan 04 M5 + M6 + the merged half of
 * M7) — the ONE place the platform asks a git provider "what is happening
 * to this Task's pull request?".
 *
 * Three consumers, one code path:
 *
 *  - `GET /api/tasks/:id/pr-status` — on-demand, owner-scoped, throttled.
 *  - the `task-pr-status-sync` cron — batch sweep of stale open PRs.
 *  - `GET /api/tasks/:id/diff` — the board's diff sheet.
 *
 * Design rules, all load-bearing:
 *
 *  1. **Throttled by the cache, not by the caller.** Every refresh path
 *     goes through `refreshIfStale`, which returns the cached row
 *     untouched when `ciCheckedAt` is younger than the floor. A user
 *     hammering the pill cannot amplify into provider calls.
 *  2. **Single-flight per Task.** Concurrent refreshes for one Task share
 *     one in-flight promise, so a board with ten cards in review and a
 *     cron tick landing at the same moment still makes one call per PR.
 *  3. **Terminal states are never re-polled.** Once a PR reads `merged`
 *     or `closed`, the sweep predicate excludes it forever (the plan's
 *     "only while the PR is open").
 *  4. **A provider failure is not a Task failure.** Every write is
 *     best-effort; a rate-limited sync leaves the previous verdict in
 *     place and tries again next tick.
 *  5. **Merged ⇒ done goes through `TaskTransitionService`**, never a raw
 *     status write, so the approver + blocker gates keep holding. A Task
 *     whose approvals are still pending simply stays in review — the
 *     merge is recorded, the transition is not forced.
 */

/** Minimum seconds between two provider reads for the same Task. */
export const PR_STATUS_REFRESH_FLOOR_SECONDS = 60;

/** How stale the cron lets a cached verdict get before refreshing it. */
export const PR_STATUS_SYNC_STALE_SECONDS = 120;

/** Tasks refreshed per cron tick (per-provider rate budget). */
export const PR_STATUS_SYNC_BATCH = 25;

export interface TaskPrStatusView {
    taskId: string;
    prNumber: number | null;
    prUrl: string | null;
    prState: string | null;
    ciState: string | null;
    ciCheckedAt: Date | null;
    checks: Array<{
        name: string;
        status: string;
        conclusion?: string | null;
        detailsUrl?: string;
    }>;
    /** True when this response came from the cache without a provider call. */
    cached: boolean;
}

export interface TaskDiffView {
    taskId: string;
    /** `pull-request` when a PR exists, `compare` for a bare branch. */
    source: 'pull-request' | 'compare';
    prNumber: number | null;
    prUrl: string | null;
    branchRef: string | null;
    baseRef: string | null;
    diff: GitDiffResult;
}

export interface PrStatusSyncSummary {
    scanned: number;
    refreshed: number;
    merged: number;
    completed: number;
    failed: number;
}

@Injectable()
export class TaskPrStatusService {
    private readonly logger = new Logger(TaskPrStatusService.name);

    /** Single-flight map, keyed by task id (rule 2 above). */
    private readonly inFlight = new Map<string, Promise<Task>>();

    constructor(
        private readonly tasks: TaskRepository,
        private readonly works: WorkRepository,
        @Optional() private readonly gitFacade?: GitFacadeService,
        @Optional() private readonly transitions?: TaskTransitionService,
    ) {}

    // ── Read paths ────────────────────────────────────────────────────

    /**
     * Owner-scoped PR status for one Task. Refreshes from the provider
     * only when the cache is older than `PR_STATUS_REFRESH_FLOOR_SECONDS`.
     */
    async getForTask(
        userId: string,
        taskId: string,
        opts: { refresh?: boolean } = {},
    ): Promise<TaskPrStatusView> {
        const task = await this.tasks.findByIdAndUser(taskId, userId);
        if (!task) throw new NotFoundException(`Task ${taskId} not found.`);

        if (!task.prNumber || !task.workId) {
            return this.toView(task, true);
        }

        const floorMs = PR_STATUS_REFRESH_FLOOR_SECONDS * 1000;
        const age = task.ciCheckedAt ? Date.now() - new Date(task.ciCheckedAt).getTime() : Infinity;
        if (!opts.refresh && age < floorMs) {
            return this.toView(task, true);
        }
        // A terminal PR never changes again — serve the cache forever.
        if (task.prState === 'merged' || task.prState === 'closed') {
            return this.toView(task, true);
        }

        const refreshed = await this.refreshTask(task, userId).catch((error) => {
            this.logger.warn(
                `PR status refresh failed for task ${task.id}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return task;
        });
        return this.toView(refreshed, refreshed === task);
    }

    /**
     * Owner-scoped capped diff for one Task.
     *
     * Prefers the PR (it is the reviewable unit); falls back to
     * `base...branch` compare for a pushed branch that has not opened one.
     * 404s when the Task has neither — there is nothing to preview.
     */
    async getDiffForTask(
        userId: string,
        taskId: string,
        opts: { maxBytes?: number; maxFiles?: number } = {},
    ): Promise<TaskDiffView> {
        const task = await this.tasks.findByIdAndUser(taskId, userId);
        if (!task) throw new NotFoundException(`Task ${taskId} not found.`);
        if (!task.workId) {
            throw new NotFoundException(`Task ${taskId} has no Work, so no repository to diff.`);
        }
        if (!task.prNumber && !task.branchRef) {
            throw new NotFoundException(`Task ${taskId} has no branch or pull request to diff.`);
        }
        if (!this.gitFacade) {
            throw new NotFoundException(`Diffs are unavailable in this runtime.`);
        }

        const target = await this.resolveRepo(task, userId);
        const diffOptions = {
            maxBytes: opts.maxBytes ?? DEFAULT_DIFF_MAX_BYTES,
            maxFiles: opts.maxFiles ?? DEFAULT_DIFF_MAX_FILES,
        };

        if (task.prNumber) {
            const diff = await this.gitFacade.getPullRequestDiff(
                target.owner,
                target.repo,
                task.prNumber,
                diffOptions,
                target.gitOptions,
            );
            return {
                taskId: task.id,
                source: 'pull-request',
                prNumber: task.prNumber,
                prUrl: task.prUrl ?? null,
                branchRef: task.branchRef ?? null,
                baseRef: target.baseRef,
                diff,
            };
        }

        const diff = await this.gitFacade.getCompareDiff(
            target.owner,
            target.repo,
            target.baseRef,
            task.branchRef as string,
            diffOptions,
            target.gitOptions,
        );
        return {
            taskId: task.id,
            source: 'compare',
            prNumber: null,
            prUrl: null,
            branchRef: task.branchRef ?? null,
            baseRef: target.baseRef,
            diff,
        };
    }

    // ── Sync sweep (the `task-pr-status-sync` cron) ───────────────────

    /**
     * Refresh every open-PR Task whose verdict has gone stale, and land
     * the merged ones.
     *
     * Per-Task isolation is total: one Task's provider error, missing
     * credentials or refused transition never stops the sweep.
     */
    async syncDuePrStatuses(
        opts: { limit?: number; staleSeconds?: number } = {},
    ): Promise<PrStatusSyncSummary> {
        const summary: PrStatusSyncSummary = {
            scanned: 0,
            refreshed: 0,
            merged: 0,
            completed: 0,
            failed: 0,
        };
        if (!this.gitFacade) return summary;

        const staleSeconds = opts.staleSeconds ?? PR_STATUS_SYNC_STALE_SECONDS;
        const staleBefore = new Date(Date.now() - staleSeconds * 1000);
        const due = await this.tasks.findDuePrStatusSync(
            staleBefore,
            opts.limit ?? PR_STATUS_SYNC_BATCH,
        );
        summary.scanned = due.length;

        for (const task of due) {
            try {
                const before = task.prState;
                const after = await this.refreshTask(task, task.userId);
                summary.refreshed += 1;
                if (after.prState === 'merged' && before !== 'merged') {
                    summary.merged += 1;
                    if (await this.completeOnMerge(after)) summary.completed += 1;
                }
            } catch (error) {
                summary.failed += 1;
                this.logger.warn(
                    `PR status sync failed for task ${task.id}: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                );
            }
        }

        return summary;
    }

    // ── Internals ─────────────────────────────────────────────────────

    /**
     * Provider read + cache write for one Task, single-flighted.
     * Returns the Task with the fresh cache values applied in memory
     * (so the caller can answer without a re-read).
     */
    private async refreshTask(task: Task, userId: string): Promise<Task> {
        const existing = this.inFlight.get(task.id);
        if (existing) return existing;

        const work = (async () => {
            if (!this.gitFacade || !task.prNumber || !task.workId) return task;
            const target = await this.resolveRepo(task, userId);
            const status = await this.gitFacade.getPullRequestStatus(
                target.owner,
                target.repo,
                task.prNumber,
                target.gitOptions,
            );
            const checkedAt = new Date();
            if (!status) {
                // The PR is gone from the provider. Record the read so the
                // sweep does not spin on it; the state stays whatever it was.
                await this.tasks.updatePrStatusCache(task.id, { ciCheckedAt: checkedAt });
                return Object.assign(task, { ciCheckedAt: checkedAt });
            }
            const patch = this.toCachePatch(status, checkedAt);
            await this.tasks.updatePrStatusCache(task.id, patch);
            // Keep the branch chip honest too — a landed PR is a merged branch.
            if (status.state === 'merged' && task.branchState !== 'merged') {
                await this.tasks
                    .updateById(task.id, { branchState: 'merged' })
                    .catch(() => undefined);
                Object.assign(task, { branchState: 'merged' });
            }
            return Object.assign(task, patch);
        })().finally(() => {
            this.inFlight.delete(task.id);
        });

        this.inFlight.set(task.id, work);
        return work;
    }

    private toCachePatch(
        status: GitPullRequestStatus,
        checkedAt: Date,
    ): Pick<Task, 'prState' | 'ciState' | 'ciCheckedAt' | 'prChecks'> {
        return {
            prState: status.state,
            ciState: status.ciState,
            ciCheckedAt: checkedAt,
            prChecks: capChecks(status.checks).map((check) => ({
                name: check.name,
                status: check.status,
                conclusion: check.conclusion ?? null,
                ...(check.detailsUrl ? { detailsUrl: check.detailsUrl } : {}),
            })),
        };
    }

    /**
     * Lifecycle transition (plan 04 M7): a merged PR completes the Task.
     *
     * Goes through `TaskTransitionService` with `actorType: 'agent'`, so
     * the approver gate, the blocker gate and the quality gate all still
     * apply. A refusal is NOT an error — the Task stays where it is and
     * the merge simply waits on the humans. Returns whether the Task
     * actually moved.
     */
    private async completeOnMerge(task: Task): Promise<boolean> {
        if (!this.transitions) return false;
        if (task.status === TaskStatus.DONE || task.status === TaskStatus.CANCELLED) return false;
        // `done` is only reachable from in_progress / in_review; anything
        // else (blocked on a conflict, still in backlog) is a human's call.
        if (task.status !== TaskStatus.IN_PROGRESS && task.status !== TaskStatus.IN_REVIEW) {
            return false;
        }
        try {
            await this.transitions.transition(task, TaskStatus.DONE, { actorType: 'agent' });
            this.logger.log(`Task ${task.id} completed — PR #${task.prNumber} merged.`);
            return true;
        } catch (error) {
            this.logger.log(
                `Task ${task.id} PR #${task.prNumber} merged but the Task stays in ` +
                    `${task.status}: ${error instanceof Error ? error.message : String(error)}`,
            );
            return false;
        }
    }

    /** Work → (owner, repo, baseRef, facade options). Mirrors TaskWorkspaceService. */
    private async resolveRepo(
        task: Task,
        userId: string,
    ): Promise<{
        owner: string;
        repo: string;
        baseRef: string;
        gitOptions: { userId: string; providerId: string; workId: string };
    }> {
        const work = await this.works.findById(task.workId as string);
        if (!work) {
            throw new NotFoundException(`Task ${task.id} has no reachable Work.`);
        }
        return {
            owner: work.getRepoOwner(),
            repo: work.getDataRepo(),
            baseRef:
                (work.taskIsolationBaseBranch && work.taskIsolationBaseBranch.trim()) || 'main',
            gitOptions: { userId, providerId: work.gitProvider, workId: work.id },
        };
    }

    private toView(task: Task, cached: boolean): TaskPrStatusView {
        return {
            taskId: task.id,
            prNumber: task.prNumber ?? null,
            prUrl: task.prUrl ?? null,
            prState: task.prState ?? null,
            ciState: task.ciState ?? null,
            ciCheckedAt: task.ciCheckedAt ?? null,
            checks: Array.isArray(task.prChecks) ? task.prChecks : [],
            cached,
        };
    }
}
