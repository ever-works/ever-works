import { matchesAnyToolPattern } from '@ever-works/contracts';
import { ConnectionScopesFacadeService } from '../connection-scopes.facade';
import type { PluginRegistryService } from '../../plugins/services/plugin-registry.service';

type Entry = {
    plugin: Record<string, unknown>;
    state: string;
};

function makeRegistry(entries: Entry[]) {
    return {
        get: jest.fn((id: string) => entries.find((entry) => entry.plugin.id === id)),
        getByCapability: jest.fn((capability: string) =>
            entries.filter((entry) =>
                (entry.plugin.capabilities as string[] | undefined)?.includes(capability),
            ),
        ),
    } as unknown as PluginRegistryService;
}

const DECLARED = [
    { id: 'write', providerScopes: ['a', 'b'], toolPatterns: ['commitToRepo', 'repo_*'] },
    { id: 'read', providerScopes: ['a'], toolPatterns: ['repo_*'] },
];

function provider(id: string, over: Record<string, unknown> = {}): Entry {
    return {
        state: 'loaded',
        plugin: {
            id,
            name: id.toUpperCase(),
            capabilities: ['git-provider', 'connection-scopes'],
            getConnectionScopePresets: () => DECLARED,
            ...over,
        },
    };
}

describe('ConnectionScopesFacadeService', () => {
    it('returns declared presets normalised least → most access', async () => {
        const facade = new ConnectionScopesFacadeService(makeRegistry([provider('vcs')]));

        const presets = await facade.getPresets('vcs');

        expect(presets.map((preset) => preset.id)).toEqual(['read', 'write']);
        expect(presets[1].providerScopes).toEqual(['a', 'b']);
    });

    it('returns [] for a provider that does not declare the capability', async () => {
        const facade = new ConnectionScopesFacadeService(
            makeRegistry([provider('plain', { capabilities: ['search'] })]),
        );
        expect(await facade.getPresets('plain')).toEqual([]);
    });

    it('returns [] for an unknown or not-loaded provider', async () => {
        const facade = new ConnectionScopesFacadeService(
            makeRegistry([{ ...provider('broken'), state: 'error' }]),
        );
        expect(await facade.getPresets('missing')).toEqual([]);
        expect(await facade.getPresets('broken')).toEqual([]);
    });

    it('awaits a lazy registry proxy whose methods return promises', async () => {
        const facade = new ConnectionScopesFacadeService(
            makeRegistry([
                provider('lazy', { getConnectionScopePresets: () => Promise.resolve(DECLARED) }),
            ]),
        );
        expect((await facade.getPresets('lazy')).map((preset) => preset.id)).toEqual([
            'read',
            'write',
        ]);
    });

    it('degrades a throwing declaration to no presets', async () => {
        const facade = new ConnectionScopesFacadeService(
            makeRegistry([
                provider('throws', {
                    getConnectionScopePresets: () => {
                        throw new Error('boom');
                    },
                }),
            ]),
        );
        jest.spyOn(
            (facade as unknown as { logger: { warn: () => void } }).logger,
            'warn',
        ).mockImplementation(() => undefined);

        expect(await facade.getPresets('throws')).toEqual([]);
        expect(await facade.listProviders()).toEqual([]);
    });

    it('lists providers without their provider scope strings', async () => {
        const facade = new ConnectionScopesFacadeService(
            makeRegistry([
                provider('zeta'),
                provider('alpha'),
                provider('none', { capabilities: ['search'] }),
                provider('empty', { getConnectionScopePresets: () => [] }),
            ]),
        );

        const providers = await facade.listProviders();

        expect(providers.map((p) => p.providerId)).toEqual(['alpha', 'zeta']);
        expect(JSON.stringify(providers)).not.toContain('providerScopes');
        expect(providers[0].presets).toEqual([
            { id: 'read', toolPatterns: ['repo_*'] },
            { id: 'write', toolPatterns: ['commitToRepo', 'repo_*'] },
        ]);
    });

    it('coversTool uses exactly the tool-grant matcher', async () => {
        const facade = new ConnectionScopesFacadeService(makeRegistry([provider('vcs')]));

        for (const tool of ['commitToRepo', 'COMMITTOREPO', 'repo_list', 'deploy_now']) {
            expect(await facade.coversTool('vcs', 'write', tool)).toBe(
                matchesAnyToolPattern(['commitToRepo', 'repo_*'], tool),
            );
        }
        expect(await facade.coversTool('vcs', 'read', 'commitToRepo')).toBe(false);
        expect(await facade.coversTool('missing', 'write', 'commitToRepo')).toBe(false);
    });

    it('providerScopesFor returns the level’s permissions, [] when undeclared', async () => {
        const facade = new ConnectionScopesFacadeService(makeRegistry([provider('vcs')]));

        expect(await facade.providerScopesFor('vcs', 'read')).toEqual(['a']);
        expect(await facade.providerScopesFor('missing', 'read')).toEqual([]);
    });
});
