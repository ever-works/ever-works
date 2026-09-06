import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Like, Repository } from 'typeorm';
import {
    MERGE_APPROVAL_MAX_AGE_MS,
    mergeApprovalPullRequestKeyPrefix,
    mergeApprovalSubjectKey,
    normalizeCommitSha,
} from '@ever-works/contracts';
import { AgentActionProposal } from '../entities/agent-action-proposal.entity';
import { TaskRepository } from '../database/repositories/task.repository';
import { UserRepository } from '../database/repositories/user.repository';
import { OrganizationMemberRepository } from '../database/repositories/organization-member.repository';
import { TenantRepository } from '../database/repositories/tenant.repository';
import { ownershipScopeOf } from '../database/ownership-scope';
import type {
    MergeApprovalQuery,
    MergeApprovalVerdict,
    MergeApprovalVerifier,
} from '../policy/merge-approval.port';
import { AgentApprovalsService } from './agent-approvals.service';
import type { AgentActionProposalDto } from './types';

/** What the merge gate knows when it asks for an approval to be raised. */
export interface RequestMergeApprovalInput {
    /** Owner of the Task; the proposal is filed to their queue + Inbox. */
    userId: string;
    taskId: string;
    /** Human-readable Task label for the proposal title. */
    taskLabel: string;
    /** The Agent whose pull request this is (ownership-checked downstream). */
    agentId: string;
    prNumber: number;
    prUrl?: string | null;
    /** Head commit read from the provider — the approval binds to it. */
    headSha: string;
    targetBranch?: string | null;
    /** `owner/repo`. */
    repository?: string | null;
    /** Provider CI verdict at raise time (always `passing` today). */
    ciState?: string | null;
    /** Provider login of the human who approved on the provider, if any. */
    reviewApprovedBy?: string | null;
    runId?: string | null;
}

/**
 * Flat rather than a discriminated union on purpose: this package
 * compiles with `strictNullChecks: false`, under which TypeScript will
 * NOT narrow `{ raised: true } | { raised: false }` at a call site, so the
 * tidier shape reads worse than it looks.
 */
export interface RequestMergeApprovalOutcome {
    raised: boolean;
    /** Present iff `raised`. */
    proposal?: AgentActionProposalDto;
    /** Why nothing was raised. Absent iff `raised`. */
    reason?: 'already-open' | 'already-decided' | 'unusable-subject' | 'failed';
}

/**
 * Merge approval (self-build slice AE, EW-805) — the READ-BACK half of
 * the approval queue, and the only consumer in the platform that treats
 * an `agent_action_proposals` row as an authorization rather than an
 * audit record.
 *
 * Two jobs, deliberately in one class because they must agree on the
 * subject key byte for byte:
 *
 *   - {@link requestMergeApproval} raises the proposal, keyed by
 *     `merge:<taskId>:<prNumber>:<headSha>`.
 *   - {@link verifyMergeApproval} answers the git facade's question by
 *     re-deriving that key from LIVE provider state and looking for an
 *     approved row under it.
 *
 * Five things must ALL be true for `approved: true`, and each maps to a
 * failure mode that has actually shipped in somebody's merge bot:
 *
 *   1. **A row exists under the exact key.** Not "for this Task", not
 *      "for this PR" — for this PR at this commit. A force-push, a new
 *      commit, or a rebase produces a different key, so the approval
 *      given for the reviewed diff cannot land a different one.
 *   2. **A human decided it.** `decidedVia === 'user'` AND `decidedById`
 *      is set. Guardrail auto-approvals write `decidedVia: 'guardrail'`
 *      with a null decider precisely so they are distinguishable, and
 *      they are rejected here. The platform cannot approve its own work.
 *   3. **The decider is a real, active, non-anonymous account.** An
 *      anonymous (unclaimed, zero-friction) account is not somebody who
 *      can be held to a merge.
 *   4. **The decider is entitled to approve for this Task's scope**,
 *      derived from PLATFORM STATE (the Task's own scope stamp, the
 *      approver's `users` row and the Organization roster), never from
 *      the proposal row — a proposal that carried its own entitlement
 *      would be a proposal that authorised itself. Tenant equality is
 *      necessary but NOT sufficient; see `entitledToApprove` for why a
 *      member removed from the Organization must stop counting.
 *   5. **The decision is not stale.** Older than
 *      `MERGE_APPROVAL_MAX_AGE_MS` and it stops counting.
 *
 * Anything unexpected — a store error, a Task that vanished, a head SHA
 * that is not a SHA — is a REFUSAL, not an exception and never an
 * approval. There is no code path in this file that returns
 * `approved: true` without having read a row.
 */
@Injectable()
export class MergeApprovalService implements MergeApprovalVerifier {
    private readonly logger = new Logger(MergeApprovalService.name);

    constructor(
        @InjectRepository(AgentActionProposal)
        private readonly proposals: Repository<AgentActionProposal>,
        private readonly tasks: TaskRepository,
        private readonly users: UserRepository,
        private readonly approvals: AgentApprovalsService,
        // Organization roster — an entitlement input, see
        // `entitledToApprove`. @Optional() per the positional-spec arity
        // rule; absent, the predicate degrades to tenant equality and says
        // so in the log.
        @Optional() private readonly organizationMembers?: OrganizationMemberRepository,
        // `tenants.ownerUserId`, so the Tenant owner — who is a member of
        // every Organization in their Tenant BY CONSTRUCTION and therefore
        // has no roster row to find — is not locked out by the roster
        // check. Appended LAST per the positional-spec arity rule.
        @Optional() private readonly tenants?: TenantRepository,
    ) {}

    // ── verify ────────────────────────────────────────────────────────

    /** {@link MergeApprovalVerifier.verifyMergeApproval}. */
    async verifyMergeApproval(query: MergeApprovalQuery): Promise<MergeApprovalVerdict> {
        const headSha = normalizeCommitSha(query.headSha);
        const taskId = (query.taskId ?? '').trim();
        if (!taskId) {
            return {
                approved: false,
                code: 'approval-missing',
                reason:
                    'This merge is not attached to a Task, so there is nothing an approval could ' +
                    'have been recorded against. Refusing rather than merging unattributed work.',
            };
        }
        if (!headSha) {
            return {
                approved: false,
                code: 'head-sha-unknown',
                reason:
                    'The pull request head commit could not be determined, so no approval can be ' +
                    'matched to what would actually be merged.',
            };
        }

        let subjectKey: string;
        try {
            subjectKey = mergeApprovalSubjectKey({ taskId, prNumber: query.prNumber, headSha });
        } catch (error) {
            return {
                approved: false,
                code: 'approval-missing',
                reason: `This merge cannot be keyed to an approval: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            };
        }

        let row: AgentActionProposal | null;
        try {
            row = await this.proposals.findOne({
                where: {
                    actionType: 'merge_pull_request',
                    subjectKey,
                    status: 'approved',
                },
                order: { decidedAt: 'DESC' },
            });
        } catch (error) {
            // A store that cannot answer is not an approval.
            this.logger.warn(
                `Merge approval lookup failed for ${subjectKey} (refusing): ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return {
                approved: false,
                code: 'approval-missing',
                reason: 'The approval record could not be read, so this merge is refused.',
            };
        }

        if (!row) {
            return this.describeMissingApproval(taskId, query.prNumber, headSha);
        }

        if (row.decidedVia !== 'user' || !row.decidedById) {
            // Reachable only if something bypassed `evaluateGuardrails`'
            // merge rule; kept as a hard gate because the whole slice
            // exists to stop the platform approving itself.
            return {
                approved: false,
                code: 'approval-not-human',
                reason:
                    'The recorded decision for this pull request was not made by a person ' +
                    `(decided via ${row.decidedVia ?? 'unknown'}). A merge needs a human approval.`,
            };
        }

        const decidedAt = row.decidedAt ? new Date(row.decidedAt) : null;
        if (!decidedAt || Number.isNaN(decidedAt.getTime())) {
            return {
                approved: false,
                code: 'approval-expired',
                reason: 'The approval for this pull request carries no decision time, so its age cannot be established.',
            };
        }
        const ageMs = Date.now() - decidedAt.getTime();
        if (ageMs > MERGE_APPROVAL_MAX_AGE_MS) {
            const hours = Math.floor(ageMs / 3_600_000);
            return {
                approved: false,
                code: 'approval-expired',
                reason:
                    `The approval for this pull request is ${hours}h old and approvals expire after ` +
                    `${MERGE_APPROVAL_MAX_AGE_MS / 3_600_000}h. Approve it again to merge.`,
            };
        }

        const entitlement = await this.entitledToApprove(taskId, row.decidedById);
        if (!entitlement.entitled) {
            return {
                approved: false,
                code: 'approver-not-entitled',
                reason: entitlement.reason,
            };
        }

        return {
            approved: true,
            approvalId: row.id,
            approvedById: row.decidedById,
            approvedAt: decidedAt,
        };
    }

    // ── request ───────────────────────────────────────────────────────

    /**
     * Raise the human-facing approval for one green pull request.
     *
     * Idempotent per subject key: a second call for the same
     * (Task, PR, head) finds the existing row and raises nothing, so the
     * 2-minute PR-status sweep does not file one Inbox item per tick. A
     * NEW head commit is a NEW subject and therefore correctly raises a
     * fresh approval — the previous one is left decided-but-unusable,
     * which is the honest record of what happened.
     *
     * The read below is not the guarantee, and cannot be: this is a
     * check-then-create whose callers sit in TWO processes — the
     * `task-pr-status-sync` cron worker and an API `?refresh=true` —
     * so `TaskPrStatusService`'s in-process `inFlight` map does not
     * serialize them. Two racing sweeps would both see nothing and both
     * insert, putting two Approve buttons in the Inbox for one merge and
     * letting a later click on the second grant a fresh 24h validity
     * window over a head the first already covered. The real guarantee is
     * the UNIQUE index on `(actionType, subjectKey)`; the read is the fast
     * path, and the loser of the race is caught below and reported as
     * `already-open` exactly as if it had lost the read.
     */
    async requestMergeApproval(
        input: RequestMergeApprovalInput,
    ): Promise<RequestMergeApprovalOutcome> {
        const headSha = normalizeCommitSha(input.headSha);
        if (!headSha) return { raised: false, reason: 'unusable-subject' };

        let subjectKey: string;
        try {
            subjectKey = mergeApprovalSubjectKey({
                taskId: input.taskId,
                prNumber: input.prNumber,
                headSha,
            });
        } catch {
            return { raised: false, reason: 'unusable-subject' };
        }

        const existing = await this.proposals.findOne({
            where: { actionType: 'merge_pull_request', subjectKey },
            order: { createdAt: 'DESC' },
        });
        if (existing) {
            return {
                raised: false,
                reason: existing.status === 'pending' ? 'already-open' : 'already-decided',
            };
        }

        try {
            // The title is the ONE string both surfaces show — the Inbox
            // item and the approvals queue — so it carries everything a
            // person needs to decide without opening anything: which pull
            // request, into which branch, in which repository, at which
            // commit. "Merge PR #7" alone is not a thing anybody can
            // responsibly say yes to.
            const target = input.targetBranch ? ` into ${input.targetBranch}` : '';
            const where = input.repository ? ` in ${input.repository}` : '';
            const proposal = await this.approvals.createProposal(input.userId, {
                agentId: input.agentId,
                actionType: 'merge_pull_request',
                title: `Merge PR #${input.prNumber}${target}${where} for ${input.taskLabel} (@ ${headSha.slice(0, 12)})`.slice(
                    0,
                    200,
                ),
                subjectKey,
                runId: input.runId ?? null,
                payload: {
                    taskId: input.taskId,
                    prNumber: input.prNumber,
                    prUrl: input.prUrl ?? null,
                    headSha,
                    targetBranch: input.targetBranch ?? null,
                    repository: input.repository ?? null,
                    ciState: input.ciState ?? null,
                    reviewApprovedBy: input.reviewApprovedBy ?? null,
                    // The RISK_SCORER flags every merge as destructive from
                    // the action type alone; this is here so the payload a
                    // human reads says the same thing the badge does.
                    destructive: true,
                },
            });
            this.logger.log(
                `Task ${input.taskId}: merge approval requested for PR #${input.prNumber} at ${headSha} (proposal ${proposal.id}).`,
            );
            return { raised: true, proposal };
        } catch (error) {
            // Lost the insert race (or an equal-and-opposite fault). Ask
            // the store what is actually there rather than reporting a
            // failure the caller would retry into the same collision.
            const winner = await this.proposals
                .findOne({
                    where: { actionType: 'merge_pull_request', subjectKey },
                    order: { createdAt: 'DESC' },
                })
                .catch(() => null);
            if (winner) {
                this.logger.debug(
                    `Task ${input.taskId}: merge approval for PR #${input.prNumber} at ${headSha} ` +
                        `was raised concurrently (proposal ${winner.id}); not filing a second one.`,
                );
                return {
                    raised: false,
                    reason: winner.status === 'pending' ? 'already-open' : 'already-decided',
                };
            }
            this.logger.warn(
                `Task ${input.taskId}: could not raise the merge approval for PR #${input.prNumber}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return { raised: false, reason: 'failed' };
        }
    }

    // ── internals ─────────────────────────────────────────────────────

    /**
     * "Nobody approved this" and "somebody approved an earlier commit"
     * are the same refusal to the policy and completely different things
     * to the human reading it, so they get different codes and wording.
     */
    private async describeMissingApproval(
        taskId: string,
        prNumber: number,
        headSha: string,
    ): Promise<MergeApprovalVerdict> {
        let priorForPr = 0;
        try {
            priorForPr = await this.proposals.count({
                where: {
                    actionType: 'merge_pull_request',
                    status: 'approved',
                    subjectKey: Like(`${mergeApprovalPullRequestKeyPrefix({ taskId, prNumber })}%`),
                },
            });
        } catch {
            // Cosmetic only — the refusal stands either way.
            priorForPr = 0;
        }

        if (priorForPr > 0) {
            return {
                approved: false,
                code: 'approval-stale',
                reason:
                    `PR #${prNumber} was approved for an earlier commit, but its head is now ` +
                    `${headSha.slice(0, 12)}. The approval covers the commit that was reviewed, not this one — ` +
                    'review and approve again.',
            };
        }
        return {
            approved: false,
            code: 'approval-missing',
            reason:
                `No human approval is on record for PR #${prNumber} at commit ${headSha.slice(0, 12)}. ` +
                'Approve it in the Inbox to let the agent merge.',
        };
    }

    /**
     * May this user approve a merge for this Task's scope?
     *
     * Derived entirely from platform state: the Task row's own scope
     * stamp, the approver's `users` row and the Organization roster.
     * Nothing on the proposal is consulted — the proposal is the thing
     * being authorised.
     *
     * The predicate is GRADUATED, and the shape is deliberate:
     *
     *   tenant equality  AND  (roster row  OR  Tenant owner  OR  the
     *                          Organization has no roster at all)
     *
     * Tenant equality ALONE — what the read paths use, and what this
     * method did until the AE review — is wrong here. Removal from an
     * Organization is expressed by deleting the roster row
     * (`OrganizationInvitationFlowService.removeMember`), and that method
     * only clears `users.tenantId` once the person's LAST membership in
     * the Tenant is gone. So somebody removed from Organization A while
     * still in Organization B keeps their `tenantId`, and a
     * tenant-equality predicate keeps handing them merge authority over
     * A's repositories — reading the revocation and ignoring it.
     * Everywhere else that is a visibility question; here it is the single
     * irreversible write in the queue.
     *
     * The two escape hatches are what stop this repeating the revert that
     * `assertActorReachable` and `UploadsController` both needed:
     *
     *  - **Tenant owner.** They are a member of every Organization in
     *    their Tenant by construction and have no roster row to find
     *    (`removeMember` refuses to remove them for exactly that reason).
     *    A roster-only check admits everybody EXCEPT the owner, which is
     *    precisely backwards.
     *  - **An Organization with an EMPTY roster.** `organization_members`
     *    is unpopulated for Organizations that predate invitations, and
     *    roster-strictness against those admitted only the Tenant owner in
     *    production. Where there is no roster there is no revocation to
     *    honour, so the documented v1 tenant-wide posture stands.
     *
     * A Task with no Organization is personal scope, and there the owner
     * is the only entitled approver.
     */
    private async entitledToApprove(
        taskId: string,
        approverId: string,
    ): Promise<{ entitled: boolean; reason?: string }> {
        const task = await this.tasks.findById(taskId).catch(() => null);
        if (!task) {
            return {
                entitled: false,
                reason: `Task ${taskId} is no longer readable, so the approver's entitlement cannot be established.`,
            };
        }
        const approver = await this.users.findById(approverId).catch(() => null);
        if (!approver || !approver.isActive) {
            return {
                entitled: false,
                reason: 'The account that approved this merge is not an active user.',
            };
        }
        if (approver.isAnonymous) {
            return {
                entitled: false,
                reason: 'An anonymous account cannot approve a merge.',
            };
        }

        const scope = ownershipScopeOf(task);
        if (!scope.organizationId) {
            if (approverId !== task.userId) {
                return {
                    entitled: false,
                    reason: 'This Task is in a personal scope and was approved by somebody other than its owner.',
                };
            }
            return { entitled: true };
        }

        if (!scope.tenantId || approver.tenantId !== scope.tenantId) {
            return {
                entitled: false,
                reason:
                    'The approver does not belong to the Tenant that owns this Task, so they may not ' +
                    'approve merges for its Organization.',
            };
        }

        if (!this.organizationMembers) {
            // No roster bound to consult. Tenant equality already held, so
            // this is the pre-AE predicate — said out loud, not silently.
            this.logger.warn(
                `Merge approver ${approverId} admitted on tenant equality alone: no Organization ` +
                    'roster is bound in this runtime.',
            );
            return { entitled: true };
        }

        const member = await this.organizationMembers
            .findByOrgAndUser(scope.organizationId, approverId)
            .catch(() => null);
        if (member) return { entitled: true };

        if (await this.isTenantOwner(approverId, scope.tenantId)) {
            // The owner holds no roster row anywhere in their own Tenant.
            return { entitled: true };
        }

        // No row and not the owner. Tell "removed from this Organization"
        // apart from "this Organization has never had a roster" — only the
        // first of those is a revocation.
        let rosterSize: number | null = null;
        try {
            rosterSize =
                typeof this.organizationMembers.countForOrganization === 'function'
                    ? await this.organizationMembers.countForOrganization(scope.organizationId)
                    : null;
        } catch (error) {
            this.logger.warn(
                `Merge approval: Organization ${scope.organizationId} roster size unreadable, ` +
                    `refusing rather than guessing: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
            );
            return {
                entitled: false,
                reason:
                    'The Organization roster could not be read, so the approver’s membership of it ' +
                    'cannot be established. Refusing rather than assuming.',
            };
        }

        if (rosterSize === 0) {
            this.logger.debug(
                `Merge approver ${approverId} admitted without a roster row: Organization ` +
                    `${scope.organizationId} has no roster at all (pre-invitations Organization).`,
            );
            return { entitled: true };
        }

        return {
            entitled: false,
            reason:
                'The approver is not a member of the Organization that owns this Task. Belonging to ' +
                'the wider Tenant is not enough to approve a merge into that Organization’s ' +
                'repository — being removed from an Organization has to mean something.',
        };
    }

    /**
     * `tenants.ownerUserId` is UNIQUE, so one read settles it. Mirrors
     * `OrganizationInvitationFlowService.isTenantOwner`, which is where the
     * "the owner is a member of every Organization by construction, so
     * there is no roster row to delete" rule is stated and enforced.
     */
    private async isTenantOwner(userId: string, tenantId: string | null): Promise<boolean> {
        if (!tenantId || !this.tenants) return false;
        const tenant = await this.tenants.findById(tenantId).catch(() => null);
        return Boolean(tenant && tenant.ownerUserId === userId);
    }
}
