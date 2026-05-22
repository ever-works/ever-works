import {
    capChain,
    isAuthOrConfigError,
    isTransientProviderError,
    resolveAiProviderForResearch,
    resolveProviderChain,
    resolveSearchProviderIds,
} from '../provider-resolver';
import type {
    PluginRegistryService,
    RegisteredPlugin,
} from '../../plugins/services/plugin-registry.service';
import type { AiFacadeService } from '../../facades/ai.facade';

type FakePlugin = {
    id: string;
    defaultForCapabilities?: string[];
    capabilities?: string[];
    settingsSchema?: RegisteredPlugin['plugin']['settingsSchema'];
};

function makeRegistered(p: FakePlugin): RegisteredPlugin {
    return {
        plugin: { id: p.id, settingsSchema: p.settingsSchema } as RegisteredPlugin['plugin'],
        manifest: {
            defaultForCapabilities: p.defaultForCapabilities,
            capabilities: p.capabilities ?? ['ai-provider', 'search'],
        } as unknown as RegisteredPlugin['manifest'],
        state: 'loaded',
    } as RegisteredPlugin;
}

function makeRegistry(plugins: FakePlugin[]): PluginRegistryService {
    return {
        getEnabledPluginsScoped: jest.fn().mockResolvedValue(plugins.map(makeRegistered)),
    } as unknown as PluginRegistryService;
}

describe('resolveProviderChain', () => {
    it('puts defaultForCapabilities plugins first', async () => {
        const registry = makeRegistry([
            { id: 'extra' },
            { id: 'preferred', defaultForCapabilities: ['ai-provider'] },
            { id: 'other' },
        ]);

        const chain = await resolveProviderChain(registry, 'ai-provider', 'user-1');

        expect(chain.map((p) => p.plugin.id)).toEqual(['preferred', 'extra', 'other']);
    });

    it('returns empty list when no plugins are enabled', async () => {
        const registry = makeRegistry([]);
        await expect(resolveProviderChain(registry, 'ai-provider', 'u')).resolves.toEqual([]);
    });

    it('queries enabled plugins scoped to the user only (no workId)', async () => {
        const registry = makeRegistry([{ id: 'p1' }]);
        await resolveProviderChain(registry, 'search', 'u-7');
        expect(registry.getEnabledPluginsScoped).toHaveBeenCalledWith('search', undefined, 'u-7');
    });
});

describe('capChain', () => {
    it('caps to max', () => {
        expect(capChain([1, 2, 3, 4], 2)).toEqual([1, 2]);
    });

    it('returns at least 1 when max is positive but smaller than 1 is impossible', () => {
        expect(capChain([1, 2, 3], 1)).toEqual([1]);
    });

    it('returns full chain when max <= 0', () => {
        expect(capChain([1, 2, 3], 0)).toEqual([1, 2, 3]);
        expect(capChain([1, 2, 3], -1)).toEqual([1, 2, 3]);
    });
});

describe('resolveSearchProviderIds', () => {
    it('returns capped, defaultForCapabilities-first plugin IDs', async () => {
        const registry = makeRegistry([
            { id: 'brave' },
            { id: 'tavily', defaultForCapabilities: ['search'] },
            { id: 'exa' },
        ]);

        await expect(resolveSearchProviderIds(registry, 'u-1')).resolves.toEqual([
            'tavily',
            'brave',
        ]);
    });

    it('skips enabled search providers missing required settings', async () => {
        const registry = makeRegistry([
            {
                id: 'tavily',
                defaultForCapabilities: ['search'],
                settingsSchema: {
                    type: 'object',
                    required: ['apiKey'],
                    properties: { apiKey: { type: 'string' } },
                } as RegisteredPlugin['plugin']['settingsSchema'],
            },
            { id: 'local-search' },
        ]);
        const settings = {
            getSettings: jest
                .fn()
                .mockResolvedValueOnce({ apiKey: '' })
                .mockResolvedValueOnce({}),
        };

        await expect(
            resolveSearchProviderIds(registry, 'u-1', settings as never),
        ).resolves.toEqual(['local-search']);
        expect(settings.getSettings).toHaveBeenCalledWith('tavily', {
            userId: 'u-1',
            includeSecrets: true,
        });
    });

    it('allows settings satisfied by env/admin-only fields', async () => {
        const registry = makeRegistry([
            {
                id: 'env-search',
                settingsSchema: {
                    type: 'object',
                    required: ['apiKey'],
                    properties: { apiKey: { type: 'string', 'x-envVar': 'SEARCH_API_KEY' } },
                } as RegisteredPlugin['plugin']['settingsSchema'],
            },
        ]);
        const settings = { getSettings: jest.fn().mockResolvedValue({}) };

        await expect(
            resolveSearchProviderIds(registry, 'u-1', settings as never),
        ).resolves.toEqual(['env-search']);
    });
});

describe('isAuthOrConfigError', () => {
    it('matches 401/403/invalid api key shapes', () => {
        for (const msg of [
            '401 Unauthorized',
            '403 Forbidden',
            'request is forbidden',
            'unauthorized request',
            'invalid api key',
            'invalid_api_key',
        ]) {
            expect(isAuthOrConfigError(new Error(msg))).toBe(true);
        }
    });

    it('returns false for transient and unknown shapes', () => {
        expect(isAuthOrConfigError(new Error('rate limit'))).toBe(false);
        expect(isAuthOrConfigError(new Error('500 Internal Server Error'))).toBe(false);
        expect(isAuthOrConfigError(undefined)).toBe(false);
    });
});

describe('isTransientProviderError', () => {
    it('classifies rate-limit / 5xx / network shapes as transient', () => {
        for (const msg of [
            'rate limit exceeded',
            'HTTP 429 Too Many Requests',
            'quota exhausted',
            'request timeout',
            'ETIMEDOUT',
            'ECONNRESET',
            'socket hang up',
            'overloaded',
            'service unavailable',
            'internal server error',
            'bad gateway',
            'gateway timeout',
            '500 Internal Server Error',
            '502 Bad Gateway',
            '503 Service Unavailable',
            '504 Gateway Timeout',
        ]) {
            expect(isTransientProviderError(new Error(msg))).toBe(true);
        }
    });

    it('classifies auth / config errors as NON-transient', () => {
        for (const msg of [
            '401 Unauthorized',
            '403 Forbidden',
            'invalid api key',
            'invalid_api_key',
        ]) {
            expect(isTransientProviderError(new Error(msg))).toBe(false);
        }
    });

    it('returns false for non-Error rejections', () => {
        expect(isTransientProviderError('string error')).toBe(false);
        expect(isTransientProviderError(undefined)).toBe(false);
    });
});

describe('resolveAiProviderForResearch', () => {
    const registry = makeRegistry([{ id: 'openai' }, { id: 'anthropic' }]);

    function makeAiFacade(getProviderConfig: jest.Mock): AiFacadeService {
        return { getProviderConfig } as unknown as AiFacadeService;
    }

    it('returns the first usable provider config', async () => {
        const getProviderConfig = jest.fn().mockResolvedValueOnce({
            providerId: 'openai',
            providerName: 'OpenAI',
            baseUrl: 'https://api.openai.com/v1',
            apiKey: 'sk-test',
            defaultModel: 'gpt-4o',
            routing: {},
        });

        const result = await resolveAiProviderForResearch(
            makeAiFacade(getProviderConfig),
            registry,
            'u',
        );

        expect(result).toMatchObject({
            providerId: 'openai',
            providerName: 'OpenAI',
            modelName: 'gpt-4o',
        });
        expect(getProviderConfig).toHaveBeenCalledTimes(1);
    });

    it('skips providers with no apiKey/baseUrl and tries the next one', async () => {
        const getProviderConfig = jest
            .fn()
            .mockResolvedValueOnce({
                providerId: 'openai',
                baseUrl: '',
                apiKey: '',
                defaultModel: 'gpt-4o',
                routing: {},
            })
            .mockResolvedValueOnce({
                providerId: 'anthropic',
                providerName: 'Anthropic',
                baseUrl: 'https://api.anthropic.com',
                apiKey: 'sk-ant',
                defaultModel: 'claude-haiku',
                routing: {},
            });

        const result = await resolveAiProviderForResearch(
            makeAiFacade(getProviderConfig),
            registry,
            'u',
        );

        expect(result?.providerId).toBe('anthropic');
        expect(getProviderConfig).toHaveBeenCalledTimes(2);
    });

    it('does not fall back to globally ready providers outside scoped enablement', async () => {
        const registry = makeRegistry([{ id: 'user-openai' }]);
        const getProviderConfig = jest.fn().mockResolvedValueOnce({
            providerId: 'user-openai',
            baseUrl: 'https://api.openai.com/v1',
            apiKey: '',
            defaultModel: 'gpt-4o',
            routing: {},
        });

        const result = await resolveAiProviderForResearch(
            makeAiFacade(getProviderConfig),
            registry,
            'u',
        );

        expect(result).toBeNull();
        expect(getProviderConfig).toHaveBeenCalledTimes(1);
        expect(getProviderConfig).toHaveBeenCalledWith({
            userId: 'u',
            providerOverride: 'user-openai',
        });
    });

    it('re-throws auth errors instead of silently masking with the next provider', async () => {
        const getProviderConfig = jest.fn().mockRejectedValue(new Error('401 Unauthorized'));

        await expect(
            resolveAiProviderForResearch(makeAiFacade(getProviderConfig), registry, 'u'),
        ).rejects.toThrow('401 Unauthorized');
        expect(getProviderConfig).toHaveBeenCalledTimes(1);
    });

    it('returns null when no provider has a usable config', async () => {
        const registry = makeRegistry([]);
        const getProviderConfig = jest.fn();
        await expect(
            resolveAiProviderForResearch(makeAiFacade(getProviderConfig), registry, 'u'),
        ).resolves.toBeNull();
        expect(getProviderConfig).not.toHaveBeenCalled();
    });
});
