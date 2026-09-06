import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentPluginPackageCatalogService } from './package-catalog.service';

const PLUGIN_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';

const options = { facadeOptions: { userId: 'user-1' } } as never;

async function packagesRoot(): Promise<string> {
    return mkdtemp(join(tmpdir(), 'agent-plugins-catalog-'));
}

async function writePackage(
    root: string,
    dirName: string,
    manifest: Record<string, unknown>,
    skills: Record<string, string> = {},
): Promise<void> {
    const dir = join(root, dirName);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'plugin.json'), JSON.stringify(manifest), 'utf8');
    for (const [name, body] of Object.entries(skills)) {
        await mkdir(join(dir, 'skills', name), { recursive: true });
        await writeFile(join(dir, 'skills', name, 'SKILL.md'), body, 'utf8');
    }
}

const skillFile = (name: string, description: string, extra = ''): string =>
    `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n# ${name}\n\nBody text.\n`;

describe('AgentPluginPackageCatalogService', () => {
    const originalEnv = process.env;
    let service: AgentPluginPackageCatalogService;

    beforeEach(() => {
        process.env = { ...originalEnv };
        delete process.env.AGENT_PLUGINS_DIR;
        process.env.FEATURE_AGENT_PLUGINS = 'true';
        service = new AgentPluginPackageCatalogService();
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    it('returns nothing at all when the feature is off', async () => {
        const root = await packagesRoot();
        await writePackage(
            root,
            'tools',
            { $schema: PLUGIN_SCHEMA, name: 'tools' },
            {
                deploy: skillFile('deploy', 'Deploy a service.'),
            },
        );
        process.env.AGENT_PLUGINS_DIR = root;
        process.env.FEATURE_AGENT_PLUGINS = 'false';

        await expect(service.listEntries(options)).resolves.toEqual([]);
        await expect(service.getEntry('deploy', options)).resolves.toBeNull();
    });

    it('maps a package skill into a catalog entry with provenance', async () => {
        const root = await packagesRoot();
        await writePackage(
            root,
            'tools',
            { $schema: PLUGIN_SCHEMA, name: 'acme.tools', version: '2.1.0' },
            { deploy: skillFile('deploy', 'Deploy a service. Use when shipping.') },
        );
        process.env.AGENT_PLUGINS_DIR = root;

        const entries = await service.listEntries(options);

        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({
            slug: 'deploy',
            description: 'Deploy a service. Use when shipping.',
            version: '2.1.0',
            packageName: 'acme.tools',
            packageVersion: '2.1.0',
            sourceKind: 'local',
        });
        expect(entries[0]?.body).toContain('Body text.');
    });

    it('keeps provenance OUT of frontmatter', async () => {
        // `installFromCatalog` writes frontmatter verbatim into the stored
        // Skill row, and that JSON is injected into the model's context.
        // Provenance is for the operator reading a catalog card, not the model
        // reading a skill.
        const root = await packagesRoot();
        await writePackage(
            root,
            'tools',
            { $schema: PLUGIN_SCHEMA, name: 'tools' },
            {
                deploy: skillFile('deploy', 'Deploy a service.'),
            },
        );
        process.env.AGENT_PLUGINS_DIR = root;

        const [entry] = await service.listEntries(options);

        expect(entry?.frontmatter).not.toHaveProperty('packageName');
        expect(entry?.frontmatter).not.toHaveProperty('sourceKind');
        expect(Object.keys(entry?.frontmatter ?? {}).sort()).toEqual(['description', 'name']);
    });

    it('tokenizes allowed-tools at ingest, into the platform shape', async () => {
        const root = await packagesRoot();
        await writePackage(
            root,
            'tools',
            { $schema: PLUGIN_SCHEMA, name: 'tools' },
            {
                deploy: skillFile('deploy', 'Deploy.', 'allowed-tools: Bash(git:*) Read\n'),
            },
        );
        process.env.AGENT_PLUGINS_DIR = root;

        const [entry] = await service.listEntries(options);

        // The specification's wire form is one space-separated string; the
        // platform works in tokens.
        expect(entry?.frontmatter.allowedTools).toEqual(['Bash(git:*)', 'Read']);
    });

    it('never emits a version longer than the storage column allows', async () => {
        // `skills.sourceCatalogVersion` is varchar(16). A version that
        // overflows it passes every test in this package and then throws at
        // INSERT the first time somebody clicks Install.
        const root = await packagesRoot();
        await writePackage(
            root,
            'unversioned',
            { $schema: PLUGIN_SCHEMA, name: 'unversioned' },
            { a: skillFile('a', 'No package version at all.') },
        );
        await writePackage(
            root,
            'overlong',
            {
                $schema: PLUGIN_SCHEMA,
                name: 'overlong',
                version: '1.0.0-rc.1+build.20260903.deadbeef',
            },
            { b: skillFile('b', 'A very long version string.') },
        );
        process.env.AGENT_PLUGINS_DIR = root;

        const entries = await service.listEntries(options);

        expect(entries).toHaveLength(2);
        for (const entry of entries) {
            expect(entry.version.length).toBeLessThanOrEqual(
                AgentPluginPackageCatalogService.MAX_VERSION_LENGTH,
            );
            expect(entry.version.length).toBeGreaterThan(0);
        }
    });

    it('synthesizes a stable version for a package that declares none', async () => {
        const root = await packagesRoot();
        await writePackage(
            root,
            'tools',
            { $schema: PLUGIN_SCHEMA, name: 'tools' },
            {
                deploy: skillFile('deploy', 'Deploy.'),
            },
        );
        process.env.AGENT_PLUGINS_DIR = root;

        const first = await service.listEntries(options);
        const second = await service.listEntries(options);

        // Absent is legal — the specification forbids rejecting a package for
        // it — so the catalog's required version has to come from somewhere,
        // and it must not change between two reads of the same package.
        expect(first[0]?.version).toBe(second[0]?.version);
    });

    it('skips a package whose manifest is invalid, keeping the rest', async () => {
        const root = await packagesRoot();
        await writePackage(
            root,
            'good',
            { $schema: PLUGIN_SCHEMA, name: 'good' },
            {
                works: skillFile('works', 'This one loads.'),
            },
        );
        await writePackage(
            root,
            'broken',
            { $schema: PLUGIN_SCHEMA, name: 'Bad Name' },
            {
                hidden: skillFile('hidden', 'Never reaches the catalog.'),
            },
        );
        process.env.AGENT_PLUGINS_DIR = root;

        const entries = await service.listEntries(options);

        expect(entries.map((e) => e.slug)).toEqual(['works']);
    });

    it('filters by tag and by search text', async () => {
        const root = await packagesRoot();
        await writePackage(
            root,
            'tools',
            { $schema: PLUGIN_SCHEMA, name: 'tools' },
            {
                deploy: skillFile('deploy', 'Ship a service.', 'tags:\n  - ops\n'),
                summarise: skillFile('summarise', 'Condense a document.', 'tags:\n  - writing\n'),
            },
        );
        process.env.AGENT_PLUGINS_DIR = root;

        const byTag = await service.listEntries({ ...(options as object), tags: ['ops'] } as never);
        expect(byTag.map((e) => e.slug)).toEqual(['deploy']);

        const bySearch = await service.listEntries({
            ...(options as object),
            search: 'condense',
        } as never);
        expect(bySearch.map((e) => e.slug)).toEqual(['summarise']);
    });

    it('returns entries in a stable order', async () => {
        const root = await packagesRoot();
        await writePackage(
            root,
            'tools',
            { $schema: PLUGIN_SCHEMA, name: 'tools' },
            {
                zulu: skillFile('zulu', 'Last alphabetically.'),
                alpha: skillFile('alpha', 'First alphabetically.'),
            },
        );
        process.env.AGENT_PLUGINS_DIR = root;

        const entries = await service.listEntries(options);

        expect(entries.map((e) => e.slug)).toEqual(['alpha', 'zulu']);
    });

    describe('getEntry', () => {
        it('agrees with listEntries about slugs', async () => {
            // If the two disagreed, the catalog would show a card whose
            // Install button 404s.
            const root = await packagesRoot();
            await writePackage(
                root,
                'tools',
                { $schema: PLUGIN_SCHEMA, name: 'tools' },
                {
                    deploy: skillFile('deploy', 'Deploy a service.'),
                },
            );
            process.env.AGENT_PLUGINS_DIR = root;

            const listed = await service.listEntries(options);
            for (const entry of listed) {
                const found = await service.getEntry(entry.slug, options);
                expect(found?.entry.slug).toBe(entry.slug);
                expect(found?.providerId).toBe('agent-plugins');
            }
        });

        it('ignores the caller filters, so a filtered view can still install', async () => {
            const root = await packagesRoot();
            await writePackage(
                root,
                'tools',
                { $schema: PLUGIN_SCHEMA, name: 'tools' },
                {
                    deploy: skillFile('deploy', 'Ship a service.', 'tags:\n  - ops\n'),
                },
            );
            process.env.AGENT_PLUGINS_DIR = root;

            const found = await service.getEntry('deploy', {
                ...(options as object),
                tags: ['something-else'],
            } as never);

            expect(found?.entry.slug).toBe('deploy');
        });

        it('returns null for an unknown slug', async () => {
            const root = await packagesRoot();
            await writePackage(root, 'tools', { $schema: PLUGIN_SCHEMA, name: 'tools' });
            process.env.AGENT_PLUGINS_DIR = root;

            await expect(service.getEntry('nope', options)).resolves.toBeNull();
        });
    });
});
