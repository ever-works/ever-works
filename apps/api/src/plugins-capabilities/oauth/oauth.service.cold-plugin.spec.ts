import { EventEmitter2 } from '@nestjs/event-emitter';
import { PLUGIN_CAPABILITIES } from '@ever-works/plugin';
import type { IPlugin, OAuthConfig, PluginManifest } from '@ever-works/plugin';
import { OAuthFacadeService } from '@ever-works/agent/facades';
import { PluginRegistryService } from '@ever-works/agent/plugins';
import type { PluginSettingsService } from '@ever-works/agent/plugins';
import type { AuthAccountRepository } from '@ever-works/agent/database';
import { OAuthService } from './oauth.service';

/**
 * The OAuth URL endpoints over a `github`-shaped OAuth provider the registry
 * holds as a COLD lazy proxy — as every disk builtIn is in lazy mode (the
 * default), in every fresh API process — through the REAL `OAuthFacadeService`
 * and `PluginRegistryService.registerLazy`, no mocks in between.
 *
 * The provider's `getAuthorizationUrl` is sync; on a cold proxy it read as the
 * async forwarding wrapper, so the facade answered a Promise and the service
 * returned `{ url: <Promise> }` — which serialises to `{}`: the browser got no
 * URL to redirect to. The URL must be the string itself.
 */
describe('OAuthService — authorization URL over a cold OAuth provider', () => {
    let onLoadRan: boolean;

    function build(): OAuthService {
        onLoadRan = false;
        const registry = new PluginRegistryService(new EventEmitter2());
        registry.registerLazy(
            {
                id: 'github',
                name: 'GitHub',
                version: '1.0.0',
                description: 'cold fixture',
                category: 'git-provider',
                capabilities: [PLUGIN_CAPABILITIES.GIT_PROVIDER, PLUGIN_CAPABILITIES.OAUTH],
                builtIn: true,
            } as PluginManifest,
            async () =>
                ({
                    id: 'github',
                    name: 'GitHub',
                    version: '1.0.0',
                    category: 'git-provider',
                    capabilities: [PLUGIN_CAPABILITIES.GIT_PROVIDER, PLUGIN_CAPABILITIES.OAUTH],
                    settingsSchema: { type: 'object', properties: {} },
                    onLoad: async () => {
                        onLoadRan = true;
                    },
                    onUnload: async () => undefined,
                    getAuthorizationUrl: (state: string, config?: Partial<OAuthConfig>) =>
                        `https://github.com/login/oauth/authorize?client_id=${config?.clientId}` +
                        `&state=${state}&scope=${(config?.scopes ?? ['repo']).join(' ')}`,
                }) as unknown as IPlugin,
            {
                builtIn: true,
                // The lifecycle manager's hook: onLoad on first materialise.
                onFirstMaterialize: async (_id, real) => {
                    await real.onLoad({} as never);
                },
            },
        );
        const pluginSettings = {
            getSettings: jest.fn().mockResolvedValue({ clientId: 'cid', clientSecret: 'secret' }),
        };
        return new OAuthService(
            new OAuthFacadeService(registry, {} as AuthAccountRepository),
            {} as AuthAccountRepository,
            pluginSettings as unknown as PluginSettingsService,
        );
    }

    it('getOAuthUrl answers the URL as a string that survives JSON serialisation', async () => {
        const result = await build().getOAuthUrl({
            userId: 'user-1',
            providerId: 'github',
            redirectUri: 'https://app/cb',
            state: 'csrf-1',
        });

        expect(typeof result.url).toBe('string');
        expect(result.url).toBe(
            'https://github.com/login/oauth/authorize?client_id=cid&state=csrf-1&scope=repo',
        );
        expect(JSON.parse(JSON.stringify(result))).toEqual({
            url: result.url,
            state: 'csrf-1',
        });
        expect(onLoadRan).toBe(true);
    });

    it('getReadPackagesOAuthUrl answers the URL as a string with the package scopes', async () => {
        const result = await build().getReadPackagesOAuthUrl({
            userId: 'user-1',
            providerId: 'github',
            redirectUri: 'https://app/cb',
            state: 'csrf-2',
        });

        expect(typeof result.url).toBe('string');
        expect(result.url).toBe(
            'https://github.com/login/oauth/authorize?client_id=cid&state=csrf-2' +
                '&scope=read:packages write:packages',
        );
    });
});
