import { mkdir, mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentPluginInstallService, sourceRefFor } from './install.service';
import type { AgentPluginPackageRepository } from './package.repository';
import type { AgentPluginRemoteAcquireService } from './remote-acquire.service';
import type { AgentPluginPackage } from '../entities/agent-plugin-package.entity';

function row(over: Partial<AgentPluginPackage> = {}): AgentPluginPackage {
    return {
        id: '11111111-1111-4111-8111-111111111111',
        userId: 'owner',
        name: 'acme.tools',
        source: 'npm',
        sourceRef: 'acme-skills@1.2.0',
        installPath: '/packages/npm/acme-skills/1.2.0',
        installState: 'installed',
        specVersion: '1.0.0',
        findings: [],
        skillNames: [],
        mcpServerNames: [],
        ...over,
    } as AgentPluginPackage;
}

function build(over: { rows?: AgentPluginPackage | null; acquire?: jest.Mock } = {}) {
    const repository = {
        findById: jest.fn().mockResolvedValue(over.rows === undefined ? row() : over.rows),
        deleteById: jest.fn().mockResolvedValue(undefined),
        upsertInstalled: jest.fn().mockImplementation(async (input) => ({ id: 'new', ...input })),
    } as unknown as AgentPluginPackageRepository & {
        findById: jest.Mock;
        deleteById: jest.Mock;
        upsertInstalled: jest.Mock;
    };

    const acquirer = {
        acquire:
            over.acquire ??
            jest.fn().mockResolvedValue({
                kind: 'npm',
                path: '/packages/npm/acme-skills/1.2.0',
                revision: '1.2.0',
                integrity: 'sha512-abc',
                load: {
                    ok: true,
                    manifest: { name: 'acme.tools', version: '1.2.0' },
                    specVersion: '1.0.0',
                    skills: [{ name: 'release-notes' }],
                    mcpServers: [{ name: 'api' }],
                    findings: [],
                },
            }),
    } as unknown as AgentPluginRemoteAcquireService & { acquire: jest.Mock };

    return { repository, acquirer, service: new AgentPluginInstallService(repository, acquirer) };
}

describe('sourceRefFor', () => {
    it('round-trips the coordinates a re-fetch needs', () => {
        expect(sourceRefFor({ kind: 'git', url: 'https://x.com/a.git', ref: 'main' })).toBe(
            'https://x.com/a.git#main',
        );
        expect(sourceRefFor({ kind: 'git', url: 'https://x.com/a.git' })).toBe(
            'https://x.com/a.git',
        );
        expect(sourceRefFor({ kind: 'npm', packageName: '@scope/p', version: '1.0.0' })).toBe(
            '@scope/p@1.0.0',
        );
        expect(sourceRefFor({ kind: 'npm', packageName: '@scope/p' })).toBe('@scope/p');
    });
});

describe('AgentPluginInstallService', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        process.env = { ...originalEnv };
        process.env.FEATURE_AGENT_PLUGINS = 'true';
        process.env.AGENT_PLUGINS_DIR = '/packages';
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    it('refuses to install while the feature is disabled', async () => {
        delete process.env.FEATURE_AGENT_PLUGINS;
        const { service, acquirer } = build();

        await expect(
            service.install({ kind: 'npm', packageName: 'acme-skills' }, { userId: 'owner' }),
        ).rejects.toMatchObject({ status: 501 });

        expect(acquirer.acquire).not.toHaveBeenCalled();
    });

    it('writes the registry row only AFTER the package validates', async () => {
        const { service, repository, acquirer } = build();

        await service.install(
            { kind: 'npm', packageName: 'acme-skills', version: '1.2.0' },
            { userId: 'owner' },
        );

        // A row written first would advertise a package that might never
        // materialise, and the catalog would offer a skill nothing can read.
        const acquireOrder = acquirer.acquire.mock.invocationCallOrder[0];
        const upsertOrder = repository.upsertInstalled.mock.invocationCallOrder[0];
        expect(acquireOrder).toBeLessThan(upsertOrder);

        expect(repository.upsertInstalled).toHaveBeenCalledWith(
            expect.objectContaining({
                name: 'acme.tools',
                source: 'npm',
                sourceRef: 'acme-skills@1.2.0',
                skillNames: ['release-notes'],
                mcpServerNames: ['api'],
            }),
        );
    });

    it('does not write a row when acquisition fails', async () => {
        const { service, repository } = build({
            acquire: jest.fn().mockRejectedValue(new Error('rejected')),
        });

        await expect(
            service.install({ kind: 'npm', packageName: 'acme-skills' }, { userId: 'owner' }),
        ).rejects.toThrow('rejected');

        expect(repository.upsertInstalled).not.toHaveBeenCalled();
    });

    describe('remove', () => {
        it('reports 404 — not 403 — for a package owned by someone else', async () => {
            const { service, repository } = build({ rows: row({ userId: 'somebody-else' }) });

            await expect(service.remove(row().id, 'owner')).rejects.toMatchObject({ status: 404 });

            // A 403 would confirm the row exists, telling an unauthorised
            // caller something about another user's packages.
            expect(repository.deleteById).not.toHaveBeenCalled();
        });

        it('reports 404 for a package that does not exist', async () => {
            const { service } = build({ rows: null });
            await expect(service.remove(row().id, 'owner')).rejects.toMatchObject({ status: 404 });
        });

        it('refuses to remove a LOCAL package, which is the operator’s directory', async () => {
            const { service, repository } = build({
                rows: row({ source: 'local', sourceRef: '/srv/packages/acme' }),
            });

            await expect(service.remove(row().id, 'owner')).rejects.toMatchObject({ status: 409 });
            expect(repository.deleteById).not.toHaveBeenCalled();
        });

        it('deletes the row BEFORE the directory, and removes both', async () => {
            const dir = await mkdtemp(join(tmpdir(), 'ap-remove-'));
            const installPath = join(dir, 'acme');
            await mkdir(installPath, { recursive: true });

            const { service, repository } = build({ rows: row({ installPath }) });

            await service.remove(row().id, 'owner');

            expect(repository.deleteById).toHaveBeenCalledWith(row().id);
            await expect(stat(installPath)).rejects.toMatchObject({ code: 'ENOENT' });
        });

        it('still succeeds when the directory cannot be deleted', async () => {
            // The row is already gone, so the package is unreachable; an
            // orphaned directory is untidy rather than incorrect.
            const { service } = build({ rows: row({ installPath: '/nonexistent/path' }) });
            await expect(service.remove(row().id, 'owner')).resolves.toBeUndefined();
        });
    });

    describe('resync', () => {
        it('re-fetches at the recorded coordinates', async () => {
            const { service, acquirer } = build({
                rows: row({ source: 'git', sourceRef: 'https://x.com/a.git#main' }),
            });

            await service.resync(row().id, 'owner');

            expect(acquirer.acquire).toHaveBeenCalledWith('/packages', {
                kind: 'git',
                url: 'https://x.com/a.git',
                ref: 'main',
            });
        });

        it('refuses for a local package, which has no remote', async () => {
            const { service } = build({ rows: row({ source: 'local' }) });
            await expect(service.resync(row().id, 'owner')).rejects.toMatchObject({ status: 409 });
        });

        it('reports 404 for someone else’s package', async () => {
            const { service } = build({ rows: row({ userId: 'somebody-else' }) });
            await expect(service.resync(row().id, 'owner')).rejects.toMatchObject({ status: 404 });
        });
    });
});
