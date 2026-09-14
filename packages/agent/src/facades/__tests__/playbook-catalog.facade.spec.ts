import type { IPlaybookProviderPlugin, PluginManifest } from '@ever-works/plugin';
import type { PlaybookCatalogEntry } from '@ever-works/contracts';
import {
    PluginRegistryService,
    type RegisteredPlugin,
} from '../../plugins/services/plugin-registry.service';
import { PluginSettingsService } from '../../plugins/services/plugin-settings.service';
import {
    MAX_PLAYBOOK_CATALOG_ENTRIES,
    PLAYBOOK_PROVIDER_PAGE_SIZE,
    PlaybookCatalogFacadeService,
} from '../playbook-catalog.facade';

function playbook(slug: string, extra: Partial<PlaybookCatalogEntry> = {}): PlaybookCatalogEntry {
    return {
        slug,
        title: `Title ${slug}`,
        outcome: 'An outcome.',
        summary: 'A summary.',
        category: 'reporting',
        version: '1.0.0',
        icon: 'report',
        trigger: { kind: 'manual', description: 'On demand' },
        steps: [
            { position: 1, title: 'One', produces: 'A thing.', requiresApproval: false },
            { position: 2, title: 'Two', produces: 'Another.', requiresApproval: true },
        ],
        connections: [],
        artefacts: [{ kind: 'kb_document', title: 'Doc', where: 'Reports' }],
        escalations: [{ when: 'Always', becomes: 'approval', carriesRecommendation: true }],
        caps: {},
        costBand: 'low',
        estimatedTokensPerRun: { min: 1, max: 2 },
        tags: [],
        provision: {
            agentTemplateSlug: 'content-marketer',
            agentName: 'Reporter',
            skillSlugs: ['digest-compilation'],
            taskTemplate: { name: 'Template', slug: 'template' },
            guardrailsAtAdoption: { mode: 'require_approval' },
        },
        ...extra,
    };
}

function provider(
    id: string,
    entries: unknown[],
    overrides: Partial<IPlaybookProviderPlugin> = {},
): RegisteredPlugin {
    const plugin = {
        id,
        name: id,
        version: '1.0.0',
        category: 'utility',
        capabilities: ['playbook-provider'],
        settingsSchema: { type: 'object', properties: {} },
        providerName: id,
        onLoad: jest.fn(),
        onUnload: jest.fn(),
        listPlaybooks: jest.fn(async ({ limit, offset }: { limit: number; offset: number }) => ({
            entries: entries.slice(offset, offset + limit),
            total: entries.length,
        })),
        getPlaybook: jest.fn(
            async (slug: string) =>
                (entries as PlaybookCatalogEntry[]).find((e) => e?.slug === slug) ?? null,
        ),
        ...overrides,
    } as unknown as IPlaybookProviderPlugin;
    return {
        plugin,
        manifest: {
            id,
            name: id,
            version: '1.0.0',
            description: 'test',
            category: 'utility',
            capabilities: ['playbook-provider'],
        } as PluginManifest,
        state: 'loaded',
        builtIn: true,
        stateHistory: [],
        registeredAt: 0,
    };
}

function facadeWith(plugins: RegisteredPlugin[], enabled: (id: string) => boolean = () => true) {
    const registry = {
        getByCapability: jest.fn().mockReturnValue(plugins),
        isPluginEnabledForScope: jest.fn(async (id: string) => enabled(id)),
    } as unknown as PluginRegistryService;
    const settings = {
        getResolvedSettings: jest.fn().mockResolvedValue({}),
    } as unknown as PluginSettingsService;
    return { facade: new PlaybookCatalogFacadeService(registry, settings), registry };
}

const scope = { userId: 'user-1' };

describe('PlaybookCatalogFacadeService', () => {
    it('resolves providers for the playbook-provider capability', async () => {
        const { facade, registry } = facadeWith([]);
        await expect(facade.listEntries(scope)).resolves.toEqual([]);
        expect(registry.getByCapability).toHaveBeenCalledWith('playbook-provider');
    });

    it('fans out across every enabled provider and unions their entries', async () => {
        const { facade } = facadeWith([
            provider('a', [playbook('one'), playbook('two')]),
            provider('b', [playbook('three')]),
        ]);
        const result = await facade.listEntries(scope);
        expect(result.map((e) => e.slug)).toEqual(['one', 'two', 'three']);
    });

    it('skips a provider that is not enabled for the scope', async () => {
        const { facade } = facadeWith(
            [provider('a', [playbook('one')]), provider('off', [playbook('hidden')])],
            (id) => id !== 'off',
        );
        expect((await facade.listEntries(scope)).map((e) => e.slug)).toEqual(['one']);
    });

    it('dedupes by slug, keeping the first entry on an equal or lower version', async () => {
        const { facade } = facadeWith([
            provider('a', [playbook('same', { title: 'First', version: '1.2.0' })]),
            provider('b', [playbook('same', { title: 'Equal', version: '1.2.0' })]),
            provider('c', [playbook('same', { title: 'Lower', version: '1.1.9' })]),
        ]);
        const result = await facade.listEntries(scope);
        expect(result).toHaveLength(1);
        expect(result[0].title).toBe('First');
    });

    it('lets a strictly higher version replace an earlier entry (1.10.0 beats 1.9.0)', async () => {
        const { facade } = facadeWith([
            provider('builtin', [playbook('same', { title: 'Built-in', version: '1.9.0' })]),
            provider('hosted', [playbook('same', { title: 'Hosted', version: '1.10.0' })]),
        ]);
        const result = await facade.listEntries(scope);
        expect(result.map((e) => e.title)).toEqual(['Hosted']);
    });

    it('drops invalid entries and sanitises the rest', async () => {
        const { facade } = facadeWith([
            provider('a', [
                playbook('ok', { title: `<b>${'x'.repeat(200)}</b>` }),
                { ...playbook('bad'), slug: 'Not A Slug' },
                'garbage',
            ]),
        ]);
        const result = await facade.listEntries(scope);
        expect(result.map((e) => e.slug)).toEqual(['ok']);
        expect(result[0].title).toHaveLength(120);
        expect(result[0].title).not.toContain('<');
    });

    it('isolates a throwing provider so the others still answer', async () => {
        const broken = provider('broken', [], {
            listPlaybooks: jest.fn().mockRejectedValue(new Error('down')),
            getPlaybook: jest.fn().mockRejectedValue(new Error('down')),
        });
        const { facade } = facadeWith([broken, provider('ok', [playbook('one')])]);
        expect((await facade.listEntries(scope)).map((e) => e.slug)).toEqual(['one']);
        expect((await facade.getEntry('one', scope))?.providerId).toBe('ok');
    });

    it('pages through a provider in pages of 200 until its total is reached', async () => {
        const many = Array.from({ length: 450 }, (_, i) => playbook(`p-${i}`));
        const source = provider('big', many);
        const { facade } = facadeWith([source]);
        const result = await facade.listEntries(scope);
        expect(result).toHaveLength(450);
        const calls = (source.plugin as unknown as { listPlaybooks: jest.Mock }).listPlaybooks.mock
            .calls;
        expect(calls.map(([opts]) => opts.offset)).toEqual([0, 200, 400]);
        expect(calls.every(([opts]) => opts.limit === PLAYBOOK_PROVIDER_PAGE_SIZE)).toBe(true);
    });

    it('caps the merged catalogue at 2000 entries', async () => {
        const first = Array.from({ length: 1500 }, (_, i) => playbook(`a-${i}`));
        const second = Array.from({ length: 1500 }, (_, i) => playbook(`b-${i}`));
        const { facade } = facadeWith([provider('a', first), provider('b', second)]);
        const result = await facade.listEntries(scope);
        expect(result).toHaveLength(MAX_PLAYBOOK_CATALOG_ENTRIES);
        expect(result[result.length - 1].slug).toBe('b-499');
    });

    it('stops paging a provider that reports more than it returns', async () => {
        const liar = provider('liar', [], {
            listPlaybooks: jest.fn().mockResolvedValue({ entries: [], total: 999 }),
        });
        const { facade } = facadeWith([liar]);
        await expect(facade.listEntries(scope)).resolves.toEqual([]);
        expect(
            (liar.plugin as unknown as { listPlaybooks: jest.Mock }).listPlaybooks,
        ).toHaveBeenCalledTimes(1);
    });

    describe('getEntry', () => {
        it('returns the highest version across providers with its provider id', async () => {
            const { facade } = facadeWith([
                provider('a', [playbook('same', { version: '1.0.0' })]),
                provider('b', [playbook('same', { version: '2.0.0' })]),
                provider('c', [playbook('same', { version: '1.5.0' })]),
            ]);
            const found = await facade.getEntry('same', scope);
            expect(found?.entry.version).toBe('2.0.0');
            expect(found?.providerId).toBe('b');
        });

        it('returns null for an unknown slug', async () => {
            const { facade } = facadeWith([provider('a', [playbook('one')])]);
            await expect(facade.getEntry('nope', scope)).resolves.toBeNull();
        });

        it('ignores an invalid entry or one whose slug does not match', async () => {
            const { facade } = facadeWith([
                provider('a', [], {
                    getPlaybook: jest.fn().mockResolvedValue(playbook('other')),
                }),
                provider('b', [], {
                    getPlaybook: jest.fn().mockResolvedValue({ ...playbook('wanted'), steps: [] }),
                }),
            ]);
            await expect(facade.getEntry('wanted', scope)).resolves.toBeNull();
        });
    });
});
