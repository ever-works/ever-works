import type { Task } from '../../entities/task.entity';
import { TaskWorkspaceService } from '../task-workspace.service';

/** Constructor slots, so the doubles are typed against the real contracts. */
type ServiceArgs = ConstructorParameters<typeof TaskWorkspaceService>;

/**
 * Multi-repo Task workspaces (self-build slice C, PR C2): a Task's own
 * `extraRepos` become fleet mounts AFTER the run agent's attachments and
 * win over them on the same repository or mount directory. Missing or
 * disabled connections fail the plan naming them.
 */

const work = {
    id: 'work-1',
    gitProvider: 'github',
    taskIsolationBaseBranch: null,
    getRepoOwner: () => 'ever-works',
    getDataRepo: () => 'ever-works',
};

function makeTask(over: Partial<Task> = {}): Task {
    return {
        id: 'task-1',
        slug: 'TSK-9',
        title: 'Add field X',
        userId: 'user-1',
        workId: 'work-1',
        branchRef: 'task/tsk-9-task1',
        branchState: 'created',
        extraRepos: null,
        ...over,
    } as unknown as Task;
}

function connection(over: Record<string, unknown> = {}) {
    return {
        id: 'conn-2',
        url: 'https://github.com/ever-works/website.git',
        defaultBranch: 'main',
        mountPath: null,
        name: 'website',
        provider: 'github',
        enabled: true,
        envFiles: null,
        ...over,
    };
}

describe('TaskWorkspaceService.describeFleetWorkspace — Task extraRepos', () => {
    let works: { findById: jest.Mock };
    let tasks: { updateById: jest.Mock; findById: jest.Mock };
    let gitFacade: { getRepository: jest.Mock };
    let attachments: { listEnabledForAgentWithRepos: jest.Mock };
    let repoConnections: { findByIdAndUser: jest.Mock };

    const build = (withRegistry = true) =>
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
            (withRegistry ? repoConnections : undefined) as unknown as ServiceArgs[10],
        );

    beforeEach(() => {
        works = { findById: jest.fn().mockResolvedValue(work) };
        tasks = { updateById: jest.fn().mockResolvedValue(undefined), findById: jest.fn() };
        gitFacade = {
            getRepository: jest.fn(async (owner: string, repo: string) => ({
                defaultBranch: 'develop',
                cloneUrl: `https://github.com/${owner}/${repo}.git`,
            })),
        };
        attachments = {
            listEnabledForAgentWithRepos: jest.fn().mockResolvedValue([
                {
                    repoConnection: {
                        id: 'conn-1',
                        url: 'https://github.com/ever-works/directory-web-template.git',
                        defaultBranch: 'develop',
                        mountPath: null,
                        name: 'directory-web-template',
                        provider: 'github',
                        enabled: true,
                        envFiles: null,
                    },
                },
            ]),
        };
        repoConnections = { findByIdAndUser: jest.fn().mockResolvedValue(connection()) };
    });

    it('appends the Task extras after the agent attachments, with their own directory and writability', async () => {
        const spec = await build().describeFleetWorkspace({
            task: makeTask({
                extraRepos: [{ repoConnectionId: 'conn-2', mountDir: 'site', writable: false }],
            }),
            userId: 'user-1',
            agentId: 'agent-1',
        });
        expect(repoConnections.findByIdAndUser).toHaveBeenCalledWith('conn-2', 'user-1');
        expect(spec?.mounts).toEqual([
            expect.objectContaining({
                repositoryId: 'ever-works/directory-web-template',
                mountDir: 'directory-web-template',
                writable: true,
            }),
            {
                repositoryId: 'ever-works/website',
                repoUrl: 'https://github.com/ever-works/website.git',
                baseRef: 'main',
                branch: 'task/tsk-9-task1',
                mountDir: 'site',
                writable: false,
            },
        ]);
    });

    it('lets a Task entry win over an agent attachment for the same repository', async () => {
        repoConnections.findByIdAndUser.mockResolvedValue(
            connection({
                id: 'conn-9',
                url: 'https://github.com/Ever-Works/Directory-Web-Template.git',
                name: 'template-again',
                mountPath: 'tpl',
            }),
        );
        const spec = await build().describeFleetWorkspace({
            task: makeTask({ extraRepos: [{ repoConnectionId: 'conn-9' }] }),
            userId: 'user-1',
            agentId: 'agent-1',
        });
        expect(spec?.mounts).toHaveLength(1);
        expect(spec?.mounts?.[0]).toMatchObject({
            repositoryId: 'Ever-Works/Directory-Web-Template',
            mountDir: 'tpl',
        });
    });

    it('works without any agent (Task extras alone) and asks the provider for a missing default branch', async () => {
        repoConnections.findByIdAndUser.mockResolvedValue(connection({ defaultBranch: null }));
        const spec = await build().describeFleetWorkspace({
            task: makeTask({ extraRepos: [{ repoConnectionId: 'conn-2' }] }),
            userId: 'user-1',
        });
        expect(attachments.listEnabledForAgentWithRepos).not.toHaveBeenCalled();
        expect(gitFacade.getRepository).toHaveBeenCalledWith('ever-works', 'website', {
            userId: 'user-1',
            providerId: 'github',
            workId: 'work-1',
        });
        expect(spec?.mounts?.[0]).toMatchObject({
            repositoryId: 'ever-works/website',
            baseRef: 'develop',
            mountDir: 'website',
            writable: true,
        });
    });

    it('skips an extra that is the primary repository', async () => {
        repoConnections.findByIdAndUser.mockResolvedValue(
            connection({ url: 'https://github.com/ever-works/ever-works.git', name: 'platform' }),
        );
        const spec = await build().describeFleetWorkspace({
            task: makeTask({ extraRepos: [{ repoConnectionId: 'conn-2' }] }),
            userId: 'user-1',
        });
        expect(spec?.mounts).toBeUndefined();
    });

    it.each([
        ['a missing connection', null, /no longer exists/],
        ['a disabled connection', connection({ enabled: false }), /is disabled/],
        [
            'an unparseable URL',
            connection({ url: 'https://git.example.com/a/b/c.git' }),
            /cannot be mounted/,
        ],
    ])('refuses %s, naming it', async (_label, row, message) => {
        repoConnections.findByIdAndUser.mockResolvedValue(row);
        await expect(
            build().describeFleetWorkspace({
                task: makeTask({ extraRepos: [{ repoConnectionId: 'conn-2' }] }),
                userId: 'user-1',
            }),
        ).rejects.toThrow(message);
    });

    it('refuses extras when the repository registry is not available', async () => {
        await expect(
            build(false).describeFleetWorkspace({
                task: makeTask({ extraRepos: [{ repoConnectionId: 'conn-2' }] }),
                userId: 'user-1',
            }),
        ).rejects.toThrow(/repository registry is not available/);
    });

    it('names the Task, not "Agent undefined", when only extras exist and no git facade is bound', async () => {
        const service = new TaskWorkspaceService(
            works as unknown as ServiceArgs[0],
            tasks as unknown as ServiceArgs[1],
            {} as unknown as ServiceArgs[2],
            {} as unknown as ServiceArgs[3],
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            attachments as unknown as ServiceArgs[9],
            repoConnections as unknown as ServiceArgs[10],
        );
        let message = '';
        try {
            // `describeFleetWorkspace` itself refuses without a facade; the
            // mount resolver's own message is what the planner would surface
            // for a runtime that binds the facade later, so call it directly.
            await (
                service as unknown as {
                    resolveFleetMounts: (input: unknown) => Promise<unknown>;
                }
            ).resolveFleetMounts({
                task: makeTask({ extraRepos: [{ repoConnectionId: 'conn-2' }] }),
                agentId: undefined,
                userId: 'user-1',
                workId: 'work-1',
                primaryRepositoryId: 'ever-works/ever-works',
                branch: 'task/tsk-9-task1',
            });
        } catch (error) {
            message = error instanceof Error ? error.message : String(error);
        }
        expect(message).toMatch(/^Task task-1 lists extra repositories but no git facade/);
        expect(message).not.toContain('undefined');
    });

    it('does not echo a credential-bearing connection URL into the refusal', async () => {
        repoConnections.findByIdAndUser.mockResolvedValue(
            connection({ url: 'https://x-access-token:ghp_secret@git.example.com/a/b/c.git' }),
        );
        let message = '';
        try {
            await build().describeFleetWorkspace({
                task: makeTask({ extraRepos: [{ repoConnectionId: 'conn-2' }] }),
                userId: 'user-1',
            });
        } catch (error) {
            message = error instanceof Error ? error.message : String(error);
        }
        expect(message).toMatch(/website .*cannot be mounted/);
        expect(message).toContain('https://git.example.com/a/b/c.git');
        expect(message).not.toContain('ghp_secret');
    });

    it('refuses two Task extras that would share a mount directory, naming both', async () => {
        // `org-a/api` and `org-b/api`, both named `api`: the derived
        // directory collides. Dropping one silently would run without a
        // repository the operator listed.
        repoConnections.findByIdAndUser.mockImplementation(async (id: string) =>
            connection({
                id,
                name: id === 'conn-a' ? 'api' : 'API',
                url: `https://github.com/${id === 'conn-a' ? 'org-a' : 'org-b'}/api.git`,
            }),
        );
        await expect(
            build().describeFleetWorkspace({
                task: makeTask({
                    extraRepos: [{ repoConnectionId: 'conn-a' }, { repoConnectionId: 'conn-b' }],
                }),
                userId: 'user-1',
            }),
        ).rejects.toThrow(
            /API \(org-b\/api at \.mounts\/API\) collides with api \(org-a\/api at \.mounts\/api\)/,
        );
    });

    it('refuses two Task extras that point at the same repository, even under distinct directories', async () => {
        repoConnections.findByIdAndUser.mockImplementation(async (id: string) =>
            connection({
                id,
                name: id,
                url: 'https://github.com/ever-works/website.git',
                mountPath: id,
            }),
        );
        await expect(
            build().describeFleetWorkspace({
                task: makeTask({
                    extraRepos: [{ repoConnectionId: 'conn-a' }, { repoConnectionId: 'conn-b' }],
                }),
                userId: 'user-1',
            }),
        ).rejects.toThrow(
            /conn-b \(ever-works\/website at \.mounts\/conn-b\) collides with conn-a/,
        );
    });

    it('lets a Task extra displace an agent attachment on the same mount directory, and keeps the rest', async () => {
        attachments.listEnabledForAgentWithRepos.mockResolvedValue([
            {
                repoConnection: {
                    id: 'conn-1',
                    url: 'https://github.com/ever-works/directory-web-template.git',
                    defaultBranch: 'develop',
                    mountPath: 'site',
                    name: 'directory-web-template',
                    provider: 'github',
                    enabled: true,
                    envFiles: null,
                },
            },
            {
                repoConnection: {
                    id: 'conn-3',
                    url: 'https://github.com/ever-works/workspace.git',
                    defaultBranch: 'main',
                    mountPath: 'kb',
                    name: 'workspace',
                    provider: 'github',
                    enabled: true,
                    envFiles: null,
                },
            },
        ]);
        const spec = await build().describeFleetWorkspace({
            task: makeTask({ extraRepos: [{ repoConnectionId: 'conn-2', mountDir: 'Site' }] }),
            userId: 'user-1',
            agentId: 'agent-1',
        });
        expect(spec?.mounts?.map((mount) => [mount.repositoryId, mount.mountDir])).toEqual([
            ['ever-works/workspace', 'kb'],
            ['ever-works/website', 'Site'],
        ]);
    });
});

describe('TaskWorkspaceService.finalizeMountPush — Task extraRepos', () => {
    let works: { findById: jest.Mock };
    let tasks: { updateById: jest.Mock; findById: jest.Mock };
    let gitFacade: { getRepository: jest.Mock; createPullRequest: jest.Mock };
    let attachments: { listEnabledForAgentWithRepos: jest.Mock };
    let repoConnections: { findByIdAndUser: jest.Mock };

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
            repoConnections as unknown as ServiceArgs[10],
        );

    const taskWithExtra = () =>
        makeTask({
            linkedPullRequests: null,
            extraRepos: [{ repoConnectionId: 'conn-2' }],
        } as Partial<Task>);

    const push = () => ({
        task: taskWithExtra(),
        userId: 'user-1',
        agentId: 'agent-1',
        agentCanOpenPullRequests: true,
        repositoryId: 'ever-works/website',
        branch: 'task/tsk-9-task1',
        baseRef: 'main',
        headSha: 'e'.repeat(40),
    });

    beforeEach(() => {
        works = { findById: jest.fn().mockResolvedValue(work) };
        tasks = {
            updateById: jest.fn().mockResolvedValue(undefined),
            findById: jest.fn(async () => taskWithExtra()),
        };
        gitFacade = {
            getRepository: jest.fn().mockResolvedValue({ defaultBranch: 'main', cloneUrl: '' }),
            createPullRequest: jest.fn().mockResolvedValue({
                number: 5,
                url: 'https://github.com/ever-works/website/pull/5',
            }),
        };
        // The repository reached the workspace through the Task, not the agent.
        attachments = { listEnabledForAgentWithRepos: jest.fn().mockResolvedValue([]) };
        repoConnections = { findByIdAndUser: jest.fn().mockResolvedValue(connection()) };
    });

    it('records `pushed` for an extra on a generic git connection instead of failing a pull request', async () => {
        repoConnections.findByIdAndUser.mockResolvedValue(connection({ provider: 'git' }));
        const outcome = await build().finalizeMountPush(push());
        expect(outcome).toEqual({ repositoryId: 'ever-works/website', outcome: 'pushed-no-pr' });
        expect(gitFacade.createPullRequest).not.toHaveBeenCalled();
        expect(tasks.updateById).toHaveBeenCalledWith('task-1', {
            linkedPullRequests: [expect.objectContaining({ state: 'pushed', prNumber: null })],
        });
    });

    it('opens the pull request through the extra connection’s own provider, not the Work’s', async () => {
        works.findById.mockResolvedValue({ ...work, gitProvider: 'git' });
        const outcome = await build().finalizeMountPush(push());
        expect(outcome).toMatchObject({ outcome: 'pr-opened', prNumber: 5 });
        expect(gitFacade.createPullRequest).toHaveBeenCalledWith(
            expect.objectContaining({ owner: 'ever-works', repo: 'website', base: 'main' }),
            { userId: 'user-1', providerId: 'github', workId: 'work-1' },
        );
        expect(repoConnections.findByIdAndUser).toHaveBeenCalledWith('conn-2', 'user-1');
    });

    it('still falls back to the Work provider when the extra is gone from the registry', async () => {
        repoConnections.findByIdAndUser.mockResolvedValue(null);
        await build().finalizeMountPush(push());
        expect(gitFacade.createPullRequest).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ providerId: 'github' }),
        );
    });
});
