import { BadRequestException } from '@nestjs/common';
import { TasksService } from '../tasks.service';

/**
 * Multi-repo Task workspaces (self-build slice C, PR C2) — the Task's own
 * extra repositories are validated on create and update: every connection
 * must belong to the caller and be enabled, mount directories must be
 * single safe names and unique, at most eight entries. The service is
 * built positionally with the repository-registry double in the LAST
 * constructor slot (the arity rule every TasksService spec follows).
 */
function makeService(repoConnections: { findByIdAndUser: jest.Mock } | undefined) {
    const created: Array<Record<string, unknown>> = [];
    const patches: Array<Record<string, unknown>> = [];
    const tasks = {
        create: jest.fn(async (data: Record<string, unknown>) => {
            created.push(data);
            return { id: 'task-new', slug: 'TSK-1', title: data.title, ...data };
        }),
        findById: jest.fn().mockResolvedValue({ id: 'task-1', title: 'T', userId: 'user-1' }),
        findByIdAndUser: jest
            .fn()
            .mockResolvedValue({ id: 'task-1', title: 'T', userId: 'user-1' }),
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

const connection = (over: Record<string, unknown> = {}) => ({
    id: 'conn-1',
    userId: 'user-1',
    name: 'directory-web-template',
    enabled: true,
    ...over,
});

describe('TasksService — extraRepos (multi-repo Task workspaces, PR C2)', () => {
    it('stores validated, trimmed entries on create and passes through omitted options', async () => {
        const repoConnections = { findByIdAndUser: jest.fn().mockResolvedValue(connection()) };
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
        const repoConnections = { findByIdAndUser: jest.fn().mockResolvedValue(connection()) };
        const { service, created, patches } = makeService(repoConnections);

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
    ])('refuses a mount directory that is %s', async (_label, mountDir) => {
        const { service } = makeService({
            findByIdAndUser: jest.fn().mockResolvedValue(connection()),
        });
        await expect(
            service.create('user-1', {
                title: 'T',
                extraRepos: [{ repoConnectionId: 'conn-1', mountDir }],
            } as never),
        ).rejects.toThrow(/must be a single directory name/);
    });

    it('refuses duplicate connections, duplicate directories (case-insensitively) and more than eight entries', async () => {
        const { service } = makeService({
            findByIdAndUser: jest.fn().mockResolvedValue(connection()),
        });
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
