import { Injectable, Logger, Optional } from '@nestjs/common';
import { normalizeCommitSha } from '@ever-works/contracts';
import type { GitDiffResult, GitPullRequestStatus } from '@ever-works/plugin';
import { capChecks } from '@ever-works/plugin';
import { TaskStatus, type Task } from '../entities/task.entity';
import type { TaskApprover } from '../entities/task-approver.entity';
import type { TaskAgentReview } from '../entities/task-agent-review.entity';
import type { Agent } from '../entities/agent.entity';
import { TaskRepository } from '../database/repositories/task.repository';
import { WorkRepository } from '../database/repositories/work.repository';
import { AgentRepository } from '../database/repositories/agent.repository';
import { AgentRunRepository } from '../database/repositories/agent-run.repository';
import {
    TaskAgentReviewRepository,
    type ClaimAgentReviewResult,
} from '../database/repositories/task-agent-review.repository';
import {
    TaskApproverRepository,
    TaskAssigneeRepository,
} from '../database/repositories/task-side.repositories';
import { GitFacadeService } from '../facades/git.facade';
import { config } from '../config';
import { resolveTaskDispatchAgentIds } from './task-dispatch-agents';
import {
    AGENT_REVIEW_BRIEF_MISSING,
    AGENT_REVIEW_DIFF_MAX_BYTES,
    AGENT_REVIEW_DIFF_MAX_FILES,
    agentApproverNeedsReview,
    agentReviewApproverFingerprint,
    agentReviewClaimKey,
    agentReviewPlanKey,
    assessReviewDiff,
    composeAgentReviewBrief,
    isAgentReviewRunScope,
    isSameAgentIdentity,
    parseAgentReviewVerdict,
    resolveReviewHead,
    SUBMIT_TASK_REVIEW_TOOL,
    type AgentReviewDispatchDecision,
    type AgentReviewDispatchOutcome,
    type AgentReviewDispatchReason,
    type AgentReviewVerdictResult,
} from './task-agent-review';
import { resolveTaskRepository } from './task-repository';

/** Longest reviewer-supplied summary persisted on the review row. */
export const AGENT_REVIEW_SUMMARY_MAX_CHARS = 4000;

/** One review the caller should now start a run for. */
export interface PlannedAgentReview {
    reviewId: string;
    reviewerAgentId: string;
    approverId: string;
    headSha: string;
    /** The brief, seeded onto the run row BEFORE the job runtime sees it. */
    brief: string;
    /** Runtime dedup key — one review run per (task, reviewer, head). */
    dedupKey: string;
}

export interface AgentReviewPlan extends AgentReviewDispatchOutcome {
    dispatches: PlannedAgentReview[];
}

/**
 * What the platform's OWN state says about a Task's agent reviews, read
 * without any provider call — see {@link TaskAgentReviewService.probeAgentReviewPlan}.
 */
export interface AgentReviewPlanProbe {
    /** `false` when configuration switches the stage off; nothing else is read. */
    enabled: boolean;
    /** The head this Task last recorded (`prHeadSha`, else `ciHeadSha`), normalized. */
    headSha: string | null;
    /** {@link agentReviewPlanKey} for that head and the agent approver set; `null` without a head. */
    planKey: string | null;
    /** Agent approvers that need a review of `headSha`. */
    needsReview: number;
    /** Of those, how many hold no review claim for `(reviewer, headSha)`. */
    unclaimed: number;
}

/** What `TaskTransitionService.dispatchAgentRun` reported back. */
export interface AgentReviewDispatchResult {
    runId: string | null;
    dispatched: boolean;
    parked: boolean;
    error?: string;
}

export interface SubmitAgentReviewInput {
    /**
     * The RUN that is speaking — the tool loop's own run id. Platform
     * state, never model input, and THE authorization: only the run the
     * review ledger bound at dispatch may answer that review.
     */
    runId: string | null | undefined;
    /**
     * Optional, model-supplied, and never trusted. When present it must
     * name the Task the bound review is about, or nothing is recorded; the
     * Task written is always the bound review's own.
     */
    taskId?: string | null;
    /** The agent whose RUN is speaking. Platform state, never model input. */
    reviewerAgentId: string;
    /** Raw model-supplied verdict. Only an explicit value is a verdict. */
    verdict: unknown;
    summary?: string | null;
}

/**
 * Reviewer agent stage (self-build slice AD, EW-811, closes finding R18).
 *
 * ## The gap this closes
 *
 * Before this slice, an "agent approver" on a Task was a row nothing ever
 * wrote: `TaskApproverRepository.setState` had zero production callers,
 * there was no review-run dispatch anywhere in the repo, and the only
 * textual trace of a reviewer agent was two `starter-review-coordinator`
 * strings in seeded template copy. A red build produced a resumed run
 * (slice AC) and a human decision (slice AE), and nothing ever read the
 * diff.
 *
 * ## The two halves
 *
 *  - {@link planReviews} — called on entry to `in_review`. Reads the pull
 *    request and its diff, refuses everything it cannot review, and
 *    CLAIMS one ledger row per surviving agent approver. It does not
 *    start runs: it returns a plan, and `TaskTransitionService` starts
 *    them through `dispatchAgentRun`, THE dispatch path, so a review run
 *    passes the same admission gate, credits precheck and kill switch as
 *    every other run. There is no new `createQueued` call site in this
 *    slice.
 *  - {@link submitVerdict} — called by the reviewer's own tool. Verifies
 *    that the RUN speaking is the run the platform bound to this review
 *    before it was enqueued, that its agent is not reviewing its own
 *    work, and that the commit it read is still the commit under review
 *    (read live from the provider, never from a cache), and only then
 *    writes the `task_approvers` row.
 *
 * ## Three properties this file exists to hold
 *
 * 1. **A reviewer never approves its own work, and the PLATFORM decides
 *    that.** {@link disqualifiedReviewer} is consulted at dispatch (so no
 *    money is spent on a review that could not be accepted) AND again at
 *    verdict time (so an approver attached after the run, or a second
 *    agent row wearing the same persona, is refused at the moment it
 *    matters). Identity is `(userId, slug)`, not the primary key —
 *    `agents` is unique per SCOPE, so one persona can hold several ids.
 *
 * 2. **An agent approval is not a human approval.** This file writes
 *    an approval to exactly one table, `task_approvers`, through exactly
 *    two methods: `TaskAgentReviewRepository.recordVerdict` (which settles
 *    the review ledger row in the same transaction), and
 *    `TaskApproverRepository.restoreAgentDecisionFromReview`, which only
 *    puts a verdict that `recordVerdict` already recorded in the ledger for
 *    the live head back onto its `pending` row. It never touches
 *    `agent_action_proposals`, which is the only table
 *    `MergeApprovalService.verifyMergeApproval` reads, and it stamps
 *    `decidedVia: 'agent-review'` — a value that does not exist in
 *    `AgentActionProposalDecidedVia` and would be refused by that
 *    verifier's `decidedVia !== 'user'` check even if it did. Nothing
 *    here widens the merge gate; the `task_approvers` gate is still only
 *    `in_review → done`.
 *
 * 3. **Bounded cost.** One review is one model run. Every path that can
 *    start one is bounded: the lifetime budget (a UNIQUE `(taskId, slot)`
 *    in `task_agent_reviews`, so the database refuses a run past it however
 *    planners interleave), the per-entry approver cap, and the
 *    `(taskId, claimKey)` unique index keyed on `(reviewer, head commit)`
 *    which collapses a retried transition, a flip-flop, a replica race
 *    and a push re-planned by the PR-status poll into ONE run per commit.
 *    A review run cannot re-trigger itself: it holds one tool and no
 *    workspace, so it can neither transition the Task nor push. One claim
 *    is one model run — the worker's quality-gate iterate loop never runs
 *    for a review run. A re-entry on an already-claimed commit costs no
 *    provider call at all (the pre-claim check). A dispatch that fails
 *    still spends its claim, deliberately: a claim a redelivery can retry
 *    forever is the review storm the ledger exists to stop.
 *
 *    A review run is refused on the FLEET, before any node is involved:
 *    a fleet node has no tool channel through which a verdict could be
 *    recorded, so a fleet review would be a model run with a structurally
 *    impossible outcome. It lands as a failed dispatch on the run row and
 *    the ledger, where an owner can read why.
 *
 * ## Fail-closed, everywhere
 *
 * An unfetchable diff, a truncated diff, an empty diff, an unreadable
 * pull request, an unknown head commit, an unreadable budget and an
 * unreadable reviewer identity are ALL refusals that dispatch nothing and
 * approve nothing. There is no path in this file that reaches an approval
 * without having read a diff, and none that treats an unreadable verdict
 * as a pass.
 */
@Injectable()
export class TaskAgentReviewService {
    private readonly logger = new Logger(TaskAgentReviewService.name);

    constructor(
        private readonly tasks: TaskRepository,
        private readonly reviews: TaskAgentReviewRepository,
        private readonly approvers: TaskApproverRepository,
        // Every one of these is @Optional() so an install that wires only
        // part of the graph refuses to review rather than half-reviewing;
        // the refusal ladder names which piece was missing.
        @Optional() private readonly works?: WorkRepository,
        @Optional() private readonly assignees?: TaskAssigneeRepository,
        @Optional() private readonly runs?: AgentRunRepository,
        @Optional() private readonly agents?: AgentRepository,
        @Optional() private readonly gitFacade?: GitFacadeService,
    ) {}

    // ── the dispatch half ─────────────────────────────────────────────

    /**
     * Does this Task still owe agent reviews for the head it last recorded?
     * Two ledger-side reads, never a provider call (CodeRabbit CR-2).
     *
     * The PR-status poll's reconcile asks this for every `in_review` Task it
     * refreshes, so it has to be cheap: the approver rows and the claim keys,
     * nothing else. It deliberately does NOT run the self-review check (more
     * reads per approver) — a reviewer refused for that is remembered by the
     * plan memory instead, under the key this returns.
     *
     * `null` when a read threw: the caller cannot tell, so the reconcile does
     * nothing this time (no spend) and asks again on the next poll.
     */
    async probeAgentReviewPlan(task: Task): Promise<AgentReviewPlanProbe | null> {
        try {
            if (
                config.agents.getAgentReviewMaxRunsPerTask() <= 0 ||
                config.agents.getAgentReviewMaxApproversPerEntry() <= 0
            ) {
                return {
                    enabled: false,
                    headSha: null,
                    planKey: null,
                    needsReview: 0,
                    unclaimed: 0,
                };
            }
            const headSha = normalizeCommitSha(resolveReviewHead(task));
            const agentRows = (await this.approvers.findByTaskId(task.id)).filter(
                (row) => row.approverType === 'agent',
            );
            const needing = agentRows.filter((row) => agentApproverNeedsReview(row, headSha));
            if (!headSha) {
                return {
                    enabled: true,
                    headSha: null,
                    planKey: null,
                    needsReview: needing.length,
                    unclaimed: needing.length,
                };
            }
            const planKey = agentReviewPlanKey(
                headSha,
                agentReviewApproverFingerprint(agentRows.map((row) => row.id)),
            );
            const probe: AgentReviewPlanProbe = {
                enabled: true,
                headSha,
                planKey,
                needsReview: needing.length,
                unclaimed: 0,
            };
            if (needing.length === 0) return probe;
            const claimed = new Set(await this.reviews.listClaimKeysForTask(task.id));
            probe.unclaimed = needing.filter(
                (row) => !claimed.has(agentReviewClaimKey(row.approverId, headSha)),
            ).length;
            return probe;
        } catch (error) {
            this.logger.warn(
                `Agent review for task ${task.id}: could not read whether reviews are owed — ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return null;
        }
    }

    /**
     * Decide which agent approvers get a review run for this Task, and
     * claim a ledger row for each.
     *
     * Never throws: the caller is a transition side effect and a review
     * hiccup must not roll back a status change. Every failure is a named
     * reason in the returned plan.
     *
     * `options.alreadyStarted` — reviews earlier planning attempts already
     * dispatched in this same entry for this same key (the plan memory's
     * `agentReviewPlanStarted`, see `agentReviewPlanCarriedStarts`). They
     * count against the per-entry approver cap, so a retry after a transient
     * failure buys only what the cap has left; when nothing is left the plan
     * is refused `approver-cap` before a single read. Omitted = 0, the
     * behaviour of every caller outside the plan memory.
     */
    async planReviews(
        task: Task,
        options: { alreadyStarted?: number } = {},
    ): Promise<AgentReviewPlan> {
        try {
            return await this.planReviewsInner(task, options);
        } catch (error) {
            this.logger.warn(
                `Agent review planning failed for task ${task.id}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return { taskId: task.id, reason: 'error', decisions: [], dispatches: [] };
        }
    }

    private async planReviewsInner(
        task: Task,
        options: { alreadyStarted?: number },
    ): Promise<AgentReviewPlan> {
        const empty = (reason: AgentReviewDispatchReason): AgentReviewPlan => ({
            taskId: task.id,
            reason,
            decisions: [],
            dispatches: [],
        });

        if (task.status !== TaskStatus.IN_REVIEW) return empty('not-in-review');

        const maxRuns = config.agents.getAgentReviewMaxRunsPerTask();
        if (maxRuns <= 0) return empty('disabled');
        const maxApprovers = config.agents.getAgentReviewMaxApproversPerEntry();
        if (maxApprovers <= 0) return empty('approver-cap');
        // The per-entry cap is per ENTRY, not per planning attempt: starts an
        // earlier attempt of this entry already made count here (adversarial
        // review of CR-2). A spent cap costs no read at all.
        const carried = Number(options.alreadyStarted ?? 0);
        const alreadyStarted = Number.isFinite(carried) ? Math.max(0, Math.trunc(carried)) : 0;
        if (alreadyStarted >= maxApprovers) return empty('approver-cap');

        // Approvers come from platform state, keyed by the Task — never
        // from a request body, and never filtered by anything a caller
        // supplied.
        const approverRows = await this.approvers.findByTaskId(task.id);
        const agentApproverRows = approverRows.filter((row) => row.approverType === 'agent');
        // The head this Task last recorded. Used here ONLY to decide what
        // might need a review and to skip provider calls; every WRITE below
        // binds to the LIVE head read from the provider.
        const cachedHead = normalizeCommitSha(resolveReviewHead(task));
        // Who might need a review: every PENDING agent approver, and every
        // agent approver whose decision is not a review of the head this
        // Task records (Greptile P1-A on PR #2419). An approval — or a
        // request for changes — about commit A says nothing about commit B.
        // This used to be `approvalState === 'pending'` alone, so an agent
        // that approved A was never asked about B, and its approval for A
        // stood in for a review of B at the `→ done` gate.
        const pendingAgentApprovers = agentApproverRows.filter((row) =>
            agentApproverNeedsReview(row, cachedHead),
        );
        if (pendingAgentApprovers.length === 0) return empty('no-agent-approvers');

        // Budget BEFORE any provider call: a Task that has spent its
        // lifetime allowance must not even cost a diff fetch.
        //
        // The ledger read is allowed to throw, and the throw is caught
        // ONLY to name it — never to substitute a permissive default. A
        // budget nobody can count is not a budget, so an unreadable ledger
        // STOPS the stage exactly as a spent one does.
        let spent: number;
        try {
            spent = await this.reviews.countForTask(task.id);
        } catch (error) {
            this.logger.warn(
                `Agent review for task ${task.id}: review budget unreadable — ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return empty('budget-unreadable');
        }
        const budgetSpent = spent >= maxRuns;
        // A spent budget buys no review — but a verdict the ledger ALREADY
        // holds for the head this Task records costs no budget to put back
        // (see `restoreRecordedVerdicts` below). Only when there is one does
        // a spent Task go on to the (one, status-only) provider read that
        // restoring needs; otherwise it still stops here, before any.
        if (
            budgetSpent &&
            !(await this.holdsRecordedVerdict(task.id, pendingAgentApprovers, cachedHead))
        ) {
            return empty('budget-spent');
        }

        // THE self-review refusal, decided BEFORE any provider call.
        //
        // Ordering is deliberate: a Task whose only agent approver is the
        // agent that wrote the code must not cost a pull-request read and
        // a diff fetch to find that out. Nothing survives here and the
        // whole plan is refusals — which is also the shape a reader wants,
        // because the approver row then stays `pending` and the
        // `in_review → done` gate stays shut until a human looks.
        const disqualified = await this.buildDisqualificationSet(task);
        const decisions: AgentReviewDecisionList = [];
        const eligible: TaskApprover[] = [];
        for (const approver of pendingAgentApprovers) {
            const refusal = await this.disqualifiedReviewer(approver.approverId, disqualified);
            if (refusal) {
                decisions.push({ reviewerAgentId: approver.approverId, reason: refusal });
                continue;
            }
            eligible.push(approver);
        }
        if (eligible.length === 0) return { taskId: task.id, decisions, dispatches: [] };

        if (!task.workId) return { ...empty('no-work'), decisions };
        if (!task.prNumber) return { ...empty('no-pull-request'), decisions };

        // Pre-claim check, BEFORE any provider call. The claim below is
        // the real guard, but it used to be tested only after a live
        // pull-request read AND a diff download of up to 80 KB, so a Task
        // dragged between `in_progress` and `in_review` on one commit paid
        // two provider calls per flip, forever, for zero runs. When every
        // eligible reviewer already holds a claim for the head this Task
        // last recorded, nothing here can buy a run, so nothing is read —
        // unless one of those claims already carries a VERDICT, which the
        // live read below can put back on its approver row.
        //
        // Using the CACHED head only to decide to do NOTHING is safe: a push
        // the cache has not seen yet is picked up by the PR-status poll,
        // which re-plans reviews when it records a new head
        // (`TaskPrStatusService`). The claim key itself is always the LIVE
        // head below. A stale decision this skips is not reset here (a
        // cached head can lag the live one, and resetting against it could
        // erase a current approval), and it cannot pass the `→ done` gate
        // either, which binds agent decisions to the Task's current head.
        if (cachedHead && !budgetSpent) {
            const claimedKeys = new Set(await this.reviews.listClaimKeysForTask(task.id));
            const unclaimed = eligible.filter(
                (approver) =>
                    !claimedKeys.has(agentReviewClaimKey(approver.approverId, cachedHead)),
            );
            if (
                unclaimed.length === 0 &&
                !(await this.holdsRecordedVerdict(task.id, eligible, cachedHead))
            ) {
                for (const approver of eligible) {
                    decisions.push({
                        reviewerAgentId: approver.approverId,
                        reason: 'already-claimed',
                    });
                }
                return { taskId: task.id, headSha: cachedHead, decisions, dispatches: [] };
            }
        }

        if (!this.gitFacade || !this.works) return { ...empty('pr-unreadable'), decisions };

        const work = await this.works.findById(task.workId).catch(() => null);
        if (!work) return { ...empty('no-work'), decisions };
        const target = this.resolveRepoTarget(task, work);

        // Live read: the head commit and the CI roll-up in one call, from
        // the provider rather than from a cache, because an approval is
        // bound to a commit and a stale head would bind it to the wrong
        // one. Same posture as the merge gate.
        let status: GitPullRequestStatus | null;
        try {
            status = await this.gitFacade.getPullRequestStatus(
                target.owner,
                target.repo,
                task.prNumber,
                target.gitOptions,
            );
        } catch (error) {
            this.logger.warn(
                `Agent review for task ${task.id}: pull request unreadable — ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return { ...empty('pr-unreadable'), decisions };
        }
        if (!status) return { ...empty('pr-unreadable'), decisions };
        if (status.state !== 'open' && status.state !== 'draft')
            return { ...empty('pr-closed'), decisions };

        // The LIVE head, and only the live head. A provider answer with no
        // parseable head is refused rather than filled in from the Task's
        // cached columns: the claim key, the ledger row and every later
        // staleness check bind to this value, while the diff below is
        // whatever the pull request's head is NOW — so a cached (lagging)
        // head would record a commit that is not the commit reviewed.
        const headSha = normalizeCommitSha(status.headSha);
        if (!headSha) return { ...empty('head-unknown'), decisions };

        // STALE DECISIONS GO BACK TO PENDING — against the LIVE head only
        // (Greptile P1-A on PR #2419). Once a plan gets this far (it has a
        // live head), every agent approver whose decision is not an
        // `agent-review` verdict about `headSha` is reset, whether or not
        // this plan can then buy it a new review: a spent budget, a diff
        // that turns out unreviewable and a reviewer that is now refused all
        // leave it `pending` for a human — the safe direction. A plan that
        // stops BEFORE the live read (the Task left review, no eligible
        // reviewer, no pull request, nothing restorable on a spent budget or
        // on an all-claimed cached head) resets nothing, because it has no
        // live head to compare against; such a stale decision still stays
        // shut at the `→ done` gate, which binds every agent decision to the
        // current head. Each reset is a compare-and-set on the exact decision
        // read above, so a verdict that lands in between is never erased.
        for (const row of agentApproverRows) {
            if (row.approvalState !== 'approved' && row.approvalState !== 'rejected') continue;
            if (!agentApproverNeedsReview(row, headSha)) continue;
            const reset = await this.approvers.resetAgentDecisionToPending({
                id: row.id,
                taskId: task.id,
                approvalState: row.approvalState,
                decidedVia: row.decidedVia ?? null,
                decidedHeadSha: row.decidedHeadSha ?? null,
            });
            if (reset) {
                this.logger.log(
                    `Agent review for task ${task.id}: agent ${row.approverId}'s '${row.approvalState}' ` +
                        `was about ${row.decidedHeadSha ?? 'no commit'}, not ${headSha} — reset to pending.`,
                );
            }
        }

        // Which eligible reviewers still need a NEW review of `headSha`. The
        // rest either hold an `agent-review` verdict about this very head
        // already, or hold a claim for it — and a claim that already carries
        // a verdict is put back on its approver row here, so a head that
        // moves away and comes back (or a verdict an older review overwrote)
        // does not strand a reviewer's answer about this exact commit.
        const settled = await this.restoreRecordedVerdicts(task, eligible, headSha);
        if (budgetSpent || eligible.every((approver) => settled.has(approver.id))) {
            for (const approver of eligible) {
                decisions.push({
                    reviewerAgentId: approver.approverId,
                    reason: settled.has(approver.id) ? 'already-claimed' : 'budget-spent',
                });
            }
            const plan: AgentReviewPlan = { taskId: task.id, headSha, decisions, dispatches: [] };
            if (budgetSpent) plan.reason = 'budget-spent';
            return plan;
        }

        // The diff is pinned to THAT commit: `baseRef...headSha`, the same
        // three-dot comparison a pull request's file list is, but keyed on
        // the commit the claim, the ledger row and the verdict's
        // stale-head check all bind to. It used to be the pull request's
        // file list, which is whatever the head is when THAT request runs —
        // so a push landing between the status read and the file read (or
        // the provider's file list lagging a push, which needs no attacker)
        // bound the review to one commit and showed the reviewer another.
        // A force-push back to the bound commit before the verdict then
        // passed the stale-head check with an approval for code nobody
        // read. Found by review of slice AD.
        //
        // No base branch reported = cannot pin = no review. Fail closed,
        // with the same reason as a diff that could not be fetched.
        const baseRef = typeof status.baseRef === 'string' ? status.baseRef.trim() : '';
        if (!baseRef) {
            this.logger.warn(
                `Agent review for task ${task.id}: the provider reported no base branch for ` +
                    `#${task.prNumber}, so the diff cannot be pinned to ${headSha}.`,
            );
            return { ...empty('diff-unavailable'), headSha, decisions };
        }

        let diff: GitDiffResult;
        try {
            diff = await this.gitFacade.getCompareDiff(
                target.owner,
                target.repo,
                baseRef,
                headSha,
                { maxBytes: AGENT_REVIEW_DIFF_MAX_BYTES, maxFiles: AGENT_REVIEW_DIFF_MAX_FILES },
                target.gitOptions,
            );
        } catch (error) {
            // FAIL CLOSED. A diff we could not fetch is not a small diff,
            // and reviewing nothing is not reviewing.
            this.logger.warn(
                `Agent review for task ${task.id}: diff unavailable at ${headSha} — ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return { ...empty('diff-unavailable'), headSha, decisions };
        }
        const diffRefusal = assessReviewDiff(diff);
        if (diffRefusal) {
            this.logger.warn(
                `Agent review for task ${task.id}: ${diffRefusal} at ${headSha} ` +
                    `(${diff.totalFiles} files, truncated=${diff.truncated}).`,
            );
            return { ...empty(diffRefusal), headSha, decisions };
        }

        const brief = composeAgentReviewBrief({
            taskSlug: task.slug ?? task.id,
            taskTitle: task.title,
            repoFullName: `${target.owner}/${target.repo}`,
            prNumber: task.prNumber,
            prUrl: task.prUrl ?? null,
            headSha,
            ciState: status.ciState,
            checksComplete: status.checksComplete,
            checks: capChecks(status.checks ?? []).map((check) => ({
                name: check.name,
                status: check.status,
                conclusion: check.conclusion ?? null,
            })),
            diff,
            verdictToolName: SUBMIT_TASK_REVIEW_TOOL,
        });
        if (brief === null) {
            // FAIL CLOSED. The whole brief does not fit the model budget,
            // and a partial one would let a reviewer approve code it never
            // saw — so nothing is claimed and nothing is dispatched.
            this.logger.warn(
                `Agent review for task ${task.id}: diff-too-large at ${headSha} — the brief ` +
                    `(${diff.totalFiles} files, ${diff.patchBytes} patch bytes) exceeds the review budget.`,
            );
            return { ...empty('diff-too-large'), headSha, decisions };
        }

        const dispatches: PlannedAgentReview[] = [];
        // The in-memory remainder only saves doomed INSERTs. The bound is
        // the claim's unique budget slot (Greptile P1-C on PR #2419): `spent`
        // was read before the provider calls, and another planner may have
        // spent the same slot since.
        let remainingBudget = maxRuns - spent;
        let started = alreadyStarted;
        // Set when a claim THROWS. Everything claimed before it is still
        // returned for dispatch — see the catch below.
        let claimFailed = false;

        for (const approver of eligible) {
            if (settled.has(approver.id)) {
                // Its decision IS an `agent-review` verdict about this very
                // head, or this coordinate is already claimed (and, when that
                // claim carries a verdict, it was just put back above). There
                // is nothing left to buy.
                decisions.push({
                    reviewerAgentId: approver.approverId,
                    reason: 'already-claimed',
                });
                continue;
            }
            if (claimFailed) {
                decisions.push({ reviewerAgentId: approver.approverId, reason: 'error' });
                continue;
            }
            if (started >= maxApprovers) {
                decisions.push({ reviewerAgentId: approver.approverId, reason: 'approver-cap' });
                continue;
            }
            if (remainingBudget <= 0) {
                decisions.push({ reviewerAgentId: approver.approverId, reason: 'budget-spent' });
                continue;
            }
            let claim: ClaimAgentReviewResult;
            try {
                claim = await this.reviews.claim({
                    taskId: task.id,
                    reviewerAgentId: approver.approverId,
                    approverId: approver.id,
                    claimKey: agentReviewClaimKey(approver.approverId, headSha),
                    headSha,
                    maxRuns,
                    prNumber: task.prNumber ?? null,
                    ciState: status.ciState,
                    workId: task.workId ?? null,
                    tenantId: task.tenantId ?? null,
                    organizationId: task.organizationId ?? null,
                });
            } catch (error) {
                // A store failure on THIS claim. It used to escape to
                // `planReviews`' catch, which returned `dispatches: []` and
                // so dropped every review claimed earlier in this loop: those
                // rows stayed `dispatched` with no run, holding a budget slot
                // and a claim key that answered `already-claimed` forever
                // (review of Greptile P1-C on PR #2419). The claims already
                // won are returned for dispatch; nothing more is claimed in
                // this plan, because the store that just failed is the store
                // every further claim writes to.
                claimFailed = true;
                this.logger.warn(
                    `Agent review for task ${task.id}: claim for agent ${approver.approverId} at ${headSha} failed — ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                );
                decisions.push({ reviewerAgentId: approver.approverId, reason: 'error' });
                continue;
            }
            if (claim.outcome === 'already-claimed') {
                decisions.push({
                    reviewerAgentId: approver.approverId,
                    reason: 'already-claimed',
                });
                continue;
            }
            if (claim.outcome !== 'claimed') {
                // `budget-spent` from the DATABASE: every slot is held, some
                // of them by a planner this one never saw. Nothing after this
                // approver can claim one either. Any outcome this code does
                // not know is refused the same way — fail closed.
                remainingBudget = 0;
                decisions.push({ reviewerAgentId: approver.approverId, reason: 'budget-spent' });
                continue;
            }
            const claimed = claim.review;
            remainingBudget -= 1;
            started += 1;
            decisions.push({
                reviewerAgentId: approver.approverId,
                reason: 'dispatched',
                reviewId: claimed.id,
            });
            dispatches.push({
                reviewId: claimed.id,
                reviewerAgentId: approver.approverId,
                approverId: approver.id,
                headSha,
                brief,
                // The head is IN the dedup key as well as the claim key so
                // the job runtime's own idempotency agrees with ours.
                dedupKey: `${task.id}:${approver.approverId}:review:${headSha}`,
            });
        }

        const plan: AgentReviewPlan = { taskId: task.id, headSha, decisions, dispatches };
        if (claimFailed) plan.reason = 'error';
        return plan;
    }

    /**
     * Does any of these approvers' claims for `head` already carry a
     * VERDICT that belongs to that approver row?
     *
     * A cheap probe (ledger reads only, no provider call) that lets the two
     * early exits above — the spent budget and the all-claimed cached head —
     * keep costing nothing in the common case, while a reviewer's recorded
     * answer about the head can still be put back. Never throws: a ledger
     * that cannot answer is "nothing to restore", which only keeps the early
     * exit.
     */
    private async holdsRecordedVerdict(
        taskId: string,
        approvers: TaskApprover[],
        head: string | null,
    ): Promise<boolean> {
        if (!head) return false;
        for (const approver of approvers) {
            const claim = await this.findClaim(taskId, approver, head);
            if (claim && isRecordedVerdictFor(claim, approver, head)) return true;
        }
        return false;
    }

    /** The ledger row for `(approver's agent, head)`, or `null` — never throws. */
    private async findClaim(
        taskId: string,
        approver: TaskApprover,
        head: string,
    ): Promise<TaskAgentReview | null> {
        try {
            return (
                (await this.reviews.findByClaimKey(
                    taskId,
                    agentReviewClaimKey(approver.approverId, head),
                )) ?? null
            );
        } catch {
            return null;
        }
    }

    /**
     * For each eligible reviewer, decide whether `headSha` still needs a
     * NEW review, restoring a recorded verdict on the way.
     *
     * Returns the ids of the approver rows that need nothing bought:
     *
     *  - the row's decision already IS an `agent-review` verdict about
     *    `headSha` (it only looked stale against the cached head);
     *  - the `(reviewer, headSha)` claim already exists. When that ledger row
     *    is a verdict for this approver row, the verdict is put back on the
     *    row (`TaskApproverRepository.restoreAgentDecisionFromReview`, a
     *    compare-and-set from `pending`, so it never overwrites a decision
     *    that landed since); a claim still in flight, refused or failed is
     *    left alone, and the row stays as it is.
     *
     * Head-bound decisions plus one review per (reviewer, head) otherwise
     * lose a verdict for good: approve A, push B (reset, B reviewed),
     * force-push back to A — the `(reviewer, A)` claim exists, so no review
     * of A could ever be bought again, and the approver stayed `pending` at a
     * commit its reviewer had approved.
     *
     * Only ever called with the LIVE head, and after the reset above, so a
     * restored decision is about the commit the pull request is on now.
     * Never throws: a restore that fails leaves the row `pending`, the gate
     * shut — the safe direction.
     */
    private async restoreRecordedVerdicts(
        task: Task,
        eligible: TaskApprover[],
        headSha: string,
    ): Promise<Set<string>> {
        const settled = new Set<string>();
        for (const approver of eligible) {
            if (!agentApproverNeedsReview(approver, headSha)) {
                settled.add(approver.id);
                continue;
            }
            const claim = await this.findClaim(task.id, approver, headSha);
            if (!claim) continue;
            settled.add(approver.id);
            if (!isRecordedVerdictFor(claim, approver, headSha)) continue;
            const verdict = claim;
            const restored = await this.approvers
                .restoreAgentDecisionFromReview({
                    id: approver.id,
                    taskId: task.id,
                    reviewerAgentId: approver.approverId,
                    approvalState: verdict.state === 'approved' ? 'approved' : 'rejected',
                    decidedByRunId: verdict.runId ?? null,
                    decidedHeadSha: headSha,
                })
                .catch((error: unknown) => {
                    this.logger.warn(
                        `Agent review for task ${task.id}: could not restore review ${verdict.id} ` +
                            `onto approver ${approver.id} — ${
                                error instanceof Error ? error.message : String(error)
                            }`,
                    );
                    return false;
                });
            if (restored) {
                this.logger.log(
                    `Agent review for task ${task.id}: restored agent ${approver.approverId}'s ` +
                        `'${verdict.state}' about ${headSha} from review ${verdict.id}.`,
                );
            }
        }
        return settled;
    }

    /**
     * Bind a freshly created run to its review — called by
     * `TaskTransitionService.dispatchAgentRun` after the run row exists and
     * BEFORE the job runtime is told about it.
     *
     * THROWS when the binding does not land, on purpose: the dispatch
     * treats that as a failed dispatch, rolls the run back and never
     * enqueues it. A review run with no binding could not record a verdict
     * (pure spend), and — before this ordering — its own run row would
     * count as authorship evidence until a post-enqueue stamp landed, so a
     * fast reviewer was refused as reviewing its own work.
     */
    async bindRun(reviewId: string, runId: string): Promise<void> {
        await this.reviews.bindRun(reviewId, runId);
    }

    /**
     * Record what the dispatch actually did.
     *
     * A parked run still holds its claim and its seeded brief — the drain
     * hook promotes it later and it reads the same brief. A dispatch that
     * produced no run settles the row `failed`, and the claim STAYS
     * spent: see the entity doc.
     */
    async recordDispatchResult(reviewId: string, result: AgentReviewDispatchResult): Promise<void> {
        try {
            if (result.runId) {
                await this.reviews.stampRunId(reviewId, result.runId);
            }
            if (!result.dispatched && !result.parked) {
                await this.reviews.casSettle(reviewId, 'failed', {
                    refusalCode: (result.error ?? 'dispatch-failed').slice(0, 64),
                });
            }
        } catch (error) {
            this.logger.warn(
                `Agent review ${reviewId}: could not record dispatch result — ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }

    /**
     * Close the review bound to a run that started WITHOUT its brief.
     *
     * Called by the tool loop (`AgentRunService`) when a review run's
     * execution finds no brief at the head of its first steering drain —
     * a job-runtime retry of a `running` row, whose brief the earlier
     * execution already consumed. The loop never calls the model for such
     * an execution; this settles the ledger row `failed` as well, so the
     * verdict half's own authorization (`findOpenForRun`, which reads only
     * OPEN rows) refuses `no-open-review` for that run from now on,
     * whatever executes it next. Two independent closures, each sufficient.
     *
     * Never throws; `false` when nothing open was bound to the run (already
     * settled, or not a review run at all).
     */
    async abandonRunWithoutBrief(runId: string): Promise<boolean> {
        try {
            const review = await this.reviews.findOpenForRun(runId);
            if (!review) return false;
            const settled = await this.reviews.casSettle(review.id, 'failed', {
                refusalCode: AGENT_REVIEW_BRIEF_MISSING,
            });
            if (settled) {
                this.logger.warn(
                    `Agent review ${review.id}: run ${runId} started without its brief — review settled failed, no verdict can be recorded.`,
                );
            }
            return settled;
        } catch (error) {
            this.logger.warn(
                `Agent review for run ${runId}: could not settle a brief-less review — ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return false;
        }
    }

    // ── the verdict half ──────────────────────────────────────────────

    /**
     * Record a reviewer's explicit verdict, and write its approver row.
     *
     * Every refusal below leaves `task_approvers` untouched, which leaves
     * the row `pending`, which keeps the `in_review → done` gate shut. The
     * safe direction is always "a human has to look".
     */
    async submitVerdict(input: SubmitAgentReviewInput): Promise<AgentReviewVerdictResult> {
        try {
            return await this.submitVerdictInner(input);
        } catch (error) {
            this.logger.warn(
                `Agent review verdict failed for run ${input.runId ?? '(none)'}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return { reason: 'error' };
        }
    }

    private async submitVerdictInner(
        input: SubmitAgentReviewInput,
    ): Promise<AgentReviewVerdictResult> {
        // AUTHORIZATION, first, and keyed on the RUN. A review is answered
        // only by the run the platform bound to it before that run was
        // enqueued. It used to be keyed on (task, agent), which let ANY run
        // of the reviewer — a chat reply, a run on another Task, a run
        // started after the review's own run had been cancelled — approve
        // a review it never received a diff for, and let a model pick which
        // of its open reviews to answer by naming a Task.
        const runId = typeof input.runId === 'string' ? input.runId.trim() : '';
        if (!runId) return { reason: 'no-open-review' };
        const review = await this.reviews.findOpenForRun(runId);
        if (!review || review.reviewerAgentId !== input.reviewerAgentId) {
            return { reason: 'no-open-review' };
        }
        // The model-supplied Task id is a cross-check, never a selector.
        if (input.taskId && input.taskId !== review.taskId) return { reason: 'no-open-review' };

        // …and the run row must be the review run that binding describes:
        // this agent, this Task, admitted with the review-only tool scope.
        // `null` runs repository = cannot verify = refuse.
        if (!this.runs) return { reason: 'reviewer-unreadable' };
        const run = await this.runs.findById(runId);
        if (
            !run ||
            run.agentId !== input.reviewerAgentId ||
            run.taskId !== review.taskId ||
            !isAgentReviewRunScope(run.delegationScope)
        ) {
            return { reason: 'no-open-review' };
        }

        const task = await this.tasks.findById(review.taskId);
        if (!task) return { reason: 'no-task' };

        // Re-checked HERE and not only at dispatch: an approver can be
        // attached after the implementing run finished, and a second agent
        // row can be created for the same persona at any time. The
        // platform decides this at the moment the verdict would land.
        const disqualified = await this.buildDisqualificationSet(task);
        const selfReview = await this.disqualifiedReviewer(input.reviewerAgentId, disqualified);
        if (selfReview) {
            this.logger.warn(
                `Agent review ${review.id}: refused a verdict from agent ${input.reviewerAgentId} on task ${task.id} — ${selfReview}.`,
            );
            if (selfReview === 'self-review') {
                // A durable refusal: this reviewer can never become
                // eligible for this commit, so close the row.
                await this.reviews.casSettle(review.id, 'refused', { refusalCode: selfReview });
                return { reason: 'self-review' };
            }
            // `reviewer-unreadable` is a STORE failure, not a verdict about
            // the reviewer. Leave the row open so a retry can succeed —
            // but refuse this verdict, because an identity we could not
            // read is not an identity we cleared.
            return { reason: 'reviewer-unreadable' };
        }

        // The push-during-review case. A verdict is a statement about a
        // commit; if the branch moved, the statement is about code that is
        // no longer there.
        const current = await this.resolveCurrentHead(task);
        if (current.kind === 'unreadable') {
            // The provider could not answer. NOT answered from the Task's
            // cached head — that is the value that lags a push, so a
            // force-push the poll has not seen yet would pass. Not settled
            // either: a provider hiccup is not a verdict about the review,
            // and the reviewer may call the tool again.
            return { reason: 'head-unreadable', headSha: review.headSha };
        }
        if (current.kind === 'unknown' || current.head !== review.headSha) {
            await this.reviews.casSettle(review.id, 'refused', { refusalCode: 'stale-head' });
            return { reason: 'stale-head', headSha: review.headSha };
        }

        const verdict = parseAgentReviewVerdict(input.verdict);
        if (!verdict) {
            // Deliberately does NOT settle the row: an unreadable verdict
            // is the reviewer failing to answer, not the platform refusing
            // it, and the run may still call the tool correctly. The row
            // stays open until the head moves or the budget runs out.
            return { reason: 'unreadable-verdict' };
        }

        const approverRows = await this.approvers.findByTaskId(task.id);
        const approver = approverRows.find(
            (row): row is TaskApprover =>
                row.id === review.approverId &&
                row.approverType === 'agent' &&
                row.approverId === input.reviewerAgentId,
        );
        if (!approver) {
            await this.reviews.casSettle(review.id, 'refused', {
                refusalCode: 'approver-missing',
            });
            return { reason: 'approver-missing' };
        }

        const summary = (input.summary ?? '').slice(0, AGENT_REVIEW_SUMMARY_MAX_CHARS) || null;
        // ONE write, in ONE transaction: the review leaves `dispatched` and
        // the approver row takes the verdict together, or neither happens
        // (Greptile P1-B on PR #2419). It used to be a review CAS followed
        // by a separate `setState`: an approver write that threw left the
        // review terminal and the verdict unrecordable forever, and one that
        // matched no row was ignored and reported `recorded`. The review CAS
        // inside the transaction is still the one-verdict-per-review guard,
        // so a model that calls the tool twice writes the approver row once.
        const outcome = await this.reviews.recordVerdict({
            reviewId: review.id,
            state: verdict === 'approve' ? 'approved' : 'changes-requested',
            summary,
            approver: {
                id: approver.id,
                taskId: task.id,
                reviewerAgentId: input.reviewerAgentId,
                approvalState: verdict === 'approve' ? 'approved' : 'rejected',
                decidedByRunId: review.runId ?? null,
                decidedHeadSha: review.headSha,
            },
        });
        if (outcome === 'review-not-open') return { reason: 'no-open-review' };
        if (outcome === 'superseded') {
            // The approver row already carries a verdict from a review that
            // was claimed AFTER this one — a newer commit's review answered
            // first, and this verdict passed its live-head check only because
            // the provider read lagged that push. Nothing was written. Closed
            // as a refusal, the same way a verdict about a head that moved is:
            // it is a statement about code the Task has moved on from, and an
            // open review nobody can ever record would just hold its run.
            await this.reviews.casSettle(review.id, 'refused', { refusalCode: 'superseded' });
            this.logger.warn(
                `Agent review ${review.id}: the verdict from agent ${input.reviewerAgentId} on task ${task.id} ` +
                    `at ${review.headSha} was superseded by a newer review's verdict — not recorded.`,
            );
            return { reason: 'stale-head', headSha: review.headSha };
        }
        if (outcome !== 'recorded') {
            // `approver-not-written`, or anything this code does not know:
            // nothing was recorded, and the review is still open.
            this.logger.warn(
                `Agent review ${review.id}: the verdict from agent ${input.reviewerAgentId} on task ${task.id} ` +
                    `was not recorded — the approver row ${approver.id} was not written; the review stays open.`,
            );
            return { reason: 'approver-not-written', headSha: review.headSha };
        }
        this.logger.log(
            `Agent review ${review.id}: agent ${input.reviewerAgentId} recorded '${verdict}' on task ${task.id} at ${review.headSha}.`,
        );
        return {
            reason: 'recorded',
            verdict,
            approverId: approver.id,
            headSha: review.headSha,
        };
    }

    // ── the self-review refusal ───────────────────────────────────────

    /**
     * Every agent identity this Task's work belongs to.
     *
     * Two sources, both platform state:
     *
     *  - the dispatch ladder (`resolveTaskDispatchAgentIds`) — who the
     *    Task is assigned to. The SAME function the transition service
     *    uses to decide who implements it, so the two can never disagree.
     *  - the Task's WHOLE run history — every distinct agent that has
     *    executed on it, however long ago. This is the one that catches an
     *    agent that ran and was then unassigned.
     *
     * One kind of run is left out of the history: a run this Task's review
     * ledger bound to a review AND whose own row proves it was admitted
     * with the review-only tool scope. Such a run holds one tool, gets no
     * workspace and cannot run on the fleet, so it provably wrote nothing —
     * and without leaving it out every reviewer would disqualify itself the
     * moment it started, and no second round could ever happen.
     *
     * Being IN the ledger is not enough on its own, deliberately. Before
     * review, every ledger run id was subtracted unconditionally while the
     * review run itself carried the full tool surface and a workspace, so
     * a reviewer could push commits that this set then ignored, and review
     * — and approve — them on the next round.
     *
     * Returns `null` when the set CANNOT be computed — no run repository
     * bound, or a store that threw. `null` is not "nobody is
     * disqualified": it is "the platform cannot tell who wrote this", and
     * every caller turns it into a refusal. Fail closed.
     */
    private async buildDisqualificationSet(task: Task): Promise<Set<string> | null> {
        if (!this.runs) return null;
        try {
            const ids = new Set<string>();
            for (const agentId of await resolveTaskDispatchAgentIds(task, this.assignees)) {
                ids.add(agentId);
            }
            const boundRunIds = await this.reviews.listRunIdsForTask(task.id);
            const provenReviewRunIds: string[] = [];
            if (boundRunIds.length > 0) {
                for (const run of await this.runs.findByIds(boundRunIds)) {
                    if (run.taskId === task.id && isAgentReviewRunScope(run.delegationScope)) {
                        provenReviewRunIds.push(run.id);
                    }
                }
            }
            for (const agentId of await this.runs.findAuthorAgentIdsForTask(
                task.id,
                provenReviewRunIds,
            )) {
                ids.add(agentId);
            }
            return ids;
        } catch (error) {
            this.logger.warn(
                `Agent review for task ${task.id}: could not read who implemented it — ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return null;
        }
    }

    /**
     * Is this reviewer disqualified from reviewing this Task?
     *
     * Returns the refusal reason, or `null` when the reviewer is clean.
     *
     * The comparison is by IDENTITY, not by id: `agents` is unique on
     * `(userId, scope, scopeTargetId, slug)`, so the same persona can hold
     * a tenant-scope row and a work-scope row with different primary keys.
     * Approving your own work from your other id is still approving your
     * own work.
     *
     * FAILS CLOSED in both unreadable cases: no agent repository bound, or
     * a reviewer row that cannot be read, both refuse.
     */
    private async disqualifiedReviewer(
        reviewerAgentId: string,
        disqualified: Set<string> | null,
    ): Promise<'self-review' | 'reviewer-unreadable' | null> {
        // "We could not work out who wrote this" is never a licence to
        // let somebody approve it.
        if (!disqualified) return 'reviewer-unreadable';
        if (disqualified.has(reviewerAgentId)) return 'self-review';
        if (disqualified.size === 0) return null;
        if (!this.agents) return 'reviewer-unreadable';
        const reviewer = await this.agents.findById(reviewerAgentId).catch(() => null);
        if (!reviewer) return 'reviewer-unreadable';
        for (const otherId of disqualified) {
            const other = await this.agents.findById(otherId).catch(() => null);
            if (!other) return 'reviewer-unreadable';
            if (isSameAgentIdentity(toIdentity(reviewer), toIdentity(other))) {
                return 'self-review';
            }
        }
        return null;
    }

    // ── the completion gate's head ────────────────────────────────────

    /**
     * The pull request's head RIGHT NOW, read from the provider, for the
     * `in_review → done` approver gate — or `null` when it cannot be read.
     *
     * Review of Greptile P1-A on PR #2419: the gate used to bind agent
     * decisions to the Task's CACHED head (`prHeadSha` / `ciHeadSha`). Those
     * columns are written by the PR-status poll and by check deliveries, and a
     * push to an already-open pull request writes neither
     * (`TaskWorkspaceService.recordRemotePush` deliberately leaves the head to
     * the provider). So between a push and the next poll the cache still
     * named the old commit, and an agent approval of that old commit opened
     * the gate for code nobody reviewed — the fix loop's own run could push B
     * and call `transitionTask('done')` inside that window.
     *
     * Same lookup, same posture as the verdict path's live-head check: from
     * the provider and nowhere else, never a cached fallback. Never throws —
     * every failure (no facade, no Work, no pull request, a provider error, an
     * unparseable head) is `null`, and `null` counts no commit-bound decision.
     */
    async readLivePullRequestHead(task: Task): Promise<string | null> {
        try {
            const current = await this.resolveCurrentHead(task);
            return current.kind === 'live' ? current.head : null;
        } catch (error) {
            this.logger.warn(
                `Task ${task.id}: pull request head unreadable for the completion gate — ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return null;
        }
    }

    // ── helpers ───────────────────────────────────────────────────────

    /**
     * The commit the pull request is on RIGHT NOW — from the provider, and
     * from nowhere else.
     *
     *  - `live`       — the provider answered with a parseable head.
     *  - `unreadable` — the lookup is wired but did not answer (the Work
     *                   row, the provider call, or its head field). The
     *                   caller refuses WITHOUT settling, so a retry can
     *                   succeed.
     *  - `unknown`    — nothing here can ever answer (no facade bound, or
     *                   the Task has no pull request). A durable refusal.
     *
     * The Task's cached `prHeadSha` / `ciHeadSha` are deliberately NOT a
     * fallback. They are written by a two-minute poll, so they are exactly
     * the value that still names the OLD commit right after a force-push;
     * falling back to them on a provider error — the same error the
     * dispatch half refuses on — accepted a verdict for code that was no
     * longer on the branch.
     */
    private async resolveCurrentHead(
        task: Task,
    ): Promise<{ kind: 'live'; head: string } | { kind: 'unreadable' } | { kind: 'unknown' }> {
        if (!this.gitFacade || !this.works || !task.workId || !task.prNumber) {
            return { kind: 'unknown' };
        }
        const work = await this.works.findById(task.workId).catch(() => null);
        if (!work) return { kind: 'unreadable' };
        const target = this.resolveRepoTarget(task, work);
        try {
            const status = await this.gitFacade.getPullRequestStatus(
                target.owner,
                target.repo,
                task.prNumber,
                target.gitOptions,
            );
            const live = normalizeCommitSha(status?.headSha);
            return live ? { kind: 'live', head: live } : { kind: 'unreadable' };
        } catch {
            return { kind: 'unreadable' };
        }
    }

    /**
     * Work → (owner, repo, facade options).
     *
     * Mirrors `TaskPrStatusService.resolveRepo`, which itself mirrors
     * `TaskWorkspaceService` — the repo's established convention for this
     * lookup, kept rather than extracted because those two are the pattern
     * a reader will compare this against. `userId` is `task.userId` from
     * platform state; a request never reaches this.
     */
    private resolveRepoTarget(
        task: Task,
        work: {
            id: string;
            gitProvider: string;
            kind?: string | null;
            getRepoOwner(role?: 'data' | 'work' | 'website'): string;
            getDataRepo(): string;
            getWebsiteRepo?(): string;
        },
    ): {
        owner: string;
        repo: string;
        gitOptions: { userId: string; providerId: string; workId: string };
    } {
        return {
            owner: resolveTaskRepository(work).owner,
            repo: resolveTaskRepository(work).repo,
            gitOptions: {
                userId: task.userId,
                providerId: work.gitProvider,
                workId: work.id,
            },
        };
    }
}

type AgentReviewDecisionList = AgentReviewDispatchDecision[];

/**
 * Is this ledger row a terminal VERDICT (`approved` / `changes-requested`)
 * that was dispatched for exactly this approver row and its agent, about
 * exactly `head`? Only such a row may be put back on the approver row.
 */
function isRecordedVerdictFor(
    review: TaskAgentReview,
    approver: TaskApprover,
    head: string,
): boolean {
    if (review.state !== 'approved' && review.state !== 'changes-requested') return false;
    if (review.approverId !== approver.id) return false;
    if (review.reviewerAgentId !== approver.approverId) return false;
    return normalizeCommitSha(review.headSha) === head;
}

function toIdentity(agent: Agent): { id: string; userId: string; slug: string } {
    return { id: agent.id, userId: agent.userId, slug: agent.slug };
}
