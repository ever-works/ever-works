import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DatabaseModule } from '@ever-works/agent/database';
import {
    TenantCredentialSnapshot,
    TenantJobRuntimeAudit,
    TenantJobRuntimeConfig,
    TenantRuntimeProviderAllowlist,
} from '@ever-works/agent/entities';
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
import { IsPlatformAdminGuard } from '../../auth/guards/platform-admin.guard';
import { OperatorTenantRuntimeAllowlistController } from '../../operator/tenant-runtime-allowlist/operator-tenant-runtime-allowlist.controller';
import { TenantJobRuntimeBootAuditService } from './tenant-job-runtime-boot-audit.service';
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
        TypeOrmModule.forFeature([
            TenantJobRuntimeConfig,
            TenantJobRuntimeAudit,
            // EW-752 P5.1 (T35a) — per-tenant runtime provider allow-list
            // overlay. Registered here (not in a separate operator module)
            // so the service can inject both the legacy audit repo and the
            // new allow-list repo without duplicating the DI graph.
            TenantRuntimeProviderAllowlist,
            // EW-742 P1 T11 follow-up — per-version credential snapshot
            // history. `CredentialVersionService` injects this repo to
            // satisfy the graceful-drain contract (ADR-017 §3 Q4): an
            // in-flight run pinned at v=N must still resolve its bag
            // after the tenant rotates to N+1.
            TenantCredentialSnapshot,
        ]),
    ],
    providers: [
        TenantJobRuntimeService,
        CredentialVersionService,
        RuntimeBindingStamperService,
        TenantAwareRuntimeResolver,
        // SWC-Number-DI gotcha: TenantCredentialCache's optional `opts`
        // constructor arg has a JS-object type that SWC's design-time
        // metadata emits as `Number`, which NestJS then tries to inject
        // → UnknownDependenciesException at boot. Wrap in useFactory so
        // NestJS skips constructor introspection. Zero-dep class (see
        // packages/agent/src/tasks/tenant-credential.cache.ts comments).
        { provide: TenantCredentialCache, useFactory: () => new TenantCredentialCache() },
        // EW-752 P5.1 (T35b) — boot-time writer for the
        // `operator_allowlist_boot` audit row. Implements
        // `OnApplicationBootstrap` so registering it here is enough for
        // NestJS to call it on app start.
        TenantJobRuntimeBootAuditService,
        // EW-752 P5.1 (T35a) — `OperatorTenantRuntimeAllowlistController`
        // is `@UseGuards(IsPlatformAdminGuard)` and the guard resolves
        // `UserRepository` from the imported DatabaseModule. The guard
        // must be a provider of the module that owns the controller
        // (same wiring pattern as `BudgetsModule` for the EW-602
        // AdminUsageController gate).
        IsPlatformAdminGuard,
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
    controllers: [
        TenantJobRuntimeController,
        // EW-752 P5.1 (T35a) — operator-scoped CRUD for the per-tenant
        // allow-list overlay. Co-mounted in this module rather than its
        // own `OperatorModule` because the controller depends on
        // `TenantJobRuntimeService` (which lives here) plus
        // `IsPlatformAdminGuard`. A future broader `OperatorModule` can
        // import this module to re-expose the controller; nothing
        // precludes that hoist.
        OperatorTenantRuntimeAllowlistController,
    ],
    exports: [
        TenantCredentialCache,
        TenantAwareRuntimeResolver,
        RuntimeBindingStamperService,
        // EW-742 P3.2 T22 — exported so TriggerInternalModule can expose
        // resolveSnapshot through the remote-proxy controller for the
        // worker-host consumption path.
        CredentialVersionService,
        // EW-752 P5.1 (T35b) — exported so consumers wanting to trigger
        // a boot-audit snapshot manually (e.g. a future ops endpoint)
        // can inject it without re-registering.
        TenantJobRuntimeBootAuditService,
    ],
})
export class TenantJobRuntimeModule {}
