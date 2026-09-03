import { HttpException } from '@nestjs/common';
import { mkdtemp, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    AgentPluginNpmSource,
    versionPermitted,
    type NpmManifest,
    type PacoteLike,
} from './npm-source';
import { AgentPluginAllowlistService } from './allowlist.service';

function allowlistStub(result: {
    allowed: boolean;
    reason?: string;
    entry?: { versionRange?: string | null; integrity?: string | null };
}): AgentPluginAllowlistService {
    return {
        check: jest.fn().mockResolvedValue({
            allowed: result.allowed,
            reason: result.reason ?? (result.allowed ? 'allowed' : 'denied'),
            entry: result.entry,
        }),
    } as unknown as AgentPluginAllowlistService;
}

function pacoteStub(
    manifest: Partial<NpmManifest> = {},
): PacoteLike & { manifest: jest.Mock; extract: jest.Mock } {
    return {
        manifest: jest.fn().mockResolvedValue({
            name: 'acme-skills',
            version: '1.2.0',
            _integrity: 'sha512-abc',
            ...manifest,
        }),
        extract: jest.fn().mockImplementation(async (_spec: string, dest: string) => {
            await mkdir(dest, { recursive: true });
        }),
    };
}

async function scratch(): Promise<string> {
    return mkdtemp(join(tmpdir(), 'ap-npm-'));
}

describe('versionPermitted', () => {
    it('permits everything when no range is configured', () => {
        expect(versionPermitted('9.9.9', null)).toBe(true);
        expect(versionPermitted('9.9.9', '  ')).toBe(true);
        expect(versionPermitted('9.9.9', '*')).toBe(true);
    });

    it('matches exactly or by prefix, and does NOT interpret semver ranges', () => {
        expect(versionPermitted('1.2.0', '1.2.0')).toBe(true);
        expect(versionPermitted('1.2.1', '1.2.0')).toBe(false);
        expect(versionPermitted('1.2.9', '1.2.*')).toBe(true);
        expect(versionPermitted('1.3.0', '1.2.*')).toBe(false);
        // `^1.0.0` is treated as a literal, so it matches nothing rather than
        // silently authorising every future 1.x — including one published
        // after a publisher-account compromise.
        expect(versionPermitted('1.5.0', '^1.0.0')).toBe(false);
    });
});

describe('AgentPluginNpmSource', () => {
    it('refuses an unallowlisted package WITHOUT resolving a manifest', async () => {
        const pacote = pacoteStub();
        const source = new AgentPluginNpmSource(allowlistStub({ allowed: false }));
        source.setPacote(pacote);

        await expect(
            source.acquire({ packageName: 'acme-skills', destDir: await scratch() }),
        ).rejects.toMatchObject({ status: 409 });

        // Resolving a manifest still contacts the registry and discloses this
        // deployment's interest in the package.
        expect(pacote.manifest).not.toHaveBeenCalled();
        expect(pacote.extract).not.toHaveBeenCalled();
    });

    it('checks the RESOLVED version against the range, so a dist-tag cannot bypass it', async () => {
        // The request says `latest`, which carries no version. Checking the
        // request instead of the resolution would let `latest` through
        // whatever the range says.
        const pacote = pacoteStub({ version: '2.0.0' });
        const source = new AgentPluginNpmSource(
            allowlistStub({ allowed: true, entry: { versionRange: '1.*' } }),
        );
        source.setPacote(pacote);

        await expect(
            source.acquire({
                packageName: 'acme-skills',
                version: 'latest',
                destDir: await scratch(),
            }),
        ).rejects.toMatchObject({ status: 409 });

        expect(pacote.manifest).toHaveBeenCalled();
        expect(pacote.extract).not.toHaveBeenCalled();
    });

    it('refuses with 424 when a pinned integrity does not match what the registry served', async () => {
        const pacote = pacoteStub({ _integrity: 'sha512-served' });
        const source = new AgentPluginNpmSource(
            allowlistStub({ allowed: true, entry: { integrity: 'sha512-pinned' } }),
        );
        source.setPacote(pacote);

        await expect(
            source.acquire({ packageName: 'acme-skills', destDir: await scratch() }),
        ).rejects.toMatchObject({ status: 424 });

        expect(pacote.extract).not.toHaveBeenCalled();
    });

    it('extracts with the manifest integrity, and creates NO node_modules symlink', async () => {
        const pacote = pacoteStub();
        const source = new AgentPluginNpmSource(allowlistStub({ allowed: true }));
        source.setPacote(pacote);
        const root = await scratch();
        const dest = join(root, 'pkg');

        const result = await source.acquire({ packageName: 'acme-skills', destDir: dest });

        expect(result).toMatchObject({ version: '1.2.0', integrity: 'sha512-abc' });
        expect(pacote.extract).toHaveBeenCalledWith(
            'acme-skills@1.2.0',
            dest,
            expect.objectContaining({ integrity: 'sha512-abc' }),
        );

        // The control that keeps these packages non-executable: nothing may
        // place them on the module resolution path.
        await expect(stat(join(root, 'node_modules'))).rejects.toMatchObject({
            code: 'ENOENT',
        });
    });

    it('maps a registry timeout to 504 and other registry failures to 502', async () => {
        const slow = pacoteStub();
        slow.manifest.mockRejectedValue(new Error('request ETIMEDOUT'));
        const a = new AgentPluginNpmSource(allowlistStub({ allowed: true }));
        a.setPacote(slow);
        await expect(
            a.acquire({ packageName: 'acme-skills', destDir: await scratch() }),
        ).rejects.toMatchObject({ status: 504 });

        const broken = pacoteStub();
        broken.manifest.mockRejectedValue(new Error('404 Not Found'));
        const b = new AgentPluginNpmSource(allowlistStub({ allowed: true }));
        b.setPacote(broken);
        await expect(
            b.acquire({ packageName: 'acme-skills', destDir: await scratch() }),
        ).rejects.toMatchObject({ status: 502 });
    });

    it('rejects an implausibly long version specifier before any lookup', async () => {
        const pacote = pacoteStub();
        const source = new AgentPluginNpmSource(allowlistStub({ allowed: true }));
        source.setPacote(pacote);

        await expect(
            source.acquire({
                packageName: 'acme-skills',
                version: 'v'.repeat(500),
                destDir: await scratch(),
            }),
        ).rejects.toBeInstanceOf(HttpException);

        expect(pacote.manifest).not.toHaveBeenCalled();
    });

    describe('latestVersion', () => {
        it('returns null instead of throwing when the registry is unreachable', async () => {
            const pacote = pacoteStub();
            pacote.manifest.mockRejectedValue(new Error('registry down'));
            const source = new AgentPluginNpmSource(allowlistStub({ allowed: true }));
            source.setPacote(pacote);

            // Not knowing whether an update exists must never fail the page
            // that asked.
            await expect(source.latestVersion('acme-skills')).resolves.toBeNull();
        });

        it('returns null for a version the allowlist range would not permit', async () => {
            const pacote = pacoteStub({ version: '3.0.0' });
            const source = new AgentPluginNpmSource(
                allowlistStub({ allowed: true, entry: { versionRange: '1.*' } }),
            );
            source.setPacote(pacote);

            // Offering an update the operator has not authorised would invite
            // a one-click policy violation.
            await expect(source.latestVersion('acme-skills')).resolves.toBeNull();
        });

        it('returns the version when it is permitted', async () => {
            const source = new AgentPluginNpmSource(allowlistStub({ allowed: true }));
            source.setPacote(pacoteStub({ version: '1.4.0' }));
            await expect(source.latestVersion('acme-skills')).resolves.toBe('1.4.0');
        });
    });
});
