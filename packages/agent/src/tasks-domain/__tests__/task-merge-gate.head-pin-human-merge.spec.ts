import type { MergePolicy } from '@ever-works/contracts';
import {
    TaskMergeGateService,
    pullRequestHeadMismatch,
    pullRequestHeadRepoMismatch,
} from '../task-merge-gate.service';
import { APP_HUMAN_MERGE_PATHS_ENV } from '../app-work-change-gate.port';

/**
 * Works-security (2026-10-18) — two merge-gate narrowings.
 *
 *   - Item 7b: the pull request is merged by NUMBER after every gate judged the
 *     Task's BRANCH, so a live head branch (or head repository) that is not the
 *     Task's stops the merge before any approval is raised.
 *   - Item 5: a change to a path the App spec reserves for a person
 *     (`agents.requireHumanMergePaths`) is never merged on green CI alone,
 *     whatever the merge policy says.
 */
describe('TaskMergeGateService — head pin and human-merge paths', () => {
    const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

    const NO_APPROVAL_NEEDED: MergePolicy = {
        allowAgentMerge: true,
        requireGreenGate: true,
        requireHumanApproval: false,
        allowedMergeMethods: ['squash'],
        protectedBranches: [],
    };

    const task = (over: Record<string, unknown> = {}) =>
        ({
            id: 'task-1',
            userId: 'owner-1',
            slug: 'T-42',
            workId: 'work-1',
            agentId: 'agent-1',
            prNumber: 7,
            prUrl: 'https://github.com/acme/shop/pull/7',
            branchRef: 'task/t-42',
            labels: [],
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

    function build(over: { appVerdict?: unknown; approved?: boolean } = {}) {
        const works = {
            findById: jest.fn().mockResolvedValue({
                id: 'work-1',
                organizationId: null,
                tenantId: null,
                // Not a floor branch, so only the rule under test can raise an approval.
                taskIsolationBaseBranch: 'feature/base',
                getRepoOwner: () => 'acme',
                getDataRepo: () => 'shop',
            }),
        };
        const mergePolicy = {
            resolve: jest.fn().mockResolvedValue({
                policy: NO_APPROVAL_NEEDED,
                source: 'work',
                chain: [],
            }),
        };
        const taskWorkspace = {
            judgeAppWorkMerge: jest.fn().mockResolvedValue(over.appVerdict ?? null),
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
        return { service, taskWorkspace, mergeApprovals };
    }

    const previous = process.env[APP_HUMAN_MERGE_PATHS_ENV];
    afterEach(() => {
        if (previous === undefined) delete process.env[APP_HUMAN_MERGE_PATHS_ENV];
        else process.env[APP_HUMAN_MERGE_PATHS_ENV] = previous;
    });

    // ── item 7b ──────────────────────────────────────────────────────

    it('refuses a pull request whose live head branch is not the Task branch', async () => {
        const { service, taskWorkspace, mergeApprovals } = build();
        const outcome = await service.onPullRequestStatusRefreshed(
            task(),
            status({ headRef: 'someone-else' }),
        );
        expect(outcome).toEqual({ action: 'skipped', reason: 'pr-head-ref-mismatch' });
        expect(taskWorkspace.attemptMergeForOpenPullRequest).not.toHaveBeenCalled();
        expect(mergeApprovals.requestMergeApproval).not.toHaveBeenCalled();
    });

    it('control: the same head branch merges on this policy', async () => {
        const { service, taskWorkspace } = build();
        const outcome = await service.onPullRequestStatusRefreshed(
            task(),
            status({ headRef: 'task/t-42' }),
        );
        expect(outcome.action).toBe('merge-attempted');
        expect(taskWorkspace.attemptMergeForOpenPullRequest).toHaveBeenCalledTimes(1);
    });

    it('pure helpers compare only what both sides know', () => {
        expect(pullRequestHeadMismatch({ branchRef: 'a' }, { headRef: 'a' })).toBeNull();
        expect(pullRequestHeadMismatch({ branchRef: 'refs/heads/a' }, { headRef: 'a' })).toBeNull();
        expect(pullRequestHeadMismatch({ branchRef: 'a' }, { headRef: 'b' })).toMatch(/not the Task's branch/);
        expect(pullRequestHeadMismatch({ branchRef: null }, { headRef: 'b' })).toBeNull();
        expect(pullRequestHeadMismatch({ branchRef: 'a' }, {})).toBeNull();
        expect(pullRequestHeadRepoMismatch('acme/shop', { headRepoFullName: 'ACME/Shop' })).toBeNull();
        expect(pullRequestHeadRepoMismatch('acme/shop', { headRepoFullName: 'evil/shop' })).toMatch(
            /evil\/shop/,
        );
        expect(pullRequestHeadRepoMismatch(null, { headRepoFullName: 'evil/shop' })).toBeNull();
        expect(pullRequestHeadRepoMismatch('acme/shop', { headRepoFullName: null })).toBeNull();
    });

    // ── item 5 ───────────────────────────────────────────────────────

    it('raises a human approval for a change to a human-merge path, whatever the policy says', async () => {
        const { service, taskWorkspace, mergeApprovals } = build({
            appVerdict: { allowed: true, humanMergePaths: ['db/migrations/001.sql'] },
        });
        const outcome = await service.onPullRequestStatusRefreshed(task(), status());
        expect(outcome).toEqual({ action: 'approval-requested', proposalId: 'p-new' });
        expect(taskWorkspace.attemptMergeForOpenPullRequest).not.toHaveBeenCalled();
    });

    it('once a person approved, merges with the approval requirement RAISED in the facade', async () => {
        const { service, taskWorkspace } = build({
            appVerdict: { allowed: true, humanMergePaths: ['db/migrations/001.sql'] },
            approved: true,
        });
        await service.onPullRequestStatusRefreshed(task(), status());
        expect(taskWorkspace.attemptMergeForOpenPullRequest).toHaveBeenCalledWith(
            expect.objectContaining({ requireHumanApproval: true, headSha: HEAD }),
        );
    });

    it('control: an App Work change with no human-merge path merges on this policy', async () => {
        const { service, taskWorkspace, mergeApprovals } = build({ appVerdict: { allowed: true } });
        const outcome = await service.onPullRequestStatusRefreshed(task(), status());
        expect(outcome.action).toBe('merge-attempted');
        expect(mergeApprovals.requestMergeApproval).not.toHaveBeenCalled();
        expect(taskWorkspace.attemptMergeForOpenPullRequest).toHaveBeenCalledTimes(1);
    });

    it('APP_HUMAN_MERGE_PATHS_ENFORCED=false restores the policy-only answer', async () => {
        process.env[APP_HUMAN_MERGE_PATHS_ENV] = 'false';
        const { service, taskWorkspace } = build({
            appVerdict: { allowed: true, humanMergePaths: ['db/migrations/001.sql'] },
        });
        const outcome = await service.onPullRequestStatusRefreshed(task(), status());
        expect(outcome.action).toBe('merge-attempted');
        expect(taskWorkspace.attemptMergeForOpenPullRequest).toHaveBeenCalledTimes(1);
    });
});
