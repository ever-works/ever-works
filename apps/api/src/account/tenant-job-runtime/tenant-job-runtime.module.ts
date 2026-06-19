import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DatabaseModule } from '@ever-works/agent/database';
import { TenantJobRuntimeAudit, TenantJobRuntimeConfig } from '@ever-works/agent/entities';
import {
    CredentialVersionService,
    InMemoryJobRuntimeProviderRegistry,
    InProcessSecretStoreResolver,
    JOB_RUNTIME_PROVIDER_REGISTRY,
    RuntimeBindingStamperService,
    SECRET_STORE_RESOLVER,
    TenantAwareRuntimeResolver,
    TenantCredentialCache,
} from '@ever-works/agent/tasks';
import { TenantJobRuntimeController } from './tenant-job-runtime.controller';
import { TenantJobRuntimeService } from './tenant-job-runtime.service';

/**
 * EW-742 / EW-746 (P2.0 — tenant-job-runtime overlay admin API) — wires
 * the controller + service + TypeORM repository registrations for the
 * five admin endpoints under `/api/account/job-runtime/...`.
 *
 * Spec: [`docs/specs/features/tenant-job-runtime-overlay/spec.md`](../../../../docs/specs/features/tenant-job-runtime-overlay/spec.md)
 * Plan: [`plan.md` §4 API surface](../../../../docs/specs/features/tenant-job-runtime-overlay/plan.md#4-api-surface)
 * Tasks: [`tasks.md` T14 + T20 + T21](../../../../docs/specs/features/tenant-job-runtime-overlay/tasks.md)
 *
 * Imports the global `DatabaseModule` (provides the TypeORM connection)
 * plus `TypeOrmModule.forFeature([...])` so the service can inject the
 * scoped `Repository<TenantJobRuntimeConfig>` and
 * `Repository<TenantJobRuntimeAudit>`. `CredentialVersionService`,
 * `TenantAwareRuntimeResolver` (EW-742 P3 / EW-747 T20), and
 * `TenantCredentialCache` (EW-742 P3.1 / T21) are provided locally rather
 * than imported via a separate module — they live in
 * `@ever-works/agent/tasks` and need the same forFeature registration
 * to resolve their own `@InjectRepository(TenantJobRuntimeConfig)`.
 * Co-providing here keeps the DI graph flat; if another module ever
 * needs the same services, hoist them into a dedicated providers
 * module and import.
 *
 * The `JOB_RUNTIME_PROVIDER_REGISTRY` provider binds the in-memory
 * default implementation per EW-685 P0 T4 — same single-active-runtime
 * semantic as before. The resolver wraps it without changing the
 * registry contract; non-overridden tenants still resolve to whatever
 * the registry returns from `getActive()`.
 *
 * `TenantCredentialCache` is a dumb in-memory LRU+TTL bag (zero DI deps)
 * exposed via `exports` so the P3 resolver and future P4 worker host
 * can inject it. This module is its registration point.
 */
@Module({
    imports: [
        DatabaseModule,
        TypeOrmModule.forFeature([TenantJobRuntimeConfig, TenantJobRuntimeAudit]),
    ],
    providers: [
        TenantJobRuntimeService,
        CredentialVersionService,
        RuntimeBindingStamperService,
        TenantAwareRuntimeResolver,
        TenantCredentialCache,
        {
            provide: JOB_RUNTIME_PROVIDER_REGISTRY,
            useClass: InMemoryJobRuntimeProviderRegistry,
        },
        {
            // EW-742 P3.2 — default in-process SecretStoreResolver.
            // Supports `inline:` only; production deployments override
            // this binding with a scheme-specific resolver via a module
            // override or environment-keyed factory.
            provide: SECRET_STORE_RESOLVER,
            useClass: InProcessSecretStoreResolver,
        },
    ],
    controllers: [TenantJobRuntimeController],
    exports: [TenantCredentialCache, TenantAwareRuntimeResolver, RuntimeBindingStamperService],
})
export class TenantJobRuntimeModule {}
