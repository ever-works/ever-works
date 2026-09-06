import type { Task } from '../../entities/task.entity';
import { TaskWorkspaceService } from '../task-workspace.service';

/** Constructor slots, so the doubles are typed against the real contracts. */
type ServiceArgs = ConstructorParameters<typeof TaskWorkspaceService>;

/**
 * Run secrets on the PLANNING side (self-build slice Y, EW-781).
 *
 * The property this file exists for: a fleet workspace spec names WHICH
 * repository's env files a run needs and at WHICH paths, and carries no
 * content whatsoever. Every assertion below therefore also checks the
 * sentinel is absent from the serialized spec — a future refactor that
 * "helpfully" attaches the decrypted contents would pass a shape check
 * and fail here.
 *
 * The second property is the grant union: grants are bound per repository
 * (the operator binds them to something they own) but a run is ONE
 * process tree over one workspace, so their effect is per run. That is
 * the trade the docs have to state plainly, and it is pinned here.
 */

const SENTINEL = 'sentinel-3b70-DATABASE_URL=postgres://u:p@db/app';

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
        envGrants: null,
        ...over,
    };
}

describe('TaskWorkspaceService — run secrets by reference', () => {
    let works: { findById: jest.Mock };
    let tasks: { updateById: jest.Mock; findById: jest.Mock };
    let gitFacade: { getRepository: jest.Mock };
    let attachments: { listEnabledForAgentWithRepos: jest.Mock };
    let repoConnections: { findByIdAndUser: jest.Mock; listByUser: jest.Mock };

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

    beforeEach(() => {
        works = { findById: jest.fn().mockResolvedValue(work) };
        tasks = { updateById: jest.fn().mockResolvedValue(undefined), findById: jest.fn() };
        gitFacade = {
            getRepository: jest.fn(async (owner: string, repo: string) => ({
                defaultBranch: 'develop',
                cloneUrl: `https://github.com/${owner}/${repo}.git`,
            })),
        };
        attachments = { listEnabledForAgentWithRepos: jest.fn().mockResolvedValue([]) };
        repoConnections = {
            findByIdAndUser: jest.fn().mockResolvedValue(connection()),
            listByUser: jest.fn().mockResolvedValue([]),
        };
    });

    it('emits no reference at all when nothing declares env files (every pre-slice Task)', async () => {
        const spec = await build().describeFleetWorkspace({ task: makeTask(), userId: 'user-1' });
        expect(spec).not.toHaveProperty('envFilesRef');
    });

    it('resolves the PRIMARY repository through a registry row with the same clone URL', async () => {
        // The primary of a Task is a Work repository, not a registry row, so
        // without this the one repository that matters most — the platform
        // building itself — would silently get nothing.
        repoConnections.listByUser.mockResolvedValue([
            connection({
                id: 'conn-primary',
                url: 'https://github.com/ever-works/ever-works.git',
                name: 'platform',
                envFiles: { 'apps/api/.env': SENTINEL, '.env': SENTINEL },
            }),
        ]);
        const spec = await build().describeFleetWorkspace({ task: makeTask(), userId: 'user-1' });
        expect(spec?.envFilesRef).toEqual([
            { repoConnectionId: 'conn-primary', paths: ['apps/api/.env', '.env'] },
        ]);
        expect(JSON.stringify(spec)).not.toContain(SENTINEL);
    });

    it('emits a reference per MOUNT, tagged with the directory it lands in', async () => {
        attachments.listEnabledForAgentWithRepos.mockResolvedValue([
            {
                repoConnection: connection({
                    id: 'conn-1',
                    url: 'https://github.com/ever-works/directory-web-template.git',
                    name: 'directory-web-template',
                    envFiles: { '.env.local': SENTINEL },
                }),
            },
        ]);
        const spec = await build().describeFleetWorkspace({
            task: makeTask(),
            userId: 'user-1',
            agentId: 'agent-1',
        });
        expect(spec?.envFilesRef).toEqual([
            {
                repoConnectionId: 'conn-1',
                mountDir: 'directory-web-template',
                paths: ['.env.local'],
            },
        ]);
        expect(JSON.stringify(spec)).not.toContain(SENTINEL);
    });

    it('refuses the plan when two enabled rows claim the Task primary repository', async () => {
        // Picking one by listing order would make "whose `.env` landed in the
        // checkout" a matter of luck.
        repoConnections.listByUser.mockResolvedValue([
            connection({
                id: 'a',
                name: 'platform',
                url: 'https://github.com/ever-works/ever-works.git',
                envFiles: { '.env': SENTINEL },
            }),
            connection({
                id: 'b',
                name: 'platform-copy',
                url: 'git@github.com:ever-works/ever-works.git',
                envFiles: { '.env': SENTINEL },
            }),
        ]);
        await expect(
            build().describeFleetWorkspace({ task: makeTask(), userId: 'user-1' }),
        ).rejects.toThrow(/disable or remove all but one/);
    });

    it('fails the plan when the registry cannot be READ, rather than delivering nothing', async () => {
        repoConnections.listByUser.mockRejectedValue(new Error('db down'));
        await expect(
            build().describeFleetWorkspace({ task: makeTask(), userId: 'user-1' }),
        ).rejects.toThrow(/could not be matched against the repository registry/);
    });

    it('ignores a DISABLED registry row for the primary', async () => {
        repoConnections.listByUser.mockResolvedValue([
            connection({
                id: 'conn-primary',
                url: 'https://github.com/ever-works/ever-works.git',
                enabled: false,
                envFiles: { '.env': SENTINEL },
            }),
        ]);
        const spec = await build().describeFleetWorkspace({ task: makeTask(), userId: 'user-1' });
        expect(spec).not.toHaveProperty('envFilesRef');
    });
});

describe('TaskWorkspaceService.resolveFleetRunEnvGrants', () => {
    let works: { findById: jest.Mock };
    let attachments: { listEnabledForAgentWithRepos: jest.Mock };
    let repoConnections: { findByIdAndUser: jest.Mock; listByUser: jest.Mock };

    const build = () =>
        new TaskWorkspaceService(
            works as unknown as ServiceArgs[0],
            { updateById: jest.fn(), findById: jest.fn() } as unknown as ServiceArgs[1],
            {} as unknown as ServiceArgs[2],
            {} as unknown as ServiceArgs[3],
            {} as unknown as ServiceArgs[4],
            undefined,
            undefined,
            undefined,
            undefined,
            attachments as unknown as ServiceArgs[9],
            repoConnections as unknown as ServiceArgs[10],
        );

    beforeEach(() => {
        works = { findById: jest.fn().mockResolvedValue(work) };
        attachments = { listEnabledForAgentWithRepos: jest.fn().mockResolvedValue([]) };
        repoConnections = {
            findByIdAndUser: jest.fn().mockResolvedValue(null),
            listByUser: jest.fn().mockResolvedValue([]),
        };
    });

    it('grants nothing by default, which is the pre-slice refusal', async () => {
        await expect(
            build().resolveFleetRunEnvGrants({ task: makeTask(), userId: 'user-1' }),
        ).resolves.toEqual([]);
    });

    it('UNIONS the grants of every repository in the run (one workspace, one process tree)', async () => {
        repoConnections.listByUser.mockResolvedValue([
            connection({
                id: 'conn-primary',
                url: 'https://github.com/ever-works/ever-works.git',
                envGrants: ['DATABASE_URL'],
            }),
        ]);
        attachments.listEnabledForAgentWithRepos.mockResolvedValue([
            {
                repoConnection: connection({
                    id: 'conn-1',
                    url: 'https://github.com/ever-works/directory-web-template.git',
                    envGrants: ['GH_TOKEN', 'DATABASE_URL'],
                }),
            },
        ]);
        await expect(
            build().resolveFleetRunEnvGrants({
                task: makeTask(),
                userId: 'user-1',
                agentId: 'agent-1',
            }),
        ).resolves.toEqual(['GH_TOKEN', 'DATABASE_URL']);
    });

    it('drops an ungrantable name even if a row somehow carries one', async () => {
        repoConnections.listByUser.mockResolvedValue([
            connection({
                id: 'conn-primary',
                url: 'https://github.com/ever-works/ever-works.git',
                envGrants: ['FLEET_NODE_SECRET', 'DATABASE_URL', '*'],
            }),
        ]);
        await expect(
            build().resolveFleetRunEnvGrants({ task: makeTask(), userId: 'user-1' }),
        ).resolves.toEqual(['DATABASE_URL']);
    });

    it('REVOKES on the next run: a cleared list stops appearing in the plan', async () => {
        repoConnections.listByUser.mockResolvedValue([
            connection({
                id: 'conn-primary',
                url: 'https://github.com/ever-works/ever-works.git',
                envGrants: ['DATABASE_URL'],
            }),
        ]);
        const service = build();
        await expect(
            service.resolveFleetRunEnvGrants({ task: makeTask(), userId: 'user-1' }),
        ).resolves.toEqual(['DATABASE_URL']);

        // The operator clears the grant; grants are read when the job is
        // PLANNED, so the very next run is planned without it. Nothing has
        // to reach the machines.
        repoConnections.listByUser.mockResolvedValue([
            connection({
                id: 'conn-primary',
                url: 'https://github.com/ever-works/ever-works.git',
                envGrants: null,
            }),
        ]);
        await expect(
            service.resolveFleetRunEnvGrants({ task: makeTask(), userId: 'user-1' }),
        ).resolves.toEqual([]);
    });
});
