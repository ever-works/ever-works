import { Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { DomainEventPublisher } from '../domain-events/domain-event-publisher.service';
import type { GitDiffResult, GitPullRequestStatus } from '@ever-works/plugin';
import { DEFAULT_DIFF_MAX_BYTES, DEFAULT_DIFF_MAX_FILES, capChecks } from '@ever-works/plugin';
import { isAppWorkKind, normalizeCommitSha } from '@ever-works/contracts';
import { Task, TaskStatus } from '../entities/task.entity';
import { TaskRepository } from '../database/repositories/task.repository';
import { WorkRepository } from '../database/repositories/work.repository';
import { GitFacadeService } from '../facades/git.facade';
import { TaskTransitionService } from './task-transition.service';
import { TaskMergeGateService } from './task-merge-gate.service';
import { TaskCiAutoResumeService } from './task-ci-auto-resume.service';
import { classifyCheckResult, computeCiFailureKey, isTrustedCheckApp } from './task-ci-auto-resume';
import { config } from '../config';
import {
    PROMOTION_LANE_WATCHER,
    type PromotionLaneWatcher,
} from '../policy/promotion-merge-guard.port';
import { pickOwnerRepo, requireTaskRepository } from './task-repository';
import { TASK_DELIVERY_TRACKER, type TaskDeliveryTracker } from './task-delivery.port';
import { TASK_LIFECYCLE_POSTER, type TaskLifecyclePoster } from './task-lifecycle-poster.port';
import { checksSettledPost } from './task-lifecycle-posts';
import { TASK_APP_CHECKS, type TaskAppChecks } from './task-app-checks.port';
import { hasAppCheckLeg, withAppCheckRollUp } from './app-check-legs';

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
 *  6. **This is also where the MERGE question gets re-asked** (merge
 *     approval, self-build slice AE). A provider read is the only moment
 *     the platform knows whether a pull request is green, so every
 *     successful refresh hands the LIVE status to
 *     `TaskMergeGateService`, which raises the human approval for a green
 *     pull request and lands an approved one. Best-effort, per rule 4:
 *     the gate can never fail a status refresh.
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
    /**
     * APW-08 T22 — merges the App Works delivery chain took over: recorded as `merged` and NOT
     * completed here (the Task closes when its change is live). Always `0` without the chain.
     */
    deliveryTracked: number;
}

/** What {@link TaskPrStatusService.refreshTask} answers: the Task, and the provider read behind it. */
export interface TaskPrRefresh {
    task: Task;
    /** `null` when no provider read happened, or the pull request is gone from the provider. */
    status: GitPullRequestStatus | null;
}

@Injectable()
export class TaskPrStatusService {
    private readonly logger = new Logger(TaskPrStatusService.name);

    /** Single-flight map, keyed by task id (rule 2 above). */
    private readonly inFlight = new Map<string, Promise<TaskPrRefresh>>();

    constructor(
        private readonly tasks: TaskRepository,
        private readonly works: WorkRepository,
        @Optional() private readonly gitFacade?: GitFacadeService,
        @Optional() private readonly transitions?: TaskTransitionService,
        // Merge approval (self-build slice AE, EW-805) — the post-CI
        // re-evaluation of the merge. Appended LAST + @Optional() per the
        // positional-spec arity rule; absent, this service behaves exactly
        // as it did before the slice (refresh the cache, land merged PRs).
        @Optional() private readonly mergeGate?: TaskMergeGateService,
        // CI feedback + autonomous fix loop (slice AC, EW-806). Appended
        // LAST and @Optional(), the house positional convention: every
        // existing call site and positional test construction keeps its
        // meaning, and an install without the fix loop polls exactly as
        // it did before.
        @Optional() private readonly autoResume?: TaskCiAutoResumeService,
        // Release promotion lane (self-build slice AI, EW-808) — the
        // watcher that records what `promotion-gate.yml` said about this
        // Task's pull request. Appended LAST + @Optional() per the
        // positional-spec arity rule, and injected by TOKEN so
        // `TasksDomainModule` does not have to import the module that
        // imports it. Absent, promotions simply are not watched.
        @Optional()
        @Inject(PROMOTION_LANE_WATCHER)
        private readonly promotionLane?: PromotionLaneWatcher,
        // Domain events (EW-P1-1 B2) — a PR/CI state change is runtime-only:
        // `task.runtime_updated`, no version or updatedAt bump. Appended LAST
        // + @Optional (positional-spec arity rule).
        @Optional() private readonly domainEvents?: DomainEventPublisher,
        // APW-08 T22 — the App Works delivery chain's merge hook. Appended LAST + @Optional()
        // (positional-spec arity rule) and injected by TOKEN so this file never imports the
        // app-works graph. Absent, every merged pull request completes its Task as before.
        @Optional()
        @Inject(TASK_DELIVERY_TRACKER)
        private readonly delivery?: TaskDeliveryTracker,
        // APW-08 T26 / T54 (FR-43) — **Checks passed.** / **Checks failed: {names}.** on an App
        // Work Task, once per settled verdict (see `checksSettledPost`). Appended LAST +
        // @Optional() (positional-spec arity rule) and injected by TOKEN (see the port). Absent,
        // a refresh posts nothing, exactly as before.
        @Optional()
        @Inject(TASK_LIFECYCLE_POSTER)
        private readonly lifecycle?: TaskLifecyclePoster,
        // APW-08 T16 (APW08-G04) — the required/advisory split of an App Work pull request's
        // `Ever Works check: {name}` legs, read from the App rules at the PR base. Appended LAST +
        // @Optional() (positional-spec arity rule) and injected by TOKEN (see the port: a value
        // import of the App rules from here closes a require ring). Absent, or for any other Work
        // kind, the provider's roll-up is used exactly as before.
        @Optional()
        @Inject(TASK_APP_CHECKS)
        private readonly appChecks?: TaskAppChecks,
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

        const before = task.prState;
        const refreshed = await this.refreshTask(task, userId)
            .then(async (result) => {
                // APW-08 T22 — the on-demand read can be the first to see a merge, and the sweep
                // never re-selects a merged pull request, so a tracked merge is recorded here too
                // (once: `recordMerge` writes only from no state). Nothing else changes on this
                // path — it still never completes a Task.
                if (result.task.prState === 'merged' && before !== 'merged') {
                    await this.recordTrackedMerge(result.task, result.status);
                }
                return result.task;
            })
            .catch((error) => {
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
            deliveryTracked: 0,
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
                const { task: after, status } = await this.refreshTask(task, task.userId);
                summary.refreshed += 1;
                if (after.prState === 'merged' && before !== 'merged') {
                    summary.merged += 1;
                    if (await this.recordTrackedMerge(after, status)) {
                        summary.deliveryTracked += 1;
                    } else if (await this.completeOnMerge(after)) {
                        summary.completed += 1;
                    }
                } else {
                    await this.offerRedGateToFixLoop(after);
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

    /**
     * APW-08 T22 (FR-29, FR-30, FR-33) — a merge the App Works delivery chain follows is recorded
     * (`deliveryState = 'merged'`) and the Task stays in review until its change is live; the
     * caller then skips `completeOnMerge`. Any other merge — another branch (S19), a non-App
     * Work, no merge commit reported, no chain bound — answers `false` and completes as before.
     *
     * A tracker that THROWS also answers `false`: a merged Task is never stranded in review by a
     * broken hook (the chain degrades to today's behaviour, plan §8.2).
     */
    private async recordTrackedMerge(
        task: Task,
        status: GitPullRequestStatus | null,
    ): Promise<boolean> {
        if (!this.delivery) return false;
        try {
            if (!(await this.delivery.isDeliveryTracked(task, status))) return false;
            // A Task the chain already follows (its state was recorded by an earlier read).
            if (task.deliveryState) return true;
            if (!status) return false;
            const { recorded } = await this.delivery.recordMerge(task, status);
            if (recorded) return true;
            // Review of #3030 — a merge that was NOT recorded (a unique-index conflict, a caught
            // write error) leaves `deliveryState` NULL, and skipping the completion then would
            // strand the Task in review. Only a genuinely lost compare-and-set (another reader
            // recorded this merge first) counts as tracked, and only once the row says so.
            const current = await this.tasks.findById(task.id);
            return Boolean(current?.deliveryState);
        } catch (error) {
            this.logger.warn(
                `Task ${task.id}: the delivery merge hook threw; completing on merge instead (${
                    error instanceof Error ? error.message : String(error)
                }).`,
            );
            return false;
        }
    }

    /**
     * CI feedback + autonomous fix loop (slice AC, EW-806) — the SAFETY
     * NET behind the webhook.
     *
     * The webhook is a one-shot: a red result refused for a TRANSIENT
     * reason (`run-in-flight`, because the run that pushed the branch is
     * still posting the PR link when CI reports; `awaiting-human`, until
     * the owner answers) is refused forever, because nothing re-delivers
     * it. Every envelope for that push has already been ingested, so a
     * GitHub redelivery short-circuits as a duplicate, and when the run
     * finally ends there is no further CI event to arrive. The Task's red
     * build was then never retried — silently, with no Inbox notice.
     *
     * This sweep already runs every two minutes over exactly the right
     * population (open pull requests whose verdict has gone stale, never
     * a merged or closed one) and already has the provider's full check
     * list in hand, so re-offering a still-red gate here costs one extra
     * call on a Task that was going to be polled anyway.
     *
     * It cannot double-spend: the evaluator's claim key is
     * `ci:<headSha>`, so a head the webhook already resumed for is
     * `already-claimed` on every tick thereafter, forever.
     */
    private async offerRedGateToFixLoop(task: Task): Promise<void> {
        if (!this.autoResume?.onCheckResult) return;
        if (task.ciState !== 'failing' || !task.workId || !task.prNumber) return;
        // F8 — only a red check REPORTED BY an allow-listed app may be
        // re-offered: the webhook intake and the evaluator refuse any other
        // reporter, and this safety net must not be the way around them. A
        // commit status, or a row cached before the reporter was recorded,
        // has no app and is never re-offered.
        const trustedApps = config.agents.getTrustedCheckApps();
        const failing = (Array.isArray(task.prChecks) ? task.prChecks : []).filter(
            (check) =>
                // APW-08 T16 — an advisory App leg is reported, never handed to the fix loop.
                check.advisory !== true &&
                classifyCheckResult({
                    status: check.status,
                    conclusion: check.conclusion ?? null,
                }) === 'failing' &&
                isTrustedCheckApp(check.appSlug, trustedApps),
        );
        if (failing.length === 0) return;
        try {
            const target = await this.resolveRepo(task, task.userId);
            const headSha = (task.ciHeadSha ?? '').trim();
            if (!headSha) return;
            await this.autoResume.onCheckResult({
                // Platform state throughout — this path has no webhook
                // body to be tempted by.
                userId: task.userId,
                owner: target.owner,
                repo: target.repo,
                headSha,
                headBranch: task.branchRef ?? null,
                prNumbers: [task.prNumber],
                // The poll reads the PULL REQUEST, so the head it reports
                // IS the pull request's head by construction.
                prHeads: [{ number: task.prNumber, headSha }],
                observedAt: task.ciCheckedAt ?? null,
                verdict: 'failing',
                granularity: 'check_suite',
                appSlug: failing[0].appSlug ?? null,
                checkName: failing[0].name,
                conclusion: failing[0].conclusion ?? 'failure',
                url: failing[0].detailsUrl ?? task.prUrl ?? null,
                outputTitle: null,
                outputSummary: null,
                failureKey: computeCiFailureKey({
                    checkNames: failing.map((check) => check.name),
                    output: null,
                }),
            });
        } catch (error) {
            // Never a sweep failure: the fix loop is an extra, and this
            // Task's PR status has already been refreshed successfully.
            this.logger.warn(
                `CI fix-loop re-offer failed for task ${task.id}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }

    // ── Internals ─────────────────────────────────────────────────────

    /**
     * `task.runtime_updated` when a field the integration DTO shows
     * (`runtime.prState` / `runtime.ciState`) actually changed — the 2-minute
     * poll must not flood the outbox with no-op reads. Best-effort.
     */
    private async recordRuntimeChange(
        task: Task,
        patch: { prState?: unknown; ciState?: unknown },
    ): Promise<void> {
        const publisher = this.domainEvents;
        if (!publisher) return;
        const previous: Record<string, unknown> = {};
        if ('prState' in patch && patch.prState !== task.prState)
            previous.prState = task.prState ?? null;
        if ('ciState' in patch && patch.ciState !== task.ciState)
            previous.ciState = task.ciState ?? null;
        if (Object.keys(previous).length === 0) return;
        try {
            await publisher.transaction((manager) =>
                publisher.runtime(manager, task.id, {
                    changedFields: ['runtime'],
                    previous: { runtime: previous },
                    actor: { type: 'system', id: 'pr-status-cron', label: null },
                }),
            );
        } catch (err) {
            this.logger.warn(`Could not record task.runtime_updated for task ${task.id}: ${err}`);
        }
    }

    /**
     * Provider read + cache write for one Task, single-flighted.
     * Returns the Task with the fresh cache values applied in memory
     * (so the caller can answer without a re-read) AND the provider's
     * status behind it (APW-08 T22, APW08-G10: the merge hook needs the
     * merge commit and base branch, which the Task does not store).
     * `status` is `null` exactly where no read happened or the pull
     * request is gone from the provider.
     */
    private async refreshTask(task: Task, userId: string): Promise<TaskPrRefresh> {
        const existing = this.inFlight.get(task.id);
        if (existing) return existing;

        const work = (async () => {
            if (!this.gitFacade || !task.prNumber || !task.workId) return { task, status: null };
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
                return { task: Object.assign(task, { ciCheckedAt: checkedAt }), status: null };
            }
            // APW-08 T16 (FR-16) — an App Work's advisory legs, read at the PR base, so a failing
            // advisory `Ever Works check: {name}` leg reds neither the roll-up nor the merge gate
            // nor the **Checks failed** post. `null` (and `effective === status`) for every other
            // kind and whenever the rules cannot be read: then nothing is reclassified.
            const advisory = await this.appAdvisoryLegs(task, target, status);
            const effective = withAppCheckRollUp(status, advisory);
            const patch = this.toCachePatch(effective, checkedAt, advisory);
            // Reviewer agent stage (slice AD) — the head this Task had
            // recorded BEFORE this read, so a moved head is detectable below.
            const previousPrHead = task.prHeadSha ?? null;
            // APW-08 T26 / T54 (FR-43) — the verdict this Task had recorded
            // BEFORE this read against the one written now: a settled change
            // owes one thread post, an unchanged one none (so a sweep or a
            // poll that re-reads the same verdict posts nothing).
            const checksPost = this.lifecycle
                ? checksSettledPost(
                      { ciState: task.ciState, checks: task.prChecks },
                      { ciState: patch.ciState, checks: patch.prChecks },
                  )
                : null;
            await this.tasks.updatePrStatusCache(task.id, patch);
            await this.recordRuntimeChange(task, patch);
            // CI feedback + autonomous fix loop (slice AC, EW-806): the
            // provider's answer includes the pull request's CURRENT head,
            // which is the most authoritative statement of it anywhere —
            // better than any single check delivery, and available even on
            // an install whose webhook is not subscribed to check events at
            // all. Written through the same monotonic CAS the webhook uses,
            // so the two writers cannot clobber each other; a lost CAS just
            // means the webhook got there first and the in-memory copy is
            // left alone.
            const providerHead = (status.headSha ?? '').trim();
            if (providerHead && providerHead !== task.ciHeadSha) {
                const landed = await this.tasks
                    .recordCiHead({
                        taskId: task.id,
                        expectedHeadSha: task.ciHeadSha ?? null,
                        headSha: providerHead,
                        seenAt: checkedAt,
                        failing: false,
                    })
                    .catch(() => false);
                if (landed) {
                    Object.assign(task, { ciHeadSha: providerHead, ciHeadSeenAt: checkedAt });
                }
            }
            // Keep the branch chip honest too — a landed PR is a merged branch.
            if (status.state === 'merged' && task.branchState !== 'merged') {
                await this.tasks
                    .updateById(task.id, { branchState: 'merged' })
                    .catch(() => undefined);
                Object.assign(task, { branchState: 'merged' });
            }
            Object.assign(task, patch);

            // APW-08 T26 / T54 (FR-43) — posted once the cache write landed
            // and BEFORE the merge gate below may merge on green, so the
            // thread reads "Checks passed." ahead of "Merged into …". App
            // Work Tasks only (the poster decides); never throws.
            if (checksPost && this.lifecycle) {
                await this.lifecycle
                    .post({ task, post: checksPost, workKind: target.workKind })
                    .catch((error: unknown) => {
                        this.logger.warn(
                            `Task ${task.id}: the checks thread post threw: ${
                                error instanceof Error ? error.message : String(error)
                            }`,
                        );
                        return false;
                    });
            }

            // Reviewer agent stage (slice AD, EW-811) — a push while the
            // Task sits in `in_review` is not an ENTRY into `in_review`, so
            // the transition hook never sees it: slice AC's fix loop
            // resumes the run and pushes a new commit without moving the
            // Task. This read is where the platform learns the head moved,
            // so this is where the new commit gets its review. Bounded by
            // the review ledger's per-(reviewer, head) claim and lifetime
            // budget; fire-and-forget so a review hiccup never fails a
            // status refresh.
            if (
                task.status === TaskStatus.IN_REVIEW &&
                patch.prHeadSha &&
                patch.prHeadSha !== previousPrHead &&
                this.transitions?.requestAgentReviews
            ) {
                void this.transitions.requestAgentReviews(task).catch((error: unknown) => {
                    this.logger.warn(
                        `Task ${task.id}: agent review re-plan threw after a head change: ${
                            error instanceof Error ? error.message : String(error)
                        }`,
                    );
                });
            } else if (
                // CodeRabbit CR-2 — the head did NOT move, and this is still
                // the one place that visits every open-PR Task on a schedule
                // (the two-minute sweep; the on-demand refresh too). Planning
                // that never happened — a process killed between persisting
                // `in_review` (or a head change) and planning, a transient
                // provider failure — is recovered here instead of stalling
                // until the next push. `reconcileAgentReviews` is bounded by
                // the plan memory on the Task row: a steady-state Task costs
                // two ledger reads, a deterministically refused head costs no
                // provider call ever again, and a transient failure is retried
                // with capped backoff. Fire-and-forget, never a refresh failure.
                //
                // Only while the pull request THIS read reports is still open
                // (or draft): planning refuses a merged or closed one
                // (`pr-closed`) only after a Work read and a provider read of
                // its own, so reconciling the refresh that first sees the
                // merge would buy exactly that — and nothing else.
                task.status === TaskStatus.IN_REVIEW &&
                (patch.prState === 'open' || patch.prState === 'draft') &&
                patch.prHeadSha &&
                patch.prHeadSha === previousPrHead &&
                typeof this.transitions?.reconcileAgentReviews === 'function'
            ) {
                void this.transitions.reconcileAgentReviews(task).catch((error: unknown) => {
                    this.logger.warn(
                        `Task ${task.id}: agent review reconcile threw after a PR status refresh: ${
                            error instanceof Error ? error.message : String(error)
                        }`,
                    );
                });
            }

            // Release promotion lane (slice AI) — runs BEFORE the merge
            // gate, and deliberately runs whatever CI says: a promotion
            // has to be legible even when it can never merge, so an
            // operator watching a red promotion sees the gate's actual
            // verdict instead of silence. The merge gate below then reads
            // what this just recorded, for the same live head.
            if (this.promotionLane) {
                await this.promotionLane
                    .onPullRequestStatusRefreshed(task, effective)
                    .catch((error: unknown) => {
                        this.logger.warn(
                            `Task ${task.id}: promotion lane threw after a PR status refresh: ${
                                error instanceof Error ? error.message : String(error)
                            }`,
                        );
                        return undefined;
                    });
            }

            // Merge approval (self-build slice AE) — THIS is the moment
            // the merge question can finally be answered: the provider has
            // just told us the pull request's state, head commit and CI
            // verdict. Best-effort by contract (rule 4 above): the gate
            // never fails a status refresh, and it is deliberately given
            // the LIVE `status` rather than the Task's cache.
            if (this.mergeGate) {
                await this.mergeGate
                    .onPullRequestStatusRefreshed(task, effective)
                    .catch((error: unknown) => {
                        this.logger.warn(
                            `Task ${task.id}: merge gate threw after a PR status refresh: ${
                                error instanceof Error ? error.message : String(error)
                            }`,
                        );
                        return undefined;
                    });
            }
            return { task, status: effective };
        })().finally(() => {
            this.inFlight.delete(task.id);
        });

        this.inFlight.set(task.id, work);
        return work;
    }

    /**
     * APW-08 T16 — the advisory `Ever Works check: {name}` legs of an App Work pull request, from
     * the App rules at the PR's base branch. Read only for an App Work whose status carries at
     * least one App leg (no leg, no read). Never throws: a failed read classifies nothing, which
     * can only keep a red roll-up red.
     */
    private async appAdvisoryLegs(
        task: Task,
        target: { baseRef: string; workKind: string | null },
        status: GitPullRequestStatus,
    ): Promise<ReadonlySet<string> | null> {
        if (!this.appChecks || !isAppWorkKind(target.workKind)) return null;
        if (!hasAppCheckLeg(status.checks)) return null;
        try {
            return await this.appChecks.advisoryLegs(task, status.baseRef ?? target.baseRef);
        } catch (error) {
            this.logger.warn(
                `Task ${task.id}: App check legs could not be classified; the provider roll-up stands (${
                    error instanceof Error ? error.message : String(error)
                }).`,
            );
            return null;
        }
    }

    private toCachePatch(
        status: GitPullRequestStatus,
        checkedAt: Date,
        // APW-08 T16 — advisory App legs, marked on the cached row so every later reader of
        // `prChecks` (the **Checks failed** names, the fix-loop re-offer) skips them without
        // re-reading the rules. Absent for every other kind: the row is byte-for-byte as before.
        advisory?: ReadonlySet<string> | null,
    ): Pick<Task, 'prState' | 'ciState' | 'ciCheckedAt' | 'prChecks' | 'prHeadSha'> {
        return {
            prState: status.state,
            ciState: status.ciState,
            ciCheckedAt: checkedAt,
            // Merge approval (slice AE): the head the PROVIDER reports.
            // `recordRemotePush` still refuses to persist the head a run
            // pushed — the remote owns the branch head — and this is the
            // same rule from the other side: the only head worth caching
            // is the one the provider just named.
            prHeadSha: normalizeCommitSha(status.headSha),
            prChecks: capChecks(status.checks).map((check) => ({
                name: check.name,
                status: check.status,
                conclusion: check.conclusion ?? null,
                ...(check.detailsUrl ? { detailsUrl: check.detailsUrl } : {}),
                // Who reported it (F8) — the fix-loop re-offer reads this.
                appSlug: check.appSlug ?? null,
                ...(advisory?.has(check.name) ? { advisory: true } : {}),
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
            await this.transitions.transition(task, TaskStatus.DONE, {
                actorType: 'agent',
                // Works-security: the platform completing the Task its own pull
                // request belongs to — dependents are released as before (see
                // `withAgentFanOutSuppressed`).
                ownRunTask: true,
                // Reviewer agent stage (review of Greptile P1-A on PR #2419):
                // the approver gate binds agent decisions to the MERGED head —
                // `refreshTask` assigned `prHeadSha` from the provider's answer
                // moments ago, and a merged pull request's head never moves
                // again. Passed explicitly because the Task's other head
                // column (`ciHeadSha`) is written by a compare-and-set that can
                // lose to a check delivery in the same poll; the gate used to
                // refuse on that disagreement, and since a merge is completed
                // only once (the sweep never re-selects a merged pull request)
                // the refusal was permanent.
                livePullRequestHeadSha: task.prHeadSha ?? null,
            });
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
        /** APW-08 FR-43 — the Work's kind, so the thread post needs no second Work read. */
        workKind: string | null;
    }> {
        const work = await this.works.findById(task.workId as string);
        if (!work) {
            throw new NotFoundException(`Task ${task.id} has no reachable Work.`);
        }
        return {
            // EW-P2-4 — refused (400) for a repo-less Work, never a derived name.
            ...pickOwnerRepo(requireTaskRepository(work, 'pull request status')),
            baseRef:
                (work.taskIsolationBaseBranch && work.taskIsolationBaseBranch.trim()) || 'main',
            gitOptions: { userId, providerId: work.gitProvider, workId: work.id },
            workKind: work.kind ?? null,
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
