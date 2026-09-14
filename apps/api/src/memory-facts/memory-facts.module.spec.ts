/**
 * api-side MemoryFactsApiModule — the guard that a saved fact actually gets
 * EMBEDDED, on whichever job runtime is configured.
 *
 * `MEMORY_FACT_EMBED_DISPATCHER` is consumed by `MemoryFactService`, declared
 * in the agent-side `MemoryFactsModule` this module imports. Nest never
 * resolves a provider's dependencies upward into an importer, so the token
 * must come from a `@Global()` module — and it must come from the job-runtime
 * provider REGISTRY, not a runtime-specific adapter, or every install that
 * selected a different job-runtime plugin silently never embeds a fact.
 *
 * The registry binding itself (`buildJobRuntimeProviders()` in the @Global
 * TriggerModule) is pinned in `memory-fact-embed.job-runtime.spec.ts` and in
 * `packages/agent/src/tasks/__tests__/job-runtime.providers.spec.ts`. This
 * spec pins the other half: this module must not SHADOW that binding with a
 * provider of its own, it stays @Global, and it registers the in-process
 * nightly sweep used when Trigger.dev is not the runtime.
 *
 * Mocking posture mirrors `workflows.module.spec.ts`: the heavy barrels are
 * stubbed so the decorator metadata can be asserted without the entity graph.
 */

jest.mock('@ever-works/agent/services', () => ({
    MemoryFactsModule: class AgentMemoryFactsModule {},
    MemoryFactSweepService: class MemoryFactSweepService {},
}));
jest.mock('@ever-works/agent/database', () => ({
    DatabaseModule: class DatabaseModule {},
}));
jest.mock('@ever-works/agent/cache', () => ({
    DistributedTaskLockService: class DistributedTaskLockService {},
}));
jest.mock('@ever-works/agent/config', () => ({
    config: { trigger: { shouldUseTrigger: jest.fn() } },
}));
jest.mock('@ever-works/agent/tasks', () => ({
    MEMORY_FACT_EMBED_DISPATCHER: Symbol('MEMORY_FACT_EMBED_DISPATCHER'),
    MEMORY_FACT_GC_CRON: '13 4 * * *',
    runMemoryFactGcJob: jest.fn(),
}));
jest.mock('./memory-facts.controller', () => ({
    MemoryFactsController: class MemoryFactsController {},
}));

import { MEMORY_FACT_EMBED_DISPATCHER } from '@ever-works/agent/tasks';
import { DistributedTaskLockService } from '@ever-works/agent/cache';
import { MemoryFactsApiModule } from './memory-facts.module';
import { MemoryFactGcCronService } from './memory-fact-gc-cron.service';

describe('MemoryFactsApiModule — embed dispatch wiring', () => {
    const GLOBAL_MODULE_METADATA = '__module:global__';

    it('is @Global()', () => {
        expect(Reflect.getMetadata(GLOBAL_MODULE_METADATA, MemoryFactsApiModule)).toBe(true);
    });

    it('does NOT bind MEMORY_FACT_EMBED_DISPATCHER itself — the job-runtime registry does', () => {
        const providers: unknown[] = Reflect.getMetadata('providers', MemoryFactsApiModule) ?? [];
        const shadow = providers.find(
            (provider) =>
                typeof provider === 'object' &&
                provider !== null &&
                (provider as { provide?: unknown }).provide === MEMORY_FACT_EMBED_DISPATCHER,
        );
        expect(shadow).toBeUndefined();
        expect(Reflect.getMetadata('exports', MemoryFactsApiModule) ?? []).not.toContain(
            MEMORY_FACT_EMBED_DISPATCHER,
        );
    });

    it('registers the in-process nightly sweep with its distributed lock', () => {
        const providers: unknown[] = Reflect.getMetadata('providers', MemoryFactsApiModule) ?? [];
        expect(providers).toEqual(
            expect.arrayContaining([MemoryFactGcCronService, DistributedTaskLockService]),
        );
    });

    it('mounts the controller and imports the agent-side module', () => {
        expect(Reflect.getMetadata('controllers', MemoryFactsApiModule) ?? []).toHaveLength(1);
        const imports: Array<{ name?: string }> =
            Reflect.getMetadata('imports', MemoryFactsApiModule) ?? [];
        expect(imports.map((m) => m.name)).toContain('AgentMemoryFactsModule');
    });
});
