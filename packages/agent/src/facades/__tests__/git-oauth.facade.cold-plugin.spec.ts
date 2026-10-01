import { PLUGIN_CAPABILITIES } from '@ever-works/plugin';
import type { OAuthConfig } from '@ever-works/plugin';
import { GitFacadeService, NoGitProviderError } from '../git.facade';
import { NoOAuthProviderError, OAuthFacadeService } from '../oauth.facade';
import type { PluginRegistryService } from '../../plugins/services/plugin-registry.service';
import {
    createRegistry,
    gate,
    registerColdPlugin,
    settle,
    type ColdPluginSpec,
    type Pingable,
} from '../../plugins/__tests__/cold-plugin.fixture';

/**
 * The git and OAuth facades over a `github`-shaped provider the registry holds
 * as a COLD lazy proxy — as every disk builtIn is in lazy mode (the default),
 * in every fresh process. `getCloneUrl` / `getWebUrl` / `getLocalDir` /
 * `getAuthorizationUrl` are SYNC on the plugin; on a cold proxy they read as
 * the async forwarding wrapper, so a facade that forwarded the call without
 * loading the plugin first answered a Promise where its callers expect a
 * string (`{ url: <Promise> }` serialised to `{}`; `fs.rm(<Promise>)`).
 *
 * The facade methods are async and load the provider first, so each answers
 * the string itself.
 */

function registerColdGithub(registry: PluginRegistryService, spec: Partial<ColdPluginSpec> = {}) {
    return registerColdPlugin(registry, {
        id: 'github',
        category: 'git-provider',
        capabilities: [PLUGIN_CAPABILITIES.GIT_PROVIDER, PLUGIN_CAPABILITIES.OAUTH],
        settingsSchema: { type: 'object', properties: {} },
        ...spec,
        members: {
            // Sync on the real class — and, like a provider that sets its client
            // up in onLoad, unusable before onLoad has run.
            getCloneUrl(this: Pingable, owner: string, repo: string): string {
                this.ping();
                return `https://github.com/${owner}/${repo}.git`;
            },
            getWebUrl(this: Pingable, owner: string, repo: string): string {
                this.ping();
                return `https://github.com/${owner}/${repo}`;
            },
            getLocalDir(this: Pingable, owner: string, repo: string, key?: string): string {
                this.ping();
                return `/tmp/git/${owner}/${repo}${key ? `#${key}` : ''}`;
            },
            getAuthorizationUrl(
                this: Pingable,
                state: string,
                config?: Partial<OAuthConfig>,
            ): string {
                this.ping();
                const scopes = config?.scopes?.join(',') ?? 'repo';
                return `https://github.com/login/oauth/authorize?state=${state}&scope=${scopes}`;
            },
            ...(spec.members ?? {}),
        },
    });
}

function gitFacade(registry: PluginRegistryService): GitFacadeService {
    return new GitFacadeService(registry, {} as never, {} as never, {} as never, {} as never);
}

function oauthFacade(registry: PluginRegistryService): OAuthFacadeService {
    return new OAuthFacadeService(registry, {} as never);
}

describe('GitFacadeService — sync URL/dir reads over a cold git provider', () => {
    let registry: PluginRegistryService;

    beforeEach(() => {
        registry = createRegistry();
    });

    it('getCloneUrl loads the provider and answers the string', async () => {
        const cold = registerColdGithub(registry);

        const url = await gitFacade(registry).getCloneUrl('github', 'acme', 'site');

        expect(url).toBe('https://github.com/acme/site.git');
        expect(cold.loads()).toBe(1);
    });

    it('getWebUrl loads the provider and answers the string', async () => {
        registerColdGithub(registry);

        const url = await gitFacade(registry).getWebUrl('github', 'acme', 'site');

        expect(url).toBe('https://github.com/acme/site');
    });

    it('getLocalDir loads the provider and forwards the checkout key', async () => {
        registerColdGithub(registry);

        const dir = await gitFacade(registry).getLocalDir(
            'github',
            'acme',
            'site',
            'work:work-1:data',
        );

        expect(dir).toBe('/tmp/git/acme/site#work:work-1:data');
    });

    it('waits for a first load another caller started (onLoad included)', async () => {
        const firstLoad = gate();
        const cold = registerColdGithub(registry, { firstLoadGate: firstLoad.promise });
        const facade = gitFacade(registry);

        const first = facade.getWebUrl('github', 'acme', 'one');
        await settle();
        expect(cold.proxy.__isMaterialized).toBe(true);
        expect(cold.onLoadDone()).toBe(false);
        const second = facade.getCloneUrl('github', 'acme', 'two');
        await settle();

        firstLoad.release();

        await expect(first).resolves.toBe('https://github.com/acme/one');
        await expect(second).resolves.toBe('https://github.com/acme/two.git');
        expect(cold.loads()).toBe(1);
    });

    it('rejects with NoGitProviderError when the only provider fails its onLoad', async () => {
        const cold = registerColdGithub(registry, { onLoadFails: true });

        await expect(
            gitFacade(registry).getWebUrl('github', 'acme', 'site'),
        ).rejects.toBeInstanceOf(NoGitProviderError);
        expect(cold.registered.state).toBe('error');
    });

    it('rejects with NoGitProviderError when the provider cannot be imported', async () => {
        registerColdGithub(registry, { failing: true });

        await expect(
            gitFacade(registry).getCloneUrl('github', 'acme', 'site'),
        ).rejects.toBeInstanceOf(NoGitProviderError);
    });
});

describe('OAuthFacadeService.getAuthorizationUrl over a cold OAuth provider', () => {
    let registry: PluginRegistryService;

    beforeEach(() => {
        registry = createRegistry();
    });

    it('loads the provider and answers the URL string (not a Promise)', async () => {
        const cold = registerColdGithub(registry);

        const url = await oauthFacade(registry).getAuthorizationUrl('github', 'csrf-1', {
            scopes: ['read:packages'],
        });

        expect(typeof url).toBe('string');
        expect(url).toBe(
            'https://github.com/login/oauth/authorize?state=csrf-1&scope=read:packages',
        );
        expect(cold.onLoadDone()).toBe(true);
    });

    it('rejects with NoOAuthProviderError when the only provider fails its onLoad', async () => {
        registerColdGithub(registry, { onLoadFails: true });

        await expect(
            oauthFacade(registry).getAuthorizationUrl('github', 'csrf-1'),
        ).rejects.toBeInstanceOf(NoOAuthProviderError);
    });
});
