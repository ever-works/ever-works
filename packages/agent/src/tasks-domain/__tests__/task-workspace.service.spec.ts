import { TaskWorkspaceService } from '../task-workspace.service';

describe('TaskWorkspaceService', () => {
    const makeWork = (overrides: Record<string, unknown> = {}) => ({
        id: 'work-1',
        gitProvider: 'github',
        taskIsolation: 'worktree',
        taskIsolationBaseBranch: null,
        taskIsolationTargetRepo: 'work-output',
        taskBranchCleanup: 'on-merge',
        getRepoOwner: () => 'acme',
        getDataRepo: () => 'site-data',
        ...overrides,
    });

    const makeTask = (overrides: Record<string, unknown> = {}) =>
        ({
            id: '123e4567-e89b-12d3-a456-426614174000',
            slug: 't-42',
            workId: 'work-1',
            isolationMode: null,
            branchRef: null,
            branchState: null,
            ...overrides,
        }) as any;

    const handle = {
        path: '/ws/task',
        baseSha: 'abc123def456',
        reused: false,
        branch: 'task/t-42-123e4567',
        bindingKey: '123e4567-e89b-12d3-a456-426614174000',
    };

    let works: { findById: jest.Mock };
    let tasks: { updateById: jest.Mock };
    let runs: { setWorkspaceMeta: jest.Mock };
    let workspaceFacade: { provision: jest.Mock };
    let gitFacade: { getAccessToken: jest.Mock; getRepository: jest.Mock };

    const build = () =>
        new TaskWorkspaceService(
            works as any,
            tasks as any,
            runs as any,
            workspaceFacade as any,
            gitFacade as any,
        );

    beforeEach(() => {
        works = { findById: jest.fn().mockResolvedValue(makeWork()) };
        tasks = { updateById: jest.fn().mockResolvedValue(undefined) };
        runs = { setWorkspaceMeta: jest.fn().mockResolvedValue(undefined) };
        workspaceFacade = { provision: jest.fn().mockResolvedValue(handle) };
        gitFacade = {
            getAccessToken: jest.fn().mockResolvedValue('tok-123'),
            getRepository: jest.fn().mockResolvedValue({
                defaultBranch: 'main',
                cloneUrl: 'https://github.com/acme/site-data.git',
            }),
        };
    });

    const input = () => ({
        task: makeTask(),
        userId: 'user-1',
        runId: 'run-1',
        agentCanCommit: true,
    });

    it('returns null without touching git when isolation resolves off', async () => {
        works.findById.mockResolvedValue(makeWork({ taskIsolation: 'off' }));
        const result = await build().provisionForRun(input());
        expect(result).toBeNull();
        expect(gitFacade.getAccessToken).not.toHaveBeenCalled();
        expect(workspaceFacade.provision).not.toHaveBeenCalled();
    });

    it('returns null for a Task with no Work', async () => {
        const result = await build().provisionForRun({
            ...input(),
            task: makeTask({ workId: null }),
        });
        expect(result).toBeNull();
        expect(works.findById).not.toHaveBeenCalled();
    });

    it('provisions fetch-first from the repo default branch and persists identity', async () => {
        const result = await build().provisionForRun(input());
        expect(result).toEqual(
            expect.objectContaining({ cwd: '/ws/task', branch: 'task/t-42-123e4567' }),
        );
        expect(workspaceFacade.provision).toHaveBeenCalledWith(
            expect.objectContaining({
                repoUrl: 'https://github.com/acme/site-data.git',
                baseRef: 'main',
                bindingKey: '123e4567-e89b-12d3-a456-426614174000',
                auth: { token: 'tok-123' },
            }),
            { userId: 'user-1', workId: 'work-1' },
        );
        expect(tasks.updateById).toHaveBeenCalledWith(
            '123e4567-e89b-12d3-a456-426614174000',
            expect.objectContaining({
                branchRef: 'task/t-42-123e4567',
                baseSha: 'abc123def456',
                branchState: 'created',
            }),
        );
        expect(runs.setWorkspaceMeta).toHaveBeenCalledWith(
            'run-1',
            expect.objectContaining({ branchRef: 'task/t-42-123e4567', reused: false }),
        );
    });

    it('honors the Work base-branch override', async () => {
        works.findById.mockResolvedValue(makeWork({ taskIsolationBaseBranch: 'develop' }));
        await build().provisionForRun(input());
        expect(workspaceFacade.provision).toHaveBeenCalledWith(
            expect.objectContaining({ baseRef: 'develop' }),
            expect.anything(),
        );
    });

    it('reuses a persisted branchRef verbatim and keeps its lifecycle state', async () => {
        await build().provisionForRun({
            ...input(),
            task: makeTask({ branchRef: 'task/old-slug-deadbeef', branchState: 'pushed' }),
        });
        expect(workspaceFacade.provision).toHaveBeenCalledWith(
            expect.objectContaining({ branch: 'task/old-slug-deadbeef' }),
            expect.anything(),
        );
        const patch = tasks.updateById.mock.calls[0][1];
        expect(patch.branchState).toBeUndefined();
    });

    it('fails LOUDLY when isolation is on but no git credentials exist', async () => {
        gitFacade.getAccessToken.mockResolvedValue(null);
        await expect(build().provisionForRun(input())).rejects.toThrow(/no git credentials/);
    });

    it('clamps to off when the agent cannot commit', async () => {
        const result = await build().provisionForRun({ ...input(), agentCanCommit: false });
        expect(result).toBeNull();
        expect(workspaceFacade.provision).not.toHaveBeenCalled();
    });

    it('workspaceMeta persistence failure does not fail the provision', async () => {
        runs.setWorkspaceMeta.mockRejectedValue(new Error('db hiccup'));
        const result = await build().provisionForRun(input());
        expect(result).not.toBeNull();
    });

    describe('attached repos (Feature G — advisory provision-spec field)', () => {
        const buildWithAttachments = (attachments: { listEnabledForAgentWithRepos: jest.Mock }) =>
            new TaskWorkspaceService(
                works as any,
                tasks as any,
                runs as any,
                workspaceFacade as any,
                gitFacade as any,
                undefined,
                undefined,
                undefined,
                undefined,
                attachments as any,
            );

        it('passes the agent enabled attachments as advisory attachedRepos', async () => {
            const attachments = {
                listEnabledForAgentWithRepos: jest.fn().mockResolvedValue([
                    {
                        repoConnection: {
                            url: 'https://github.com/acme/tools',
                            defaultBranch: 'main',
                            mountPath: null,
                            name: 'tools',
                            enabled: true,
                        },
                    },
                    {
                        // Disabled repo row → filtered out even though the
                        // attachment edge itself is enabled.
                        repoConnection: {
                            url: 'https://github.com/acme/off',
                            defaultBranch: null,
                            mountPath: 'off-dir',
                            name: 'off',
                            enabled: false,
                        },
                    },
                ]),
            };
            await buildWithAttachments(attachments).provisionForRun({
                ...input(),
                agentId: 'agent-1',
            });
            expect(attachments.listEnabledForAgentWithRepos).toHaveBeenCalledWith(
                'agent-1',
                'user-1',
            );
            expect(workspaceFacade.provision).toHaveBeenCalledWith(
                expect.objectContaining({
                    attachedRepos: [
                        { url: 'https://github.com/acme/tools', branch: 'main', mountDir: 'tools' },
                    ],
                }),
                expect.anything(),
            );
        });

        it('omits the field entirely without an agentId or with no attachments', async () => {
            const attachments = { listEnabledForAgentWithRepos: jest.fn().mockResolvedValue([]) };
            await buildWithAttachments(attachments).provisionForRun(input());
            expect(attachments.listEnabledForAgentWithRepos).not.toHaveBeenCalled();
            expect(workspaceFacade.provision.mock.calls[0][0]).not.toHaveProperty('attachedRepos');

            await buildWithAttachments(attachments).provisionForRun({
                ...input(),
                agentId: 'agent-1',
            });
            expect(workspaceFacade.provision.mock.calls[1][0]).not.toHaveProperty('attachedRepos');
        });

        it('a failed attachment read degrades to no extra repos, never a failed provision', async () => {
            const attachments = {
                listEnabledForAgentWithRepos: jest.fn().mockRejectedValue(new Error('db down')),
            };
            const result = await buildWithAttachments(attachments).provisionForRun({
                ...input(),
                agentId: 'agent-1',
            });
            expect(result).not.toBeNull();
            expect(workspaceFacade.provision.mock.calls[0][0]).not.toHaveProperty('attachedRepos');
        });
    });

    describe('finalizeRun (M4)', () => {
        let transitions: { transition: jest.Mock };
        let taskChat: { post: jest.Mock };
        let facadeExt: {
            provision: jest.Mock;
            finalize: jest.Mock;
            simulateMerge: jest.Mock;
        };

        const buildFull = () =>
            new TaskWorkspaceService(
                works as any,
                { ...tasks, findById: jest.fn().mockResolvedValue(makeTask()) } as any,
                runs as any,
                facadeExt as any,
                {
                    ...gitFacade,
                    createPullRequest: jest.fn().mockResolvedValue({
                        number: 7,
                        url: 'https://github.com/acme/site-data/pull/7',
                    }),
                } as any,
                transitions as any,
                taskChat as any,
            );

        const workspace = {
            cwd: '/ws/task',
            branch: 'task/t-42-123e4567',
            baseSha: 'abc123def456',
            reused: false,
            provider: 'workspace',
        };

        const finalizeInput = () => ({
            task: makeTask(),
            userId: 'user-1',
            agentId: 'agent-1',
            agentCanOpenPullRequests: true,
            workspace,
        });

        beforeEach(() => {
            transitions = { transition: jest.fn().mockResolvedValue(undefined) };
            taskChat = { post: jest.fn().mockResolvedValue(undefined) };
            facadeExt = {
                provision: jest.fn(),
                finalize: jest
                    .fn()
                    .mockResolvedValue({ pushed: true, headSha: 'cafe42', empty: false }),
                simulateMerge: jest.fn().mockResolvedValue({ clean: true, conflictPaths: [] }),
            };
        });

        it('empty run → no-changes, no push state, no PR', async () => {
            facadeExt.finalize.mockResolvedValue({ pushed: false, headSha: null, empty: true });
            const result = await buildFull().finalizeRun(finalizeInput());
            expect(result.outcome).toBe('no-changes');
            expect(tasks.updateById).not.toHaveBeenCalled();
            expect(facadeExt.simulateMerge).not.toHaveBeenCalled();
        });

        it('clean merge → opens PR, persists pr-open, moves Task to in_review', async () => {
            const svc = buildFull();
            const result = await svc.finalizeRun(finalizeInput());
            expect(result).toEqual(expect.objectContaining({ outcome: 'pr-opened', prNumber: 7 }));
            expect(tasks.updateById).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({ branchState: 'pushed' }),
            );
            expect(tasks.updateById).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({
                    branchState: 'pr-open',
                    prNumber: 7,
                    prUrl: 'https://github.com/acme/site-data/pull/7',
                }),
            );
            // Quality gates (Wave 3 M8): the finalize step's flip declares
            // itself agent-driven so a red gate can never enter review here.
            expect(transitions.transition).toHaveBeenCalledWith(expect.anything(), 'in_review', {
                actorType: 'agent',
            });
        });

        it('conflict → NAMES paths, posts chat message, moves Task to blocked, NO PR', async () => {
            facadeExt.simulateMerge.mockResolvedValue({
                clean: false,
                conflictPaths: ['src/app.ts', 'README.md'],
            });
            const svc = buildFull();
            const result = await svc.finalizeRun(finalizeInput());
            expect(result.outcome).toBe('conflict');
            expect(result.conflictPaths).toEqual(['src/app.ts', 'README.md']);
            expect(tasks.updateById).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({
                    branchState: 'conflict',
                    conflictPaths: ['src/app.ts', 'README.md'],
                }),
            );
            expect(taskChat.post).toHaveBeenCalledWith(
                'user-1',
                expect.objectContaining({
                    authorType: 'agent',
                    body: expect.stringContaining('src/app.ts'),
                }),
            );
            expect(transitions.transition).toHaveBeenCalledWith(expect.anything(), 'blocked', {
                actorType: 'agent',
            });
        });

        it('no PR permission → pushed-no-pr, branch stays pushed', async () => {
            const svc = buildFull();
            const result = await svc.finalizeRun({
                ...finalizeInput(),
                agentCanOpenPullRequests: false,
            });
            expect(result.outcome).toBe('pushed-no-pr');
            expect(tasks.updateById).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({ branchState: 'pushed' }),
            );
            // No PR is opened — the permission the agent lacks is exactly
            // the one that would open it.
            expect(tasks.updateById).not.toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({ branchState: 'pr-open' }),
            );
        });

        /**
         * Run-driven lifecycle (plan 04 M7) — the Task status follows the
         * RUN RESULT, not who is allowed to open a pull request.
         *
         * A `pushed-no-pr` run completed WITH CHANGES: they are committed
         * and pushed on the Task branch, so the work is reviewable and the
         * card belongs in the review column. Before this, such a Task sat
         * in `in_progress` forever with no signal that it was waiting on a
         * human to open the PR.
         */
        it('pushed-no-pr moves the Task to in_review — completed WITH changes', async () => {
            const svc = buildFull();
            await svc.finalizeRun({ ...finalizeInput(), agentCanOpenPullRequests: false });
            expect(transitions.transition).toHaveBeenCalledWith(expect.anything(), 'in_review', {
                actorType: 'agent',
            });
        });

        it('uses the SAME agent-declared transition path as the PR-opened branch', async () => {
            const svc = buildFull();
            await svc.finalizeRun({ ...finalizeInput(), agentCanOpenPullRequests: false });
            // Exactly one transition — the review-entry edge. A second
            // (duplicated) write here would double-fire the gates.
            expect(transitions.transition).toHaveBeenCalledTimes(1);
            expect(transitions.transition.mock.calls[0][2]).toEqual({ actorType: 'agent' });
        });

        it('an empty run still does NOT enter review — nothing to review', async () => {
            facadeExt.finalize.mockResolvedValue({ pushed: false, headSha: null, empty: true });
            const svc = buildFull();
            const result = await svc.finalizeRun({
                ...finalizeInput(),
                agentCanOpenPullRequests: false,
            });
            expect(result.outcome).toBe('no-changes');
            expect(transitions.transition).not.toHaveBeenCalled();
        });

        it('a conflicting run goes to blocked, never to review', async () => {
            facadeExt.simulateMerge.mockResolvedValue({
                clean: false,
                conflictPaths: ['src/app.ts'],
            });
            const svc = buildFull();
            await svc.finalizeRun({ ...finalizeInput(), agentCanOpenPullRequests: false });
            expect(transitions.transition).toHaveBeenCalledTimes(1);
            expect(transitions.transition).toHaveBeenCalledWith(expect.anything(), 'blocked', {
                actorType: 'agent',
            });
        });
    });
});
