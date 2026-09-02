import { TaskWorkspaceService, tokenFreeCloneUrl } from '../task-workspace.service';

/**
 * Agent execution v2 — describing a Task's repository for a FLEET NODE.
 *
 * The node provisions the worktree itself, so what leaves the platform
 * is a token-free spec that resolves the SAME repository, base ref and
 * branch the cloud path would, and the branch identity is persisted on
 * the Task exactly as the cloud path persists it.
 */

function makeWork(over: Record<string, unknown> = {}) {
    return {
        id: 'work-1',
        gitProvider: 'github',
        taskIsolationBaseBranch: null,
        getRepoOwner: () => 'acme',
        getDataRepo: () => 'site-data',
        ...over,
    };
}

function makeTask(over: Record<string, unknown> = {}) {
    return {
        id: 'task-1',
        slug: 'TSK-9',
        userId: 'user-1',
        workId: 'work-1',
        branchRef: null,
        branchState: null,
        ...over,
    } as any;
}

describe('TaskWorkspaceService.describeFleetWorkspace', () => {
    let works: { findById: jest.Mock };
    let tasks: { updateById: jest.Mock };
    let gitFacade: { getRepository: jest.Mock };

    const build = (opts: { withGitFacade?: boolean } = {}) =>
        new TaskWorkspaceService(
            works as any,
            tasks as any,
            {} as any,
            {} as any,
            (opts.withGitFacade === false ? undefined : gitFacade) as any,
        );

    beforeEach(() => {
        works = { findById: jest.fn().mockResolvedValue(makeWork()) };
        tasks = { updateById: jest.fn().mockResolvedValue(undefined) };
        gitFacade = {
            getRepository: jest.fn().mockResolvedValue({
                defaultBranch: 'main',
                cloneUrl: 'https://github.com/acme/site-data.git',
            }),
        };
    });

    it('describes the Work repository, the default branch and a fresh task branch', async () => {
        const spec = await build().describeFleetWorkspace({ task: makeTask(), userId: 'user-1' });
        expect(gitFacade.getRepository).toHaveBeenCalledWith('acme', 'site-data', {
            userId: 'user-1',
            providerId: 'github',
            workId: 'work-1',
        });
        expect(spec).toEqual({
            repositoryId: 'acme/site-data',
            repoUrl: 'https://github.com/acme/site-data.git',
            baseRef: 'main',
            branch: 'task/tsk-9-task1',
        });
        // Persisted so the reconciler and a later cloud re-run agree.
        expect(tasks.updateById).toHaveBeenCalledWith('task-1', {
            branchRef: 'task/tsk-9-task1',
            branchState: 'created',
        });
    });

    it('honours the Work base branch and reuses an existing task branch verbatim', async () => {
        works.findById.mockResolvedValue(makeWork({ taskIsolationBaseBranch: ' develop ' }));
        const spec = await build().describeFleetWorkspace({
            task: makeTask({ branchRef: 'task/task-1-old-slug', branchState: 'pushed' }),
            userId: 'user-1',
        });
        expect(spec?.baseRef).toBe('develop');
        expect(spec?.branch).toBe('task/task-1-old-slug');
        expect(tasks.updateById).not.toHaveBeenCalled();
    });

    it('is null for a Task without a Work, or a Work without a repository', async () => {
        expect(
            await build().describeFleetWorkspace({
                task: makeTask({ workId: null }),
                userId: 'user-1',
            }),
        ).toBeNull();
        works.findById.mockResolvedValue(null);
        expect(
            await build().describeFleetWorkspace({ task: makeTask(), userId: 'user-1' }),
        ).toBeNull();
        works.findById.mockResolvedValue(makeWork({ getDataRepo: () => '' }));
        expect(
            await build().describeFleetWorkspace({ task: makeTask(), userId: 'user-1' }),
        ).toBeNull();
    });

    it('fails loudly without a git facade', async () => {
        await expect(
            build({ withGitFacade: false }).describeFleetWorkspace({
                task: makeTask(),
                userId: 'user-1',
            }),
        ).rejects.toThrow(/no git facade/);
    });

    it('refuses a clone URL that carries a credential instead of stripping it', async () => {
        gitFacade.getRepository.mockResolvedValue({
            defaultBranch: 'main',
            cloneUrl: 'https://x-access-token:ghp_secret@github.com/acme/site-data.git',
        });
        await expect(
            build().describeFleetWorkspace({ task: makeTask(), userId: 'user-1' }),
        ).rejects.toThrow(/credential/);
    });
});

describe('tokenFreeCloneUrl', () => {
    it.each([
        'https://github.com/acme/site-data.git',
        'ssh://git@github.com/acme/site-data.git',
        'git@github.com:acme/site-data.git',
    ])('passes %s through', (url) => {
        expect(tokenFreeCloneUrl(url)).toBe(url);
    });

    it.each([
        'https://user:pass@github.com/acme/site-data.git',
        'https://token@github.com/acme/site-data.git',
        'ssh://git:pw@github.com/acme/site-data.git',
    ])('refuses %s', (url) => {
        expect(() => tokenFreeCloneUrl(url)).toThrow(/credential/);
    });

    it('refuses an empty or unparsable value', () => {
        expect(() => tokenFreeCloneUrl('')).toThrow(/no clone URL/);
        expect(() => tokenFreeCloneUrl('not a url')).toThrow(/not a valid URL/);
    });
});
