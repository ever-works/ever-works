import type { MergePolicy } from '@ever-works/contracts';
import { PROMOTION_TASK_LABEL, releaseRevertTaskLabels } from '@ever-works/contracts';
import { TaskMergeGateService } from '../task-merge-gate.service';

/**
 * Post-deploy verification and revert (self-build slice AJ, EW-809) × merge
 * approval (slice AE) — the merge gate's side of the REVERT.
 *
 * ## The hole this file closes
 *
 * A revert Task is deliberately an ORDINARY Task: no `release:promotion`
 * label, so the promotion guard answers `{ promotion: null }` for it and
 * `ReleasePromotionService` leaves it alone. That is what stops "a revert
 * opens a promotion which triggers another check" from being a cycle — and
 * it is also what, until this file existed, dropped a revert straight into
 * the ordinary agent-merge path.
 *
 * The configuration that path needs is the configuration the release lane
 * REQUIRES: `allowAgentMerge: true`, and `main` / `stage` absent from
 * `protectedBranches` (otherwise slice AI's own promotion merges are
 * refused with `protected-branch`). On that configuration
 * `requireHumanApproval: false` — described in `task-merge-gate.service.ts`
 * itself as "a legitimate operator choice for ordinary agent work" — made
 * `needsApproval` false for a revert, and the gate merged it. Production
 * was reverted with no `merge_pull_request` approval ever raised, verified
 * or recorded. `isReleaseRevertTask` existed for exactly this check and was
 * called by nothing.
 *
 * Two properties, asserted here and nowhere else:
 *
 *   1. a revert is never merged without a recorded human approval, whatever
 *      the scope's policy says — the same rule slice AI hard-wires for a
 *      promotion, for the strictly stronger reason that undoing a release
 *      is the same class of act as making one;
 *   2. the branch the gate reasons about is the branch the revert LANDS ON,
 *      resolved from the Work's release ladder — not the Work's
 *      `taskIsolationBaseBranch`, which is the right answer for every other
 *      Task pull request on the platform and the wrong one here.
 */
describe('TaskMergeGateService — release revert Tasks', () => {
    const HEAD = 'c1d2e3f405162738495a6b7c8d9e0f1122334455';

    /** The operator posture the release lane requires, with approvals OFF. */
    const NO_APPROVAL_NEEDED: MergePolicy = {
        allowAgentMerge: true,
        requireGreenGate: true,
        requireHumanApproval: false,
        allowedMergeMethods: ['squash'],
        // `main` deliberately NOT protected — with it protected, slice AI's
        // own promotion merges are refused, so this is the only shape in
        // which the lane runs at all.
        protectedBranches: ['release/frozen'],
    };

    const NEEDS_APPROVAL: MergePolicy = { ...NO_APPROVAL_NEEDED, requireHumanApproval: true };

    const LADDER = { integration: 'develop', staging: 'stage', production: 'main' };

    const revertTask = (over: Record<string, unknown> = {}) =>
        ({
            id: 'task-99',
            userId: 'owner-1',
            slug: 'T-99',
            workId: 'work-1',
            agentId: 'agent-1',
            prNumber: 12,
            prUrl: 'https://github.com/ever-works/ever-works/pull/12',
            labels: releaseRevertTaskLabels('stage-to-main'),
            ...over,
        }) as never;

    const status = (over: Record<string, unknown> = {}) =>
        ({
            number: 12,
            state: 'open',
            merged: false,
            ciState: 'passing',
            checksComplete: true,
            headSha: HEAD,
            checks: [],
            ...over,
        }) as never;

    function build(
        over: {
            policy?: MergePolicy;
            approved?: boolean;
            work?: Record<string, unknown>;
        } = {},
    ) {
        const works = {
            findById: jest.fn().mockResolvedValue({
                id: 'work-1',
                organizationId: null,
                tenantId: null,
                // The branch every ordinary Task pull request targets, and
                // the value the gate used to compute a revert's base from.
                taskIsolationBaseBranch: 'work/agent-base',
                releaseLadder: LADDER,
                getRepoOwner: () => 'ever-works',
                getDataRepo: () => 'ever-works',
                ...over.work,
            }),
        };
        const mergePolicy = {
            resolve: jest.fn().mockResolvedValue({
                policy: over.policy ?? NO_APPROVAL_NEEDED,
                source: 'work',
                chain: [],
            }),
        };
        const taskWorkspace = {
            attemptMergeForOpenPullRequest: jest
                .fn()
                .mockResolvedValue({ attempted: true, merged: true }),
        };
        const mergeApprovals = {
            verifyMergeApproval: jest
                .fn()
                .mockResolvedValue(
                    over.approved
                        ? { approved: true, approvalId: 'p-1', approvedById: 'human-1' }
                        : { approved: false, code: 'approval-missing' },
                ),
            requestMergeApproval: jest
                .fn()
                .mockResolvedValue({ raised: true, proposal: { id: 'p-new' } }),
        };
        // A bound guard that recognises nothing: a revert Task carries no
        // promotion label, so this is what the real guard answers for it.
        const guard = {
            assessPromotionForMerge: jest.fn().mockResolvedValue({ promotion: false }),
        };
        const service = new TaskMergeGateService(
            works as never,
            mergePolicy as never,
            taskWorkspace as never,
            mergeApprovals as never,
            guard as never,
        );
        return { service, works, mergePolicy, taskWorkspace, mergeApprovals, guard };
    }

    // ── The approval is not optional for a revert ─────────────────────

    it('will not merge a revert on `requireHumanApproval: false` — it raises the approval instead', async () => {
        // THE property. This is the exact configuration the release lane
        // runs in, and before this the gate took the `if (!needsApproval)`
        // shortcut and merged the revert into production unattended.
        const { service, taskWorkspace, mergeApprovals } = build();

        const outcome = await service.onPullRequestStatusRefreshed(revertTask(), status());

        expect(outcome).toEqual({ action: 'approval-requested', proposalId: 'p-new' });
        expect(taskWorkspace.attemptMergeForOpenPullRequest).not.toHaveBeenCalled();
        expect(mergeApprovals.requestMergeApproval).toHaveBeenCalledWith(
            expect.objectContaining({ taskId: 'task-99', prNumber: 12, headSha: HEAD }),
        );
    });

    it('merges a revert only once a human approval verifies for THIS head', async () => {
        const { service, taskWorkspace, mergeApprovals } = build({ approved: true });

        const outcome = await service.onPullRequestStatusRefreshed(revertTask(), status());

        expect(outcome).toMatchObject({ action: 'merge-attempted' });
        expect(mergeApprovals.verifyMergeApproval).toHaveBeenCalledWith({
            taskId: 'task-99',
            prNumber: 12,
            headSha: HEAD,
        });
        // And the facade is told to RAISE the requirement as well, so the
        // property does not rest on this service alone.
        expect(taskWorkspace.attemptMergeForOpenPullRequest).toHaveBeenCalledWith(
            expect.objectContaining({ requireHumanApproval: true }),
        );
    });

    it('is unaffected by the operator turning approvals off — both policies take the same path', async () => {
        const off = build();
        const on = build({ policy: NEEDS_APPROVAL });

        const a = await off.service.onPullRequestStatusRefreshed(revertTask(), status());
        const b = await on.service.onPullRequestStatusRefreshed(revertTask(), status());

        expect(a).toEqual(b);
        expect(off.taskWorkspace.attemptMergeForOpenPullRequest).not.toHaveBeenCalled();
        expect(on.taskWorkspace.attemptMergeForOpenPullRequest).not.toHaveBeenCalled();
    });

    // ── The branch the gate reasons about ────────────────────────────

    it('names the branch the revert LANDS ON in the approval a human reads', async () => {
        // The Inbox line is "Merge PR #12 into <branch> in <repo>". With the
        // Work's isolation base it read "into work/agent-base" — a founder
        // approving what looks like a sandbox merge while production is
        // reverted.
        const { service, mergeApprovals } = build();

        await service.onPullRequestStatusRefreshed(revertTask(), status());

        expect(mergeApprovals.requestMergeApproval).toHaveBeenCalledWith(
            expect.objectContaining({ targetBranch: 'main' }),
        );
    });

    it('hands the merge path the release base, so the protected-branch rule sees `main`', async () => {
        // `evaluateAgentMerge` evaluates `ctx.targetBranch`. Computed from
        // the Work's isolation base it found no protected match and allowed
        // a merge into production that a conservative operator had
        // explicitly protected.
        const { service, taskWorkspace } = build({
            approved: true,
            work: { taskIsolationBaseBranch: 'work/agent-base' },
        });

        await service.onPullRequestStatusRefreshed(revertTask(), status());

        expect(taskWorkspace.attemptMergeForOpenPullRequest).toHaveBeenCalledWith(
            expect.objectContaining({ baseRef: 'main', requireHumanApproval: true }),
        );
    });

    it('resolves the base from the RUNG, so a staging revert does not name production', async () => {
        const { service, mergeApprovals } = build();

        await service.onPullRequestStatusRefreshed(
            revertTask({ labels: releaseRevertTaskLabels('develop-to-stage') }),
            status(),
        );

        expect(mergeApprovals.requestMergeApproval).toHaveBeenCalledWith(
            expect.objectContaining({ targetBranch: 'stage' }),
        );
    });

    it('reads the base from the LADDER, never from a branch name baked into the code', async () => {
        const { service, mergeApprovals } = build({
            work: { releaseLadder: { integration: 'dev', staging: 'rc', production: 'live' } },
        });

        await service.onPullRequestStatusRefreshed(revertTask(), status());

        expect(mergeApprovals.requestMergeApproval).toHaveBeenCalledWith(
            expect.objectContaining({ targetBranch: 'live' }),
        );
    });

    // ── Fails closed ─────────────────────────────────────────────────

    it.each([
        ['the Work has no release ladder', { releaseLadder: null }],
        [
            'the ladder is unusable',
            { releaseLadder: { integration: 'develop', staging: 'develop', production: 'main' } },
        ],
    ])('refuses the merge outright when %s', async (_label, work) => {
        // Rather than falling back to the Work's isolation base, which is
        // how a revert would be merged against a branch the gate had to
        // guess — and reported to a human as that guess.
        const { service, taskWorkspace, mergeApprovals } = build({ approved: true, work });

        const outcome = await service.onPullRequestStatusRefreshed(revertTask(), status());

        expect(outcome).toEqual({ action: 'skipped', reason: 'revert-base-unresolved' });
        expect(taskWorkspace.attemptMergeForOpenPullRequest).not.toHaveBeenCalled();
        expect(mergeApprovals.requestMergeApproval).not.toHaveBeenCalled();
    });

    it('refuses a revert Task whose rung label was lost', async () => {
        const { service, taskWorkspace } = build({ approved: true });

        const outcome = await service.onPullRequestStatusRefreshed(
            revertTask({ labels: ['release:revert'] }),
            status(),
        );

        expect(outcome).toEqual({ action: 'skipped', reason: 'revert-base-unresolved' });
        expect(taskWorkspace.attemptMergeForOpenPullRequest).not.toHaveBeenCalled();
    });

    // ── Nothing else moved ───────────────────────────────────────────

    it('leaves an ordinary Task on the ordinary path — approvals off still merges it', async () => {
        // The pair to the first test. This slice must not turn every agent
        // merge on the platform into an approval prompt.
        const { service, taskWorkspace, mergeApprovals } = build();

        const outcome = await service.onPullRequestStatusRefreshed(
            revertTask({ labels: ['chore'] }),
            status(),
        );

        expect(outcome).toMatchObject({ action: 'merge-attempted' });
        expect(mergeApprovals.requestMergeApproval).not.toHaveBeenCalled();
        expect(taskWorkspace.attemptMergeForOpenPullRequest).toHaveBeenCalledWith(
            expect.not.objectContaining({ requireHumanApproval: true }),
        );
    });

    it('does not mistake a promotion Task for a revert', async () => {
        const { service } = build({ work: { releaseLadder: null } });

        // A promotion Task with an unusable ladder must still be refused by
        // the PROMOTION path (guard says not-a-promotion here, so it falls
        // through to the ordinary one) — never by the revert refusal, which
        // would hide the real reason.
        const outcome = await service.onPullRequestStatusRefreshed(
            revertTask({ labels: [PROMOTION_TASK_LABEL, 'release:promotion:stage-to-main'] }),
            status(),
        );

        expect(outcome).not.toEqual({ action: 'skipped', reason: 'revert-base-unresolved' });
    });
});
