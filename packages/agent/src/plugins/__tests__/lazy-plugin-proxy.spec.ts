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
});
