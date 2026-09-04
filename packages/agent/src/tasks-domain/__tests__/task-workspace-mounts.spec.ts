import type { Task } from '../../entities/task.entity';
import {
    TaskWorkspaceService,
    credentialFreeUrlForMessages,
    repositoryIdFromCloneUrl,
} from '../task-workspace.service';

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

describe('credentialFreeUrlForMessages', () => {
    it.each([
        [
            'https://x-access-token:ghp_secret@github.com/group/sub/repo.git',
            'https://github.com/group/sub/repo.git',
        ],
        [
            'https://ghp_secret@github.com/group/sub/repo.git',
            'https://github.com/group/sub/repo.git',
        ],
        ['ssh://git:pw@gitlab.com/group/sub/project.git', 'ssh://gitlab.com/group/sub/project.git'],
        ['ghp_secret@github.com:group/sub/repo.git', 'github.com:group/sub/repo.git'],
        [
            'https://github.com/ever-works/ever-works.git',
            'https://github.com/ever-works/ever-works.git',
        ],
        ['x-access-token:ghp_secret@github.com:group/repo', '<unparseable URL>'],
        ['not a url', '<unparseable URL>'],
        ['', '<no URL>'],
    ])('never echoes userinfo: %s', (url, expected) => {
        expect(credentialFreeUrlForMessages(url)).toBe(expected);
        expect(credentialFreeUrlForMessages(url)).not.toContain('ghp_secret');
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

    it('does not echo a credential-bearing URL into the refusal (it lands on the run and in the logs)', async () => {
        attachments.listEnabledForAgentWithRepos.mockResolvedValue([
            attachment({
                url: 'https://x-access-token:ghp_secret@git.example.com/deep/nested/path.git',
                name: 'weird',
            }),
        ]);
        let message = '';
        try {
            await build().describeFleetWorkspace({
                task: makeTask(),
                userId: 'user-1',
                agentId: 'agent-1',
            });
        } catch (error) {
            message = error instanceof Error ? error.message : String(error);
        }
        expect(message).toMatch(/conn-1 .*cannot be mounted/);
        expect(message).toContain('https://git.example.com/deep/nested/path.git');
        expect(message).not.toContain('ghp_secret');
        expect(message).not.toContain('x-access-token');
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

    it('re-records an already-open pull request on a re-run instead of asking the provider for another', async () => {
        // Second fleet run of the same Task: the branch behind PR #42 was
        // just updated. The provider would answer 422 "already exists" and
        // the failure would have REPLACED the link with a `failed` entry.
        tasks.findById.mockResolvedValue(
            makeTask({
                linkedPullRequests: [
                    {
                        repositoryId: 'Ever-Works/Directory-Web-Template',
                        branch: 'task/tsk-9-task1',
                        baseRef: 'develop',
                        headSha: 'a'.repeat(40),
                        prNumber: 42,
                        prUrl: 'https://github.com/ever-works/directory-web-template/pull/42',
                        state: 'pr-open',
                        error: null,
                        updatedAt: '2026-09-01T00:00:00.000Z',
                    },
                ],
            }),
        );
        gitFacade.createPullRequest.mockRejectedValue(
            new Error('422: A pull request already exists'),
        );

        const outcome = await build().finalizeMountPush({ ...base(), headSha: 'f'.repeat(40) });

        expect(outcome).toEqual({
            repositoryId: 'ever-works/directory-web-template',
            outcome: 'pr-opened',
            prNumber: 42,
            prUrl: 'https://github.com/ever-works/directory-web-template/pull/42',
        });
        expect(gitFacade.createPullRequest).not.toHaveBeenCalled();
        expect(tasks.updateById).toHaveBeenCalledWith('task-1', {
            linkedPullRequests: [
                expect.objectContaining({
                    repositoryId: 'ever-works/directory-web-template',
                    state: 'pr-open',
                    prNumber: 42,
                    prUrl: 'https://github.com/ever-works/directory-web-template/pull/42',
                    headSha: 'f'.repeat(40),
                    error: null,
                }),
            ],
        });
    });

    it('still opens a pull request when the recorded one is for another branch, failed, or only pushed', async () => {
        for (const prior of [
            {
                branch: 'task/tsk-9-old',
                state: 'pr-open' as const,
                prNumber: 41,
                prUrl: 'https://x/pull/41',
            },
            { branch: 'task/tsk-9-task1', state: 'failed' as const, prNumber: null, prUrl: null },
            { branch: 'task/tsk-9-task1', state: 'pushed' as const, prNumber: null, prUrl: null },
        ]) {
            gitFacade.createPullRequest.mockClear();
            tasks.findById.mockResolvedValue(
                makeTask({
                    linkedPullRequests: [
                        {
                            repositoryId: 'ever-works/directory-web-template',
                            baseRef: 'develop',
                            headSha: null,
                            error: null,
                            updatedAt: '2026-09-01T00:00:00.000Z',
                            ...prior,
                        },
                    ],
                }),
            );
            const outcome = await build().finalizeMountPush(base());
            expect(outcome).toMatchObject({ outcome: 'pr-opened', prNumber: 42 });
            expect(gitFacade.createPullRequest).toHaveBeenCalledTimes(1);
        }
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

/**
 * Multi-repo Task workspaces (self-build slice C) meet the M6 "Discard
 * branch" escape hatch.
 *
 * `taskBranchName` is a pure function of the Task id and slug, so the next
 * run recomputes the SAME branch in EVERY repository the Task spans. A
 * discard that resets only the primary therefore leaves the mount branch
 * AND its recorded `pr-open` entry alive, and the next run's mount commits
 * land straight back in the pull request the operator threw away.
 */
describe('TaskWorkspaceService discard reaches every repository the Task pushed', () => {
    type Doubles = {
        works: { findById: jest.Mock };
        tasks: {
            findByIdAndUser: jest.Mock;
            findById: jest.Mock;
            updateById: jest.Mock;
            findBranchCleanupCandidates: jest.Mock;
        };
        gitFacade: { deleteBranch: jest.Mock };
        attachments: { listEnabledForAgentWithRepos: jest.Mock };
        repoConnections: { findByIdAndUser: jest.Mock };
    };

    let d: Doubles;

    /** Primary PR #10 open, mount PR #3 open, a second mount only pushed. */
    const multiRepoTask = () =>
        makeTask({
            agentId: 'agent-1',
            branchState: 'pr-open',
            prNumber: 10,
            prUrl: 'https://github.com/ever-works/ever-works/pull/10',
            extraRepos: [{ repoConnectionId: 'conn-2' }],
            linkedPullRequests: [
                {
                    repositoryId: 'ever-works/directory-web-template',
                    branch: 'task/tsk-9-task1',
                    baseRef: 'develop',
                    headSha: 'a'.repeat(40),
                    prNumber: 3,
                    prUrl: 'https://github.com/ever-works/directory-web-template/pull/3',
                    state: 'pr-open',
                    error: null,
                    updatedAt: '2026-09-01T00:00:00.000Z',
                },
                {
                    repositoryId: 'ever-works/workspace',
                    branch: 'task/tsk-9-task1',
                    baseRef: 'main',
                    headSha: 'b'.repeat(40),
                    prNumber: null,
                    prUrl: null,
                    state: 'pushed',
                    error: null,
                    updatedAt: '2026-09-01T00:00:00.000Z',
                },
            ],
        });

    const build = () =>
        new TaskWorkspaceService(
            d.works as unknown as ServiceArgs[0],
            d.tasks as unknown as ServiceArgs[1],
            {} as unknown as ServiceArgs[2],
            {} as unknown as ServiceArgs[3],
            d.gitFacade as unknown as ServiceArgs[4],
            undefined,
            undefined,
            undefined,
            undefined,
            d.attachments as unknown as ServiceArgs[9],
            d.repoConnections as unknown as ServiceArgs[10],
        );

    const deleted = () =>
        d.gitFacade.deleteBranch.mock.calls.map((call: unknown[]) => [
            `${call[0]}/${call[1]}`,
            call[2],
            (call[3] as { providerId: string }).providerId,
        ]);

    beforeEach(() => {
        const task = multiRepoTask();
        d = {
            works: {
                findById: jest
                    .fn()
                    .mockResolvedValue({ ...makeWork(), taskBranchCleanup: 'on-merge' }),
            },
            tasks: {
                findByIdAndUser: jest.fn().mockResolvedValue(task),
                findById: jest.fn().mockResolvedValue(task),
                updateById: jest.fn().mockResolvedValue(undefined),
                findBranchCleanupCandidates: jest.fn().mockResolvedValue([task]),
            },
            gitFacade: { deleteBranch: jest.fn().mockResolvedValue(undefined) },
            // The template mount is an agent attachment (provider `github`)…
            attachments: {
                listEnabledForAgentWithRepos: jest.fn().mockResolvedValue([attachment()]),
            },
            // …and `ever-works/workspace` is a Task extra on a GENERIC git
            // connection, so its own provider must be used, not the Work's.
            repoConnections: {
                findByIdAndUser: jest.fn().mockResolvedValue({
                    id: 'conn-2',
                    url: 'https://github.com/ever-works/workspace.git',
                    provider: 'git',
                }),
            },
        };
    });

    it('deletes every mount branch through its own provider and clears the links with the primary reset', async () => {
        await build().discardBranch('user-1', 'task-1');

        expect(deleted()).toEqual([
            ['ever-works/ever-works', 'task/tsk-9-task1', 'github'],
            ['ever-works/directory-web-template', 'task/tsk-9-task1', 'github'],
            ['ever-works/workspace', 'task/tsk-9-task1', 'git'],
        ]);
        expect(d.tasks.updateById).toHaveBeenCalledWith('task-1', {
            branchRef: null,
            branchState: 'discarded',
            baseSha: null,
            prNumber: null,
            prUrl: null,
            conflictPaths: null,
            linkedPullRequests: null,
        });
    });

    it('keeps going when one remote refuses, and still resets the Task', async () => {
        d.gitFacade.deleteBranch.mockImplementation((_owner: string, repo: string) =>
            repo === 'directory-web-template'
                ? Promise.reject(new Error('403: resource not accessible'))
                : Promise.resolve(undefined),
        );

        await expect(build().discardBranch('user-1', 'task-1')).resolves.toBeUndefined();

        expect(deleted().map((call) => call[0])).toEqual([
            'ever-works/ever-works',
            'ever-works/directory-web-template',
            'ever-works/workspace',
        ]);
        // The refused branch is STILL on its remote and its pull request is
        // still open — deleting the branch is what would have closed it. The
        // row is the only record of either, so clearing it here would trade a
        // recoverable leak for an unrecoverable one: after this patch
        // `branchRef` is null, so the branch cockpit is gone from the Task
        // page and `findBranchCleanupCandidates` will never look at the row
        // again. It survives, downgraded to `failed` with its PR link intact.
        expect(d.tasks.updateById).toHaveBeenCalledWith(
            'task-1',
            expect.objectContaining({
                branchState: 'discarded',
                linkedPullRequests: [
                    expect.objectContaining({
                        repositoryId: 'ever-works/directory-web-template',
                        branch: 'task/tsk-9-task1',
                        state: 'failed',
                        prNumber: 3,
                        prUrl: 'https://github.com/ever-works/directory-web-template/pull/3',
                        error: expect.stringContaining('403: resource not accessible'),
                    }),
                ],
            }),
        );
    });

    it('refuses to reuse the pull request of a branch whose delete failed', async () => {
        // The fence BD-1 exists for: the survivor above must not become the
        // `pr-open` entry a later run's mount push lands in. `failed` is the
        // one state `findOpenLinkedPullRequest` never matches.
        d.gitFacade.deleteBranch.mockRejectedValue(new Error('403: resource not accessible'));

        await build().discardBranch('user-1', 'task-1');

        const [, patch] = d.tasks.updateById.mock.calls[0] as [
            string,
            { linkedPullRequests: Array<{ state: string }> },
        ];
        expect(patch.linkedPullRequests).toHaveLength(2);
        expect(patch.linkedPullRequests.map((entry) => entry.state)).toEqual(['failed', 'failed']);
    });

    it('keeps no record for a mount branch that was already gone', async () => {
        // The common case, not an error: a mount branch merged under
        // auto-delete-on-merge, or a discard retried after a partial
        // failure. GitHub answers `deleteRef` for a missing ref with
        // "Reference does not exist" — that is a completed discard, and
        // leaving a `failed` entry behind would tell the operator a branch
        // is still live when it is not.
        d.gitFacade.deleteBranch.mockRejectedValue(
            new Error('Reference does not exist - https://docs.github.com/rest'),
        );

        await build().discardBranch('user-1', 'task-1');

        expect(d.tasks.updateById).toHaveBeenCalledWith(
            'task-1',
            expect.objectContaining({ linkedPullRequests: null }),
        );
    });

    it('keeps the record when the remote answers 404, which is also what a revoked token looks like', async () => {
        // The deliberate asymmetry: GitHub answers 404 both for "no such
        // branch" and for "your token cannot see this repository". Only the
        // second is a branch left behind, and the two are indistinguishable
        // from here — so an ambiguous failure keeps its record rather than
        // silently dropping a live branch and its open pull request.
        d.gitFacade.deleteBranch.mockRejectedValue(new Error('Not Found'));

        await build().discardBranch('user-1', 'task-1');

        const [, patch] = d.tasks.updateById.mock.calls[0] as [
            string,
            { linkedPullRequests: Array<{ state: string }> | null },
        ];
        expect(patch.linkedPullRequests).toHaveLength(2);
    });

    it('sweeps mount branches too, so a multi-repo Task cannot leak one branch per extra repository', async () => {
        const result = await build().sweepStaleBranches({ staleDays: 30 });

        expect(result).toEqual({ cleaned: 1 });
        expect(deleted()).toEqual([
            ['ever-works/ever-works', 'task/tsk-9-task1', 'github'],
            ['ever-works/directory-web-template', 'task/tsk-9-task1', 'github'],
            ['ever-works/workspace', 'task/tsk-9-task1', 'git'],
        ]);
        expect(d.tasks.updateById).toHaveBeenCalledWith('task-1', {
            branchState: 'cleaned',
            linkedPullRequests: null,
        });
    });

    it('leaves a malformed linked entry to a human instead of stranding the reset', async () => {
        const task = makeTask({
            agentId: 'agent-1',
            linkedPullRequests: [
                {
                    repositoryId: 'directory-web-template',
                    branch: 'task/tsk-9-task1',
                    baseRef: 'develop',
                    headSha: null,
                    prNumber: null,
                    prUrl: null,
                    state: 'pushed',
                    error: null,
                    updatedAt: '2026-09-01T00:00:00.000Z',
                },
            ],
        });
        d.tasks.findByIdAndUser.mockResolvedValue(task);

        await build().discardBranch('user-1', 'task-1');

        expect(deleted()).toEqual([['ever-works/ever-works', 'task/tsk-9-task1', 'github']]);
        // "Leaving it to a human" only works if the human can still see it:
        // the entry the discard could not parse is kept, marked failed, with
        // the reason in `error`.
        expect(d.tasks.updateById).toHaveBeenCalledWith(
            'task-1',
            expect.objectContaining({
                linkedPullRequests: [
                    expect.objectContaining({
                        repositoryId: 'directory-web-template',
                        state: 'failed',
                        error: expect.stringContaining('not a deletable'),
                    }),
                ],
            }),
        );
    });

    it('sweeps only what it actually deleted, so a refused branch keeps its record', async () => {
        // Worse here than in the interactive discard: the sweep KEEPS
        // `branchRef` and only flips the state to `cleaned`, so an
        // over-clearing sweep would leave the Task page rendering a branch
        // cockpit whose linked-pull-request list had just been emptied while
        // the branch and its PR were still live.
        d.gitFacade.deleteBranch.mockImplementation((_owner: string, repo: string) =>
            repo === 'workspace'
                ? Promise.reject(new Error('Delete branch not supported by this provider'))
                : Promise.resolve(undefined),
        );

        await expect(build().sweepStaleBranches({ staleDays: 30 })).resolves.toEqual({
            cleaned: 1,
        });

        expect(d.tasks.updateById).toHaveBeenCalledWith('task-1', {
            branchState: 'cleaned',
            linkedPullRequests: [
                expect.objectContaining({
                    repositoryId: 'ever-works/workspace',
                    state: 'failed',
                    error: expect.stringContaining('Delete branch not supported by this provider'),
                }),
            ],
        });
    });
});
