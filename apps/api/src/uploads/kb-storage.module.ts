import { Global, Module } from '@nestjs/common';
import { KB_STORAGE_PLUGIN } from '@ever-works/agent/services';
import { getActiveStorageBackend } from './storage-backend.factory';

/**
 * EW-641 — `@Global()` provider for the KB upload pipeline's storage
 * plugin token.
 *
 * **Why @Global() instead of providing inside `WorksModule`?**
 * `KnowledgeBaseModule` lives in `@ever-works/agent/services` and is
 * imported BY `WorksModule`. NestJS DI resolves a provider's
 * dependencies against:
 *
 *   1. Its owning module's `providers` list, AND
 *   2. Modules listed in the owning module's `imports` (transitively).
 *
 * It does NOT walk back up to modules that *import* the owning module
 * (i.e., consumer modules). So when `KnowledgeBaseService` is
 * constructed as a provider inside `KnowledgeBaseModule` and asks for
 * `@Inject(KB_STORAGE_PLUGIN)`, NestJS only sees what `KnowledgeBaseModule`
 * itself imports — `DatabaseModule`, `FacadesModule`. Neither provides
 * the token.
 *
 * Until now the previous wiring (provider in `WorksModule.providers`)
 * silently bound `undefined` thanks to the `@Optional()` decorator on
 * the injection site. `KbController` then hit a `ServiceUnavailableException`
 * on every upload with `"KB uploads require a storage plugin — not
 * configured in this deployment"` — which is exactly what the e2e
 * suite started seeing once the row-19 / row-22-24 KB Playwright specs
 * actually exercised the upload route (run 26302118655 on develop).
 *
 * `TriggerModule` solves the identical problem for `KB_MIRROR_DOCUMENT_DISPATCHER`
 * by being `@Global()` so its providers are visible from every DI
 * graph. This module mirrors that pattern for the storage plugin: one
 * provider, exported, marked `@Global()`. Imported once in
 * `api.module.ts`, KB upload paths now resolve the local-fs (or
 * configured) backend just like any unit test that wires the mock
 * explicitly.
 *
 * Lives in `apps/api/` because the factory `getActiveStorageBackend`
 * is API-side code (driven by API-only env vars + the API's plugin
 * registry). The agent package can't own the wiring without
 * introducing a circular dependency.
 */
@Global()
@Module({
    providers: [
        {
            provide: KB_STORAGE_PLUGIN,
            useFactory: () => getActiveStorageBackend(),
        },
    ],
    exports: [KB_STORAGE_PLUGIN],
})
export class KbStorageModule {}
