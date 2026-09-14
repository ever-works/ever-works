import { Global, Module } from '@nestjs/common';
import { MemoryFactsModule } from '@ever-works/agent/services';
import { MEMORY_FACT_EMBED_DISPATCHER } from '@ever-works/agent/tasks';
import { memoryFactEmbedTriggerAdapter } from '@ever-works/trigger-tasks';
import { MemoryFactsController } from './memory-facts.controller';

/**
 * Memory facts — the `/api/memory/facts` surface (AW-07).
 *
 * Mounts the controller only; the services and the repository live in the
 * agent-side `MemoryFactsModule`. `ScopeContextService` arrives through the
 * `@Global()` ScopeModule and authentication through the global guards.
 *
 * ## The dispatcher binding, and why `@Global()` is load-bearing
 *
 * `MEMORY_FACT_EMBED_DISPATCHER` is bound HERE because its adapter carries
 * the job-runtime SDK, which `@ever-works/agent` deliberately does not take.
 *
 * The consumer, `MemoryFactService`, is declared in the agent-side module
 * this one IMPORTS. NestJS resolves a provider's dependencies in the
 * injector of the module that DECLARES it — never upward into an importer —
 * so a plain `@Module` binding would be invisible to the service and its
 * `@Optional()` injection would silently resolve to `undefined`. Every fact
 * would then save un-embedded and wait for the nightly sweep, with no error
 * anywhere. `WorkflowsModule` documents the same trap;
 * `memory-facts.module.spec.ts` pins it.
 */
@Global()
@Module({
    imports: [MemoryFactsModule],
    controllers: [MemoryFactsController],
    providers: [{ provide: MEMORY_FACT_EMBED_DISPATCHER, useValue: memoryFactEmbedTriggerAdapter }],
    exports: [MEMORY_FACT_EMBED_DISPATCHER],
})
export class MemoryFactsApiModule {}
