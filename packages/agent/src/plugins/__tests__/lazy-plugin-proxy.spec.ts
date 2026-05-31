import { createLazyPluginProxy } from '../services/lazy-plugin-proxy';
import type { IPlugin, PluginManifest } from '@ever-works/plugin';

const makeManifest = (id: string): PluginManifest =>
    ({
        id,
        name: `Plugin ${id}`,
        version: '1.0.0',
        description: 'Test plugin',
        category: 'utility',
        capabilities: ['test'],
    }) as PluginManifest;

const makeRealPlugin = (id: string, onLoad: jest.Mock): IPlugin =>
    ({
        id,
        name: `Plugin ${id}`,
        version: '1.0.0',
        category: 'utility',
        capabilities: ['test'],
        settingsSchema: { type: 'object', properties: { apiKey: { type: 'string' } } },
        onLoad,
        onUnload: jest.fn().mockResolvedValue(undefined),
        // Plugin-specific method only on the real instance — verifies the
        // proxy forwards arbitrary subclass methods (e.g. generate, extract).
        customMethod: jest.fn().mockResolvedValue('result'),
    }) as unknown as IPlugin;

describe('lazy-plugin-proxy', () => {
    it('does not invoke the loader until the first method call', async () => {
        const onLoad = jest.fn().mockResolvedValue(undefined);
        const loader = jest.fn().mockResolvedValue(makeRealPlugin('p1', onLoad));

        const stub = createLazyPluginProxy(makeManifest('p1'), loader);

        // Sync property reads come from the manifest — no import required.
        expect(stub.id).toBe('p1');
        expect(stub.name).toBe('Plugin p1');
        expect(stub.version).toBe('1.0.0');
        expect(stub.category).toBe('utility');
        expect(stub.capabilities).toEqual(['test']);
        expect(stub.__isMaterialized).toBe(false);

        expect(loader).not.toHaveBeenCalled();
        expect(onLoad).not.toHaveBeenCalled();

        // First method call triggers materialization.
        await stub.onLoad({} as never);
        expect(loader).toHaveBeenCalledTimes(1);
        expect(stub.__isMaterialized).toBe(true);
    });

    it('exposes the real plugin settingsSchema only after materialization', async () => {
        // Regression for the lazy-load PR #1156 chat outage: while cold the
        // proxy returned `{}` for settingsSchema (the package.json manifest
        // carries no JSON-Schema), and it kept returning `{}` even AFTER
        // materialization. Settings resolution then found no x-envVar-bound
        // fields (e.g. the OpenRouter apiKey), never read PLUGIN_OPENROUTER_API_KEY,
        // and AI calls failed with "401 Missing Authentication header".
        const onLoad = jest.fn().mockResolvedValue(undefined);
        const loader = jest.fn().mockResolvedValue(makeRealPlugin('p-schema', onLoad));
        const stub = createLazyPluginProxy(makeManifest('p-schema'), loader);

        // Cold: no import cost, empty schema from the manifest.
        expect(stub.settingsSchema).toEqual({});
        expect(loader).not.toHaveBeenCalled();

        // After materialization the proxy must delegate to the real plugin's
        // class-level schema.
        await stub.__materialize();
        expect(stub.settingsSchema).toEqual({
            type: 'object',
            properties: { apiKey: { type: 'string' } },
        });
    });

    it('shares a single import across concurrent method calls', async () => {
        const onLoad = jest.fn().mockResolvedValue(undefined);
        let resolveLoader!: (p: IPlugin) => void;
        const loader = jest.fn().mockImplementation(
            () =>
                new Promise<IPlugin>((resolve) => {
                    resolveLoader = resolve;
                }),
        );

        const stub = createLazyPluginProxy(makeManifest('p2'), loader);

        // Fire three concurrent method invocations while the loader is in flight.
        const p1 = stub.onLoad({} as never);
        const p2 = stub.onLoad({} as never);
        const p3 = stub.healthCheck?.();

        // Loader was only invoked once despite three concurrent calls.
        expect(loader).toHaveBeenCalledTimes(1);

        // Finish the import; all three calls resolve.
        resolveLoader(makeRealPlugin('p2', onLoad));
        await Promise.all([p1, p2, p3]);

        expect(loader).toHaveBeenCalledTimes(1);
    });

    it('runs onFirstMaterialize exactly once on first method call', async () => {
        const onLoad = jest.fn().mockResolvedValue(undefined);
        const loader = jest.fn().mockResolvedValue(makeRealPlugin('p3', onLoad));
        const onFirstMaterialize = jest.fn().mockResolvedValue(undefined);

        const stub = createLazyPluginProxy(makeManifest('p3'), loader, onFirstMaterialize);

        // Multiple method calls, in series and parallel.
        await stub.onLoad({} as never);
        await stub.healthCheck?.();
        await Promise.all([stub.onLoad({} as never), stub.healthCheck?.()]);

        expect(onFirstMaterialize).toHaveBeenCalledTimes(1);
        expect(onFirstMaterialize).toHaveBeenCalledWith(
            'p3',
            expect.objectContaining({ id: 'p3' }),
        );
        expect(loader).toHaveBeenCalledTimes(1);
    });

    it('forwards plugin-specific subclass methods after materialization', async () => {
        const onLoad = jest.fn().mockResolvedValue(undefined);
        const real = makeRealPlugin('p4', onLoad);
        const loader = jest.fn().mockResolvedValue(real);

        const stub = createLazyPluginProxy(makeManifest('p4'), loader);
        const customResult = await (
            stub as unknown as { customMethod: () => Promise<string> }
        ).customMethod();

        expect(customResult).toBe('result');
        expect((real as unknown as { customMethod: jest.Mock }).customMethod).toHaveBeenCalledTimes(
            1,
        );
    });

    it('skips materialization when onUnload is called before any other method', async () => {
        const onLoad = jest.fn().mockResolvedValue(undefined);
        const loader = jest.fn().mockResolvedValue(makeRealPlugin('p5', onLoad));

        const stub = createLazyPluginProxy(makeManifest('p5'), loader);
        await stub.onUnload();

        // A never-used plugin has no resources to release; we must not pay
        // the import cost just to call its onUnload.
        expect(loader).not.toHaveBeenCalled();
        expect(stub.__isMaterialized).toBe(false);
    });

    it('retries import after a transient loader failure', async () => {
        const onLoad = jest.fn().mockResolvedValue(undefined);
        const loader = jest
            .fn<Promise<IPlugin | null>, []>()
            .mockRejectedValueOnce(new Error('transient fs error'))
            .mockResolvedValueOnce(makeRealPlugin('p6', onLoad));

        const stub = createLazyPluginProxy(makeManifest('p6'), loader);

        await expect(stub.onLoad({} as never)).rejects.toThrow('transient fs error');
        expect(loader).toHaveBeenCalledTimes(1);

        // Second call should retry (importPromise was reset on failure).
        await expect(stub.onLoad({} as never)).resolves.toBeUndefined();
        expect(loader).toHaveBeenCalledTimes(2);
        expect(stub.__isMaterialized).toBe(true);
    });

    it('fires onMaterializeError when the loader throws', async () => {
        const loader = jest.fn<Promise<IPlugin | null>, []>().mockRejectedValue(new Error('boom'));
        const onMaterializeError = jest.fn().mockResolvedValue(undefined);

        const stub = createLazyPluginProxy(
            makeManifest('p7'),
            loader,
            undefined,
            onMaterializeError,
        );

        await expect(stub.onLoad({} as never)).rejects.toThrow('boom');

        expect(onMaterializeError).toHaveBeenCalledTimes(1);
        expect(onMaterializeError).toHaveBeenCalledWith(
            'p7',
            expect.objectContaining({ message: 'boom' }),
        );
    });

    it('fires onMaterializeError when the loader returns null', async () => {
        const loader = jest.fn<Promise<IPlugin | null>, []>().mockResolvedValue(null);
        const onMaterializeError = jest.fn().mockResolvedValue(undefined);

        const stub = createLazyPluginProxy(
            makeManifest('p8'),
            loader,
            undefined,
            onMaterializeError,
        );

        await expect(stub.onLoad({} as never)).rejects.toThrow(/Failed to materialize plugin/);
        expect(onMaterializeError).toHaveBeenCalledTimes(1);
    });

    it('does not let onMaterializeError swallow the original loader error', async () => {
        const loader = jest
            .fn<Promise<IPlugin | null>, []>()
            .mockRejectedValue(new Error('original'));
        const onMaterializeError = jest
            .fn<Promise<void>, [string, Error]>()
            .mockRejectedValue(new Error('hook-failure'));

        const stub = createLazyPluginProxy(
            makeManifest('p9'),
            loader,
            undefined,
            onMaterializeError,
        );

        // Caller should see the ORIGINAL loader error, not the hook's error —
        // the hook is best-effort bookkeeping and must not mask the cause.
        await expect(stub.onLoad({} as never)).rejects.toThrow('original');
    });

    // Regression: the stub is a plain object, NOT a thenable. Before the fix,
    // `get` returned a materialize-and-forward wrapper for ANY unknown prop —
    // including `then`. So `await stub` (or returning it from an async fn, or
    // Promise.resolve(stub)) made the runtime see a thenable, call
    // `then(resolve, reject)`, materialize, find no real `then` method, and
    // throw `TypeError: Plugin "<id>" has no method "then"` from an async tick
    // — an uncaught rejection that crashed the API process and ECONNREFUSED'd
    // the rest of the e2e suite.
    it('does not expose Promise-detection keys (then/catch/finally are undefined)', () => {
        const loader = jest.fn().mockResolvedValue(makeRealPlugin('github', jest.fn()));
        const stub = createLazyPluginProxy(makeManifest('github'), loader);
        const asRecord = stub as unknown as Record<string, unknown>;

        expect(asRecord.then).toBeUndefined();
        expect(asRecord.catch).toBeUndefined();
        expect(asRecord.finally).toBeUndefined();
        expect(loader).not.toHaveBeenCalled();
    });

    it('`await stub` resolves to the stub without materializing or throwing', async () => {
        const loader = jest.fn().mockResolvedValue(makeRealPlugin('github', jest.fn()));
        const stub = createLazyPluginProxy(makeManifest('github'), loader);

        // Must NOT throw `Plugin "github" has no method "then"`.
        const awaited = await stub;

        expect(awaited).toBe(stub);
        expect(stub.__isMaterialized).toBe(false);
        expect(loader).not.toHaveBeenCalled();
    });

    it('Promise.resolve(stub) does not trigger materialization', async () => {
        const loader = jest.fn().mockResolvedValue(makeRealPlugin('github', jest.fn()));
        const stub = createLazyPluginProxy(makeManifest('github'), loader);

        await Promise.resolve(stub);

        expect(loader).not.toHaveBeenCalled();
    });

    it('well-known symbol access returns undefined (no spurious materialization)', () => {
        const loader = jest.fn().mockResolvedValue(makeRealPlugin('github', jest.fn()));
        const stub = createLazyPluginProxy(makeManifest('github'), loader);
        const asSym = stub as unknown as Record<symbol, unknown>;

        expect(asSym[Symbol.iterator]).toBeUndefined();
        expect(asSym[Symbol.asyncIterator]).toBeUndefined();
        expect(loader).not.toHaveBeenCalled();
    });
});
