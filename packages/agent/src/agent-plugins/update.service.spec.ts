import { AgentPluginUpdateService } from './update.service';
import type { AgentPluginPackageRepository } from './package.repository';
import type { AgentPluginGitSource } from './git-source';
import type { AgentPluginNpmSource } from './npm-source';
import type { AgentPluginPackage } from '../entities/agent-plugin-package.entity';

function row(over: Partial<AgentPluginPackage> = {}): AgentPluginPackage {
    return {
        id: 'pkg-1',
        userId: 'user-1',
        name: 'acme.tools',
        source: 'npm',
        sourceRef: 'acme-skills@1.2.0',
        version: '1.2.0',
        integrity: 'sha512-abc',
        installState: 'installed',
        specVersion: '1.0.0',
        findings: [],
        skillNames: ['release-notes'],
        mcpServerNames: [],
        ...over,
    } as AgentPluginPackage;
}

function build(rows: AgentPluginPackage[], over: { npm?: jest.Mock; git?: jest.Mock } = {}) {
    const repository = {
        findRemoteInstalled: jest.fn().mockResolvedValue(rows),
    } as unknown as AgentPluginPackageRepository & { findRemoteInstalled: jest.Mock };
    const npm = {
        latestVersion: over.npm ?? jest.fn().mockResolvedValue('1.2.0'),
    } as unknown as AgentPluginNpmSource & { latestVersion: jest.Mock };
    const git = {
        remoteSha: over.git ?? jest.fn().mockResolvedValue(null),
    } as unknown as AgentPluginGitSource & { remoteSha: jest.Mock };
    return {
        repository,
        npm,
        git,
        service: new AgentPluginUpdateService(repository, git, npm),
    };
}

describe('AgentPluginUpdateService', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        process.env = { ...originalEnv };
        process.env.FEATURE_AGENT_PLUGINS = 'true';
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    it('does nothing while the flag is off', async () => {
        delete process.env.FEATURE_AGENT_PLUGINS;
        const { service, repository } = build([row()]);

        const result = await service.checkForUpdates();

        expect(result.updates).toEqual([]);
        expect(repository.findRemoteInstalled).not.toHaveBeenCalled();
    });

    it('reports an npm package whose registry version has moved on', async () => {
        const { service } = build([row()], { npm: jest.fn().mockResolvedValue('1.3.0') });

        const result = await service.checkForUpdates();

        expect(result.updates).toEqual([
            {
                packageId: 'pkg-1',
                name: 'acme.tools',
                source: 'npm',
                current: '1.2.0',
                available: '1.3.0',
            },
        ]);
        expect(result.unknown).toEqual([]);
    });

    it('reports nothing when the installed version is already current', async () => {
        const { service } = build([row()], { npm: jest.fn().mockResolvedValue('1.2.0') });

        const result = await service.checkForUpdates();

        expect(result.updates).toEqual([]);
        expect(result.unknown).toEqual([]);
    });

    it('distinguishes an UNREACHABLE remote from an up-to-date package', async () => {
        // Reporting an outage as "up to date" would be a reassuring lie: the
        // operator would see a green check and never learn the registry is
        // unreachable.
        const { service } = build([row()], { npm: jest.fn().mockResolvedValue(null) });

        const result = await service.checkForUpdates();

        expect(result.updates).toEqual([]);
        expect(result.unknown).toEqual([
            expect.objectContaining({ packageId: 'pkg-1', name: 'acme.tools' }),
        ]);
    });

    it('compares a git package against its recorded COMMIT, not its version', async () => {
        const installed = 'a'.repeat(40);
        const remote = 'b'.repeat(40);
        const { service } = build(
            [
                row({
                    source: 'git',
                    sourceRef: 'https://x.com/a.git#main',
                    integrity: installed,
                    version: '1.0.0',
                }),
            ],
            { git: jest.fn().mockResolvedValue(remote) },
        );

        const result = await service.checkForUpdates();

        expect(result.updates[0]).toMatchObject({
            source: 'git',
            current: installed,
            available: remote,
        });
    });

    it('reports no git update when the remote commit is unchanged', async () => {
        const sha = 'c'.repeat(40);
        const { service } = build(
            [row({ source: 'git', sourceRef: 'https://x.com/a.git', integrity: sha })],
            { git: jest.fn().mockResolvedValue(sha) },
        );

        await expect(service.checkForUpdates()).resolves.toMatchObject({
            updates: [],
            unknown: [],
        });
    });

    it('survives the registry being unreadable', async () => {
        const { service, repository } = build([]);
        repository.findRemoteInstalled.mockRejectedValue(new Error('ECONNREFUSED'));

        await expect(service.checkForUpdates()).resolves.toMatchObject({ updates: [] });
    });

    it('lets one package’s failure not hide another package’s update', async () => {
        const { service } = build([row(), row({ id: 'pkg-2', name: 'other' })], {
            npm: jest.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue('9.9.9'),
        });

        const result = await service.checkForUpdates();

        expect(result.updates).toHaveLength(1);
        expect(result.unknown).toHaveLength(1);
    });

    describe('checkSkillUpdates', () => {
        it('fans one package update out to each skill the user has installed', async () => {
            const { service } = build(
                [row({ skillNames: ['release-notes', 'changelog', 'not-installed'] })],
                { npm: jest.fn().mockResolvedValue('1.3.0') },
            );

            const result = await service.checkSkillUpdates({
                'release-notes': '1.2.0',
                changelog: '1.2.0',
            });

            // `not-installed` is absent: there is nothing to update.
            expect(result).toEqual([
                { slug: 'release-notes', oldVersion: '1.2.0', newVersion: '1.3.0' },
                { slug: 'changelog', oldVersion: '1.2.0', newVersion: '1.3.0' },
            ]);
        });

        it('shortens a git commit, which does not fit a catalog version column', async () => {
            const remote = 'd'.repeat(40);
            const { service } = build(
                [
                    row({
                        source: 'git',
                        sourceRef: 'https://x.com/a.git',
                        integrity: 'e'.repeat(40),
                        skillNames: ['plan'],
                    }),
                ],
                { git: jest.fn().mockResolvedValue(remote) },
            );

            const result = await service.checkSkillUpdates({ plan: 'abc123' });

            expect(result[0].newVersion).toBe(remote.slice(0, 12));
            expect(result[0].newVersion.length).toBeLessThanOrEqual(16);
        });

        it('returns nothing when no package has an update', async () => {
            const { service } = build([row()], { npm: jest.fn().mockResolvedValue('1.2.0') });
            await expect(service.checkSkillUpdates({ 'release-notes': '1.2.0' })).resolves.toEqual(
                [],
            );
        });
    });
});
