import { Injectable, Logger, Optional } from '@nestjs/common';
import type { GitPullRequestStatus } from '@ever-works/plugin';
import { normalizeCommitSha } from '@ever-works/contracts';
import { Task } from '../entities/task.entity';
import { WorkRepository } from '../database/repositories/work.repository';
import { MergePolicyService } from '../policy/merge-policy.service';
import { MergeApprovalService } from '../agent-approvals/merge-approval.service';
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

        const work = await this.works.findById(task.workId);
        if (!work) return { action: 'skipped', reason: 'no-work' };

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

        if (!resolved.policy.requireHumanApproval) {
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
            targetBranch:
                (work.taskIsolationBaseBranch && work.taskIsolationBaseBranch.trim()) || null,
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
}
