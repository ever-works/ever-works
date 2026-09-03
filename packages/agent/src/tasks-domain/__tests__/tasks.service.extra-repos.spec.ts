import { BadRequestException } from '@nestjs/common';
import { TasksService } from '../tasks.service';

/**
 * Multi-repo Task workspaces (self-build slice C, PR C2) — the Task's own
 * extra repositories are validated on create and update: every connection
 * must belong to the Task OWNER and be enabled, describe an owner/repository
 * URL, the EFFECTIVE mount directory (explicit or derived from the
 * connection) must pass the fleet gate and be unique, two connections may
 * not point at one repository, at most eight entries. The service is built
 * positionally with the repository-registry double in the LAST constructor
 * slot (the arity rule every TasksService spec follows).
 */
function makeService(
    repoConnections: { findByIdAndUser: jest.Mock } | undefined,
    taskRow: Record<string, unknown> = { id: 'task-1', title: 'T', userId: 'user-1' },
) {
    const created: Array<Record<string, unknown>> = [];
    const patches: Array<Record<string, unknown>> = [];
    const tasks = {
        create: jest.fn(async (data: Record<string, unknown>) => {
            created.push(data);
            return { id: 'task-new', slug: 'TSK-1', title: data.title, ...data };
        }),
        findById: jest.fn().mockResolvedValue(taskRow),
        findByIdAndUser: jest.fn().mockResolvedValue(taskRow),
        updateById: jest.fn(async (_id: string, patch: Record<string, unknown>) => {
            patches.push(patch);
        }),
        wouldCreateCycle: jest.fn().mockResolvedValue(false),
        findByUserIdFiltered: jest.fn().mockResolvedValue({ rows: [], total: 0 }),
    };
    const counter = {
        next: jest.fn().mockResolvedValue(1),
        nextSlug: jest.fn().mockResolvedValue('TSK-1'),
    };
    const args: unknown[] = new Array(TasksService.length).fill(undefined);
    args[0] = tasks;
    args[1] = { removeForTask: jest.fn(), listForTask: jest.fn().mockResolvedValue([]) };
    args[2] = { removeForTask: jest.fn(), listForTask: jest.fn().mockResolvedValue([]) };
    args[3] = { removeForTask: jest.fn(), listForTask: jest.fn().mockResolvedValue([]) };
    args[4] = { removeForTask: jest.fn(), listForTask: jest.fn().mockResolvedValue([]) };
    args[5] = { removeForTask: jest.fn(), listForTask: jest.fn().mockResolvedValue([]) };
    args[6] = counter;
    args[7] = { transition: jest.fn() };
    args[args.length - 1] = repoConnections;
    const service = new (TasksService as unknown as new (...a: unknown[]) => TasksService)(...args);
    return { service, tasks, created, patches };
}

/** A registry row; the URL and name derive from the id so two ids never collide by accident. */
const connection = (over: Record<string, unknown> = {}) => {
    const id = typeof over.id === 'string' ? over.id : 'conn-1';
    return {
        id,
        userId: 'user-1',
        name: id,
        url: `https://github.com/ever-works/${id}.git`,
        mountPath: null,
        provider: 'github',
        enabled: true,
        ...over,
    };
};

/** A registry answering every id with its own row (plus per-id overrides). */
const registry = (overrides: Record<string, Record<string, unknown>> = {}) => ({
    findByIdAndUser: jest.fn(async (id: string) => connection({ id, ...(overrides[id] ?? {}) })),
});

describe('TasksService — extraRepos (multi-repo Task workspaces, PR C2)', () => {
    it('stores validated, trimmed entries on create and passes through omitted options', async () => {
        const repoConnections = registry();
        const { service, created } = makeService(repoConnections);

        await service.create('user-1', {
            title: 'Add field X',
            extraRepos: [
                { repoConnectionId: ' conn-1 ', mountDir: ' tpl ' },
                { repoConnectionId: 'conn-2', writable: false },
            ],
        } as never);

        expect(repoConnections.findByIdAndUser).toHaveBeenCalledWith('conn-1', 'user-1');
        expect(created[0]?.extraRepos).toEqual([
            { repoConnectionId: 'conn-1', mountDir: 'tpl' },
            { repoConnectionId: 'conn-2', writable: false },
        ]);
    });

    it('stores null for an empty list and leaves extraRepos alone when the update omits it', async () => {
        const { service, created, patches } = makeService(registry());

        await service.create('user-1', { title: 'Nothing extra', extraRepos: [] } as never);
        expect(created[0]?.extraRepos).toBeNull();

        await service.update('user-1', 'task-1', { title: 'Renamed' } as never);
        expect(patches[0]).not.toHaveProperty('extraRepos');

        await service.update('user-1', 'task-1', { extraRepos: null } as never);
        expect(patches[1]?.extraRepos).toBeNull();
    });

    it('refuses a connection the caller does not own or that is disabled', async () => {
        const repoConnections = { findByIdAndUser: jest.fn().mockResolvedValue(null) };
        const { service } = makeService(repoConnections);
        await expect(
            service.create('user-1', {
                title: 'T',
                extraRepos: [{ repoConnectionId: 'conn-9' }],
            } as never),
        ).rejects.toThrow(new BadRequestException('Repository connection conn-9 not found.'));

        repoConnections.findByIdAndUser.mockResolvedValue(connection({ enabled: false }));
        await expect(
            service.create('user-1', {
                title: 'T',
                extraRepos: [{ repoConnectionId: 'conn-1' }],
            } as never),
        ).rejects.toThrow(/is disabled/);
    });

    it.each([
        ['a path', 'tools/template'],
        ['a leading dot', '.hidden'],
        ['.git', '.git'],
        ['.mounts', '.mounts'],
        ['a space', 'my template'],
        // Windows strips trailing dots: `api.` and `api` would be one directory.
        ['a trailing dot', 'api.'],
        // Windows device names cannot be created at all.
        ['a Windows device name', 'NUL'],
        ['a Windows device name with an extension', 'com1.txt'],
    ])('refuses a mount directory that is %s', async (_label, mountDir) => {
        const { service } = makeService(registry());
        await expect(
            service.create('user-1', {
                title: 'T',
                extraRepos: [{ repoConnectionId: 'conn-1', mountDir }],
            } as never),
        ).rejects.toThrow(/must be a single directory name/);
    });

    it('refuses duplicate connections, duplicate directories (case-insensitively) and more than eight entries', async () => {
        const { service } = makeService(registry());
        await expect(
            service.create('user-1', {
                title: 'T',
                extraRepos: [{ repoConnectionId: 'conn-1' }, { repoConnectionId: 'conn-1' }],
            } as never),
        ).rejects.toThrow(/listed twice/);
        await expect(
            service.create('user-1', {
                title: 'T',
                extraRepos: [
                    { repoConnectionId: 'conn-1', mountDir: 'Shared' },
                    { repoConnectionId: 'conn-2', mountDir: 'shared' },
                ],
            } as never),
        ).rejects.toThrow(/is used twice/);
        await expect(
            service.create('user-1', {
                title: 'T',
                extraRepos: Array.from({ length: 9 }, (_, index) => ({
                    repoConnectionId: `conn-${index}`,
                })),
            } as never),
        ).rejects.toThrow(/at most 8/);
    });

    it('refuses two connections whose DERIVED directories collide, and an explicit one colliding with a derived one', async () => {
        // `org-a/api` and `org-b/api`, both named `api`: no explicit mountDir
        // anywhere, yet they would land in the same `.mounts/api`.
        const { service } = makeService(
            registry({
                'conn-a': { name: 'api', url: 'https://github.com/org-a/api.git' },
                'conn-b': { name: 'API', url: 'https://github.com/org-b/api.git' },
            }),
        );
        await expect(
            service.create('user-1', {
                title: 'T',
                extraRepos: [{ repoConnectionId: 'conn-a' }, { repoConnectionId: 'conn-b' }],
            } as never),
        ).rejects.toThrow(/mount directory 'API' is used twice \(api and API\)/);

        await expect(
            service.create('user-1', {
                title: 'T',
                extraRepos: [
                    { repoConnectionId: 'conn-1', mountDir: 'api' },
                    { repoConnectionId: 'conn-a' },
                ],
            } as never),
        ).rejects.toThrow(/mount directory 'api' is used twice \(conn-1 and api\)/);
    });

    it('refuses two connections that point at the same repository', async () => {
        const { service } = makeService(
            registry({
                'conn-a': { url: 'https://github.com/ever-works/website.git' },
                'conn-b': { url: 'https://github.com/Ever-Works/Website' },
            }),
        );
        await expect(
            service.create('user-1', {
                title: 'T',
                extraRepos: [{ repoConnectionId: 'conn-a' }, { repoConnectionId: 'conn-b' }],
            } as never),
        ).rejects.toThrow(/conn-a and conn-b both point at Ever-Works\/Website/);
    });

    it('refuses a connection whose derived mount directory would fail the fleet gate, naming it', async () => {
        const { service } = makeService(registry({ 'conn-1': { name: 'dot', mountPath: '.git' } }));
        await expect(
            service.create('user-1', {
                title: 'T',
                extraRepos: [{ repoConnectionId: 'conn-1' }],
            } as never),
        ).rejects.toThrow(
            /Repository connection dot would be mounted at '\.git'.*Set an explicit mountDir/,
        );

        // An explicit directory repairs it without touching the registry.
        const { service: repaired, created } = makeService(
            registry({ 'conn-1': { name: 'dot', mountPath: '.git' } }),
        );
        await repaired.create('user-1', {
            title: 'T',
            extraRepos: [{ repoConnectionId: 'conn-1', mountDir: 'dot' }],
        } as never);
        expect(created[0]?.extraRepos).toEqual([{ repoConnectionId: 'conn-1', mountDir: 'dot' }]);
    });

    it('refuses a connection whose URL is not owner/repository (the plan could never mount it)', async () => {
        const { service } = makeService(
            registry({ 'conn-1': { url: 'https://git.example.com/deep/nested/path.git' } }),
        );
        await expect(
            service.create('user-1', {
                title: 'T',
                extraRepos: [{ repoConnectionId: 'conn-1' }],
            } as never),
        ).rejects.toThrow(/conn-1 cannot be mounted on a fleet run/);
    });

    it('validates an update against the Task OWNER, refusing an editor’s own connection with a clear message', async () => {
        const repoConnections = {
            findByIdAndUser: jest.fn(async (id: string, userId: string) =>
                userId === 'owner-1' ? null : connection({ id, userId }),
            ),
        };
        const { service } = makeService(repoConnections, {
            id: 'task-1',
            title: 'T',
            userId: 'owner-1',
        });
        await expect(
            service.update('member-2', 'task-1', {
                extraRepos: [{ repoConnectionId: 'conn-1' }],
            } as never),
        ).rejects.toThrow(/must be connections in the Task owner's repository registry/);
        expect(repoConnections.findByIdAndUser).toHaveBeenCalledWith('conn-1', 'owner-1');
        expect(repoConnections.findByIdAndUser).not.toHaveBeenCalledWith('conn-1', 'member-2');
    });

    it('refuses extra repositories outright when the registry is not available', async () => {
        const { service } = makeService(undefined);
        await expect(
            service.create('user-1', {
                title: 'T',
                extraRepos: [{ repoConnectionId: 'conn-1' }],
            } as never),
        ).rejects.toThrow(/repository registry is not configured/);
    });
});
