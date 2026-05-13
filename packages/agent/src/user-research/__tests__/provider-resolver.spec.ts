import {
    capChain,
    isTransientProviderError,
    resolveProviderChain,
    tryInOrder,
} from '../provider-resolver';
import type {
    PluginRegistryService,
    RegisteredPlugin,
} from '../../plugins/services/plugin-registry.service';

type FakePlugin = {
    id: string;
    defaultForCapabilities?: string[];
};

function makeRegistered(p: FakePlugin): RegisteredPlugin {
    return {
        plugin: { id: p.id } as RegisteredPlugin['plugin'],
        manifest: {
            defaultForCapabilities: p.defaultForCapabilities,
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

describe('tryInOrder', () => {
    const plugins = [
        makeRegistered({ id: 'a' }),
        makeRegistered({ id: 'b' }),
        makeRegistered({ id: 'c' }),
    ];

    it('returns the first success without trying later providers', async () => {
        const attempt = jest.fn().mockResolvedValueOnce('ok');
        const result = await tryInOrder(plugins, attempt, () => true);
        expect(result).toBe('ok');
        expect(attempt).toHaveBeenCalledTimes(1);
    });

    it('falls through transient errors to the next provider', async () => {
        const attempt = jest
            .fn<Promise<string>, [RegisteredPlugin]>()
            .mockRejectedValueOnce(new Error('rate limit'))
            .mockRejectedValueOnce(new Error('429 quota'))
            .mockResolvedValueOnce('third-time');

        const result = await tryInOrder(plugins, attempt, () => true);
        expect(result).toBe('third-time');
        expect(attempt).toHaveBeenCalledTimes(3);
    });

    it('rethrows the first non-retryable error immediately', async () => {
        const attempt = jest
            .fn<Promise<string>, [RegisteredPlugin]>()
            .mockRejectedValueOnce(new Error('401 unauthorized'));

        await expect(tryInOrder(plugins, attempt, () => false)).rejects.toThrow('401 unauthorized');
        expect(attempt).toHaveBeenCalledTimes(1);
    });

    it('throws if the chain is empty', async () => {
        await expect(
            tryInOrder(
                [],
                async () => 'x',
                () => true,
            ),
        ).rejects.toThrow('No providers available');
    });

    it('rethrows the last transient error if every provider fails', async () => {
        const attempt = jest
            .fn<Promise<string>, [RegisteredPlugin]>()
            .mockRejectedValue(new Error('rate limit'));

        await expect(tryInOrder(plugins, attempt, () => true)).rejects.toThrow('rate limit');
        expect(attempt).toHaveBeenCalledTimes(3);
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
            'bad gateway',
            'gateway timeout',
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
