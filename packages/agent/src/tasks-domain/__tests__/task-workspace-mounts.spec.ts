import type { Task } from '../../entities/task.entity';
import { TaskWorkspaceService, repositoryIdFromCloneUrl } from '../task-workspace.service';

/** Constructor slots, so the doubles are typed against the real contracts. */
type ServiceArgs = ConstructorParameters<typeof TaskWorkspaceService>;
type WorkDouble = Pick<
    Awaited<ReturnType<ServiceArgs[0]['findById']>> & object,
    'id' | 'gitProvider' | 'taskIsolationBaseBranch' | 'getRepoOwner' | 'getDataRepo'
>;

/**
 * Multi-repo Task workspaces (self-build slice C) on the platform side.
 *
 *   - `describeFleetWorkspace` turns the run agent's enabled repository
 *     attachments into workspace MOUNTS on the same Task branch, refusing
 *     what it cannot describe and skipping only the primary itself;
 *   - `finalizeMountPush` opens the pull request for a mounted repository
 *     a fleet run pushed and records it on the Task, never throwing for a
 *     provider failure (the branch is already pushed).
 */

function makeWork(over: Partial<WorkDouble> = {}): WorkDouble {
    return {
        id: 'work-1',
        gitProvider: 'github',
        taskIsolationBaseBranch: null,
        getRepoOwner: () => 'ever-works',
        getDataRepo: () => 'ever-works',
        ...over,
    };
}

function makeTask(over: Partial<Task> = {}): Task {
    return {
        id: 'task-1',
        slug: 'TSK-9',
        title: 'Add field X',
        userId: 'user-1',
        workId: 'work-1',
        branchRef: 'task/tsk-9-task1',
        branchState: 'created',
        linkedPullRequests: null,
        ...over,
    } as unknown as Task;
}

function attachment(
    over: Partial<{
        id: string;
        url: string;
        defaultBranch: string | null;
        mountPath: string | null;
        name: string;
        provider: 'github' | 'git';
        enabled: boolean;
    }> = {},
) {
    return {
        repoConnection: {
            id: 'conn-1',
            url: 'https://github.com/ever-works/directory-web-template.git',
            defaultBranch: 'develop',
            mountPath: null,
            name: 'directory-web-template',
            provider: 'github',
            enabled: true,
            envFiles: null,
            ...over,
        },
    };
}

describe('repositoryIdFromCloneUrl', () => {
    it.each([
        ['https://github.com/ever-works/ever-works.git', 'ever-works/ever-works'],
        ['https://github.com/ever-works/ever-works', 'ever-works/ever-works'],
        [
            'https://github.com/Ever-Works/Directory-Web-Template/',
            'Ever-Works/Directory-Web-Template',
        ],
        ['git@github.com:ever-works/workspace.git', 'ever-works/workspace'],
        ['ssh://git@gitlab.com/group/project.git', 'group/project'],
    ])('parses %s', (url, expected) => {
        expect(repositoryIdFromCloneUrl(url)).toBe(expected);
    });

    it.each([
        ['an owner-only URL', 'https://github.com/ever-works'],
        ['a nested path', 'https://gitlab.com/group/sub/project.git'],
        ['a bare host', 'https://github.com/'],
        ['traversal', 'https://github.com/../x'],
        ['free text', 'not a url'],
    ])('rejects %s', (_label, url) => {
        expect(repositoryIdFromCloneUrl(url)).toBeNull();
    });
});

describe('TaskWorkspaceService.describeFleetWorkspace — mounts', () => {
    let works: { findById: jest.Mock };
    let tasks: { updateById: jest.Mock; findById: jest.Mock };
    let gitFacade: { getRepository: jest.Mock; createPullRequest: jest.Mock };
    let attachments: { listEnabledForAgentWithRepos: jest.Mock };

    const build = () =>
        new TaskWorkspaceService(
            works as unknown as ServiceArgs[0],
            tasks as unknown as ServiceArgs[1],
            {} as unknown as ServiceArgs[2],
            {} as unknown as ServiceArgs[3],
            gitFacade as unknown as ServiceArgs[4],
            undefined,
            undefined,
            undefined,
            undefined,
            attachments as unknown as ServiceArgs[9],
        );

    beforeEach(() => {
        works = { findById: jest.fn().mockResolvedValue(makeWork()) };
        tasks = {
            updateById: jest.fn().mockResolvedValue(undefined),
            findById: jest.fn().mockResolvedValue(makeTask()),
        };
        gitFacade = {
            getRepository: jest.fn(async (owner: string, repo: string) => ({
                defaultBranch: repo === 'workspace' ? 'main' : 'develop',
                cloneUrl: `https://github.com/${owner}/${repo}.git`,
            })),
            createPullRequest: jest.fn(),
        };
        attachments = { listEnabledForAgentWithRepos: jest.fn().mockResolvedValue([]) };
    });

    it('describes a single-repository workspace when the agent has no attachments (unchanged)', async () => {
        const spec = await build().describeFleetWorkspace({
            task: makeTask(),
            userId: 'user-1',
            agentId: 'agent-1',
        });
        expect(spec).toEqual({
            repositoryId: 'ever-works/ever-works',
            repoUrl: 'https://github.com/ever-works/ever-works.git',
            baseRef: 'develop',
            branch: 'task/tsk-9-task1',
        });
        expect(attachments.listEnabledForAgentWithRepos).toHaveBeenCalledWith('agent-1', 'user-1');
    });

    it('turns enabled attachments into mounts on the same Task branch, resolving a missing default branch', async () => {
        attachments.listEnabledForAgentWithRepos.mockResolvedValue([
            attachment(),
            attachment({
                id: 'conn-2',
                url: 'git@github.com:ever-works/workspace.git',
                defaultBranch: null,
                mountPath: 'kb',
                name: 'Workspace',
            }),
        ]);

        const spec = await build().describeFleetWorkspace({
            task: makeTask(),
            userId: 'user-1',
            agentId: 'agent-1',
        });

        expect(spec?.mounts).toEqual([
            {
                repositoryId: 'ever-works/directory-web-template',
                repoUrl: 'https://github.com/ever-works/directory-web-template.git',
                baseRef: 'develop',
                branch: 'task/tsk-9-task1',
                mountDir: 'directory-web-template',
                writable: true,
            },
            {
                repositoryId: 'ever-works/workspace',
                repoUrl: 'git@github.com:ever-works/workspace.git',
                baseRef: 'main',
                branch: 'task/tsk-9-task1',
                mountDir: 'kb',
                writable: true,
            },
        ]);
        // The default branch of the second mount came from the provider, scoped to the caller.
        expect(gitFacade.getRepository).toHaveBeenCalledWith('ever-works', 'workspace', {
            userId: 'user-1',
            providerId: 'github',
            workId: 'work-1',
        });
    });

    it('skips an attachment that is the primary repository instead of mounting it twice', async () => {
        attachments.listEnabledForAgentWithRepos.mockResolvedValue([
            attachment({ url: 'https://github.com/Ever-Works/Ever-Works.git', name: 'platform' }),
            attachment({
                id: 'conn-2',
                url: 'https://github.com/ever-works/website.git',
                name: 'website',
            }),
        ]);
        const spec = await build().describeFleetWorkspace({
            task: makeTask(),
            userId: 'user-1',
            agentId: 'agent-1',
        });
        expect(spec?.mounts?.map((mount) => mount.repositoryId)).toEqual(['ever-works/website']);
    });

    it('refuses an attachment whose URL is not owner/repository, naming it', async () => {
        attachments.listEnabledForAgentWithRepos.mockResolvedValue([
            attachment({ url: 'https://git.example.com/deep/nested/path.git', name: 'weird' }),
        ]);
        await expect(
            build().describeFleetWorkspace({
                task: makeTask(),
                userId: 'user-1',
                agentId: 'agent-1',
            }),
        ).rejects.toThrow(/conn-1 .*cannot be mounted/);
    });

    it('refuses two attachments that would share a mount directory', async () => {
        attachments.listEnabledForAgentWithRepos.mockResolvedValue([
            attachment({ mountPath: 'shared' }),
            attachment({
                id: 'conn-2',
                url: 'https://github.com/ever-works/website.git',
                mountPath: 'Shared',
                name: 'w',
            }),
        ]);
        await expect(
            build().describeFleetWorkspace({
                task: makeTask(),
                userId: 'user-1',
                agentId: 'agent-1',
            }),
        ).rejects.toThrow(/is used by another mount/);
    });

    it('ignores attachments entirely when no agent is given', async () => {
        attachments.listEnabledForAgentWithRepos.mockResolvedValue([attachment()]);
        const spec = await build().describeFleetWorkspace({ task: makeTask(), userId: 'user-1' });
        expect(spec?.mounts).toBeUndefined();
        expect(attachments.listEnabledForAgentWithRepos).not.toHaveBeenCalled();
    });
});

describe('TaskWorkspaceService.finalizeMountPush', () => {
    let works: { findById: jest.Mock };
    let tasks: { updateById: jest.Mock; findById: jest.Mock };
    let gitFacade: { getRepository: jest.Mock; createPullRequest: jest.Mock };
    let attachments: { listEnabledForAgentWithRepos: jest.Mock };

    const build = () =>
        new TaskWorkspaceService(
            works as unknown as ServiceArgs[0],
            tasks as unknown as ServiceArgs[1],
            {} as unknown as ServiceArgs[2],
            {} as unknown as ServiceArgs[3],
            gitFacade as unknown as ServiceArgs[4],
            undefined,
            undefined,
            undefined,
            undefined,
            attachments as unknown as ServiceArgs[9],
        );

    const base = () => ({
        task: makeTask(),
        userId: 'user-1',
        agentId: 'agent-1',
        agentCanOpenPullRequests: true,
        repositoryId: 'ever-works/directory-web-template',
        branch: 'task/tsk-9-task1',
        baseRef: 'develop',
        headSha: 'e'.repeat(40),
        primaryPrUrl: 'https://github.com/ever-works/ever-works/pull/10',
        summary: 'Consumed field X in the template.',
    });

    beforeEach(() => {
        works = { findById: jest.fn().mockResolvedValue(makeWork()) };
        tasks = {
            updateById: jest.fn().mockResolvedValue(undefined),
            findById: jest.fn().mockResolvedValue(makeTask()),
        };
        gitFacade = {
            getRepository: jest.fn().mockResolvedValue({ defaultBranch: 'develop', cloneUrl: '' }),
            createPullRequest: jest.fn().mockResolvedValue({
                number: 42,
                url: 'https://github.com/ever-works/directory-web-template/pull/42',
            }),
        };
        attachments = { listEnabledForAgentWithRepos: jest.fn().mockResolvedValue([attachment()]) };
    });

    it('opens the pull request in the mounted repository, cross-linked to the primary, and records it', async () => {
        const outcome = await build().finalizeMountPush(base());

        expect(outcome).toEqual({
            repositoryId: 'ever-works/directory-web-template',
            outcome: 'pr-opened',
            prNumber: 42,
            prUrl: 'https://github.com/ever-works/directory-web-template/pull/42',
        });
        expect(gitFacade.createPullRequest).toHaveBeenCalledWith(
            expect.objectContaining({
                owner: 'ever-works',
                repo: 'directory-web-template',
                head: 'task/tsk-9-task1',
                base: 'develop',
                title: 'Task TSK-9: Add field X (ever-works/directory-web-template)',
                body: expect.stringContaining(
                    'Part of https://github.com/ever-works/ever-works/pull/10',
                ),
            }),
            { userId: 'user-1', providerId: 'github', workId: 'work-1' },
        );
        expect(tasks.updateById).toHaveBeenCalledWith('task-1', {
            linkedPullRequests: [
                expect.objectContaining({
                    repositoryId: 'ever-works/directory-web-template',
                    branch: 'task/tsk-9-task1',
                    baseRef: 'develop',
                    headSha: 'e'.repeat(40),
                    prNumber: 42,
                    prUrl: 'https://github.com/ever-works/directory-web-template/pull/42',
                    state: 'pr-open',
                    error: null,
                }),
            ],
        });
    });

    it('upserts by repository so a re-run replaces the entry instead of duplicating it', async () => {
        tasks.findById.mockResolvedValue(
            makeTask({
                linkedPullRequests: [
                    {
                        repositoryId: 'Ever-Works/Directory-Web-Template',
                        branch: 'task/tsk-9-task1',
                        baseRef: 'develop',
                        headSha: 'a'.repeat(40),
                        prNumber: null,
                        prUrl: null,
                        state: 'failed',
                        error: 'earlier failure',
                        updatedAt: '2026-09-01T00:00:00.000Z',
                    },
                    {
                        repositoryId: 'ever-works/workspace',
                        branch: 'task/tsk-9-task1',
                        baseRef: 'main',
                        headSha: null,
                        prNumber: 7,
                        prUrl: 'https://github.com/ever-works/workspace/pull/7',
                        state: 'pr-open',
                        error: null,
                        updatedAt: '2026-09-01T00:00:00.000Z',
                    },
                ],
            }),
        );
        await build().finalizeMountPush(base());
        const [, patch] = tasks.updateById.mock.calls[0];
        expect(patch.linkedPullRequests).toHaveLength(2);
        expect(
            patch.linkedPullRequests.map((entry: { repositoryId: string; state: string }) => [
                entry.repositoryId,
                entry.state,
            ]),
        ).toEqual([
            ['ever-works/workspace', 'pr-open'],
            ['ever-works/directory-web-template', 'pr-open'],
        ]);
    });

    it('records the pushed branch without a pull request when the agent may not open one', async () => {
        const outcome = await build().finalizeMountPush({
            ...base(),
            agentCanOpenPullRequests: false,
        });
        expect(outcome).toEqual({
            repositoryId: 'ever-works/directory-web-template',
            outcome: 'pushed-no-pr',
        });
        expect(gitFacade.createPullRequest).not.toHaveBeenCalled();
        expect(tasks.updateById).toHaveBeenCalledWith('task-1', {
            linkedPullRequests: [
                expect.objectContaining({ state: 'pushed', prNumber: null, prUrl: null }),
            ],
        });
    });

    it('records a provider failure on the Task instead of throwing (the branch is already pushed)', async () => {
        gitFacade.createPullRequest.mockRejectedValue(new Error('403: resource not accessible'));
        const outcome = await build().finalizeMountPush(base());
        expect(outcome).toEqual({
            repositoryId: 'ever-works/directory-web-template',
            outcome: 'failed',
            error: '403: resource not accessible',
        });
        expect(tasks.updateById).toHaveBeenCalledWith('task-1', {
            linkedPullRequests: [
                expect.objectContaining({
                    state: 'failed',
                    error: '403: resource not accessible',
                    prUrl: null,
                }),
            ],
        });
    });

    it('falls back to the Work git provider when the attachment is gone', async () => {
        attachments.listEnabledForAgentWithRepos.mockResolvedValue([]);
        await build().finalizeMountPush({ ...base(), baseRef: null });
        expect(gitFacade.getRepository).toHaveBeenCalledWith(
            'ever-works',
            'directory-web-template',
            {
                userId: 'user-1',
                providerId: 'github',
                workId: 'work-1',
            },
        );
        expect(gitFacade.createPullRequest).toHaveBeenCalledWith(
            expect.objectContaining({ base: 'develop' }),
            expect.objectContaining({ providerId: 'github' }),
        );
    });
});
