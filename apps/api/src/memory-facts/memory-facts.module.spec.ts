/**
 * api-side MemoryFactsApiModule — the guard that a saved fact actually gets
 * EMBEDDED.
 *
 * `MEMORY_FACT_EMBED_DISPATCHER` is bound in this module, but its consumer —
 * `MemoryFactService` — is declared in the agent-side `MemoryFactsModule`
 * this module imports. Nest never resolves a provider's dependencies upward
 * into an importer, so without `@Global()` the `@Optional()` injection is
 * silently `undefined`: every fact saves, nothing is ever enqueued, and
 * meaning-based search quietly never works until the nightly sweep. No boot
 * error, no failing unit test, and CI has no job runtime anyway — which is
 * exactly why it is pinned here (same trap `workflows.module.spec.ts` pins).
 *
 * Mocking posture mirrors that spec: the heavy barrels are stubbed so the
 * decorator metadata can be asserted without the entity graph.
 */

jest.mock('@ever-works/agent/services', () => ({
    MemoryFactsModule: class AgentMemoryFactsModule {},
}));
jest.mock('@ever-works/agent/tasks', () => ({
    MEMORY_FACT_EMBED_DISPATCHER: Symbol('MEMORY_FACT_EMBED_DISPATCHER'),
}));
jest.mock('@ever-works/trigger-tasks', () => ({
    memoryFactEmbedTriggerAdapter: { dispatchMemoryFactEmbed: async () => null },
}));
jest.mock('./memory-facts.controller', () => ({
    MemoryFactsController: class MemoryFactsController {},
}));

import { MEMORY_FACT_EMBED_DISPATCHER } from '@ever-works/agent/tasks';
import { memoryFactEmbedTriggerAdapter } from '@ever-works/trigger-tasks';
import { MemoryFactsApiModule } from './memory-facts.module';

describe('MemoryFactsApiModule — embed dispatch wiring', () => {
    const GLOBAL_MODULE_METADATA = '__module:global__';

    it('is @Global() — without it the dispatcher never reaches MemoryFactService', () => {
        expect(Reflect.getMetadata(GLOBAL_MODULE_METADATA, MemoryFactsApiModule)).toBe(true);
    });

    it('binds MEMORY_FACT_EMBED_DISPATCHER to the job-runtime adapter, not a placeholder', () => {
        const providers = Reflect.getMetadata('providers', MemoryFactsApiModule) ?? [];
        const binding = providers.find(
            (provider: unknown) =>
                typeof provider === 'object' &&
                provider !== null &&
                (provider as { provide?: unknown }).provide === MEMORY_FACT_EMBED_DISPATCHER,
        );
        expect(binding).toBeDefined();
        expect((binding as { useValue?: unknown }).useValue).toBe(memoryFactEmbedTriggerAdapter);
    });

    it('exports the token', () => {
        expect(Reflect.getMetadata('exports', MemoryFactsApiModule) ?? []).toContain(
            MEMORY_FACT_EMBED_DISPATCHER,
        );
    });

    it('mounts the controller and imports the agent-side module', () => {
        expect(Reflect.getMetadata('controllers', MemoryFactsApiModule) ?? []).toHaveLength(1);
        expect(Reflect.getMetadata('imports', MemoryFactsApiModule) ?? []).toHaveLength(1);
    });
});
