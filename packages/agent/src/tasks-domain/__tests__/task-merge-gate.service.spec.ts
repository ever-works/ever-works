import type { MergePolicy } from '@ever-works/contracts';
import { TaskMergeGateService } from '../task-merge-gate.service';

/**
 * Merge approval (self-build slice AE, EW-805) — the post-CI gate.
 *
 * This is the service that turns "CI went green" into either an Inbox
 * approval or a merge, and it is the answer to the original defect: the
 * merge decision no longer fires at pull-request-open time, when no CI
 * has run and no human has been asked.
 *
 * Everything is driven through the real `onPullRequestStatusRefreshed`
 * with a real `GitPullRequestStatus`-shaped payload; the collaborators
 * (policy, approvals, workspace) are doubles whose calls are the
 * assertions.
 */
describe('TaskMergeGateService', () => {
    const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

    const NEEDS_APPROVAL: MergePolicy = {
        allowAgentMerge: true,
        requireGreenGate: true,
        requireHumanApproval: true,
        allowedMergeMethods: ['squash'],
        protectedBranches: ['main'],
    };

    const task = (over: Record<string, unknown> = {}) =>
        ({
            id: 'task-1',
            userId: 'owner-1',
            slug: 'T-42',
            workId: 'work-1',
            agentId: 'agent-1',
            prNumber: 7,
            prUrl: 'https://github.com/acme/site-data/pull/7',
            ...over,
        }) as never;

    const status = (over: Record<string, unknown> = {}) =>
        ({
            number: 7,
            state: 'open',
            merged: false,
            ciState: 'passing',
            headSha: HEAD,
            checks: [],
            ...over,
        }) as never;

    function build(over: { policy?: MergePolicy; approved?: boolean } = {}) {
        const works = {
            findById: jest.fn().mockResolvedValue({
                id: 'work-1',
                organizationId: 'org-1',
                tenantId: 'tenant-1',
                taskIsolationBaseBranch: 'develop',
                getRepoOwner: () => 'acme',
                getDataRepo: () => 'site-data',
            }),
        };
        const mergePolicy = {
            resolve: jest.fn().mockResolvedValue({
                policy: over.policy ?? NEEDS_APPROVAL,
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
        const service = new TaskMergeGateService(
            works as never,
            mergePolicy as never,
            taskWorkspace as never,
            mergeApprovals as never,
        );
        return { service, works, mergePolicy, taskWorkspace, mergeApprovals };
    }

    // ── the ask ───────────────────────────────────────────────────────

    it('raises the approval for a green, open pull request, bound to the live head', async () => {
        const { service, mergeApprovals, taskWorkspace } = build();

        const outcome = await service.onPullRequestStatusRefreshed(task(), status());

        expect(outcome).toEqual({ action: 'approval-requested', proposalId: 'p-new' });
        expect(mergeApprovals.requestMergeApproval).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: 'owner-1',
                taskId: 'task-1',
                agentId: 'agent-1',
                prNumber: 7,
                headSha: HEAD,
                targetBranch: 'develop',
                repository: 'acme/site-data',
                ciState: 'passing',
            }),
        );
        // Nothing is merged just because CI went green.
        expect(taskWorkspace.attemptMergeForOpenPullRequest).not.toHaveBeenCalled();
    });

    it('surfaces a provider review approval only when it covers THIS head', async () => {
        const { service, mergeApprovals } = build();

        await service.onPullRequestStatusRefreshed(
            task({ prReviewApprovedSha: HEAD, prReviewApprovedBy: 'octocat' }),
            status(),
        );
        expect(mergeApprovals.requestMergeApproval.mock.calls[0][0].reviewApprovedBy).toBe(
            'octocat',
        );

        mergeApprovals.requestMergeApproval.mockClear();
        await service.onPullRequestStatusRefreshed(
            task({ prReviewApprovedSha: 'b'.repeat(40), prReviewApprovedBy: 'octocat' }),
            status(),
        );
        // The reviewer looked at a different commit; saying "octocat
        // approved" next to this diff would be a lie.
        expect(mergeApprovals.requestMergeApproval.mock.calls[0][0].reviewApprovedBy).toBeNull();
    });

    // ── an INCOMPLETE CI read is not green ────────────────────────────
    //
    // `ciState` is a roll-up over the head commit's checks; `checks` is a
    // bounded display sample. A provider that could not read the whole set
    // reports `checksComplete: false`, and the roll-up it gives back is
    // therefore a statement about a subset — a failure may sit in the part
    // nobody read. Authorising on it would show the human a green badge
    // the platform manufactured.

    it('neither asks nor merges when the provider could not read all the checks', async () => {
        const { service, mergeApprovals, taskWorkspace } = build();

        const outcome = await service.onPullRequestStatusRefreshed(
            task(),
            status({ ciState: 'passing', checksComplete: false }),
        );

        expect(outcome).toEqual({ action: 'skipped', reason: 'ci-incomplete' });
        expect(mergeApprovals.requestMergeApproval).not.toHaveBeenCalled();
        expect(taskWorkspace.attemptMergeForOpenPullRequest).not.toHaveBeenCalled();
    });

    it('does not merge an APPROVED pull request on an incomplete CI read either', async () => {
        const { service, taskWorkspace } = build({ approved: true });
        await service.onPullRequestStatusRefreshed(
            task(),
            status({ ciState: 'passing', checksComplete: false }),
        );
        expect(taskWorkspace.attemptMergeForOpenPullRequest).not.toHaveBeenCalled();
    });

    it('does not merge on an incomplete CI read when the policy asks for no approval', async () => {
        const { service, taskWorkspace } = build({
            policy: { ...NEEDS_APPROVAL, requireHumanApproval: false },
        });
        await service.onPullRequestStatusRefreshed(
            task(),
            status({ ciState: 'passing', checksComplete: false }),
        );
        expect(taskWorkspace.attemptMergeForOpenPullRequest).not.toHaveBeenCalled();
    });

    it('proceeds normally when the provider does not report completeness at all', async () => {
        // Only an explicit `false` is a warning — an older provider that
        // omits the field is taken at its word, exactly as before.
        const { service, mergeApprovals } = build();
        await service.onPullRequestStatusRefreshed(task(), status());
        expect(mergeApprovals.requestMergeApproval).toHaveBeenCalled();
    });

    it('reports approval-pending rather than re-asking on the next sweep', async () => {
        const { service, mergeApprovals } = build();
        mergeApprovals.requestMergeApproval.mockResolvedValue({
            raised: false,
            reason: 'already-open',
        });
        await expect(service.onPullRequestStatusRefreshed(task(), status())).resolves.toEqual({
            action: 'approval-pending',
        });
    });

    // ── the merge ─────────────────────────────────────────────────────

    it('MERGES once a human approval exists for the current head', async () => {
        const { service, taskWorkspace, mergeApprovals } = build({ approved: true });

        const outcome = await service.onPullRequestStatusRefreshed(task(), status());

        expect(mergeApprovals.verifyMergeApproval).toHaveBeenCalledWith({
            taskId: 'task-1',
            prNumber: 7,
            headSha: HEAD,
        });
        expect(taskWorkspace.attemptMergeForOpenPullRequest).toHaveBeenCalledWith({
            task: expect.objectContaining({ id: 'task-1' }),
            agentId: 'agent-1',
            gateStatus: 'green',
            // The head read LIVE moments ago, forwarded so the refusal
            // record can be keyed by it and told to the human once rather
            // than on every two-minute sweep. Never an input to the
            // decision — the facade re-reads and pins the head itself.
            headSha: HEAD,
        });
        expect(outcome).toEqual({
            action: 'merge-attempted',
            merge: { attempted: true, merged: true },
        });
        // The approved action is EXECUTED, not merely recorded. Before this
        // slice nothing in the platform ever read `status === 'approved'`.
        expect(mergeApprovals.requestMergeApproval).not.toHaveBeenCalled();
    });

    it('merges without an approval only when the policy asked for none', async () => {
        const { service, taskWorkspace, mergeApprovals } = build({
            policy: { ...NEEDS_APPROVAL, requireHumanApproval: false },
        });
        await service.onPullRequestStatusRefreshed(task(), status());
        expect(mergeApprovals.verifyMergeApproval).not.toHaveBeenCalled();
        expect(mergeApprovals.requestMergeApproval).not.toHaveBeenCalled();
        expect(taskWorkspace.attemptMergeForOpenPullRequest).toHaveBeenCalledTimes(1);
    });

    // ── everything that stops it ──────────────────────────────────────

    it.each([
        ['draft', { state: 'draft' }, 'pr-draft'],
        ['closed', { state: 'closed' }, 'pr-closed'],
        ['already merged', { state: 'merged' }, 'pr-merged'],
        ['failing CI', { ciState: 'failing' }, 'ci-failing'],
        ['pending CI', { ciState: 'pending' }, 'ci-pending'],
        ['unknown CI', { ciState: 'unknown' }, 'ci-unknown'],
        ['no head commit', { headSha: null }, 'head-sha-unknown'],
    ] as const)('does nothing for %s', async (_label, over, reason) => {
        const { service, mergeApprovals, taskWorkspace } = build();
        await expect(service.onPullRequestStatusRefreshed(task(), status(over))).resolves.toEqual({
            action: 'skipped',
            reason,
        });
        expect(mergeApprovals.requestMergeApproval).not.toHaveBeenCalled();
        expect(taskWorkspace.attemptMergeForOpenPullRequest).not.toHaveBeenCalled();
    });

    it('does not ask a human for permission the policy could never use', async () => {
        // `allowAgentMerge: false` is the shipped default. An approval
        // raised under it would be an Inbox item whose Approve button does
        // nothing.
        const { service, mergeApprovals } = build({
            policy: { ...NEEDS_APPROVAL, allowAgentMerge: false },
        });
        await expect(service.onPullRequestStatusRefreshed(task(), status())).resolves.toEqual({
            action: 'skipped',
            reason: 'agent-merge-disabled',
        });
        expect(mergeApprovals.requestMergeApproval).not.toHaveBeenCalled();
    });

    it('stands down for a Task with no Agent — nobody to attribute the merge to', async () => {
        const { service, mergeApprovals } = build();
        await expect(
            service.onPullRequestStatusRefreshed(task({ agentId: null }), status()),
        ).resolves.toEqual({ action: 'skipped', reason: 'no-agent' });
        expect(mergeApprovals.requestMergeApproval).not.toHaveBeenCalled();
    });

    it('stands down for a Task with no pull request', async () => {
        const { service } = build();
        await expect(
            service.onPullRequestStatusRefreshed(task({ prNumber: null }), status()),
        ).resolves.toEqual({ action: 'skipped', reason: 'no-pull-request' });
    });

    it('stands down when the Work is unreadable', async () => {
        const { service, works } = build();
        works.findById.mockResolvedValue(null);
        await expect(service.onPullRequestStatusRefreshed(task(), status())).resolves.toEqual({
            action: 'skipped',
            reason: 'no-work',
        });
    });

    it('never merges and never raises when the verifier is unbound', async () => {
        const works = {
            findById: jest.fn().mockResolvedValue({
                id: 'work-1',
                getRepoOwner: () => 'acme',
                getDataRepo: () => 'site-data',
            }),
        };
        const mergePolicy = {
            resolve: jest
                .fn()
                .mockResolvedValue({ policy: NEEDS_APPROVAL, source: 'work', chain: [] }),
        };
        const taskWorkspace = { attemptMergeForOpenPullRequest: jest.fn() };
        const service = new TaskMergeGateService(
            works as never,
            mergePolicy as never,
            taskWorkspace as never,
        );
        await expect(service.onPullRequestStatusRefreshed(task(), status())).resolves.toEqual({
            action: 'skipped',
            reason: 'no-approval-verifier',
        });
        expect(taskWorkspace.attemptMergeForOpenPullRequest).not.toHaveBeenCalled();
    });

    // ── it can never break the sweep that calls it ────────────────────

    it('swallows a thrown collaborator — a status refresh must not fail on the gate', async () => {
        const { service, mergePolicy } = build();
        mergePolicy.resolve.mockRejectedValue(new Error('db down'));
        await expect(service.onPullRequestStatusRefreshed(task(), status())).resolves.toEqual({
            action: 'skipped',
            reason: 'evaluation-failed',
        });
    });

    it('a failed merge attempt is reported, not thrown', async () => {
        const { service, taskWorkspace } = build({ approved: true });
        taskWorkspace.attemptMergeForOpenPullRequest.mockResolvedValue({
            attempted: true,
            merged: false,
            refusalCode: 'protected-branch',
        });
        await expect(service.onPullRequestStatusRefreshed(task(), status())).resolves.toEqual({
            action: 'merge-attempted',
            merge: { attempted: true, merged: false, refusalCode: 'protected-branch' },
        });
    });
});
