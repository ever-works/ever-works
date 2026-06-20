import type { IJobRuntimeProvider, JobRuntimeDispatchers } from '@ever-works/plugin';
import { KB_BACKFILL_SKELETON_DISPATCHER } from '../kb-backfill-skeleton-dispatcher';
import { KB_EMBED_DOCUMENT_DISPATCHER } from '../kb-embed-document-dispatcher';
import { KB_MIRROR_DOCUMENT_DISPATCHER } from '../kb-mirror-document-dispatcher';
import { KB_NORMALIZE_MEDIA_DISPATCHER } from '../kb-normalize-media-dispatcher';
import { KB_ORG_OVERLAY_FANOUT_DISPATCHER } from '../kb-org-overlay-fanout-dispatcher';
import { KB_REEMBED_WORK_DISPATCHER } from '../kb-reembed-work-dispatcher';
import { KB_TRANSCRIBE_DISPATCHER } from '../kb-transcribe-dispatcher';
import { TEMPLATE_CUSTOMIZATION_DISPATCHER } from '../template-customization-dispatcher';
import { WEBHOOK_DELIVERY_DISPATCHER } from '../webhook-delivery-dispatcher';
import { WORK_GENERATION_DISPATCHER } from '../work-generation-dispatcher';
import { WORK_IMPORT_DISPATCHER } from '../work-import-dispatcher';
import {
    InMemoryJobRuntimeProviderRegistry,
    JOB_RUNTIME_PROVIDER_REGISTRY,
    buildJobRuntimeProviders,
    type JobRuntimeProviderRegistry,
} from '../job-runtime.providers';

/**
 * EW-685 P0 T4 — binding factory tests.
 *
 * Pins the four invariants the cutover PR will rely on:
 *   1. The {@link JOB_RUNTIME_PROVIDER_REGISTRY} token is a process-local
 *      `Symbol()` (matches the DI-token convention every dispatcher symbol
 *      in this package uses — same registry-collision guard as
 *      `tasks.spec.ts`).
 *   2. The default in-memory registry returns `null` until something is
 *      registered, and last-`register()` wins (single-active-runtime per
 *      EW-683 §4).
 *   3. {@link buildJobRuntimeProviders} returns exactly 11 NestJS providers
 *      — one per `*_DISPATCHER` symbol exported from `@ever-works/agent/tasks`.
 *      Drift here means a dispatcher silently fails to rebind when the
 *      cutover PR flips the bindings.
 *   4. Each factory function delegates to `registry.getActive().dispatchers`
 *      when a provider is registered, and falls back to `null` when nothing
 *      is registered — preserving the existing `string | null` enqueue
 *      semantic per the IJobRuntimeProvider contract JSDoc §3.
 */
describe('job-runtime.providers (EW-685 P0 T4 binding factory)', () => {
    /**
     * Build a minimal {@link IJobRuntimeProvider} test double. The
     * dispatchers object is the only field the factory actually reads;
     * the rest of the interface is stubbed so TypeScript stops yelling.
     */
    function mockProvider(
        dispatchers: JobRuntimeDispatchers = { sentinel: 'mock-dispatchers' },
    ): IJobRuntimeProvider {
        return {
            id: 'mock',
            name: 'Mock Provider',
            version: '0.0.0-test',
            category: 'job-runtime' as IJobRuntimeProvider['category'],
            capabilities: [],
            settingsSchema: { type: 'object', properties: {} },
            runtimeId: 'trigger',
            dispatchers,
            async registerSchedules() {
                /* no-op */
            },
            async cancel() {
                return false;
            },
            async getRunStatus() {
                return 'unknown';
            },
            isEnabled() {
                return true;
            },
            async onLoad() {
                /* no-op — synthetic test provider, no resources to wire */
            },
            async onUnload() {
                /* no-op — synthetic test provider, no resources to release */
            },
        } satisfies IJobRuntimeProvider;
    }

    describe('JOB_RUNTIME_PROVIDER_REGISTRY token', () => {
        it('is a process-local Symbol with the documented description', () => {
            expect(typeof JOB_RUNTIME_PROVIDER_REGISTRY).toBe('symbol');
            expect(JOB_RUNTIME_PROVIDER_REGISTRY.description).toBe('JOB_RUNTIME_PROVIDER_REGISTRY');
        });

        it('is NOT registered via Symbol.for (DI-token isolation invariant)', () => {
            // Symbol.for(<key>) is registry-shared; calling it twice with
            // the same key returns the same symbol. Plain Symbol(<desc>)
            // does not. Guards the same invariant tasks.spec.ts pins for
            // every dispatcher symbol.
            expect(JOB_RUNTIME_PROVIDER_REGISTRY).not.toBe(
                Symbol.for('JOB_RUNTIME_PROVIDER_REGISTRY'),
            );
        });

        it('is the same singleton when re-imported (ESM module-cache pin)', () => {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const reimported = require('../job-runtime.providers').JOB_RUNTIME_PROVIDER_REGISTRY;
            expect(reimported).toBe(JOB_RUNTIME_PROVIDER_REGISTRY);
        });
    });

    describe('InMemoryJobRuntimeProviderRegistry default implementation', () => {
        it('getActive() returns null when nothing has been registered', () => {
            const registry: JobRuntimeProviderRegistry = new InMemoryJobRuntimeProviderRegistry();
            expect(registry.getActive()).toBeNull();
        });

        it('register(provider) makes that provider observable via getActive()', () => {
            const registry = new InMemoryJobRuntimeProviderRegistry();
            const provider = mockProvider();
            registry.register(provider);
            expect(registry.getActive()).toBe(provider);
        });

        it('multiple register() calls — last call wins (single-active-runtime per EW-683 §4)', () => {
            const registry = new InMemoryJobRuntimeProviderRegistry();
            const first = mockProvider({ which: 'first' });
            const second = mockProvider({ which: 'second' });
            const third = mockProvider({ which: 'third' });
            registry.register(first);
            registry.register(second);
            registry.register(third);
            expect(registry.getActive()).toBe(third);
            // Sanity: the sentinel on the active dispatchers matches the
            // last provider's payload, not an earlier one.
            expect(registry.getActive()?.dispatchers).toEqual({ which: 'third' });
        });
    });

    describe('buildJobRuntimeProviders()', () => {
        it('returns exactly one NestJS provider per *_DISPATCHER symbol (arity = 11)', () => {
            const providers = buildJobRuntimeProviders();
            expect(providers).toHaveLength(11);
        });

        it('binds every *_DISPATCHER symbol exported from @ever-works/agent/tasks', () => {
            const providers = buildJobRuntimeProviders();
            // `Provider` is a union; the factory-flavour we emit always has
            // a `.provide` symbol. Narrow via `as { provide: symbol }` to
            // keep the assertion direct without leaking the full DI typing.
            const provideTokens = new Set(providers.map((p) => (p as { provide: symbol }).provide));
            // Compare as a Set — Symbol values cannot be sorted (the default
            // sort comparator coerces to string and symbols throw on
            // String() coercion). Identity match against the canonical
            // 11-symbol list is the actual invariant we care about.
            const expected = new Set<symbol>([
                KB_BACKFILL_SKELETON_DISPATCHER,
                KB_EMBED_DOCUMENT_DISPATCHER,
                KB_MIRROR_DOCUMENT_DISPATCHER,
                KB_NORMALIZE_MEDIA_DISPATCHER,
                KB_ORG_OVERLAY_FANOUT_DISPATCHER,
                KB_REEMBED_WORK_DISPATCHER,
                KB_TRANSCRIBE_DISPATCHER,
                TEMPLATE_CUSTOMIZATION_DISPATCHER,
                WEBHOOK_DELIVERY_DISPATCHER,
                WORK_GENERATION_DISPATCHER,
                WORK_IMPORT_DISPATCHER,
            ]);
            expect(provideTokens).toEqual(expected);
            // Belt-and-suspenders: no duplicate provide tokens (a duplicate
            // would silently shadow the earlier binding in NestJS).
            expect(provideTokens.size).toBe(providers.length);
        });

        it('every emitted provider injects the JOB_RUNTIME_PROVIDER_REGISTRY token', () => {
            const providers = buildJobRuntimeProviders();
            for (const p of providers) {
                const factoryProvider = p as { inject?: symbol[] };
                expect(factoryProvider.inject).toEqual([JOB_RUNTIME_PROVIDER_REGISTRY]);
            }
        });

        it('each factory returns the active provider.dispatchers when one is registered', () => {
            const registry = new InMemoryJobRuntimeProviderRegistry();
            // Distinct sentinel per dispatcher symbol so we can verify the
            // factory genuinely hands back the live `dispatchers` view (not
            // a stale snapshot or `null`).
            const dispatchers: JobRuntimeDispatchers = {
                dispatchWorkGeneration: jest.fn(),
                cancelWorkGeneration: jest.fn(),
                tag: 'active-provider-dispatchers',
            };
            registry.register(mockProvider(dispatchers));

            const providers = buildJobRuntimeProviders();
            for (const p of providers) {
                const factoryProvider = p as {
                    useFactory: (r: JobRuntimeProviderRegistry) => unknown;
                };
                expect(factoryProvider.useFactory(registry)).toBe(dispatchers);
            }
        });

        it('each factory returns null when no provider is registered (preserves dev fallback)', () => {
            // Per IJobRuntimeProvider contract JSDoc §3: a disabled or
            // unreachable runtime returns null and the API's in-process
            // dev fallback takes over. The binding factory MUST surface
            // null through every dispatcher symbol so call sites that
            // already check `await dispatcher?.dispatchX(...) ?? null`
            // keep working unchanged.
            const registry = new InMemoryJobRuntimeProviderRegistry();
            const providers = buildJobRuntimeProviders();
            for (const p of providers) {
                const factoryProvider = p as {
                    useFactory: (r: JobRuntimeProviderRegistry) => unknown;
                };
                expect(factoryProvider.useFactory(registry)).toBeNull();
            }
        });

        it('symbols filter binds only the requested subset (pull-model provider partial bind)', () => {
            // EW-685 T4 full cutover landed in trigger.module.ts with no
            // `symbols:` filter (all 11 bind through the registry). The
            // `symbols:` option remains for tests and for future modules
            // that want to bind a strict subset (e.g. a pull-model worker
            // host that only owns a subset of the dispatcher surface).
            // The factory must honour the subset and return EXACTLY those
            // providers — no fewer, no more.
            const subset: readonly symbol[] = [
                WORK_GENERATION_DISPATCHER,
                WORK_IMPORT_DISPATCHER,
                TEMPLATE_CUSTOMIZATION_DISPATCHER,
            ];
            const providers = buildJobRuntimeProviders({ symbols: subset });
            expect(providers).toHaveLength(3);
            const provideTokens = new Set(providers.map((p) => (p as { provide: symbol }).provide));
            expect(provideTokens).toEqual(new Set(subset));
        });

        it('symbols filter with empty array binds nothing', () => {
            const providers = buildJobRuntimeProviders({ symbols: [] });
            expect(providers).toEqual([]);
        });

        it('reflects later register() calls — providers are resolved per-call, not memoised', () => {
            // If the factory cached the active provider at module-init
            // time, the EW-742 P3 tenant-aware resolver (which dispatches
            // per-request) wouldn't work. Pin "resolves on every call"
            // here so an accidental memoisation in a follow-up PR fails
            // loudly instead of silently freezing the wrong provider in.
            const registry = new InMemoryJobRuntimeProviderRegistry();
            const providers = buildJobRuntimeProviders();
            // Take the first provider as representative; the assertions
            // above already cover identical behaviour across all 11.
            const factory = (
                providers[0] as { useFactory: (r: JobRuntimeProviderRegistry) => unknown }
            ).useFactory;

            expect(factory(registry)).toBeNull();

            const first = mockProvider({ which: 'first' });
            registry.register(first);
            expect(factory(registry)).toEqual({ which: 'first' });

            const second = mockProvider({ which: 'second' });
            registry.register(second);
            expect(factory(registry)).toEqual({ which: 'second' });
        });
    });
});
