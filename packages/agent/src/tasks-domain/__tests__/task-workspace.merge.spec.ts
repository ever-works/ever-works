import { TaskWorkspaceService } from '../task-workspace.service';
import { MergePolicyRefusedError } from '../../facades/git.facade';
import { ActivityActionType, ActivityStatus } from '../../entities/activity-log.types';
import type { MergeDecision, MergePolicy, ResolvedMergePolicy } from '@ever-works/contracts';

/**
 * Merge-policy matrix (Wave 3, founder decision D4) — the AGENT-MERGE
 * PATH.
 *
 * Before this landed, `GitFacadeService.mergePullRequest` had no
 * production caller and `AgentMergeActor` was never constructed: the
 * whole matrix governed an action that could not occur. These specs pin
 * the two properties that make it real and keep it safe —
 *
 *   1. with the SHIPPED DEFAULT (`allowAgentMerge: false`) nothing is
 *      attempted and nothing is said, so no existing deployment changes
 *      behaviour by upgrading; and
 *   2. once someone opts in, every refusal is RECORDED — task chat plus
 *      an activity row carrying the stable refusal code — rather than
 *      swallowed into a log line nobody reads.
 */
describe('TaskWorkspaceService — agent merge path (Wave 3 D4)', () => {
    const PERMISSIVE: MergePolicy = {
        allowAgentMerge: true,
        requireGreenGate: true,
        requireHumanApproval: false,
        allowedMergeMethods: ['squash'],
        protectedBranches: ['main'],
    };

    const CONSERVATIVE: MergePolicy = {
        allowAgentMerge: false,
        requireGreenGate: true,
        requireHumanApproval: true,
        allowedMergeMethods: ['squash'],
        protectedBranches: ['main', 'master', 'develop', 'stage'],
    };

    const makeWork = (overrides: Record<string, unknown> = {}) => ({
        id: 'work-1',
        organizationId: 'org-1',
        tenantId: 'tenant-1',
        gitProvider: 'github',
        taskIsolation: 'worktree',
        taskIsolationBaseBranch: 'release',
        taskIsolationTargetRepo: 'work-output',
        taskBranchCleanup: 'on-merge',
        getRepoOwner: () => 'acme',
        getDataRepo: () => 'site-data',
        ...overrides,
    });

    const makeTask = () =>
        ({
            id: '123e4567-e89b-12d3-a456-426614174000',
            slug: 't-42',
            title: 'Ship the thing',
            workId: 'work-1',
            userId: 'user-1',
            branchRef: 'task/t-42-123e4567',
            branchState: 'pushed',
        }) as any;

    const workspace = {
        cwd: '/ws/task',
        branch: 'task/t-42-123e4567',
        baseSha: 'abc123def456',
        reused: false,
        provider: 'workspace',
    };

    let works: { findById: jest.Mock };
    let tasks: { updateById: jest.Mock; findById: jest.Mock; recordMergeRefusal: jest.Mock };
    let runs: { setWorkspaceMeta: jest.Mock };
    let workspaceFacade: { finalize: jest.Mock; simulateMerge: jest.Mock; provision: jest.Mock };
    let gitFacade: {
        getRepository: jest.Mock;
        createPullRequest: jest.Mock;
        mergePullRequest: jest.Mock;
    };
    let transitions: { transition: jest.Mock };
    let taskChat: { post: jest.Mock };
    let mergePolicy: { resolve: jest.Mock };
    let activityLog: { log: jest.Mock };

    const resolution = (policy: MergePolicy, source: ResolvedMergePolicy['source'] = 'work') => ({
        policy,
        source,
        chain: [
            { scope: 'default' as const, id: null, fields: [] },
            { scope: 'work' as const, id: 'work-1', fields: ['allowAgentMerge'] as never },
        ],
    });

    const build = () =>
        new TaskWorkspaceService(
            works as any,
            tasks as any,
            runs as any,
            workspaceFacade as any,
            gitFacade as any,
            transitions as any,
            taskChat as any,
            mergePolicy as any,
            activityLog as any,
        );

    const finalizeInput = (overrides: Record<string, unknown> = {}) => ({
        task: makeTask(),
        userId: 'user-1',
        agentId: 'agent-1',
        agentCanOpenPullRequests: true,
        workspace,
        gateStatus: 'green' as const,
        ...overrides,
    });

    beforeEach(() => {
        works = { findById: jest.fn().mockResolvedValue(makeWork()) };
        tasks = {
            updateById: jest.fn().mockResolvedValue(undefined),
            findById: jest.fn().mockResolvedValue(makeTask()),
            recordMergeRefusal: jest.fn().mockResolvedValue(undefined),
        };
        runs = { setWorkspaceMeta: jest.fn() };
        workspaceFacade = {
            provision: jest.fn(),
            finalize: jest
                .fn()
                .mockResolvedValue({ pushed: true, headSha: 'cafe42', empty: false }),
            simulateMerge: jest.fn().mockResolvedValue({ clean: true, conflictPaths: [] }),
        };
        gitFacade = {
            getRepository: jest.fn().mockResolvedValue({
                defaultBranch: 'main',
                cloneUrl: 'https://github.com/acme/site-data.git',
            }),
            createPullRequest: jest.fn().mockResolvedValue({
                number: 7,
                url: 'https://github.com/acme/site-data/pull/7',
            }),
            mergePullRequest: jest.fn().mockResolvedValue({ merged: true, sha: 'deadbeef' }),
        };
        transitions = { transition: jest.fn().mockResolvedValue(undefined) };
        taskChat = { post: jest.fn().mockResolvedValue(undefined) };
        mergePolicy = { resolve: jest.fn().mockResolvedValue(resolution(PERMISSIVE)) };
        activityLog = { log: jest.fn().mockResolvedValue(undefined) };
    });

    const refuse = (decision: MergeDecision) => {
        gitFacade.mergePullRequest.mockRejectedValue(
            new MergePolicyRefusedError(decision, 'github'),
        );
    };

    /**
     * CONTRACT REVERSAL (AE review). Every assertion below used to drive
     * the merge through `finalizeRun` — i.e. from PULL-REQUEST-OPEN time,
     * milliseconds after `createPullRequest`. Nothing merges from there
     * any more, under ANY policy, because nothing CAN be judged there: a
     * branch pushed one second ago has no check runs, so "is this pull
     * request green?" has no answer yet. An intermediate revision of this
     * slice kept the old behaviour for operators with
     * `requireHumanApproval: false`, and it merged pull requests before a
     * single check had started — while the post-CI gate, on the same
     * policy, waited for green. Those operators opted out of a PERSON,
     * not out of CI.
     *
     * The merge path itself is unchanged and is still exactly one method;
     * this helper is the entry point the post-CI gate uses, so the
     * assertions are about the same code as before.
     */
    const openPrTask = (overrides: Record<string, unknown> = {}) =>
        ({ ...makeTask(), prNumber: 7, prUrl: 'https://x/pull/7', ...overrides }) as never;

    const mergeNow = (
        over: { task?: unknown; gateStatus?: 'green' | 'red' | null; headSha?: string | null } = {},
    ) =>
        build().attemptMergeForOpenPullRequest({
            task: (over.task ?? openPrTask()) as never,
            agentId: 'agent-1',
            gateStatus: over.gateStatus ?? 'green',
            ...('headSha' in over ? { headSha: over.headSha } : {}),
        });

    // ── 1. The permissive path actually merges ────────────────────────

    it('merges an open pull request when the resolved policy allows it', async () => {
        const outcome = await mergeNow();

        expect(outcome).toEqual(
            expect.objectContaining({
                attempted: true,
                merged: true,
                mergeMethod: 'squash',
                sha: 'deadbeef',
            }),
        );
        expect(gitFacade.mergePullRequest).toHaveBeenCalledTimes(1);
    });

    it('constructs the AgentMergeActor from the real run context', async () => {
        await mergeNow();

        const [owner, repo, prNumber, mergeOptions, options, actor] =
            gitFacade.mergePullRequest.mock.calls[0];
        expect(owner).toBe('acme');
        expect(repo).toBe('site-data');
        expect(prNumber).toBe(7);
        expect(mergeOptions).toEqual({ mergeMethod: 'squash' });
        expect(options).toEqual(
            expect.objectContaining({ userId: 'user-1', providerId: 'github', workId: 'work-1' }),
        );
        // CONTRACT REVERSAL (merge approval, slice AE). This assertion used
        // to include `humanApproved: false` — the hardcoded literal this
        // slice removes. The claim was genuinely wrong: an ASKER cannot
        // answer "did a human approve this?", and because the literal was
        // always false, a policy with `requireHumanApproval: true` (the
        // shipped default) refused every agent merge forever with no way
        // for anyone to say yes.
        //
        // What replaces it is `taskId`: the actor now names WHICH merge
        // this is, and `GitFacadeService` looks the approval up itself
        // against the live head commit.
        expect(actor).toEqual({
            agentId: 'agent-1',
            workId: 'work-1',
            organizationId: 'org-1',
            tenantId: 'tenant-1',
            gateStatus: 'green',
            taskId: '123e4567-e89b-12d3-a456-426614174000',
            // The Work's configured base branch, not the repo default —
            // the protected-branch rule is worthless against the wrong one.
            targetBranch: 'release',
        });
    });

    it('requests the most-preferred method the policy allows, never a method it forbids', async () => {
        mergePolicy.resolve.mockResolvedValue(
            resolution({ ...PERMISSIVE, allowedMergeMethods: ['rebase', 'squash'] }),
        );
        await mergeNow();
        expect(gitFacade.mergePullRequest.mock.calls[0][3]).toEqual({ mergeMethod: 'rebase' });
    });

    it('records a landed merge to task chat and the activity log, and flips branchState', async () => {
        await mergeNow();

        expect(taskChat.post).toHaveBeenCalledWith(
            'user-1',
            expect.objectContaining({ body: expect.stringContaining('Merged PR #7') }),
        );
        expect(tasks.updateById).toHaveBeenCalledWith(
            '123e4567-e89b-12d3-a456-426614174000',
            expect.objectContaining({ branchState: 'merged' }),
        );
        expect(activityLog.log).toHaveBeenCalledWith(
            expect.objectContaining({
                actionType: ActivityActionType.TASK_MERGED,
                status: ActivityStatus.COMPLETED,
                details: expect.objectContaining({
                    prNumber: 7,
                    mergeMethod: 'squash',
                    policySource: 'work',
                    sha: 'deadbeef',
                }),
            }),
        );
    });

    // ── 2. The conservative default changes nothing ───────────────────

    it('attempts NOTHING and says nothing under the shipped platform default', async () => {
        mergePolicy.resolve.mockResolvedValue(resolution(CONSERVATIVE, 'default'));

        const result = await build().finalizeRun(finalizeInput());

        expect(result.outcome).toBe('pr-opened');
        expect(result.merge).toEqual({
            attempted: false,
            merged: false,
            policySource: 'default',
        });
        expect(gitFacade.mergePullRequest).not.toHaveBeenCalled();
        // The silence is the point: no chat noise, no activity row on the
        // path every existing deployment takes.
        expect(taskChat.post).not.toHaveBeenCalled();
        expect(activityLog.log).not.toHaveBeenCalled();
    });

    it('does not attempt a merge when the policy read itself fails', async () => {
        mergePolicy.resolve.mockRejectedValue(new Error('db down'));
        const result = await build().finalizeRun(finalizeInput());
        expect(result.merge).toEqual({ attempted: false, merged: false });
        expect(gitFacade.mergePullRequest).not.toHaveBeenCalled();
    });

    it('leaves the PR open and never throws when the merge policy is unbound', async () => {
        const svc = new TaskWorkspaceService(
            works as any,
            tasks as any,
            runs as any,
            workspaceFacade as any,
            gitFacade as any,
            transitions as any,
            taskChat as any,
        );
        const result = await svc.finalizeRun(finalizeInput());
        expect(result.outcome).toBe('pr-opened');
        expect(result.merge).toBeUndefined();
        expect(gitFacade.mergePullRequest).not.toHaveBeenCalled();
    });

    // ── 3. Every refusal code surfaces with its reason ────────────────

    const REFUSALS: Array<{ code: NonNullable<MergeDecision['code']>; reason: string }> = [
        { code: 'agent-merge-disabled', reason: 'Agent merges are disabled by the policy.' },
        { code: 'protected-branch', reason: "Branch 'release' is protected." },
        { code: 'target-branch-unknown', reason: 'The target branch could not be determined.' },
        { code: 'merge-method-not-allowed', reason: "Merge method 'squash' is not allowed." },
        { code: 'gate-not-green', reason: "The gate status is 'red'." },
        { code: 'human-approval-required', reason: 'A human approval is required.' },
    ];

    it.each(REFUSALS)(
        'surfaces refusal $code to task chat with its reason and records it',
        async ({ code, reason }) => {
            refuse({ allowed: false, code, reason, source: 'organization' });

            const outcome = await mergeNow();

            // The PR still exists — a refusal never throws at the sweep.
            expect(outcome).toEqual(
                expect.objectContaining({
                    attempted: true,
                    merged: false,
                    refusalCode: code,
                    policySource: 'organization',
                }),
            );

            const chatBody = taskChat.post.mock.calls[0][1].body as string;
            expect(chatBody).toContain('was NOT merged');
            expect(chatBody).toContain(code);
            expect(chatBody).toContain(reason);
            expect(chatBody).toContain('organization');

            expect(activityLog.log).toHaveBeenCalledWith(
                expect.objectContaining({
                    actionType: ActivityActionType.TASK_MERGE_REFUSED,
                    status: ActivityStatus.FAILED,
                    details: expect.objectContaining({
                        refusalCode: code,
                        reason: expect.stringContaining(reason),
                        policySource: 'organization',
                        prNumber: 7,
                    }),
                }),
            );
        },
    );

    it('never marks the branch merged on a refusal', async () => {
        refuse({ allowed: false, code: 'gate-not-green', reason: 'red', source: 'work' });
        await mergeNow();
        const states = tasks.updateById.mock.calls.map(
            (call: unknown[]) => (call[1] as { branchState?: string }).branchState,
        );
        expect(states).not.toContain('merged');
    });

    it('forwards a red gate verdict to the decision point rather than hiding it', async () => {
        await mergeNow({ gateStatus: 'red' });
        expect(gitFacade.mergePullRequest.mock.calls[0][5]).toEqual(
            expect.objectContaining({ gateStatus: 'red' }),
        );
    });

    // ── 3b. A stable refusal is told to the human ONCE ────────────────
    //
    // The attempt sits on the two-minute PR-status sweep now, so a
    // refusal that is a property of the repository — a protected base
    // branch, a required CODEOWNERS review — is still true on the next
    // tick and every tick after it. Reporting each one buried the Task's
    // chat under ~720 identical messages a day and wrote as many activity
    // rows: a correct refusal turning into an outage.

    it('reports the same refusal at the same head only once', async () => {
        refuse({
            allowed: false,
            code: 'protected-branch',
            reason: "Branch 'release' is protected.",
            source: 'work',
        });
        const HEAD = 'a'.repeat(40);
        const task = openPrTask();

        const first = await mergeNow({ task, headSha: HEAD });
        const second = await mergeNow({ task, headSha: HEAD });

        // Both attempts really happened — a transient provider fault must
        // still get retried; it is the REPORT that is deduped.
        expect(gitFacade.mergePullRequest).toHaveBeenCalledTimes(2);
        expect(first).toEqual(expect.objectContaining({ refusalCode: 'protected-branch' }));
        expect(second).toEqual(expect.objectContaining({ refusalCode: 'protected-branch' }));
        expect(taskChat.post).toHaveBeenCalledTimes(1);
        expect(activityLog.log).toHaveBeenCalledTimes(1);
        expect(tasks.recordMergeRefusal).toHaveBeenCalledWith(
            (task as unknown as { id: string }).id,
            { sha: HEAD, code: 'protected-branch' },
        );
    });

    it('reports again when the head commit moves — a new commit is new news', async () => {
        refuse({
            allowed: false,
            code: 'protected-branch',
            reason: "Branch 'release' is protected.",
            source: 'work',
        });
        const task = openPrTask();
        await mergeNow({ task, headSha: 'a'.repeat(40) });
        await mergeNow({ task, headSha: 'b'.repeat(40) });
        expect(taskChat.post).toHaveBeenCalledTimes(2);
    });

    it('reports again when the SAME head produces a DIFFERENT refusal', async () => {
        const task = openPrTask();
        const HEAD = 'a'.repeat(40);
        refuse({ allowed: false, code: 'protected-branch', reason: 'protected', source: 'work' });
        await mergeNow({ task, headSha: HEAD });
        refuse({ allowed: false, code: 'gate-not-green', reason: 'red', source: 'work' });
        await mergeNow({ task, headSha: HEAD });
        expect(taskChat.post).toHaveBeenCalledTimes(2);
    });

    // ── 4. Non-policy failures are reported, never thrown ─────────────

    it('reports a provider that declines the merge without throwing', async () => {
        gitFacade.mergePullRequest.mockResolvedValue({
            merged: false,
            sha: '',
            message: 'Required status check is pending',
        });

        const outcome = await mergeNow();

        expect(outcome).toEqual(
            expect.objectContaining({
                attempted: true,
                merged: false,
                reason: 'Required status check is pending',
            }),
        );
        expect(taskChat.post).toHaveBeenCalled();
    });

    it('reports a transport fault without throwing', async () => {
        gitFacade.mergePullRequest.mockRejectedValue(new Error('socket hang up'));

        const outcome = await mergeNow();

        expect(outcome).toEqual(
            expect.objectContaining({ attempted: true, merged: false, reason: 'socket hang up' }),
        );
    });

    it('an activity-log outage never fails a merge that already landed', async () => {
        activityLog.log.mockRejectedValue(new Error('activity table locked'));
        await expect(mergeNow()).resolves.toEqual(expect.objectContaining({ merged: true }));
    });

    // ── 5. The merge is only ever reached on the PR-opened path ───────

    it('never attempts a merge when the branch conflicts (no PR exists)', async () => {
        workspaceFacade.simulateMerge.mockResolvedValue({
            clean: false,
            conflictPaths: ['src/app.ts'],
        });
        const result = await build().finalizeRun(finalizeInput());
        expect(result.outcome).toBe('conflict');
        expect(gitFacade.mergePullRequest).not.toHaveBeenCalled();
    });

    it('never attempts a merge when the agent may not open pull requests', async () => {
        const result = await build().finalizeRun(
            finalizeInput({ agentCanOpenPullRequests: false }),
        );
        expect(result.outcome).toBe('pushed-no-pr');
        expect(gitFacade.mergePullRequest).not.toHaveBeenCalled();
    });

    // ── 6. Merge approval (slice AE): the merge moved off PR-open ─────
    //
    // The merge is no longer attempted at pull-request-open time under ANY
    // policy. Under the shipped default (`requireHumanApproval: true`) it
    // could never have succeeded — the old code passed
    // `humanApproved: false` — and under either policy it could not even
    // be judged: the pull request was created milliseconds earlier, so no
    // CI has run. `TaskMergeGateService` re-asks after the provider
    // reports.

    const NEEDS_APPROVAL: MergePolicy = { ...PERMISSIVE, requireHumanApproval: true };

    it('defers the merge instead of attempting one when the policy requires an approval', async () => {
        mergePolicy.resolve.mockResolvedValue(resolution(NEEDS_APPROVAL));

        const result = await build().finalizeRun(finalizeInput());

        expect(result.outcome).toBe('pr-opened');
        expect(result.prNumber).toBe(7);
        expect(result.merge).toEqual({
            attempted: false,
            merged: false,
            awaitingApproval: true,
            awaitingCi: true,
            policySource: 'work',
        });
        expect(gitFacade.mergePullRequest).not.toHaveBeenCalled();
    });

    it('says NOTHING to the user when it defers — the human has not been asked yet', async () => {
        mergePolicy.resolve.mockResolvedValue(resolution(NEEDS_APPROVAL));
        await build().finalizeRun(finalizeInput());
        // The old code posted a `human-approval-required` refusal to task
        // chat on every single agent pull request: the platform announcing
        // it would not do something nobody had been given the chance to
        // authorise. The Inbox approval is the message now.
        expect(taskChat.post).not.toHaveBeenCalled();
        expect(activityLog.log).not.toHaveBeenCalled();
    });

    // CONTRACT REVERSAL (AE review). This used to be "still merges
    // immediately for an operator who turned the approval off", pinning a
    // merge that fired seconds after `createPullRequest` — before any
    // check run existed. That operator opted out of a HUMAN, not out of
    // CI, and the post-CI gate on the identical policy waited for green,
    // so the two entry points disagreed about what their own policy
    // meant. They agree now: green first, in both.
    it('waits for CI even when the operator turned the approval off', async () => {
        // PERMISSIVE has requireHumanApproval: false.
        const result = await build().finalizeRun(finalizeInput());
        expect(result.merge).toEqual({
            attempted: false,
            merged: false,
            awaitingCi: true,
            policySource: 'work',
        });
        expect(gitFacade.mergePullRequest).not.toHaveBeenCalled();
        // …and stays silent: the gate will merge it on the next sweep.
        expect(taskChat.post).not.toHaveBeenCalled();
    });

    // ── 7. The post-CI entry point ────────────────────────────────────

    it('attemptMergeForOpenPullRequest drives the SAME merge path as finalize', async () => {
        const task = { ...makeTask(), prNumber: 7, prUrl: 'https://x/pull/7' };
        const outcome = await build().attemptMergeForOpenPullRequest({
            task: task as never,
            agentId: 'agent-1',
            gateStatus: 'green',
        });

        expect(outcome).toEqual(
            expect.objectContaining({ attempted: true, merged: true, mergeMethod: 'squash' }),
        );
        const [owner, repo, prNumber, , , actor] = gitFacade.mergePullRequest.mock.calls[0];
        expect([owner, repo, prNumber]).toEqual(['acme', 'site-data', 7]);
        expect(actor).toEqual(
            expect.objectContaining({
                agentId: 'agent-1',
                taskId: task.id,
                // The Work's configured base branch, exactly as finalize does.
                targetBranch: 'release',
            }),
        );
    });

    it('attemptMergeForOpenPullRequest does nothing for a Task with no pull request', async () => {
        const outcome = await build().attemptMergeForOpenPullRequest({
            task: makeTask(),
            agentId: 'agent-1',
        });
        expect(outcome).toBeUndefined();
        expect(gitFacade.mergePullRequest).not.toHaveBeenCalled();
    });

    it('attemptMergeForOpenPullRequest still obeys allowAgentMerge', async () => {
        mergePolicy.resolve.mockResolvedValue(resolution(CONSERVATIVE, 'default'));
        const task = { ...makeTask(), prNumber: 7 };
        const outcome = await build().attemptMergeForOpenPullRequest({
            task: task as never,
            agentId: 'agent-1',
        });
        expect(outcome).toEqual({ attempted: false, merged: false, policySource: 'default' });
        expect(gitFacade.mergePullRequest).not.toHaveBeenCalled();
    });
});
