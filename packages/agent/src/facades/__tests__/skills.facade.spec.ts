import type { ISkillsProviderPlugin, PluginManifest, SkillCatalogEntry } from '@ever-works/plugin';
import {
    PluginRegistryService,
    type RegisteredPlugin,
} from '../../plugins/services/plugin-registry.service';
import { PluginSettingsService } from '../../plugins/services/plugin-settings.service';
import { SkillsFacadeService } from '../skills.facade';

function makeEntry(index: number): SkillCatalogEntry {
    return {
        slug: `skill-${index}`,
        title: `Skill ${index}`,
        description: `Skill ${index}`,
        frontmatter: { name: `skill-${index}`, description: `Skill ${index}` },
        body: `# Skill ${index}`,
        version: '1.0.0',
        tags: [],
    };
}

function makeProvider(entries: SkillCatalogEntry[]): ISkillsProviderPlugin {
    return {
        id: 'provider',
        name: 'Provider',
        version: '1.0.0',
        category: 'utility',
        capabilities: ['skills-provider'],
        settingsSchema: { type: 'object', properties: {} },
        configurationMode: 'hybrid',
        providerName: 'Provider',
        onLoad: jest.fn(),
        onUnload: jest.fn(),
        listEntries: jest.fn().mockImplementation(({ limit, offset }) => ({
            entries: entries.slice(offset, offset + limit),
            total: entries.length,
        })),
        getEntry: jest.fn(),
    } as ISkillsProviderPlugin;
}

function makeRegistered(plugin: ISkillsProviderPlugin): RegisteredPlugin {
    return {
        plugin,
        manifest: {
            id: plugin.id,
            name: plugin.name,
            version: plugin.version,
            description: 'Test provider',
            category: plugin.category,
            capabilities: ['skills-provider'],
        } as PluginManifest,
        state: 'loaded',
        builtIn: true,
        stateHistory: [],
        registeredAt: 0,
    };
}

describe('SkillsFacadeService', () => {
    it('returns a stable total across catalog pages', async () => {
        const entries = Array.from({ length: 120 }, (_, index) => makeEntry(index));
        const provider = makeProvider(entries);
        const registry = {
            getByCapability: jest.fn().mockReturnValue([makeRegistered(provider)]),
            isPluginEnabledForScope: jest.fn().mockResolvedValue(true),
        } as unknown as PluginRegistryService;
        const settings = {
            getResolvedSettings: jest.fn().mockResolvedValue({}),
        } as unknown as PluginSettingsService;
        const service = new SkillsFacadeService(registry, settings);

        const firstPage = await service.listEntries({ limit: 50, offset: 0 }, { userId: 'user-1' });
        const secondPage = await service.listEntries(
            { limit: 50, offset: 50 },
            { userId: 'user-1' },
        );

        expect(firstPage.entries).toHaveLength(50);
        expect(secondPage.entries).toHaveLength(50);
        expect(firstPage.total).toBe(120);
        expect(secondPage.total).toBe(120);
    });
});
