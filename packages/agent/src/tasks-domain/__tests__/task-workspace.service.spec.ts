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
});
