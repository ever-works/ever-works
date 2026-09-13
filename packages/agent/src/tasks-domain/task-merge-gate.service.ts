import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { GitPullRequestStatus } from '@ever-works/plugin';
import {
    isPromotionTask,
    isReleaseRevertTask,
    normalizeCommitSha,
    releaseRevertRungFromLabels,
    resolvePromotionBranches,
} from '@ever-works/contracts';
import type { ReleaseLadder } from '@ever-works/contracts';
import { Task } from '../entities/task.entity';
import { WorkRepository } from '../database/repositories/work.repository';
import { MergePolicyService } from '../policy/merge-policy.service';
import { MergeApprovalService } from '../agent-approvals/merge-approval.service';
import {
    PROMOTION_MERGE_GUARD,
    type PromotionMergeGuard,
    type PromotionMergeVerdict,
} from '../policy/promotion-merge-guard.port';
import { TaskWorkspaceService, type TaskAgentMergeOutcome } from './task-workspace.service';

/** What one post-CI evaluation did, for logs and for the sweep summary. */
export type TaskMergeGateOutcome =
    | { action: 'skipped'; reason: string }
    | { action: 'approval-requested'; proposalId: string }
    | { action: 'approval-pending' }
    | { action: 'merge-attempted'; merge: TaskAgentMergeOutcome | undefined };

/**
 * Merge approval (self-build slice AE, EW-805) — the RE-EVALUATION the
 * merge path never had.
 *
 * Before this, the single merge decision fired inside
 * `openPullRequestForBranch`, seconds after the pull request was created
 * and therefore before any CI existed to be green. This service asks the
 * question at the only moment it can be answered: right after
 * `TaskPrStatusService` has read the provider and knows the pull
 * request's state, its head commit and its rolled-up CI verdict.
 *
 * One method, three outcomes:
 *
 *   1. **Not ready** — the PR is not open, CI is not green, the policy
 *      does not allow agent merges. Nothing happens, nothing is said.
 *   2. **Ready and an approval is required** — raise the
 *      `merge_pull_request` proposal for THIS head commit, which lands in
 *      the human's Inbox with Approve / Reject. Idempotent per head, so a
 *      sweep every two minutes files one item, not seven hundred a day.
 *   3. **Ready and the merge may proceed** — either the policy asked for
 *      no approval, or a human already gave one for this head. Hand off
 *      to the ONE merge path, which re-verifies everything against the
 *      provider before it lands anything.
 *
 * Case 3 is what makes an approval *do* something. `AgentActionProposal`
 * has always documented itself as "the durable queue + decision record
 * only — executing the approved action is a follow-up increment". For
 * `merge_pull_request`, this is that increment.
 *
 * BEST-EFFORT BY CONTRACT. Its caller is a status refresh whose job is to
 * keep a cache honest; a merge gate that threw would turn a provider
 * hiccup into a failed PR-status sweep for every Task behind it. Every
 * path here returns rather than throws.
 *
 * Latency, stated because operators will ask: an approval clicked in the
 * Inbox lands the merge on the NEXT PR-status refresh for that Task —
 * within about two minutes on the two-minute sweep, or immediately if anyone
 * loads the Task's PR status with `?refresh=true`. The approval is not a
 * merge trigger by itself, and that is deliberate: routing the merge
 * through the CI refresh is what guarantees the "green is re-checked at
 * merge time" property for every merge, rather than for some of them.
 */
@Injectable()
export class TaskMergeGateService {
    private readonly logger = new Logger(TaskMergeGateService.name);

    constructor(
        private readonly works: WorkRepository,
        private readonly mergePolicy: MergePolicyService,
        private readonly taskWorkspace: TaskWorkspaceService,
        // Merge approval verifier + raiser. @Optional() and appended LAST
        // per the positional-spec arity rule; absent, the gate degrades to
        // "never raise, never merge", which is the safe direction.
        @Optional() private readonly mergeApprovals?: MergeApprovalService,
        // Release promotion lane (self-build slice AI, EW-808) — the
        // NARROWING for a promotion pull request. Appended LAST +
        // @Optional() per the positional-spec arity rule, and injected by
        // TOKEN so `TasksDomainModule` does not have to import the module
        // that imports it.
        //
        // Unbound does NOT mean "degrade gracefully" here: the check below
        // recognises a promotion Task off its own labels and stands down,
        // so a deployment that cannot evaluate promotions never merges one
        // through the ordinary agent path.
        @Optional()
        @Inject(PROMOTION_MERGE_GUARD)
        private readonly promotionGuard?: PromotionMergeGuard,
    ) {}

    /**
     * Called by `TaskPrStatusService` after every successful provider
     * read. `status` is that read — live, not the Task's cache.
     */
    async onPullRequestStatusRefreshed(
        task: Task,
        status: GitPullRequestStatus,
    ): Promise<TaskMergeGateOutcome> {
        try {
            return await this.evaluate(task, status);
        } catch (error) {
            this.logger.warn(
                `Task ${task.id}: post-CI merge evaluation failed (PR status still recorded): ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return { action: 'skipped', reason: 'evaluation-failed' };
        }
    }

    private async evaluate(
        task: Task,
        status: GitPullRequestStatus,
    ): Promise<TaskMergeGateOutcome> {
        if (!task.prNumber || !task.workId) {
            return { action: 'skipped', reason: 'no-pull-request' };
        }
        if (status.state !== 'open') {
            // Draft, closed or already merged. A draft is deliberately
            // excluded: an author who has not marked it ready has not
            // asked anybody to look at it.
            return { action: 'skipped', reason: `pr-${status.state}` };
        }
        if (status.ciState !== 'passing') {
            return { action: 'skipped', reason: `ci-${status.ciState}` };
        }
        // `checksComplete === false` means the provider read could not see
        // the commit's whole check set, so `ciState` is a roll-up over a
        // SAMPLE. Raising an approval on it would show a human a green
        // badge the platform manufactured, and merging on it would land a
        // pull request whose failing leg nobody ever read. Neither happens.
        if (status.checksComplete === false) {
            return { action: 'skipped', reason: 'ci-incomplete' };
        }
        const headSha = normalizeCommitSha(status.headSha);
        if (!headSha) {
            return { action: 'skipped', reason: 'head-sha-unknown' };
        }

        // Release promotion lane (slice AI) — the extra refusal, applied
        // BEFORE any approval is raised and before any merge is attempted.
        //
        // It exists because the `ciState === 'passing'` check above cannot
        // answer a release question: the roll-up treats `skipped`,
        // `cancelled`, `neutral` and `stale` as non-blocking, and
        // `promotion-gate.yml` SKIPS its e2e job by design on any head that
        // is not `stage`. Without this, a promotion whose gate never
        // evaluated would reach a human as an Approve button next to a
        // green badge the platform manufactured.
        //
        // It can only ever say NO. A Task that is not a promotion returns
        // `{ promotion: false }` and the path below is unchanged.
        const assessed = await this.assessPromotion(task, headSha);
        if (assessed.blocked) return assessed.blocked;
        // A live promotion this merge may proceed with. It carries the
        // promotion's OWN branches and pull request, which is what the
        // protected-branch rule and the human's Inbox line are computed
        // from below — the Work's `taskIsolationBaseBranch` is the right
        // answer for every Task pull request and the wrong answer for
        // every promotion.
        const promotion = assessed.promotion;

        const work = await this.works.findById(task.workId);
        if (!work) return { action: 'skipped', reason: 'no-work' };

        // Post-deploy verification and revert (slice AJ, EW-809) — the
        // SECOND narrowing, and it exists because undoing a promotion is
        // the same class of act as making one.
        //
        // A revert Task is deliberately an ORDINARY Task: it carries no
        // `release:promotion` label, so `assessPromotion` above answers
        // `{ promotion: null }` for it and, without this, `needsApproval`
        // below would collapse back to the operator's policy flag —
        // `requireHumanApproval: false` is a legitimate setting for
        // ordinary agent work, and the release lane additionally REQUIRES
        // `allowAgentMerge: true` with `main` unprotected or slice AI's own
        // promotion merges are refused. On that configuration a revert
        // pull request would have merged into production with no
        // `merge_pull_request` approval ever raised, verified or recorded.
        //
        // It also resolves the branch the revert actually lands on. Every
        // other Task pull request targets the Work's isolation base; a
        // revert lands where the promotion landed, and that value is what
        // the protected-branch rule is evaluated against AND what the
        // approving human reads. Resolved from the Work's LADDER and the
        // Task's own rung label — platform state on both sides, never
        // anything a caller supplied.
        //
        // Fails closed: a revert Task whose rung or ladder cannot be
        // resolved is not merged at all, rather than merged against a base
        // this gate had to guess.
        const revertBase = resolveRevertBase(task, work);
        if (isReleaseRevertTask(task.labels) && !revertBase) {
            this.logger.warn(
                `Task ${task.id}: release revert Task has no resolvable base branch ` +
                    '(missing rung label or unusable release ladder) — refusing the merge.',
            );
            return { action: 'skipped', reason: 'revert-base-unresolved' };
        }

        // The Agent that owns this Task's runs. Without one there is no
        // scope to resolve an Agent-level policy against and nobody to
        // attribute the merge to, so the gate stands down rather than
        // guessing.
        const agentId = task.agentId ?? null;
        if (!agentId) return { action: 'skipped', reason: 'no-agent' };

        const resolved = await this.mergePolicy.resolve({
            agentId,
            workId: work.id,
            organizationId: work.organizationId ?? null,
            tenantId: work.tenantId ?? null,
        });

        if (!resolved.policy.allowAgentMerge) {
            // Raising an approval the policy could never act on would be
            // asking a human for permission the platform cannot use.
            return { action: 'skipped', reason: 'agent-merge-disabled' };
        }

        // Release promotion lane (slice AI) — THE property the slice
        // exists for: a promotion is never merged without a recorded human
        // approval, whatever the scope's policy says.
        //
        // `requireHumanApproval: false` is a legitimate operator choice for
        // ordinary agent work ("agents land their own green work"). It is
        // not a choice about releases: a promotion moves a whole batch onto
        // `stage` or into production, the stage e2e gate has been
        // unreliable for weeks, and a bad promotion is a multi-hour outage
        // on a build lane measured at 215-243 minutes. So a promotion
        // ignores the shortcut below and always takes the approval path,
        // and `attemptMergeForOpenPullRequest` additionally RAISES the
        // requirement inside the facade so the property does not rest on
        // this branch alone.
        // `revertBase !== null` carries the slice-AJ half of the same
        // property: a revert is never merged without a recorded human
        // approval either.
        const needsApproval =
            resolved.policy.requireHumanApproval || promotion !== null || revertBase !== null;

        if (!needsApproval) {
            // The operator opted out of approvals for this scope. Green
            // provider CI is the trigger; the facade still pins the head
            // and still applies the branch / method / gate rules.
            const merge = await this.taskWorkspace.attemptMergeForOpenPullRequest({
                task,
                agentId,
                gateStatus: 'green',
                headSha,
            });
            return { action: 'merge-attempted', merge };
        }

        if (!this.mergeApprovals) {
            return { action: 'skipped', reason: 'no-approval-verifier' };
        }

        const verdict = await this.mergeApprovals.verifyMergeApproval({
            taskId: task.id,
            prNumber: task.prNumber,
            headSha,
        });
        if (verdict.approved) {
            const merge = await this.taskWorkspace.attemptMergeForOpenPullRequest({
                task,
                agentId,
                gateStatus: 'green',
                headSha,
                // The promotion's own base — or, for a revert, the branch
                // the promotion landed on. Never the Work's default; see
                // `attemptMergeForOpenPullRequest`.
                baseRef: promotion?.baseBranch ?? revertBase,
                requireHumanApproval: promotion !== null || revertBase !== null,
            });
            return { action: 'merge-attempted', merge };
        }

        // Not approved (yet). Raise the ask — idempotent per head commit,
        // so a stale approval for an earlier commit correctly produces a
        // NEW request rather than being silently reused.
        const request = await this.mergeApprovals.requestMergeApproval({
            userId: task.userId,
            taskId: task.id,
            taskLabel: task.slug ?? task.id,
            agentId,
            prNumber: task.prNumber,
            prUrl: task.prUrl ?? null,
            headSha,
            // The branch this pull request MERGES INTO, as the human will
            // read it in the Inbox ("Merge PR #7 into <branch> in <repo>").
            // A promotion carries its own base; only an ordinary Task pull
            // request targets the Work's isolation base.
            targetBranch:
                promotion?.baseBranch ??
                revertBase ??
                ((work.taskIsolationBaseBranch && work.taskIsolationBaseBranch.trim()) || null),
            repository: `${work.getRepoOwner()}/${work.getDataRepo()}`,
            ciState: status.ciState,
            // Provider-side human review, surfaced to the approver as
            // context. It is NOT an authorization: a GitHub login is not a
            // platform identity, and this platform cannot map one to an
            // entitled Organization member. Shown so the person deciding
            // knows whether anybody has actually read the diff.
            reviewApprovedBy:
                task.prReviewApprovedSha && task.prReviewApprovedSha === headSha
                    ? (task.prReviewApprovedBy ?? null)
                    : null,
        });

        if (request.raised && request.proposal) {
            return { action: 'approval-requested', proposalId: request.proposal.id };
        }
        return request.reason === 'already-open' || request.reason === 'already-decided'
            ? { action: 'approval-pending' }
            : { action: 'skipped', reason: request.reason ?? 'not-raised' };
    }

    /**
     * Release promotion lane (slice AI) — decides whether this Task's pull
     * request may go on to the approval path, and hands back the
     * promotion's own coordinates when it may.
     *
     * `blocked` is a SKIP outcome the caller returns verbatim.
     * `promotion` is the allowing verdict for a live promotion, or `null`
     * when this is an ordinary Task — the ordinary path is then exactly
     * what it was before this slice existed.
     *
     * Three fail-closed properties, all load-bearing:
     *
     *   1. **Unbound guard.** A Task whose labels say it is a promotion is
     *      refused when no guard is bound, without consulting the guard —
     *      so the refusal does not depend on the service that is missing.
     *   2. **A throwing guard.** Treated as a refusal, not as a pass. The
     *      port says implementations must not throw for "no"; if one does,
     *      the answer we did not get is not assumed to be yes.
     *   3. **The pull request is named.** The guard is told WHICH pull
     *      request is about to be merged, so a verdict recorded for the
     *      promotion's pull request can never authorise a merge of some
     *      other one that later took over `tasks.prNumber`.
     */
    private async assessPromotion(
        task: Task,
        headSha: string,
    ): Promise<{
        blocked?: TaskMergeGateOutcome;
        promotion: Extract<PromotionMergeVerdict, { allowed: true }> | null;
    }> {
        if (!this.promotionGuard) {
            return isPromotionTask(task.labels)
                ? {
                      blocked: { action: 'skipped', reason: 'promotion-guard-unbound' },
                      promotion: null,
                  }
                : { promotion: null };
        }
        let verdict: PromotionMergeVerdict;
        try {
            verdict = await this.promotionGuard.assessPromotionForMerge({
                taskId: task.id,
                labels: task.labels,
                // Non-null by the `!task.prNumber` guard at the top of
                // `evaluate`; the guard refuses when it is not the pull
                // request the promotion opened.
                prNumber: task.prNumber as number,
                headSha,
            });
        } catch (error) {
            this.logger.warn(
                `Task ${task.id}: promotion guard threw; treating as a refusal: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return {
                blocked: { action: 'skipped', reason: 'promotion-guard-failed' },
                promotion: null,
            };
        }
        if (!verdict.promotion) return { promotion: null };
        // `=== true`, not a truthiness check: this package compiles with
        // `strictNullChecks: false`, under which truthiness narrowing on a
        // boolean-literal discriminant does not exclude the `true` member
        // and `verdict.code` below stops type-checking.
        if (verdict.allowed === true) return { promotion: verdict };
        this.logger.log(
            `Task ${task.id}: promotion not mergeable — ${verdict.code}: ${verdict.reason}`,
        );
        return { blocked: { action: 'skipped', reason: verdict.code }, promotion: null };
    }
}

/**
 * The branch a release revert Task lands on, or `null` when this is not a
 * revert Task (or is one whose base cannot be resolved).
 *
 * Post-deploy verification and revert (slice AJ, EW-809). BOTH inputs are
 * platform state: the rung comes from the labels the verification service
 * filed the Task with, and the branch comes from the Work's release
 * ladder — the same `resolvePromotionBranches` slice AI opened the
 * promotion with, so a revert and the promotion it undoes can never
 * disagree about which branch is production.
 */
function resolveRevertBase(
    task: Pick<Task, 'labels'>,
    work: { releaseLadder?: ReleaseLadder | null },
): string | null {
    const rung = releaseRevertRungFromLabels(task.labels);
    if (!rung) return null;
    return resolvePromotionBranches(work.releaseLadder, rung)?.base ?? null;
}
