import { Global, Module } from '@nestjs/common';
import { DistributedTaskLockService } from '@ever-works/agent/cache';
import { DatabaseModule } from '@ever-works/agent/database';
import { MemoryFactsModule } from '@ever-works/agent/services';
import { MemoryFactsController } from './memory-facts.controller';
import { MemoryFactGcCronService } from './memory-fact-gc-cron.service';

/**
 * Memory facts — the `/api/memory/facts` surface (AW-07).
 *
 * Mounts the controller; the services and the repository live in the
 * agent-side `MemoryFactsModule`. `ScopeContextService` arrives through the
 * `@Global()` ScopeModule and authentication through the global guards.
 *
 * ## The embed dispatcher is NOT bound here
 *
 * `MEMORY_FACT_EMBED_DISPATCHER` resolves through the job-runtime provider
 * registry, exactly like every other `*_DISPATCHER` symbol:
 * `buildJobRuntimeProviders()` binds it in the `@Global()` `TriggerModule`
 * (`packages/tasks/src/trigger/trigger.module.ts`), which hands back the
 * ACTIVE provider's `dispatchers` view. Whichever job-runtime plugin is
 * registered — and the tenant overlay in front of it — enqueues
 * `memory-fact-embed`; with none registered the token resolves to `null`,
 * the fact still saves, literal search still finds it, and
 * `MemoryFactService` says so once at startup.
 *
 * The consumer, `MemoryFactService`, is declared in the agent-side module
 * this one IMPORTS. NestJS resolves a provider's dependencies in the
 * injector of the module that DECLARES it plus global modules — never
 * upward into an importer — which is why the binding lives in a `@Global()`
 * module (TriggerModule) rather than here. `memory-facts.module.spec.ts`
 * pins that this module does not shadow it with a runtime-specific adapter.
 *
 * This module stays `@Global()` so anything it exports in future reaches the
 * agent-side graph the same way.
 *
 * ## The nightly sweep on runtimes other than Trigger.dev
 *
 * `MemoryFactGcCronService` runs the `memory-fact-gc` pass in-process when
 * Trigger.dev is not the configured runtime (the established fallback shape
 * of `WorkScheduleDispatcherCronService`), so forgotten facts are purged and
 * unembedded facts backfilled on every install.
 */
@Global()
@Module({
    imports: [MemoryFactsModule, DatabaseModule],
    controllers: [MemoryFactsController],
    providers: [MemoryFactGcCronService, DistributedTaskLockService],
})
export class MemoryFactsApiModule {}
