import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentPluginPackageBootstrapService, acquireInputFor } from './package-bootstrap.service';
import type { AgentPluginPackageRepository } from './package.repository';
import type { AgentPluginRemoteAcquireService } from './remote-acquire.service';
import type { AgentPluginPackage } from '../entities/agent-plugin-package.entity';

function row(over: Partial<AgentPluginPackage> = {}): AgentPluginPackage {
    return {
        id: 'pkg-1',
        userId: 'user-1',
        name: 'acme.tools',
        source: 'npm',
        sourceRef: 'acme-skills@1.2.0',
        installPath: '/nonexistent/acme',
        installState: 'installed',
        specVersion: '1.0.0',
        findings: [],
        skillNames: [],
        mcpServerNames: [],
        ...over,
    } as AgentPluginPackage;
}

function repoStub(rows: AgentPluginPackage[]) {
    return {
        findRemoteInstalled: jest.fn().mockResolvedValue(rows),
        markInstalled: jest.fn().mockResolvedValue(undefined),
        markFailed: jest.fn().mockResolvedValue(undefined),
    } as unknown as AgentPluginPackageRepository & {
        findRemoteInstalled: jest.Mock;
        markInstalled: jest.Mock;
        markFailed: jest.Mock;
    };
}

function acquirerStub(impl?: jest.Mock) {
    return {
        acquire:
            impl ??
            jest.fn().mockResolvedValue({
                kind: 'npm',
                path: '/packages/npm/acme-skills/1.2.0',
                revision: '1.2.0',
                integrity: 'sha512-abc',
                load: { ok: true, manifest: { name: 'acme.tools', version: '1.2.0' } },
            }),
    } as unknown as AgentPluginRemoteAcquireService & { acquire: jest.Mock };
}

describe('acquireInputFor', () => {
    it('splits a scoped npm name on the LAST @, not the first', () => {
        // Splitting on the first `@` yields an empty package name and a
        // nonsense version — and would fetch the wrong thing rather than fail.
        expect(acquireInputFor({ source: 'npm', sourceRef: '@scope/pkg@1.0.0' })).toEqual({
            kind: 'npm',
            packageName: '@scope/pkg',
            version: '1.0.0',
        });
    });

    it('treats a scoped name with no version as a bare package name', () => {
        expect(acquireInputFor({ source: 'npm', sourceRef: '@scope/pkg' })).toEqual({
            kind: 'npm',
            packageName: '@scope/pkg',
        });
    });

    it('parses a git URL with and without a ref fragment', () => {
        expect(acquireInputFor({ source: 'git', sourceRef: 'https://x.com/a.git#main' })).toEqual({
            kind: 'git',
            url: 'https://x.com/a.git',
            ref: 'main',
        });
        expect(acquireInputFor({ source: 'git', sourceRef: 'https://x.com/a.git' })).toEqual({
            kind: 'git',
            url: 'https://x.com/a.git',
        });
    });

    it('returns null rather than guessing at an unusable reference', () => {
        expect(acquireInputFor({ source: 'git', sourceRef: '   ' })).toBeNull();
        expect(acquireInputFor({ source: 'local', sourceRef: '/srv/pkg' })).toBeNull();
    });
});

describe('AgentPluginPackageBootstrapService', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        process.env = { ...originalEnv };
        process.env.FEATURE_AGENT_PLUGINS = 'true';
        process.env.AGENT_PLUGINS_DIR = '/packages';
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    it('does nothing at all while the flag is off', async () => {
        delete process.env.FEATURE_AGENT_PLUGINS;
        const repository = repoStub([row()]);
        const service = new AgentPluginPackageBootstrapService(repository, acquirerStub());

        const result = await service.rematerializeFromDb();

        expect(result).toMatchObject({ attempted: 0, succeeded: 0, failed: 0 });
        // Not even a query: the flag being off must cost nothing.
        expect(repository.findRemoteInstalled).not.toHaveBeenCalled();
    });

    it('survives the registry being unreadable at boot', async () => {
        // A replica can start before the database is reachable. Warmup is an
        // optimisation, so this must not propagate and kill the pod.
        const repository = repoStub([]);
        repository.findRemoteInstalled.mockRejectedValue(new Error('ECONNREFUSED'));
        const service = new AgentPluginPackageBootstrapService(repository, acquirerStub());

        await expect(service.rematerializeFromDb()).resolves.toMatchObject({
            attempted: 0,
            failed: 0,
        });
    });

    it('skips a package already present on disk, doing no network work', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'ap-warm-'));
        const present = join(dir, 'acme');
        await mkdir(present, { recursive: true });

        const acquirer = acquirerStub();
        const service = new AgentPluginPackageBootstrapService(
            repoStub([row({ installPath: present })]),
            acquirer,
        );

        const result = await service.rematerializeFromDb();

        expect(result.skipped).toBe(1);
        expect(result.attempted).toBe(0);
        expect(acquirer.acquire).not.toHaveBeenCalled();
    });

    it('re-fetches a package whose directory is gone, and records the result', async () => {
        const repository = repoStub([row()]);
        const acquirer = acquirerStub();
        const service = new AgentPluginPackageBootstrapService(repository, acquirer);

        const result = await service.rematerializeFromDb();

        expect(result).toMatchObject({ attempted: 1, succeeded: 1, failed: 0 });
        expect(acquirer.acquire).toHaveBeenCalledWith('/packages', {
            kind: 'npm',
            packageName: 'acme-skills',
            version: '1.2.0',
        });
        expect(repository.markInstalled).toHaveBeenCalledWith(
            'pkg-1',
            expect.objectContaining({ installPath: '/packages/npm/acme-skills/1.2.0' }),
        );
    });

    it('records the resolved COMMIT as integrity for a git package', async () => {
        const sha = 'f'.repeat(40);
        const repository = repoStub([
            row({ source: 'git', sourceRef: 'https://x.com/a.git#main' }),
        ]);
        const acquirer = acquirerStub(
            jest.fn().mockResolvedValue({
                kind: 'git',
                path: '/packages/git/a/' + sha,
                revision: sha,
                integrity: null,
                load: { ok: true, manifest: { name: 'a', version: '1.0.0' } },
            }),
        );
        const service = new AgentPluginPackageBootstrapService(repository, acquirer);

        await service.rematerializeFromDb();

        // For git there is no subresource integrity; the commit IS the
        // identity of the fetched bytes.
        expect(repository.markInstalled).toHaveBeenCalledWith(
            'pkg-1',
            expect.objectContaining({ integrity: sha }),
        );
    });

    it('records a failure without throwing, so one bad package cannot block boot', async () => {
        const repository = repoStub([row(), row({ id: 'pkg-2', name: 'other' })]);
        const acquirer = acquirerStub(
            jest
                .fn()
                .mockRejectedValueOnce(new Error('registry unreachable'))
                .mockResolvedValue({
                    kind: 'npm',
                    path: '/packages/npm/other/1.0.0',
                    revision: '1.0.0',
                    integrity: null,
                    load: { ok: true, manifest: { name: 'other', version: '1.0.0' } },
                }),
        );
        const service = new AgentPluginPackageBootstrapService(repository, acquirer);

        const result = await service.rematerializeFromDb();

        expect(result).toMatchObject({ attempted: 2, succeeded: 1, failed: 1 });
        expect(repository.markFailed).toHaveBeenCalledWith('pkg-1', 'registry unreachable');
    });

    it('marks an unparseable sourceRef as failed rather than retrying it every boot', async () => {
        const repository = repoStub([row({ source: 'git', sourceRef: '' })]);
        const acquirer = acquirerStub();
        const service = new AgentPluginPackageBootstrapService(repository, acquirer);

        const result = await service.rematerializeFromDb();

        expect(acquirer.acquire).not.toHaveBeenCalled();
        expect(repository.markFailed).toHaveBeenCalledWith(
            'pkg-1',
            expect.stringContaining('not a valid git reference'),
        );
        // It was attempted and did not throw, so boot continues.
        expect(result.attempted).toBe(1);
    });

    it('falls back to the default directory when AGENT_PLUGINS_DIR is empty', async () => {
        process.env.AGENT_PLUGINS_DIR = '';
        const acquirer = acquirerStub();
        const service = new AgentPluginPackageBootstrapService(repoStub([row()]), acquirer);

        const result = await service.rematerializeFromDb();

        // envsubst renders an unset variable as an EMPTY STRING, not as
        // undefined, so the config layer uses `||` rather than `??`. An empty
        // value therefore resolves to the documented default rather than
        // disabling the feature — the guard for a genuinely empty root stays
        // as defence, but it is not reachable through configuration.
        expect(result.attempted).toBe(1);
        expect(acquirer.acquire).toHaveBeenCalledWith('/app/agent-plugins', expect.anything());
    });
});
