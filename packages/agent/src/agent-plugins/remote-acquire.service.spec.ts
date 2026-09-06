import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentPluginRemoteAcquireService } from './remote-acquire.service';
import { AgentPluginGitSource, gitPackageDir } from './git-source';
import { AgentPluginNpmSource, npmPackageDir } from './npm-source';
import { AgentPluginAllowlistService } from './allowlist.service';

/**
 * These run against the REAL conformance library and the REAL filesystem.
 * Only the network layer is stubbed, because the property under test — that a
 * non-conforming package does not survive on disk — is a fact about files.
 */

const PLUGIN_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';

const allowAll = (): AgentPluginAllowlistService =>
    ({
        check: jest.fn().mockResolvedValue({ allowed: true, reason: 'allowed', entry: undefined }),
    }) as unknown as AgentPluginAllowlistService;

async function scratch(): Promise<string> {
    return mkdtemp(join(tmpdir(), 'ap-acquire-'));
}

/** Writes a package tree into whatever directory the acquirer asks for. */
async function writePackage(
    dir: string,
    manifest: Record<string, unknown>,
    skills: Record<string, string> = {},
): Promise<void> {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'plugin.json'), JSON.stringify(manifest, null, 2), 'utf8');
    for (const [name, body] of Object.entries(skills)) {
        await mkdir(join(dir, 'skills', name), { recursive: true });
        await writeFile(join(dir, 'skills', name, 'SKILL.md'), body, 'utf8');
    }
}

const skillFile = (name: string, description: string): string =>
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nInstructions.\n`;

function gitServiceWriting(
    manifest: Record<string, unknown>,
    skills: Record<string, string> = {},
    sha = 'b'.repeat(40),
): AgentPluginGitSource {
    const source = new AgentPluginGitSource(allowAll());
    source.setGitImplementation(
        {
            clone: jest.fn().mockImplementation(async (options: Record<string, unknown>) => {
                await writePackage(options.dir as string, manifest, skills);
            }),
            resolveRef: jest.fn().mockResolvedValue(sha),
            listServerRefs: jest.fn().mockResolvedValue([{ ref: 'HEAD', oid: sha }]),
        },
        {},
    );
    return source;
}

function npmServiceWriting(
    manifest: Record<string, unknown>,
    skills: Record<string, string> = {},
    version = '1.2.0',
): AgentPluginNpmSource {
    const source = new AgentPluginNpmSource(allowAll());
    source.setPacote({
        manifest: jest.fn().mockResolvedValue({ version, _integrity: 'sha512-abc' }),
        extract: jest.fn().mockImplementation(async (_spec: string, dest: string) => {
            await writePackage(dest, manifest, skills);
        }),
    });
    return source;
}

async function exists(path: string): Promise<boolean> {
    try {
        await stat(path);
        return true;
    } catch {
        return false;
    }
}

describe('AgentPluginRemoteAcquireService', () => {
    it('keeps a conforming git package, keyed by its resolved commit', async () => {
        const root = await scratch();
        const sha = 'c'.repeat(40);
        const service = new AgentPluginRemoteAcquireService(
            gitServiceWriting(
                { $schema: PLUGIN_SCHEMA, name: 'acme.tools', version: '1.4.0' },
                { 'release-notes': skillFile('release-notes', 'Draft release notes.') },
                sha,
            ),
            npmServiceWriting({}),
        );

        const result = await service.acquire(root, {
            kind: 'git',
            url: 'https://example.com/acme.git',
            ref: 'main',
        });

        expect(result.revision).toBe(sha);
        expect(result.load.ok).toBe(true);
        // Keyed by commit, so two refs resolving to different commits cannot
        // overwrite one another.
        expect(result.path).toBe(gitPackageDir(root, 'https://example.com/acme.git', sha));
        expect(await exists(join(result.path, 'plugin.json'))).toBe(true);
    });

    it('DISCARDS a fatally invalid git package instead of leaving it on disk', async () => {
        const root = await scratch();
        const sha = 'd'.repeat(40);
        const service = new AgentPluginRemoteAcquireService(
            // An invalid plugin name is a fatal manifest finding.
            gitServiceWriting({ $schema: PLUGIN_SCHEMA, name: 'Not A Valid Name' }, {}, sha),
            npmServiceWriting({}),
        );

        await expect(
            service.acquire(root, { kind: 'git', url: 'https://example.com/bad.git' }),
        ).rejects.toMatchObject({ status: 422 });

        // The laundering path this prevents: a rejected tree left in the
        // packages root would be found and loaded by the local-directory
        // scanner on the next boot, with no record that it was ever refused.
        expect(await exists(gitPackageDir(root, 'https://example.com/bad.git', sha))).toBe(false);
    });

    it('re-keys an npm package by its RESOLVED version, not the requested dist-tag', async () => {
        const root = await scratch();
        const service = new AgentPluginRemoteAcquireService(
            gitServiceWriting({}),
            npmServiceWriting(
                { $schema: PLUGIN_SCHEMA, name: 'acme.tools', version: '2.1.0' },
                { plan: skillFile('plan', 'Plan some work.') },
                '2.1.0',
            ),
        );

        const result = await service.acquire(root, {
            kind: 'npm',
            packageName: 'acme-skills',
            version: 'latest',
        });

        expect(result.revision).toBe('2.1.0');
        expect(result.path).toBe(npmPackageDir(root, 'acme-skills', '2.1.0'));
        // `latest` must not permanently own a directory whose contents
        // silently change underneath it.
        expect(await exists(npmPackageDir(root, 'acme-skills', 'latest'))).toBe(false);
    });

    it('DISCARDS a fatally invalid npm package', async () => {
        const root = await scratch();
        const service = new AgentPluginRemoteAcquireService(
            gitServiceWriting({}),
            npmServiceWriting({ $schema: PLUGIN_SCHEMA, name: 'Bad Name' }, {}, '1.0.0'),
        );

        await expect(
            service.acquire(root, { kind: 'npm', packageName: 'acme-skills' }),
        ).rejects.toMatchObject({ status: 422 });

        expect(await exists(npmPackageDir(root, 'acme-skills', '1.0.0'))).toBe(false);
    });

    it('reports the fatal findings so an operator can see WHY it was refused', async () => {
        const root = await scratch();
        const service = new AgentPluginRemoteAcquireService(
            gitServiceWriting({ $schema: PLUGIN_SCHEMA, name: 'Bad Name' }),
            npmServiceWriting({}),
        );

        await service.acquire(root, { kind: 'git', url: 'https://example.com/bad.git' }).then(
            () => {
                throw new Error('expected the acquisition to be refused');
            },
            (err: { getResponse(): { findings?: unknown[] } }) => {
                const body = err.getResponse();
                expect(Array.isArray(body.findings)).toBe(true);
                expect(body.findings?.length).toBeGreaterThan(0);
            },
        );
    });

    it('keeps a package whose SKILLS are broken but whose manifest is valid', async () => {
        const root = await scratch();
        const service = new AgentPluginRemoteAcquireService(
            gitServiceWriting(
                { $schema: PLUGIN_SCHEMA, name: 'mixed' },
                {
                    good: skillFile('good', 'This one conforms.'),
                    bad: '---\nname: bad\n---\n\nNo description.\n',
                },
                'e'.repeat(40),
            ),
            npmServiceWriting({}),
        );

        const result = await service.acquire(root, {
            kind: 'git',
            url: 'https://example.com/mixed.git',
        });

        // Per-skill failure isolation: one bad skill must not cost the
        // operator the whole package.
        expect(result.load.ok).toBe(true);
        expect(await exists(result.path)).toBe(true);
    });
});
