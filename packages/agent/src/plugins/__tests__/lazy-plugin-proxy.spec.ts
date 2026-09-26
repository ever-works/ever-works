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

    /**
     * `JSON.stringify` reads `toJSON` and calls it when it is a function. On a
     * cold proxy that read was the forwarding wrapper, so serialising a plugin
     * (a log line, a response body) imported it, wrote `{}` (the wrapper's
     * Promise) and left that Promise to reject with `has no method "toJSON"` —
     * the same uncaught rejection the `then` guard exists to prevent.
     */
    it('JSON.stringify on a cold stub serialises its manifest fields without materializing', () => {
        // Never settles: a call to the loader cannot reject into the test run.
        const loader = jest.fn(() => new Promise<IPlugin | null>(() => undefined));
        const stub = createLazyPluginProxy(makeManifest('github'), loader);

        expect((stub as unknown as Record<string, unknown>).toJSON).toBeUndefined();
        expect(JSON.parse(JSON.stringify(stub))).toEqual({
            id: 'github',
            name: 'Plugin github',
            version: '1.0.0',
            category: 'utility',
            capabilities: ['test'],
            settingsSchema: {},
            __isMaterialized: false,
        });
        expect(loader).not.toHaveBeenCalled();
    });

    it("JSON.stringify on a materialised stub uses the real plugin's toJSON when it has one", async () => {
        const real = {
            ...makeRealPlugin('github', jest.fn()),
            toJSON: () => ({ plugin: 'github' }),
        } as unknown as IPlugin;
        const stub = createLazyPluginProxy(
            makeManifest('github'),
            jest.fn().mockResolvedValue(real),
        );
        await stub.__materialize();

        expect(JSON.stringify(stub)).toBe('{"plugin":"github"}');
    });

    /**
     * Reads of members the manifest does not carry (task_f6ae037f). Before the
     * fix the `get` trap answered EVERY such read with the async forwarding
     * wrapper — also once the real plugin had loaded. So a caller holding the
     * proxy got a function for a data member (a provider's `providerName`, a
     * form provider's `handledConfigFields`), a Promise from a sync method
     * (`getFormFields()`: the generator form then dropped agent-pipeline's own
     * fields), and `typeof`/`in` probes for optional members always said yes.
     */
    describe('members the manifest does not carry', () => {
        /** Shaped like a real plugin class: fields, a getter and prototype methods using `this`. */
        class RealDataPlugin {
            readonly id = 'p-data';
            readonly name = 'Plugin p-data';
            readonly version = '1.0.0';
            readonly category = 'utility';
            readonly capabilities = ['test', 'form-schema-provider'];
            readonly settingsSchema = { type: 'object', properties: {} };
            readonly providerName = 'Real Provider';
            readonly handledConfigFields = ['*'] as const;
            readonly formSchema = { fields: [{ name: 'prompt', type: 'textarea' }] };
            private readonly fields = [{ name: 'prompt', type: 'textarea' }];
            get providerLabel(): string {
                return `${this.providerName} v${this.version}`;
            }
            async onLoad(): Promise<void> {}
            async onUnload(): Promise<void> {}
            getFormFields() {
                return this.fields;
            }
            getDefaultValues() {
                return { fieldCount: this.getFormFields().length };
            }
        }

        type DataProxy = ReturnType<typeof createLazyPluginProxy> &
            Omit<RealDataPlugin, keyof IPlugin>;

        function build() {
            const real = new RealDataPlugin();
            const loader = jest.fn().mockResolvedValue(real);
            const proxy = createLazyPluginProxy(
                makeManifest('p-data'),
                loader,
            ) as unknown as DataProxy;
            return { real, loader, proxy };
        }

        it('answers data members, objects and getters of the materialised plugin with their real values', async () => {
            const { real, proxy } = build();
            await proxy.__materialize();

            expect(proxy.providerName).toBe('Real Provider');
            expect(proxy.handledConfigFields).toBe(real.handledConfigFields);
            expect(proxy.formSchema).toBe(real.formSchema);
            // The getter runs with `this` = the real instance.
            expect(proxy.providerLabel).toBe('Real Provider v1.0.0');
        });

        it('calls sync methods of the materialised plugin synchronously, bound to the real instance', async () => {
            const { real, proxy } = build();
            await proxy.__materialize();

            const fields = proxy.getFormFields();
            expect(fields).not.toBeInstanceOf(Promise);
            expect(fields).toBe(real.getFormFields());
            // `this` inside the method is the real instance, also when detached.
            const { getDefaultValues } = proxy;
            expect(getDefaultValues()).toEqual({ fieldCount: 1 });
            expect(proxy.getDefaultValues()).toEqual({ fieldCount: 1 });
        });

        it('answers undefined for a member the materialised plugin lacks, so optional probes are truthful', async () => {
            const { proxy } = build();
            await proxy.__materialize();
            const loose = proxy as unknown as Record<string, unknown> & {
                transformFormValues?: () => unknown;
            };

            expect(loose.transformFormValues).toBeUndefined();
            expect(loose.transformFormValues?.()).toBeUndefined();
            expect(proxy.healthCheck).toBeUndefined();
            expect(await proxy.healthCheck?.()).toBeUndefined();
            expect('transformFormValues' in proxy).toBe(false);
            expect('getFormFields' in proxy).toBe(true);
            expect('providerName' in proxy).toBe(true);
            // Manifest-backed members and the proxy's own API stay present.
            expect('__materialize' in proxy).toBe(true);
            expect(proxy.id).toBe('p-data');
        });

        it('forwards reads made from inside the first-materialise hook (onLoad) to the real plugin', async () => {
            const real = new RealDataPlugin();
            const seen: unknown[] = [];
            let proxy!: DataProxy;
            proxy = createLazyPluginProxy(
                makeManifest('p-data'),
                jest.fn().mockResolvedValue(real),
                async () => {
                    seen.push(proxy.providerName, proxy.getFormFields());
                },
            ) as unknown as DataProxy;

            await proxy.__materialize({ waitForLoad: true });

            expect(seen).toEqual(['Real Provider', real.getFormFields()]);
        });

        /**
         * The contract while COLD is unchanged: the proxy cannot tell a data
         * member from a method without importing the plugin, and a method call
         * on a cold proxy (plugin-specific ones included) must keep working —
         * so a non-manifest read answers the async forwarding wrapper, without
         * importing anything. A caller that needs a data member loads the
         * plugin first (`__materialize`, `materializePlugin`,
         * `loadRegisteredPlugins`).
         */
        it('while cold, answers a non-manifest member with the forwarding wrapper and does not import on the read', async () => {
            const { real, loader, proxy } = build();

            expect(typeof proxy.providerName).toBe('function');
            expect(typeof proxy.getFormFields).toBe('function');
            expect(loader).not.toHaveBeenCalled();

            // Calling the wrapper loads the plugin and forwards (async).
            await expect(
                (proxy.getFormFields as unknown as () => Promise<unknown>)(),
            ).resolves.toBe(real.getFormFields());
            expect(loader).toHaveBeenCalledTimes(1);
            // …and from then on reads are the real values.
            expect(proxy.providerName).toBe('Real Provider');
        });

        it('while cold, a wrapper read for a data member rejects when called, naming the member', async () => {
            const { proxy } = build();
            const wrapper = proxy.providerName as unknown as () => Promise<unknown>;

            await expect(wrapper()).rejects.toThrow('Plugin "p-data" has no method "providerName"');
        });
    });

    /**
     * EW-693 — the first-materialise hook (onLoad) runs while the instance is
     * already imported, because the hook calls the plugin THROUGH the proxy.
     * A caller from inside the hook is answered at once (an AsyncLocalStorage
     * marker says where it is called from); every other caller — plain
     * `__materialize()` or `waitForLoad` — waits for the hook to settle.
     */
    describe('__materialize({ waitForLoad: true })', () => {
        function deferred() {
            let resolve!: () => void;
            const promise = new Promise<void>((r) => (resolve = r));
            return { promise, resolve };
        }
        const flush = () => new Promise((resolve) => setImmediate(resolve));

        it('waits for the first-materialise hook, as a plain __materialize() from outside it now does too', async () => {
            const hookGate = deferred();
            const loader = jest.fn().mockResolvedValue(makeRealPlugin('w1', jest.fn()));
            const stub = createLazyPluginProxy(makeManifest('w1'), loader, () => hookGate.promise);
            const order: string[] = [];

            void stub.__materialize().then(() => order.push('first caller'));
            await flush(); // the loader has resolved; the hook is running
            void stub.__materialize().then(() => order.push('plain'));
            void stub.__materialize({ waitForLoad: true }).then(() => order.push('waitForLoad'));
            await flush();

            // Pin changed (F6, second review of 60916d328): this used to be
            // `['plain']` — a plain __materialize() from OUTSIDE the hook was
            // answered before onLoad had settled, the first-use race. Only a
            // call from inside the hook is answered at once now (see the next
            // case and lazy-plugin-proxy.first-load.spec.ts).
            expect(order).toEqual([]);
            hookGate.resolve();
            await flush();
            // All three now; which of the hook-waiters resolves first is incidental.
            expect(order).toHaveLength(3);
            expect(order).toEqual(expect.arrayContaining(['plain', 'first caller', 'waitForLoad']));
        });

        it('does not deadlock the hook, which calls the plugin through the proxy', async () => {
            const onLoad = jest.fn().mockResolvedValue(undefined);
            const loader = jest.fn().mockResolvedValue(makeRealPlugin('w2', onLoad));
            let stub: ReturnType<typeof createLazyPluginProxy>;
            stub = createLazyPluginProxy(makeManifest('w2'), loader, async () => {
                await stub.onLoad({} as never);
            });

            await expect(stub.__materialize({ waitForLoad: true })).resolves.toMatchObject({
                id: 'w2',
            });
            expect(onLoad).toHaveBeenCalledTimes(1);
        });

        it('answers at once once loaded, and starts the load when nothing has yet', async () => {
            const loader = jest.fn().mockResolvedValue(makeRealPlugin('w3', jest.fn()));
            const stub = createLazyPluginProxy(
                makeManifest('w3'),
                loader,
                jest.fn().mockResolvedValue(undefined),
            );

            await expect(stub.__materialize({ waitForLoad: true })).resolves.toMatchObject({
                id: 'w3',
            });
            await expect(stub.__materialize({ waitForLoad: true })).resolves.toMatchObject({
                id: 'w3',
            });
            expect(loader).toHaveBeenCalledTimes(1);
        });
    });
});
