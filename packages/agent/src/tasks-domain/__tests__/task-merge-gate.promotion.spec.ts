import type { MergePolicy } from '@ever-works/contracts';
import { PROMOTION_TASK_LABEL } from '@ever-works/contracts';
import { TaskMergeGateService } from '../task-merge-gate.service';

/**
 * Release promotion lane (self-build slice AI, EW-808) × merge approval
 * (slice AE) — the ONE integration point, from the merge gate's side.
 *
 * The property this file exists for: a promotion pull request goes
 * through the SAME approval path as every other agent merge, and the
 * promotion guard can only ever make that path NARROWER.
 *
 * So the assertions come in pairs. For a non-promotion Task, nothing
 * changes. For a promotion Task, every non-`success` gate reading stops
 * the gate BEFORE `requestMergeApproval` — because raising an approval on
 * a gate that skipped itself would show a human an Approve button next to
 * a green badge the platform manufactured.
 */
describe('TaskMergeGateService — promotion Tasks', () => {
    const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

    const NEEDS_APPROVAL: MergePolicy = {
        allowAgentMerge: true,
        requireGreenGate: true,
        requireHumanApproval: true,
        allowedMergeMethods: ['squash'],
        protectedBranches: ['main'],
    };

    const NO_APPROVAL_NEEDED: MergePolicy = { ...NEEDS_APPROVAL, requireHumanApproval: false };

    /**
     * What the guard says about a promotion that MAY proceed.
     *
     * It carries the promotion's own branches and pull request, because
     * the merge path's default answer to "what is this pull request's
     * base?" is the Work's `taskIsolationBaseBranch` — right for every
     * Task pull request and wrong for every promotion.
     */
    const ALLOWED = {
        promotion: true,
        allowed: true,
        promotionId: 'rp-1',
        headBranch: 'stage',
        baseBranch: 'main',
        prNumber: 7,
    } as const;

    const task = (over: Record<string, unknown> = {}) =>
        ({
            id: 'task-1',
            userId: 'owner-1',
            slug: 'T-42',
            workId: 'work-1',
            agentId: 'agent-1',
            prNumber: 7,
            prUrl: 'https://github.com/ever-works/ever-works/pull/7',
            labels: [PROMOTION_TASK_LABEL, 'release:promotion:stage-to-main'],
            ...over,
        }) as never;

    const status = (over: Record<string, unknown> = {}) =>
        ({
            number: 7,
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
            guard?: { assessPromotionForMerge: jest.Mock } | null;
            work?: Record<string, unknown>;
        } = {},
    ) {
        const works = {
            findById: jest.fn().mockResolvedValue({
                id: 'work-1',
                organizationId: null,
                tenantId: null,
                taskIsolationBaseBranch: 'main',
                getRepoOwner: () => 'ever-works',
                getDataRepo: () => 'ever-works',
                ...over.work,
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
        const guard =
            over.guard === null
                ? undefined
                : (over.guard ?? {
                      assessPromotionForMerge: jest.fn().mockResolvedValue(ALLOWED),
                  });
        const service = new TaskMergeGateService(
            works as never,
            mergePolicy as never,
            taskWorkspace as never,
            mergeApprovals as never,
            guard as never,
        );
        return { service, works, mergePolicy, taskWorkspace, mergeApprovals, guard };
    }

    // ── The promotion still needs a human ─────────────────────────────

    it('raises the SAME merge_pull_request approval for a green promotion — it does not merge it', async () => {
        const { service, mergeApprovals, taskWorkspace } = build();

        const outcome = await service.onPullRequestStatusRefreshed(task(), status());

        expect(outcome).toEqual({ action: 'approval-requested', proposalId: 'p-new' });
        expect(mergeApprovals.requestMergeApproval).toHaveBeenCalledWith(
            expect.objectContaining({ taskId: 'task-1', prNumber: 7, headSha: HEAD }),
        );
        // A passing promotion gate is permission to ASK, never to merge.
        expect(taskWorkspace.attemptMergeForOpenPullRequest).not.toHaveBeenCalled();
    });

    it('merges a promotion only once a human approval verifies for THIS head', async () => {
        const { service, taskWorkspace, mergeApprovals } = build({ approved: true });

        const outcome = await service.onPullRequestStatusRefreshed(task(), status());

        expect(outcome).toMatchObject({ action: 'merge-attempted' });
        expect(mergeApprovals.verifyMergeApproval).toHaveBeenCalledWith({
            taskId: 'task-1',
            prNumber: 7,
            headSha: HEAD,
        });
        expect(taskWorkspace.attemptMergeForOpenPullRequest).toHaveBeenCalledWith(
            expect.objectContaining({ agentId: 'agent-1', gateStatus: 'green', headSha: HEAD }),
        );
    });

    // ── The promotion's OWN base branch, everywhere it is used ────────

    it('shows the human the branch the promotion actually merges INTO, not the Work default', async () => {
        // The Work's `taskIsolationBaseBranch` is `develop` in the only
        // configuration this lane can run in (operators remove `develop`
        // from `protectedBranches` so Task pull requests can land there).
        // A `stage -> main` promotion described as "into develop" is
        // approved as one thing and merged as another.
        const { service, mergeApprovals } = build({
            work: { taskIsolationBaseBranch: 'develop' },
        });

        await service.onPullRequestStatusRefreshed(task(), status());

        expect(mergeApprovals.requestMergeApproval).toHaveBeenCalledWith(
            expect.objectContaining({ targetBranch: 'main' }),
        );
    });

    it('hands the merge path the promotion’s base, so the protected-branch rule sees `main`', async () => {
        // `git.facade` uses `agentActor.targetBranch` verbatim and only
        // reads the pull request's real base when it is ABSENT — so a
        // wrong value here means `canAgentMerge` evaluates a branch that
        // is not being merged into, and the `protected-branch` refusal
        // never fires for a promotion into production.
        const { service, taskWorkspace } = build({
            approved: true,
            work: { taskIsolationBaseBranch: 'develop' },
        });

        await service.onPullRequestStatusRefreshed(task(), status());

        expect(taskWorkspace.attemptMergeForOpenPullRequest).toHaveBeenCalledWith(
            expect.objectContaining({ baseRef: 'main', requireHumanApproval: true }),
        );
    });

    it('leaves an ordinary Task’s base branch exactly as it was', async () => {
        const guard = {
            assessPromotionForMerge: jest.fn().mockResolvedValue({ promotion: false }),
        };
        const { service, mergeApprovals, taskWorkspace } = build({
            guard,
            approved: true,
            work: { taskIsolationBaseBranch: 'develop' },
        });

        await service.onPullRequestStatusRefreshed(task({ labels: ['chore'] }), status());

        expect(taskWorkspace.attemptMergeForOpenPullRequest).toHaveBeenCalledWith(
            expect.objectContaining({ baseRef: null, requireHumanApproval: false }),
        );
        expect(mergeApprovals.verifyMergeApproval).toHaveBeenCalled();
    });

    // ── A promotion ALWAYS needs a human ──────────────────────────────

    it('never merges a promotion under a policy that needs no approval — it asks anyway', async () => {
        // THE property this slice exists for, on the ALLOWING side.
        // `requireHumanApproval: false` is a legitimate operator choice
        // for ordinary agent work; it is not a choice about releases. A
        // promotion that landed here with no Inbox proposal and no human
        // identity would be exactly the automatic cascade the brief
        // forbids.
        const { service, taskWorkspace, mergeApprovals } = build({
            policy: NO_APPROVAL_NEEDED,
        });

        const outcome = await service.onPullRequestStatusRefreshed(task(), status());

        expect(outcome).toEqual({ action: 'approval-requested', proposalId: 'p-new' });
        expect(taskWorkspace.attemptMergeForOpenPullRequest).not.toHaveBeenCalled();
        expect(mergeApprovals.requestMergeApproval).toHaveBeenCalled();
    });

    it('merges a promotion under that policy only after a human approval verifies', async () => {
        const { service, taskWorkspace, mergeApprovals } = build({
            policy: NO_APPROVAL_NEEDED,
            approved: true,
        });

        const outcome = await service.onPullRequestStatusRefreshed(task(), status());

        expect(outcome).toMatchObject({ action: 'merge-attempted' });
        expect(mergeApprovals.verifyMergeApproval).toHaveBeenCalled();
        // And the facade is told to keep the requirement, so the property
        // does not rest on this service alone.
        expect(taskWorkspace.attemptMergeForOpenPullRequest).toHaveBeenCalledWith(
            expect.objectContaining({ requireHumanApproval: true }),
        );
    });

    it('still lets an ORDINARY Task merge without an approval under that policy', async () => {
        // The narrowing is for promotions only; the operator's choice for
        // everything else is untouched.
        const guard = {
            assessPromotionForMerge: jest.fn().mockResolvedValue({ promotion: false }),
        };
        const { service, taskWorkspace, mergeApprovals } = build({
            policy: NO_APPROVAL_NEEDED,
            guard,
        });

        const outcome = await service.onPullRequestStatusRefreshed(
            task({ labels: ['chore'] }),
            status(),
        );

        expect(outcome).toMatchObject({ action: 'merge-attempted' });
        expect(mergeApprovals.requestMergeApproval).not.toHaveBeenCalled();
    });

    // ── The narrowing ─────────────────────────────────────────────────

    it.each([
        ['promotion-gate-not-success', 'promotion-gate.yml for … : skipped'],
        ['promotion-gate-stale', 'no verdict for this commit'],
        ['promotion-not-open', 'the promotion is merged'],
        ['promotion-row-missing', 'no promotion record resolves'],
    ])('stops BEFORE the approval when the guard refuses with %s', async (code, reason) => {
        const guard = {
            assessPromotionForMerge: jest
                .fn()
                .mockResolvedValue({ promotion: true, allowed: false, code, reason }),
        };
        const { service, mergeApprovals, taskWorkspace } = build({ guard });

        const outcome = await service.onPullRequestStatusRefreshed(task(), status());

        expect(outcome).toEqual({ action: 'skipped', reason: code });
        // Neither half of the merge path is reached: no Inbox ask, no merge.
        expect(mergeApprovals.requestMergeApproval).not.toHaveBeenCalled();
        expect(mergeApprovals.verifyMergeApproval).not.toHaveBeenCalled();
        expect(taskWorkspace.attemptMergeForOpenPullRequest).not.toHaveBeenCalled();
    });

    it('refuses a refused promotion even under a policy that needs no approval', async () => {
        // The most dangerous combination: an operator who turned approvals
        // off for the scope. The promotion gate still holds.
        const guard = {
            assessPromotionForMerge: jest.fn().mockResolvedValue({
                promotion: true,
                allowed: false,
                code: 'promotion-gate-not-success',
                reason: 'absent',
            }),
        };
        const { service, taskWorkspace } = build({ policy: NO_APPROVAL_NEEDED, guard });

        const outcome = await service.onPullRequestStatusRefreshed(task(), status());

        expect(outcome).toEqual({ action: 'skipped', reason: 'promotion-gate-not-success' });
        expect(taskWorkspace.attemptMergeForOpenPullRequest).not.toHaveBeenCalled();
    });

    it('asks the guard about the LIVE head and the pull request it is about to merge', async () => {
        const guard = {
            assessPromotionForMerge: jest.fn().mockResolvedValue(ALLOWED),
        };
        const { service } = build({ guard });

        await service.onPullRequestStatusRefreshed(task(), status({ headSha: HEAD.toUpperCase() }));

        expect(guard.assessPromotionForMerge).toHaveBeenCalledWith({
            taskId: 'task-1',
            labels: [PROMOTION_TASK_LABEL, 'release:promotion:stage-to-main'],
            // Named so a verdict recorded for the promotion's pull request
            // cannot authorise the merge of one that later took over
            // `tasks.prNumber`.
            prNumber: 7,
            headSha: HEAD,
        });
    });

    // ── Fail closed ───────────────────────────────────────────────────

    it('refuses a promotion Task when NO guard is bound, without needing one', async () => {
        // A deployment that cannot evaluate promotions must not merge them
        // through the ordinary agent path. The refusal is read off the
        // Task's own labels precisely so it does not depend on the service
        // that is missing.
        const { service, mergeApprovals, taskWorkspace } = build({ guard: null });

        const outcome = await service.onPullRequestStatusRefreshed(task(), status());

        expect(outcome).toEqual({ action: 'skipped', reason: 'promotion-guard-unbound' });
        expect(mergeApprovals.requestMergeApproval).not.toHaveBeenCalled();
        expect(taskWorkspace.attemptMergeForOpenPullRequest).not.toHaveBeenCalled();
    });

    it('treats a THROWING guard as a refusal, not as a pass', async () => {
        const guard = {
            assessPromotionForMerge: jest.fn().mockRejectedValue(new Error('db down')),
        };
        const { service, mergeApprovals } = build({ guard });

        const outcome = await service.onPullRequestStatusRefreshed(task(), status());

        expect(outcome).toEqual({ action: 'skipped', reason: 'promotion-guard-failed' });
        expect(mergeApprovals.requestMergeApproval).not.toHaveBeenCalled();
    });

    // ── No effect on anything else ────────────────────────────────────

    it('leaves an ordinary Task completely unchanged when the guard says "not a promotion"', async () => {
        const guard = {
            assessPromotionForMerge: jest.fn().mockResolvedValue({ promotion: false }),
        };
        const { service, mergeApprovals } = build({ guard });

        const outcome = await service.onPullRequestStatusRefreshed(
            task({ labels: ['chore'] }),
            status(),
        );

        expect(outcome).toEqual({ action: 'approval-requested', proposalId: 'p-new' });
        expect(mergeApprovals.requestMergeApproval).toHaveBeenCalled();
    });

    it('leaves an ordinary Task unchanged when NO guard is bound', async () => {
        const { service, mergeApprovals } = build({ guard: null });

        const outcome = await service.onPullRequestStatusRefreshed(
            task({ labels: null }),
            status(),
        );

        expect(outcome).toEqual({ action: 'approval-requested', proposalId: 'p-new' });
        expect(mergeApprovals.requestMergeApproval).toHaveBeenCalled();
    });

    it('never consults the guard for a promotion the ordinary gate already refused', async () => {
        // Ordering matters only for cost, not for safety — but a red
        // promotion must not cause a provider read either.
        const guard = {
            assessPromotionForMerge: jest.fn().mockResolvedValue({ promotion: false }),
        };
        const { service } = build({ guard });

        await service.onPullRequestStatusRefreshed(task(), status({ ciState: 'failing' }));
        await service.onPullRequestStatusRefreshed(task(), status({ checksComplete: false }));
        await service.onPullRequestStatusRefreshed(task(), status({ state: 'draft' }));

        expect(guard.assessPromotionForMerge).not.toHaveBeenCalled();
    });
});
