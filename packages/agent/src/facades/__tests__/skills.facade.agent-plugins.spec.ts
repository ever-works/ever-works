import type { ISkillsProviderPlugin, PluginManifest, SkillCatalogEntry } from '@ever-works/plugin';
import {
    PluginRegistryService,
    type RegisteredPlugin,
} from '../../plugins/services/plugin-registry.service';
import { PluginSettingsService } from '../../plugins/services/plugin-settings.service';
import { SkillsFacadeService } from '../skills.facade';
import type {
    AgentPluginSkillSource,
    AgentPluginSkillSourceOptions,
} from '../../agent-plugins/skill-source.token';

/**
 * The Agent Plugins additive catalog source.
 *
 * The property that matters most here is a negative one: with nothing bound,
 * this facade must behave EXACTLY as it did before the seam existed. Every
 * other guarantee — packages never displacing a provider, the source being
 * consulted even with no providers enabled, `getEntry` agreeing with
 * `listEntries` — is about the feature working; that one is about the other
 * ~100 deployments where the flag stays off.
 */

const entry = (slug: string, extra?: Partial<SkillCatalogEntry>): SkillCatalogEntry => ({
    slug,
    title: slug,
    description: `${slug} description`,
    frontmatter: { name: slug, description: `${slug} description` },
    body: 'Body.',
    version: '1.0.0',
    tags: [],
    ...extra,
});

/** A skills provider, shaped as the registry hands it to the facade. */
function providerPlugin(id: string, entries: SkillCatalogEntry[]): RegisteredPlugin {
    const plugin = {
        id,
        name: id,
        version: '1.0.0',
        category: 'utility',
        capabilities: ['skills-provider'],
        settingsSchema: { type: 'object', properties: {} },
        configurationMode: 'hybrid',
        providerName: id,
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
            id,
            name: id,
            version: '1.0.0',
            description: 'Test provider',
            category: 'utility',
            capabilities: ['skills-provider'],
        } as PluginManifest,
        state: 'loaded',
        builtIn: true,
        stateHistory: [],
        registeredAt: 0,
    };
}

function registryWith(plugins: RegisteredPlugin[]): PluginRegistryService {
    return {
        getByCapability: jest.fn().mockReturnValue(plugins),
        isPluginEnabledForScope: jest.fn().mockResolvedValue(true),
    } as unknown as PluginRegistryService;
}

const settingsStub = {
    getResolvedSettings: jest.fn().mockResolvedValue({}),
} as unknown as PluginSettingsService;

/** A package source that records what the facade asked it for. */
function packageSource(entries: SkillCatalogEntry[]): AgentPluginSkillSource & {
    listCalls: AgentPluginSkillSourceOptions[];
} {
    const listCalls: AgentPluginSkillSourceOptions[] = [];
    return {
        listCalls,
        async listEntries(options) {
            listCalls.push(options);
            return entries;
        },
        async getEntry(slug) {
            const found = entries.find((e) => e.slug === slug);
            return found ? { entry: found, providerId: 'agent-plugins' } : null;
        },
    };
}

describe('SkillsFacadeService — Agent Plugins additive source', () => {
    const facadeOptions = { userId: 'user-1' } as never;
    const listOptions = { limit: 50, offset: 0 } as never;

    describe('when nothing is bound', () => {
        it('behaves exactly as before, including the empty-provider early return', async () => {
            const facade = new SkillsFacadeService(registryWith([]), settingsStub, undefined);

            await expect(facade.listEntries(listOptions, facadeOptions)).resolves.toEqual({
                entries: [],
                total: 0,
            });
            await expect(facade.getEntry('anything', facadeOptions)).resolves.toBeNull();
        });

        it('still aggregates provider entries', async () => {
            const facade = new SkillsFacadeService(
                registryWith([providerPlugin('everworks-skills', [entry('plan')])]),
                settingsStub,
                undefined,
            );

            const result = await facade.listEntries(listOptions, facadeOptions);
            expect(result.entries.map((e) => e.slug)).toEqual(['plan']);
        });
    });

    describe('when a package source is bound', () => {
        it('is consulted even when NO provider plugin is enabled', async () => {
            // The regression this guards: the facade used to return early on
            // an empty provider list, which would have made every package
            // skill silently invisible. Only `everworks-skills` auto-enables,
            // so "no provider enabled" is a real deployment state.
            const source = packageSource([entry('from-package', { sourceKind: 'local' })]);
            const facade = new SkillsFacadeService(
                registryWith([]),
                settingsStub,
                undefined,
                source,
            );

            const result = await facade.listEntries(listOptions, facadeOptions);

            expect(result.entries.map((e) => e.slug)).toEqual(['from-package']);
            expect(result.total).toBe(1);
        });

        it('merges package entries AFTER providers, so a package can never displace one', async () => {
            const source = packageSource([
                entry('shared', { description: 'from the package' }),
                entry('unique-to-package'),
            ]);
            const facade = new SkillsFacadeService(
                registryWith([
                    providerPlugin('everworks-skills', [
                        entry('shared', { description: 'from the provider' }),
                    ]),
                ]),
                settingsStub,
                undefined,
                source,
            );

            const result = await facade.listEntries(listOptions, facadeOptions);

            expect(result.entries.map((e) => e.slug)).toEqual(['shared', 'unique-to-package']);
            // First-wins dedupe: the provider's version of the colliding slug
            // survives, which is the whole safety argument for merging last.
            expect(result.entries[0]?.description).toBe('from the provider');
        });

        it('passes the caller filters through to the source', async () => {
            const source = packageSource([]);
            const facade = new SkillsFacadeService(
                registryWith([]),
                settingsStub,
                undefined,
                source,
            );

            await facade.listEntries(
                { limit: 10, offset: 0, tags: ['ops'], search: 'deploy' } as never,
                facadeOptions,
            );

            expect(source.listCalls).toHaveLength(1);
            expect(source.listCalls[0]?.tags).toEqual(['ops']);
            expect(source.listCalls[0]?.search).toBe('deploy');
        });

        it('survives a throwing source without failing the catalog', async () => {
            // Same posture as a failing provider: one bad source must not turn
            // a working catalog into a 500.
            const broken: AgentPluginSkillSource = {
                listEntries: jest.fn().mockRejectedValue(new Error('disk gone')),
                getEntry: jest.fn().mockRejectedValue(new Error('disk gone')),
            };
            const facade = new SkillsFacadeService(
                registryWith([providerPlugin('everworks-skills', [entry('plan')])]),
                settingsStub,
                undefined,
                broken,
            );

            const result = await facade.listEntries(listOptions, facadeOptions);

            expect(result.entries.map((e) => e.slug)).toEqual(['plan']);
            await expect(facade.getEntry('plan', facadeOptions)).resolves.toMatchObject({
                providerId: 'everworks-skills',
            });
        });

        it('resolves a package slug through getEntry, so Install does not 404', async () => {
            // `listEntries` and `getEntry` are separate code paths. Wiring only
            // the first produces a catalog card whose Install button 404s,
            // because the install route resolves the slug through getEntry.
            const source = packageSource([entry('from-package')]);
            const facade = new SkillsFacadeService(
                registryWith([]),
                settingsStub,
                undefined,
                source,
            );

            await expect(facade.getEntry('from-package', facadeOptions)).resolves.toEqual({
                entry: expect.objectContaining({ slug: 'from-package' }),
                providerId: 'agent-plugins',
            });
        });

        it('lets a provider win getEntry when both offer the slug', async () => {
            const source = packageSource([entry('shared', { description: 'package' })]);
            const facade = new SkillsFacadeService(
                registryWith([
                    providerPlugin('everworks-skills', [
                        entry('shared', { description: 'provider' }),
                    ]),
                ]),
                settingsStub,
                undefined,
                source,
            );

            const found = await facade.getEntry('shared', facadeOptions);

            // Same precedence as listEntries, or the card and the install
            // would disagree about which skill the user is getting.
            expect(found?.providerId).toBe('everworks-skills');
            expect(found?.entry.description).toBe('provider');
        });

        it('returns null when neither providers nor the source know the slug', async () => {
            const facade = new SkillsFacadeService(
                registryWith([]),
                settingsStub,
                undefined,
                packageSource([]),
            );

            await expect(facade.getEntry('nope', facadeOptions)).resolves.toBeNull();
        });
    });
});
