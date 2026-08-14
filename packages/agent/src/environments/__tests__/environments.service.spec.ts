import {
    BadRequestException,
    ConflictException,
    NotFoundException,
} from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { EnvironmentsService, toRuntimeEnvironmentData } from '../environments.service';
import type { EnvironmentRepository } from '../environment.repository';
import type { Environment } from '../../entities/environment.entity';

/**
 * Environments — service-level CRUD + publish + delete-guard specs.
 * Hand-rolled mocks (house pattern for agent-package services); the
 * repository surface is small enough that a stub map keeps every test
 * readable.
 */

const USER = 'user-1';
const OTHER_USER = 'user-2';

function makeRow(overrides: Partial<Environment> = {}): Environment {
    return {
        id: 'env-1',
        userId: USER,
        name: 'Python Data',
        slug: 'python-data',
        description: null,
        pipPackages: ['pandas==2.2.0'],
        npmPackages: [],
        networkingMode: 'unrestricted',
        allowedHosts: null,
        allowPackageManagers: true,
        status: 'draft',
        availableInAllProjects: true,
        tenantId: null,
        organizationId: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-02T00:00:00Z'),
        ...overrides,
    } as Environment;
}

interface RepoMock {
    findById: jest.Mock;
    findByIdAndUser: jest.Mock;
    findByUserIdAndSlug: jest.Mock;
    findByUser: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    deleteById: jest.Mock;
}

function makeRepo(): RepoMock {
    return {
        findById: jest.fn().mockResolvedValue(null),
        findByIdAndUser: jest.fn().mockResolvedValue(null),
        findByUserIdAndSlug: jest.fn().mockResolvedValue(null),
        findByUser: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockImplementation(async (data) => makeRow(data)),
        save: jest.fn().mockImplementation(async (row) => row),
        deleteById: jest.fn().mockResolvedValue(undefined),
    };
}

function makeAgentRepo(count = 0) {
    return {
        count: jest.fn().mockResolvedValue(count),
        findOne: jest.fn().mockResolvedValue(null),
    };
}

function makeService(repo: RepoMock, agentRepo?: ReturnType<typeof makeAgentRepo>) {
    return new EnvironmentsService(
        repo as unknown as EnvironmentRepository,
        agentRepo as never,
    );
}

describe('EnvironmentsService — create', () => {
    it('creates a draft with normalized packages and a slug', async () => {
        const repo = makeRepo();
        const svc = makeService(repo);

        const dto = await svc.create(USER, {
            name: 'Python Data',
            pipPackages: ['  pandas==2.2.0 ', 'pandas==2.2.0', 'requests'],
            npmPackages: ['typescript'],
        });

        expect(repo.create).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: USER,
                slug: 'python-data',
                status: 'draft',
                pipPackages: ['pandas==2.2.0', 'requests'],
                npmPackages: ['typescript'],
                networkingMode: 'unrestricted',
                allowedHosts: null,
            }),
        );
        expect(dto.status).toBe('draft');
        expect(dto.pipPackages).toEqual(['pandas==2.2.0', 'requests']);
    });

    it('rejects a name without any alphanumeric character', async () => {
        const svc = makeService(makeRepo());
        await expect(svc.create(USER, { name: '---' })).rejects.toBeInstanceOf(
            BadRequestException,
        );
    });

    it('409s on a duplicate slug for the same user', async () => {
        const repo = makeRepo();
        repo.findByUserIdAndSlug.mockResolvedValue(makeRow());
        const svc = makeService(repo);
        await expect(svc.create(USER, { name: 'Python Data' })).rejects.toBeInstanceOf(
            ConflictException,
        );
    });

    it('translates a lost unique-index race into the same 409', async () => {
        const repo = makeRepo();
        const uniqueErr = new QueryFailedError(
            'INSERT INTO environments',
            [],
            Object.assign(new Error('duplicate key value violates unique constraint'), {
                code: '23505',
            }),
        );
        repo.create.mockRejectedValue(uniqueErr);
        const svc = makeService(repo);
        await expect(svc.create(USER, { name: 'Python Data' })).rejects.toBeInstanceOf(
            ConflictException,
        );
    });

    it('rejects invalid package specs (shell metacharacters)', async () => {
        const svc = makeService(makeRepo());
        await expect(
            svc.create(USER, { name: 'Bad', pipPackages: ['requests; rm -rf /'] }),
        ).rejects.toBeInstanceOf(BadRequestException);
        await expect(
            svc.create(USER, { name: 'Bad', npmPackages: ['pkg && curl evil'] }),
        ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('validates allowed hosts only in limited mode and nulls them otherwise', async () => {
        const repo = makeRepo();
        const svc = makeService(repo);

        await expect(
            svc.create(USER, {
                name: 'Limited',
                networkingMode: 'limited',
                allowedHosts: ['api.anthropic.com', 'not a host'],
            }),
        ).rejects.toBeInstanceOf(BadRequestException);

        await svc.create(USER, {
            name: 'Open',
            networkingMode: 'unrestricted',
            // Hosts on an unrestricted row are normalised away, not errors.
            allowedHosts: ['api.anthropic.com'],
        });
        expect(repo.create).toHaveBeenCalledWith(
            expect.objectContaining({ allowedHosts: null }),
        );
    });
});

describe('EnvironmentsService — read scoping', () => {
    it('cross-user getOne is a 404, never a 403', async () => {
        const repo = makeRepo();
        repo.findByIdAndUser.mockImplementation(async (id: string, userId: string) =>
            userId === USER ? makeRow() : null,
        );
        const svc = makeService(repo);

        await expect(svc.getOne(USER, 'env-1')).resolves.toMatchObject({ id: 'env-1' });
        await expect(svc.getOne(OTHER_USER, 'env-1')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('list forwards the status filter', async () => {
        const repo = makeRepo();
        repo.findByUser.mockResolvedValue([makeRow({ status: 'published' })]);
        const svc = makeService(repo);

        const rows = await svc.list(USER, 'published');
        expect(repo.findByUser).toHaveBeenCalledWith(USER, 'published');
        expect(rows).toHaveLength(1);
        expect(rows[0].status).toBe('published');
    });
});

describe('EnvironmentsService — update', () => {
    it('re-slugs on rename and validates replacement packages', async () => {
        const repo = makeRepo();
        repo.findByIdAndUser.mockResolvedValue(makeRow());
        const svc = makeService(repo);

        const dto = await svc.update(USER, 'env-1', {
            name: 'Node Tooling',
            npmPackages: ['@types/node@^22'],
        });
        expect(dto.name).toBe('Node Tooling');
        expect(dto.slug).toBe('node-tooling');
        expect(dto.npmPackages).toEqual(['@types/node@^22']);
        // Untouched pip list survives the update.
        expect(dto.pipPackages).toEqual(['pandas==2.2.0']);
    });

    it('nulls allowedHosts when networking flips back to unrestricted', async () => {
        const repo = makeRepo();
        repo.findByIdAndUser.mockResolvedValue(
            makeRow({ networkingMode: 'limited', allowedHosts: ['api.anthropic.com'] }),
        );
        const svc = makeService(repo);

        const dto = await svc.update(USER, 'env-1', { networkingMode: 'unrestricted' });
        expect(dto.networkingMode).toBe('unrestricted');
        expect(dto.allowedHosts).toBeNull();
    });

    it('rejects an invalid replacement host list in limited mode', async () => {
        const repo = makeRepo();
        repo.findByIdAndUser.mockResolvedValue(makeRow({ networkingMode: 'limited' }));
        const svc = makeService(repo);
        await expect(
            svc.update(USER, 'env-1', { allowedHosts: ['https://evil.example'] }),
        ).rejects.toBeInstanceOf(BadRequestException);
    });
});

describe('EnvironmentsService — publish + delete guard', () => {
    it('publish promotes a draft and is idempotent on published rows', async () => {
        const repo = makeRepo();
        repo.findByIdAndUser.mockResolvedValue(makeRow({ status: 'draft' }));
        const svc = makeService(repo);

        const dto = await svc.publish(USER, 'env-1');
        expect(dto.status).toBe('published');
        expect(repo.save).toHaveBeenCalledTimes(1);

        repo.findByIdAndUser.mockResolvedValue(makeRow({ status: 'published' }));
        await svc.publish(USER, 'env-1');
        // Already-published rows are not re-saved.
        expect(repo.save).toHaveBeenCalledTimes(1);
    });

    it('delete is refused with 409 while an Agent references the row', async () => {
        const repo = makeRepo();
        repo.findByIdAndUser.mockResolvedValue(makeRow());
        const agentRepo = makeAgentRepo(2);
        const svc = makeService(repo, agentRepo);

        await expect(svc.remove(USER, 'env-1')).rejects.toBeInstanceOf(ConflictException);
        expect(repo.deleteById).not.toHaveBeenCalled();
    });

    it('delete proceeds when nothing references the row', async () => {
        const repo = makeRepo();
        repo.findByIdAndUser.mockResolvedValue(makeRow());
        const agentRepo = makeAgentRepo(0);
        const svc = makeService(repo, agentRepo);

        await svc.remove(USER, 'env-1');
        expect(repo.deleteById).toHaveBeenCalledWith('env-1');
    });
});

describe('EnvironmentsService — resolveRuntimeEnvironmentForAgent', () => {
    it('returns the carrier only for a published, same-owner environment', async () => {
        const repo = makeRepo();
        const agentRepo = makeAgentRepo();
        agentRepo.findOne.mockResolvedValue({
            id: 'agent-1',
            userId: USER,
            environmentId: 'env-1',
        });
        repo.findById.mockResolvedValue(
            makeRow({
                status: 'published',
                networkingMode: 'limited',
                allowedHosts: ['api.anthropic.com'],
                npmPackages: ['typescript'],
            }),
        );
        const svc = makeService(repo, agentRepo);

        const resolved = await svc.resolveRuntimeEnvironmentForAgent('agent-1');
        expect(resolved).toEqual({
            id: 'env-1',
            name: 'Python Data',
            slug: 'python-data',
            pipPackages: ['pandas==2.2.0'],
            npmPackages: ['typescript'],
            networkingMode: 'limited',
            allowedHosts: ['api.anthropic.com'],
            allowPackageManagers: true,
        });
    });

    it('returns undefined for drafts, foreign rows, and unassigned agents', async () => {
        const repo = makeRepo();
        const agentRepo = makeAgentRepo();
        const svc = makeService(repo, agentRepo);

        // Agent without an assignment.
        agentRepo.findOne.mockResolvedValue({ id: 'a', userId: USER, environmentId: null });
        await expect(svc.resolveRuntimeEnvironmentForAgent('a')).resolves.toBeUndefined();

        // Draft environment.
        agentRepo.findOne.mockResolvedValue({ id: 'a', userId: USER, environmentId: 'env-1' });
        repo.findById.mockResolvedValue(makeRow({ status: 'draft' }));
        await expect(svc.resolveRuntimeEnvironmentForAgent('a')).resolves.toBeUndefined();

        // Environment owned by someone else (stale pointer).
        repo.findById.mockResolvedValue(makeRow({ status: 'published', userId: OTHER_USER }));
        await expect(svc.resolveRuntimeEnvironmentForAgent('a')).resolves.toBeUndefined();
    });
});

describe('toRuntimeEnvironmentData', () => {
    it('nulls the host list for unrestricted rows and defaults arrays', () => {
        const data = toRuntimeEnvironmentData(
            makeRow({
                pipPackages: undefined as never,
                npmPackages: undefined as never,
                networkingMode: 'unrestricted',
                allowedHosts: ['stale.example'],
            }),
        );
        expect(data.pipPackages).toEqual([]);
        expect(data.npmPackages).toEqual([]);
        expect(data.allowedHosts).toBeNull();
    });
});
