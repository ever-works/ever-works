// The module looks `WorkLifecycleService` up lazily and only as a class token; the real barrel
// drags the whole auth stack (an ESM-only dependency) into this spec, so it is a bare class here.
jest.mock('@ever-works/agent/services', () => ({
    WorkLifecycleService: class WorkLifecycleService {},
}));

import { APP_RUNTIME_EVENT_SINK, APP_RUNTIME_TARGET } from '@ever-works/agent/app-runtime';
import { AppRuntimePortsModule } from './app-runtime-ports.module';

/**
 * Lane aw-builds-bindings (2026-10-27) — the two §9.8 tokens the API's global ports module now
 * provides and exports. `app-works-di-reachability.spec.ts` proves they RESOLVE for
 * `AppDependenciesService`; this pins WHAT they resolve to, by calling the module's own factories.
 */
type FactoryProvider = { provide: unknown; useFactory: (...args: unknown[]) => unknown };

function factoryFor(token: symbol): FactoryProvider {
    const providers = (Reflect.getMetadata('providers', AppRuntimePortsModule) ?? []) as unknown[];
    const found = providers.find(
        (provider): provider is FactoryProvider =>
            typeof provider === 'object' &&
            provider !== null &&
            (provider as { provide?: unknown }).provide === token &&
            typeof (provider as { useFactory?: unknown }).useFactory === 'function',
    );
    if (!found) throw new Error(`AppRuntimePortsModule provides no factory for ${String(token)}`);
    return found;
}

describe('AppRuntimePortsModule — the event sink and the runtime target (§9.8)', () => {
    it('exports both tokens, so the global module reaches AppDependenciesModule', () => {
        const exported = (Reflect.getMetadata('exports', AppRuntimePortsModule) ?? []) as unknown[];
        expect(exported).toEqual(
            expect.arrayContaining([APP_RUNTIME_EVENT_SINK, APP_RUNTIME_TARGET]),
        );
    });

    it('binds the event sink to the catalogue-checking relay over the API emitter', async () => {
        const emitted: Array<[string, unknown]> = [];
        const sink = factoryFor(APP_RUNTIME_EVENT_SINK).useFactory({
            emit: (name: string, payload: unknown) => emitted.push([name, payload]),
        }) as { emit(event: { name: string; payload: Record<string, unknown> }): Promise<void> };

        await sink.emit({
            name: 'app.dependency.data_deleted',
            payload: { workId: 'w1', kind: 'postgres', providerId: 'cnpg' },
        });
        expect(emitted).toEqual([
            ['app.dependency.data_deleted', { workId: 'w1', kind: 'postgres', providerId: 'cnpg' }],
        ]);

        // The same refusals a relayed worker event meets.
        await expect(sink.emit({ name: 'app.anything.else', payload: {} })).rejects.toThrow(
            /unknown App runtime event/,
        );
        await expect(
            sink.emit({ name: 'app.dependency.failed', payload: { workId: 'w1', secret: 'x' } }),
        ).rejects.toThrow(/forbidden key/);
        expect(emitted).toHaveLength(1);
    });

    it('binds the runtime target to the retryable "cluster unreachable" answer — the API never dials a cluster', async () => {
        const target = factoryFor(APP_RUNTIME_TARGET).useFactory() as {
            prepareDependencyTarget(workId: string): Promise<unknown>;
        };
        await expect(target.prepareDependencyTarget('w1')).resolves.toEqual({
            unavailable: 'cluster_unreachable',
        });
    });
});
