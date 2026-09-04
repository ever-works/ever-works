import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ISkillsProviderPlugin, PluginManifest, SkillCatalogEntry } from '@ever-works/plugin';
import {
    PluginRegistryService,
    type RegisteredPlugin,
} from '../../plugins/services/plugin-registry.service';
import { PluginSettingsService } from '../../plugins/services/plugin-settings.service';
import { SkillsFacadeService } from '../../facades/skills.facade';
import { AgentPluginPackageCatalogService } from '../package-catalog.service';

/**
 * End-to-end through the real objects: a package written to a real directory,
 * read by the real conformance library, mapped by the real catalog service,
 * and merged by the real facade. Nothing is mocked except the plugin registry,
 * which stands in for the provider plugins the facade would otherwise load.
 *
 * The unit suites each prove one link. This proves the CHAIN — which is where
 * a wiring mistake lives: every piece can be correct while the assembled
 * whole surfaces nothing.
 */

const PLUGIN_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
const MCP_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';

const facadeOptions = { userId: 'user-1' } as never;
const page = { limit: 50, offset: 0 } as never;

async function packagesRoot(): Promise<string> {
    return mkdtemp(join(tmpdir(), 'agent-plugins-e2e-'));
}

async function writePackage(
    root: string,
    dirName: string,
    manifest: Record<string, unknown>,
    skills: Record<string, string> = {},
    mcp?: unknown,
): Promise<void> {
    const dir = join(root, dirName);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'plugin.json'), JSON.stringify(manifest, null, 2), 'utf8');
    for (const [name, body] of Object.entries(skills)) {
        await mkdir(join(dir, 'skills', name), { recursive: true });
        await writeFile(join(dir, 'skills', name, 'SKILL.md'), body, 'utf8');
    }
    if (mcp !== undefined) {
        await writeFile(join(dir, 'mcp.json'), JSON.stringify(mcp, null, 2), 'utf8');
    }
}

const skillFile = (name: string, description: string, extra = ''): string =>
    `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n# ${name}\n\nInstructions.\n`;

function builtinProvider(entries: SkillCatalogEntry[]): RegisteredPlugin {
    const plugin = {
        id: 'everworks-skills',
        name: 'Ever Works Skills',
        version: '1.0.0',
        category: 'utility',
        capabilities: ['skills-provider'],
        settingsSchema: { type: 'object', properties: {} },
        configurationMode: 'hybrid',
        providerName: 'Ever Works Skills',
        onLoad: jest.fn(),
        onUnload: jest.fn(),
        listEntries: jest
            .fn()
            .mockImplementation(({ limit, offset }: { limit: number; offset: number }) => ({
                entries: entries.slice(offset, offset + limit),
                total: entries.length,
            })),
        getEntry: jest
            .fn()
            .mockImplementation(
                async (slug: string) => entries.find((e) => e.slug === slug) ?? null,
            ),
    } as unknown as ISkillsProviderPlugin;

    return {
        plugin,
        manifest: {
            id: 'everworks-skills',
            name: 'Ever Works Skills',
            version: '1.0.0',
            description: 'Built-in catalog',
            category: 'utility',
            capabilities: ['skills-provider'],
        } as PluginManifest,
        state: 'loaded',
        builtIn: true,
        stateHistory: [],
        registeredAt: 0,
    };
}

function builtinEntry(slug: string): SkillCatalogEntry {
    return {
        slug,
        title: slug,
        description: `Built-in ${slug}`,
        frontmatter: { name: slug, description: `Built-in ${slug}` },
        body: 'Built-in body.',
        version: '1.0.0',
        tags: [],
    };
}

function facadeWith(providers: RegisteredPlugin[], source?: AgentPluginPackageCatalogService) {
    const registry = {
        getByCapability: jest.fn().mockReturnValue(providers),
        isPluginEnabledForScope: jest.fn().mockResolvedValue(true),
    } as unknown as PluginRegistryService;
    const settings = {
        getResolvedSettings: jest.fn().mockResolvedValue({}),
    } as unknown as PluginSettingsService;
    return new SkillsFacadeService(registry, settings, undefined, source);
}

describe('Agent Plugins → skills catalog (integration)', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        process.env = { ...originalEnv };
        delete process.env.AGENT_PLUGINS_DIR;
        delete process.env.FEATURE_AGENT_PLUGINS;
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    it('surfaces a package skill in the catalog, end to end', async () => {
        const root = await packagesRoot();
        await writePackage(
            root,
            'acme-tools',
            { $schema: PLUGIN_SCHEMA, name: 'acme.tools', version: '1.4.0' },
            {
                'release-notes': skillFile(
                    'release-notes',
                    'Draft release notes from a changelog.',
                ),
            },
            {
                $schema: MCP_SCHEMA,
                mcpServers: {
                    api: { type: 'streamable-http', url: 'https://acme.example.com/mcp' },
                },
            },
        );
        process.env.AGENT_PLUGINS_DIR = root;
        process.env.FEATURE_AGENT_PLUGINS = 'true';

        const facade = facadeWith(
            [builtinProvider([builtinEntry('plan')])],
            new AgentPluginPackageCatalogService(),
        );

        const result = await facade.listEntries(page, facadeOptions);

        expect(result.entries.map((e) => e.slug)).toEqual(['plan', 'release-notes']);
        expect(result.total).toBe(2);

        const fromPackage = result.entries.find((e) => e.slug === 'release-notes');
        expect(fromPackage).toMatchObject({
            packageName: 'acme.tools',
            packageVersion: '1.4.0',
            version: '1.4.0',
            sourceKind: 'local',
        });
        expect(fromPackage?.body).toContain('Instructions.');

        // The install path resolves through getEntry, so it must find the same
        // skill the card was rendered from.
        await expect(facade.getEntry('release-notes', facadeOptions)).resolves.toMatchObject({
            providerId: 'agent-plugins',
            entry: { slug: 'release-notes' },
        });
    });

    it('changes nothing at all while the flag is off', async () => {
        const root = await packagesRoot();
        await writePackage(
            root,
            'acme-tools',
            { $schema: PLUGIN_SCHEMA, name: 'acme.tools' },
            {
                'release-notes': skillFile('release-notes', 'Draft release notes.'),
            },
        );
        process.env.AGENT_PLUGINS_DIR = root;
        // FEATURE_AGENT_PLUGINS deliberately unset.

        const facade = facadeWith(
            [builtinProvider([builtinEntry('plan')])],
            new AgentPluginPackageCatalogService(),
        );

        const result = await facade.listEntries(page, facadeOptions);

        expect(result.entries.map((e) => e.slug)).toEqual(['plan']);
        expect(result.total).toBe(1);
        await expect(facade.getEntry('release-notes', facadeOptions)).resolves.toBeNull();
    });

    it('never lets a package displace a built-in skill of the same slug', async () => {
        const root = await packagesRoot();
        await writePackage(
            root,
            'shadower',
            { $schema: PLUGIN_SCHEMA, name: 'shadower' },
            {
                plan: skillFile('plan', 'A package skill claiming a built-in slug.'),
            },
        );
        process.env.AGENT_PLUGINS_DIR = root;
        process.env.FEATURE_AGENT_PLUGINS = 'true';

        const facade = facadeWith(
            [builtinProvider([builtinEntry('plan')])],
            new AgentPluginPackageCatalogService(),
        );

        const result = await facade.listEntries(page, facadeOptions);

        expect(result.entries).toHaveLength(1);
        expect(result.entries[0]?.description).toBe('Built-in plan');
        // And the install path agrees, or the card and the install would
        // disagree about which skill the user is getting.
        await expect(facade.getEntry('plan', facadeOptions)).resolves.toMatchObject({
            providerId: 'everworks-skills',
        });
    });

    it('surfaces package skills even with no provider plugin enabled', async () => {
        // Only `everworks-skills` auto-enables, so a deployment with no
        // skills-provider plugin is real — and the facade used to return early
        // in exactly that case.
        const root = await packagesRoot();
        await writePackage(
            root,
            'acme-tools',
            { $schema: PLUGIN_SCHEMA, name: 'acme.tools' },
            {
                'release-notes': skillFile('release-notes', 'Draft release notes.'),
            },
        );
        process.env.AGENT_PLUGINS_DIR = root;
        process.env.FEATURE_AGENT_PLUGINS = 'true';

        const facade = facadeWith([], new AgentPluginPackageCatalogService());

        const result = await facade.listEntries(page, facadeOptions);

        expect(result.entries.map((e) => e.slug)).toEqual(['release-notes']);
    });

    it('keeps the good skills of a package whose other skills are broken', async () => {
        const root = await packagesRoot();
        await writePackage(
            root,
            'mixed',
            { $schema: PLUGIN_SCHEMA, name: 'mixed' },
            {
                good: skillFile('good', 'This one conforms.'),
                mismatched: skillFile('other-name', 'Frontmatter disagrees with the directory.'),
                'no-description': '---\nname: no-description\n---\n\nMissing its description.\n',
            },
        );
        process.env.AGENT_PLUGINS_DIR = root;
        process.env.FEATURE_AGENT_PLUGINS = 'true';

        const facade = facadeWith([], new AgentPluginPackageCatalogService());

        const result = await facade.listEntries(page, facadeOptions);

        // Per-skill failure isolation, carried all the way from the
        // conformance library to the catalog.
        expect(result.entries.map((e) => e.slug)).toEqual(['good']);
    });

    it('drops an entire package whose manifest is fatally invalid', async () => {
        const root = await packagesRoot();
        await writePackage(
            root,
            'broken',
            { $schema: PLUGIN_SCHEMA, name: 'Bad Name' },
            {
                hidden: skillFile('hidden', 'Should never reach the catalog.'),
            },
        );
        await writePackage(
            root,
            'fine',
            { $schema: PLUGIN_SCHEMA, name: 'fine' },
            {
                visible: skillFile('visible', 'Should reach the catalog.'),
            },
        );
        process.env.AGENT_PLUGINS_DIR = root;
        process.env.FEATURE_AGENT_PLUGINS = 'true';

        const facade = facadeWith([], new AgentPluginPackageCatalogService());

        const result = await facade.listEntries(page, facadeOptions);

        // A fatal manifest means discover nothing from THAT package, while its
        // neighbour is unaffected.
        expect(result.entries.map((e) => e.slug)).toEqual(['visible']);
    });

    it('paginates a mixed catalog consistently', async () => {
        const root = await packagesRoot();
        await writePackage(
            root,
            'many',
            { $schema: PLUGIN_SCHEMA, name: 'many' },
            {
                'pkg-a': skillFile('pkg-a', 'Package skill A.'),
                'pkg-b': skillFile('pkg-b', 'Package skill B.'),
            },
        );
        process.env.AGENT_PLUGINS_DIR = root;
        process.env.FEATURE_AGENT_PLUGINS = 'true';

        const facade = facadeWith(
            [builtinProvider([builtinEntry('builtin-1'), builtinEntry('builtin-2')])],
            new AgentPluginPackageCatalogService(),
        );

        const first = await facade.listEntries({ limit: 3, offset: 0 } as never, facadeOptions);
        const second = await facade.listEntries({ limit: 3, offset: 3 } as never, facadeOptions);

        expect(first.total).toBe(4);
        expect(second.total).toBe(4);
        expect([...first.entries, ...second.entries].map((e) => e.slug)).toEqual([
            'builtin-1',
            'builtin-2',
            'pkg-a',
            'pkg-b',
        ]);
    });
});

describe('Agent Plugins → skills catalog updates (integration)', () => {
    /**
     * `ISkillsProviderPlugin.checkForUpdates` was on the contract and
     * implemented by two plugins with ZERO non-test callers. These tests exist
     * to keep it called: a seam every provider implements and nothing invokes
     * is indistinguishable from one that does not work.
     */

    function providerWithUpdates(
        updated: Array<{ slug: string; oldVersion: string; newVersion: string }>,
        implemented = true,
    ): RegisteredPlugin {
        const base = builtinProvider([builtinEntry('plan')]);
        const plugin = base.plugin as unknown as Record<string, unknown>;
        if (implemented) {
            plugin.checkForUpdates = jest.fn().mockResolvedValue({ updated });
        } else {
            delete plugin.checkForUpdates;
        }
        return base;
    }

    it('calls the provider seam and returns what it reports', async () => {
        const provider = providerWithUpdates([
            { slug: 'plan', oldVersion: '1.0.0', newVersion: '1.1.0' },
        ]);
        const facade = facadeWith([provider]);

        const result = await facade.checkForUpdates({ plan: '1.0.0' }, facadeOptions);

        expect(result.updated).toEqual([
            { slug: 'plan', oldVersion: '1.0.0', newVersion: '1.1.0' },
        ]);
        expect(
            (provider.plugin as unknown as { checkForUpdates: jest.Mock }).checkForUpdates,
        ).toHaveBeenCalledWith({ plan: '1.0.0' }, expect.anything());
    });

    it('skips a provider that does not implement the optional method', async () => {
        const facade = facadeWith([providerWithUpdates([], false)]);

        // Optional on the interface, so absence is normal rather than an error.
        await expect(facade.checkForUpdates({ plan: '1.0.0' }, facadeOptions)).resolves.toEqual({
            updated: [],
        });
    });

    it('does not let one failing provider hide another provider’s updates', async () => {
        const failing = builtinProvider([]);
        (failing.plugin as unknown as Record<string, unknown>).checkForUpdates = jest
            .fn()
            .mockRejectedValue(new Error('provider down'));
        (failing.plugin as unknown as Record<string, unknown>).id = 'failing-provider';

        const working = providerWithUpdates([
            { slug: 'plan', oldVersion: '1.0.0', newVersion: '2.0.0' },
        ]);

        const facade = facadeWith([failing, working]);

        const result = await facade.checkForUpdates({ plan: '1.0.0' }, facadeOptions);

        expect(result.updated).toHaveLength(1);
    });

    it('appends package updates after provider updates, never displacing them', async () => {
        const provider = providerWithUpdates([
            { slug: 'plan', oldVersion: '1.0.0', newVersion: '1.1.0' },
        ]);
        const packageSource = {
            listEntries: jest.fn().mockResolvedValue([]),
            getEntry: jest.fn().mockResolvedValue(null),
            checkForUpdates: jest.fn().mockResolvedValue([
                // Same slug as the provider's: must be dropped, matching the
                // first-wins precedence `listEntries` establishes.
                { slug: 'plan', oldVersion: '1.0.0', newVersion: '9.9.9' },
                { slug: 'release-notes', oldVersion: '1.0.0', newVersion: '1.4.0' },
            ]),
        };

        const facade = facadeWith([provider], packageSource as never);

        const result = await facade.checkForUpdates({ plan: '1.0.0' }, facadeOptions);

        expect(result.updated).toEqual([
            { slug: 'plan', oldVersion: '1.0.0', newVersion: '1.1.0' },
            { slug: 'release-notes', oldVersion: '1.0.0', newVersion: '1.4.0' },
        ]);
    });

    it('works with no provider plugin enabled at all', async () => {
        const packageSource = {
            listEntries: jest.fn().mockResolvedValue([]),
            getEntry: jest.fn().mockResolvedValue(null),
            checkForUpdates: jest
                .fn()
                .mockResolvedValue([
                    { slug: 'release-notes', oldVersion: '1.0.0', newVersion: '1.4.0' },
                ]),
        };

        const facade = facadeWith([], packageSource as never);

        const result = await facade.checkForUpdates({ 'release-notes': '1.0.0' }, facadeOptions);

        expect(result.updated).toHaveLength(1);
    });
});
