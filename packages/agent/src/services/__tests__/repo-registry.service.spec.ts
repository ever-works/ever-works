import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import {
    RepoRegistryService,
    assertValidEnvFiles,
    isValidMountPath,
    isValidRepoUrl,
} from '../repo-registry.service';
import type { RepoConnection } from '../../entities/repo-connection.entity';

/**
 * Repository registry (Feature G) — service-level behavior:
 * CRUD + validation caps, env-file masking, the derived-row listing
 * union, GitHub-App import idempotency (loud 409s), the attachments
 * authz matrix, and the provisioning resolver.
 */

const USER = 'user-1';
const OTHER_USER = 'user-2';

function makeRow(overrides: Partial<RepoConnection> = {}): RepoConnection {
    return {
        id: 'rc-1',
        userId: USER,
        name: 'my-service',
        url: 'https://github.com/acme/my-service',
        provider: 'github',
        defaultBranch: 'main',
        mountPath: null,
        description: null,
        credentialMode: 'inherit',
        credentialRef: null,
        envFiles: null,
        availableInAllProjects: true,
        sourceType: 'manual',
        sourceWorkId: null,
        sourceInstallationRepoId: null,
        enabled: true,
        createdAt: new Date('2026-08-01T00:00:00Z'),
        updatedAt: new Date('2026-08-01T00:00:00Z'),
        ...overrides,
    } as RepoConnection;
}

function makeMocks() {
    const repoConnections = {
        listByUser: jest.fn().mockResolvedValue([]),
        findByIdAndUser: jest.fn().mockResolvedValue(null),
        findByIds: jest.fn().mockResolvedValue([]),
        findByUserAndName: jest.fn().mockResolvedValue(null),
        findByUserAndSourceInstallationRepoId: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation(async (data) => makeRow(data)),
        save: jest.fn().mockImplementation(async (row) => row),
        deleteByIdAndUser: jest.fn().mockResolvedValue(true),
    };
    const attachments = {
        listForAgent: jest.fn().mockResolvedValue([]),
        listEnabledForAgentWithRepos: jest.fn().mockResolvedValue([]),
        findByAgentAndRepo: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockImplementation(async (data) => ({ id: 'edge-1', ...data })),
        deleteByAgentAndRepo: jest.fn().mockResolvedValue(true),
    };
    const agents = {
        findByIdAndUser: jest.fn().mockResolvedValue({ id: 'agent-1', userId: USER }),
    };
    const works = {
        findByUser: jest.fn().mockResolvedValue([]),
    };
    const ghInstallations = {
        findById: jest.fn().mockResolvedValue(null),
    };
    const ghInstallationRepos = {
        findById: jest.fn().mockResolvedValue(null),
    };
    const service = new RepoRegistryService(
        repoConnections as never,
        attachments as never,
        agents as never,
        works as never,
        ghInstallations as never,
        ghInstallationRepos as never,
    );
    return {
        service,
        repoConnections,
        attachments,
        agents,
        works,
        ghInstallations,
        ghInstallationRepos,
    };
}

describe('validators', () => {
    it('accepts https and ssh remotes, rejects everything else', () => {
        expect(isValidRepoUrl('https://github.com/acme/repo')).toBe(true);
        expect(isValidRepoUrl('git@github.com:acme/repo.git')).toBe(true);
        expect(isValidRepoUrl('ssh://git@host.example/acme/repo.git')).toBe(true);
        expect(isValidRepoUrl('http://github.com/acme/repo')).toBe(false);
        expect(isValidRepoUrl('javascript:alert(1)')).toBe(false);
        expect(isValidRepoUrl('file:///etc/passwd')).toBe(false);
        expect(isValidRepoUrl('https://github.com/a b')).toBe(false);
        expect(isValidRepoUrl('')).toBe(false);
    });

    it('constrains mountPath to a single traversal-free segment', () => {
        expect(isValidMountPath('my-repo')).toBe(true);
        expect(isValidMountPath('repo_1.data')).toBe(true);
        expect(isValidMountPath('..')).toBe(false);
        expect(isValidMountPath('.')).toBe(false);
        expect(isValidMountPath('a/b')).toBe(false);
        expect(isValidMountPath('../escape')).toBe(false);
        expect(isValidMountPath('a'.repeat(201))).toBe(false);
    });

    it('enforces the env-file caps (count, size, path shape, duplicates)', () => {
        const file = (path: string, content = 'A=1') => ({ path, content });
        expect(() => assertValidEnvFiles([file('.env')])).not.toThrow();
        expect(() => assertValidEnvFiles([file('apps/api/.env')])).not.toThrow();
        expect(() =>
            assertValidEnvFiles(Array.from({ length: 9 }, (_, i) => file(`.env.${i}`))),
        ).toThrow(BadRequestException);
        expect(() => assertValidEnvFiles([file('../.env')])).toThrow(BadRequestException);
        expect(() => assertValidEnvFiles([file('/etc/.env')])).toThrow(BadRequestException);
        expect(() => assertValidEnvFiles([file('.env'), file('.env')])).toThrow(
            BadRequestException,
        );
        expect(() => assertValidEnvFiles([file('.env', 'x'.repeat(32 * 1024 + 1))])).toThrow(
            BadRequestException,
        );
        expect(() => assertValidEnvFiles([file('.env', 'x'.repeat(32 * 1024))])).not.toThrow();
    });
});

describe('registry CRUD', () => {
    it('creates a manual row and returns a masked view', async () => {
        const { service, repoConnections } = makeMocks();
        const view = await service.create(USER, {
            name: 'my-service',
            url: 'https://github.com/acme/my-service',
            envFiles: [{ path: '.env', content: 'SECRET=value' }],
        });

        expect(repoConnections.create).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: USER,
                sourceType: 'manual',
                envFiles: { '.env': 'SECRET=value' },
            }),
        );
        // MASKED: paths + sizes only, never content.
        expect(view.envFiles).toEqual([{ path: '.env', size: 'SECRET=value'.length }]);
        expect(JSON.stringify(view)).not.toContain('SECRET=value');
        expect(view.mountDir).toBe('my-service');
        expect(view.readonly).toBe(false);
    });

    it('rejects an invalid URL and a traversal mountPath', async () => {
        const { service } = makeMocks();
        await expect(
            service.create(USER, { name: 'x', url: 'http://insecure.example/repo' }),
        ).rejects.toBeInstanceOf(BadRequestException);
        await expect(
            service.create(USER, {
                name: 'x',
                url: 'https://github.com/acme/x',
                mountPath: '../escape',
            }),
        ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('409s on a duplicate name', async () => {
        const { service, repoConnections } = makeMocks();
        repoConnections.findByUserAndName.mockResolvedValue(makeRow());
        await expect(
            service.create(USER, { name: 'my-service', url: 'https://github.com/acme/z' }),
        ).rejects.toBeInstanceOf(ConflictException);
    });

    it('404s cross-user reads/updates/deletes (no 403 leak)', async () => {
        const { service, repoConnections } = makeMocks();
        repoConnections.findByIdAndUser.mockResolvedValue(null);
        repoConnections.deleteByIdAndUser.mockResolvedValue(false);
        await expect(service.get(OTHER_USER, 'rc-1')).rejects.toBeInstanceOf(NotFoundException);
        await expect(service.update(OTHER_USER, 'rc-1', { name: 'x' })).rejects.toBeInstanceOf(
            NotFoundException,
        );
        await expect(service.remove(OTHER_USER, 'rc-1')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('reveals full env-file content only through getEnvFiles', async () => {
        const { service, repoConnections } = makeMocks();
        repoConnections.findByIdAndUser.mockResolvedValue(
            makeRow({ envFiles: { '.env': 'TOKEN=abc' } }),
        );
        const revealed = await service.getEnvFiles(USER, 'rc-1');
        expect(revealed.files).toEqual([{ path: '.env', content: 'TOKEN=abc' }]);

        const view = await service.get(USER, 'rc-1');
        expect(view.envFiles).toEqual([{ path: '.env', size: 'TOKEN=abc'.length }]);
    });

    it('setEnvFiles replaces the set wholesale and returns masked meta', async () => {
        const { service, repoConnections } = makeMocks();
        repoConnections.findByIdAndUser.mockResolvedValue(
            makeRow({ envFiles: { '.env': 'OLD=1' } }),
        );
        const result = await service.setEnvFiles(USER, 'rc-1', [
            { path: '.env.local', content: 'NEW=1' },
        ]);
        expect(result.files).toEqual([{ path: '.env.local', size: 5 }]);
        const saved = repoConnections.save.mock.calls[0][0];
        expect(saved.envFiles).toEqual({ '.env.local': 'NEW=1' });
    });
});

describe('derived-row union', () => {
    function makeWork(id: string, name: string, repos: Record<string, string | null>) {
        return {
            id,
            name,
            getRepoOwner: () => 'acme',
            getDataRepo: () => repos.data,
            getWebsiteRepo: () => repos.website,
            getMainRepo: () => repos.work,
        };
    }

    it('appends read-only Work entries only when includeDerived is set', async () => {
        const { service, repoConnections, works } = makeMocks();
        repoConnections.listByUser.mockResolvedValue([makeRow()]);
        works.findByUser.mockResolvedValue([
            makeWork('w1', 'Directory', { data: 'dir-data', website: 'dir-website', work: 'dir' }),
        ]);

        const plain = await service.list(USER);
        expect(plain).toHaveLength(1);
        expect(works.findByUser).not.toHaveBeenCalled();

        const unioned = await service.list(USER, { includeDerived: true });
        expect(unioned).toHaveLength(4);
        const derived = unioned.filter((v) => v.sourceType === 'work');
        expect(derived).toHaveLength(3);
        expect(derived.every((v) => v.readonly)).toBe(true);
        expect(derived.map((v) => v.id)).toEqual([
            'work:w1:work',
            'work:w1:website',
            'work:w1:data',
        ]);
        expect(derived[0].url).toBe('https://github.com/acme/dir');
    });

    it('skips roles the Work does not declare', async () => {
        const { service, works } = makeMocks();
        works.findByUser.mockResolvedValue([
            makeWork('w2', 'Lean', { data: 'lean-data', website: null, work: null }),
        ]);
        const unioned = await service.list(USER, { includeDerived: true });
        expect(unioned.map((v) => v.id)).toEqual(['work:w2:data']);
    });
});

describe('GitHub-App import', () => {
    function seedImport(mocks: ReturnType<typeof makeMocks>) {
        mocks.ghInstallationRepos.findById.mockResolvedValue({
            id: 'ghr-1',
            installationEntityId: 'inst-1',
            owner: 'acme',
            repo: 'imported',
            fullName: 'acme/imported',
            defaultBranch: 'main',
        });
        mocks.ghInstallations.findById.mockResolvedValue({
            id: 'inst-1',
            createdByUserId: USER,
            deletedAt: null,
            suspendedAt: null,
        });
    }

    it('creates a github-app row whose credentialRef is the installation entity id', async () => {
        const mocks = makeMocks();
        seedImport(mocks);
        const view = await mocks.service.importFromGithubApp(USER, 'ghr-1');
        expect(mocks.repoConnections.create).toHaveBeenCalledWith(
            expect.objectContaining({
                name: 'imported',
                url: 'https://github.com/acme/imported',
                credentialMode: 'github-app',
                credentialRef: 'inst-1',
                sourceType: 'github-app',
                sourceInstallationRepoId: 'ghr-1',
                defaultBranch: 'main',
            }),
        );
        expect(view.sourceType).toBe('github-app');
    });

    it('409s when the repo was already imported (idempotency is loud, not silent)', async () => {
        const mocks = makeMocks();
        seedImport(mocks);
        mocks.repoConnections.findByUserAndSourceInstallationRepoId.mockResolvedValue(
            makeRow({ name: 'imported' }),
        );
        await expect(mocks.service.importFromGithubApp(USER, 'ghr-1')).rejects.toBeInstanceOf(
            ConflictException,
        );
        expect(mocks.repoConnections.create).not.toHaveBeenCalled();
    });

    it('409s with a clear message on a duplicate name', async () => {
        const mocks = makeMocks();
        seedImport(mocks);
        mocks.repoConnections.findByUserAndName.mockResolvedValue(makeRow({ name: 'imported' }));
        await expect(mocks.service.importFromGithubApp(USER, 'ghr-1')).rejects.toThrow(
            /already exists.*Rename/i,
        );
    });

    it('404s when the installation belongs to someone else or is dead', async () => {
        const mocks = makeMocks();
        seedImport(mocks);
        mocks.ghInstallations.findById.mockResolvedValue({
            id: 'inst-1',
            createdByUserId: OTHER_USER,
            deletedAt: null,
            suspendedAt: null,
        });
        await expect(mocks.service.importFromGithubApp(USER, 'ghr-1')).rejects.toBeInstanceOf(
            NotFoundException,
        );

        mocks.ghInstallations.findById.mockResolvedValue({
            id: 'inst-1',
            createdByUserId: USER,
            deletedAt: null,
            suspendedAt: new Date(),
        });
        await expect(mocks.service.importFromGithubApp(USER, 'ghr-1')).rejects.toBeInstanceOf(
            NotFoundException,
        );
    });
});

describe('agent attachments authz matrix', () => {
    it('404s every attachment call for an agent the caller does not own', async () => {
        const mocks = makeMocks();
        mocks.agents.findByIdAndUser.mockResolvedValue(null);
        await expect(mocks.service.listForAgent(USER, 'agent-x')).rejects.toBeInstanceOf(
            NotFoundException,
        );
        await expect(
            mocks.service.setAttachment(USER, 'agent-x', 'rc-1', true),
        ).rejects.toBeInstanceOf(NotFoundException);
        await expect(
            mocks.service.removeAttachment(USER, 'agent-x', 'rc-1'),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(mocks.attachments.upsert).not.toHaveBeenCalled();
    });

    it('404s attaching a repo the caller does not own (owned agent)', async () => {
        const mocks = makeMocks();
        mocks.repoConnections.findByIdAndUser.mockResolvedValue(null);
        await expect(
            mocks.service.setAttachment(USER, 'agent-1', 'rc-foreign', true),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(mocks.attachments.upsert).not.toHaveBeenCalled();
    });

    it('upserts the edge and reports attachment state in listForAgent', async () => {
        const mocks = makeMocks();
        mocks.repoConnections.findByIdAndUser.mockResolvedValue(makeRow());
        const result = await mocks.service.setAttachment(USER, 'agent-1', 'rc-1', false);
        expect(result).toEqual({ agentId: 'agent-1', repoConnectionId: 'rc-1', enabled: false });
        expect(mocks.attachments.upsert).toHaveBeenCalledWith({
            userId: USER,
            agentId: 'agent-1',
            repoConnectionId: 'rc-1',
            enabled: false,
        });

        mocks.repoConnections.listByUser.mockResolvedValue([makeRow(), makeRow({ id: 'rc-2' })]);
        mocks.attachments.listForAgent.mockResolvedValue([
            { repoConnectionId: 'rc-1', enabled: false },
        ]);
        const listed = await mocks.service.listForAgent(USER, 'agent-1');
        expect(listed.map((v) => [v.id, v.attached, v.attachmentEnabled])).toEqual([
            ['rc-1', true, false],
            ['rc-2', false, false],
        ]);
    });

    it('404s removing a nonexistent edge', async () => {
        const mocks = makeMocks();
        mocks.attachments.deleteByAgentAndRepo.mockResolvedValue(false);
        await expect(
            mocks.service.removeAttachment(USER, 'agent-1', 'rc-1'),
        ).rejects.toBeInstanceOf(NotFoundException);
    });
});

describe('provisioning resolver', () => {
    it('resolves enabled attachments of enabled repos with env contents and mountDir fallback', async () => {
        const mocks = makeMocks();
        mocks.attachments.listEnabledForAgentWithRepos.mockResolvedValue([
            {
                repoConnectionId: 'rc-1',
                enabled: true,
                repoConnection: makeRow({
                    id: 'rc-1',
                    name: 'api',
                    mountPath: null,
                    defaultBranch: 'develop',
                    envFiles: { '.env': 'A=1' },
                }),
            },
            {
                repoConnectionId: 'rc-2',
                enabled: true,
                repoConnection: makeRow({ id: 'rc-2', name: 'web', enabled: false }),
            },
            { repoConnectionId: 'rc-3', enabled: true, repoConnection: undefined },
        ]);

        const resolved = await mocks.service.resolveAttachedReposForAgent(USER, 'agent-1');
        expect(resolved).toEqual([
            {
                repoConnectionId: 'rc-1',
                url: 'https://github.com/acme/my-service',
                branch: 'develop',
                mountDir: 'api',
                envFiles: [{ path: '.env', content: 'A=1' }],
            },
        ]);
    });
});
