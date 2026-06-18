import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DatabaseModule } from '@ever-works/agent/database';
import { TenantJobRuntimeAudit, TenantJobRuntimeConfig } from '@ever-works/agent/entities';
import { CredentialVersionService } from '@ever-works/agent/tasks';
import { TenantJobRuntimeController } from './tenant-job-runtime.controller';
import { TenantJobRuntimeService } from './tenant-job-runtime.service';

/**
 * EW-742 / EW-746 (P2.0 — tenant-job-runtime overlay admin API) — wires
 * the controller + service + TypeORM repository registrations for the
 * five admin endpoints under `/api/account/job-runtime/...`.
 *
 * Spec: [`docs/specs/features/tenant-job-runtime-overlay/spec.md`](../../../../docs/specs/features/tenant-job-runtime-overlay/spec.md)
 * Plan: [`plan.md` §4 API surface](../../../../docs/specs/features/tenant-job-runtime-overlay/plan.md#4-api-surface)
 * Tasks: [`tasks.md` T14](../../../../docs/specs/features/tenant-job-runtime-overlay/tasks.md)
 *
 * Imports the global `DatabaseModule` (provides the TypeORM connection)
 * plus `TypeOrmModule.forFeature([...])` so the service can inject the
 * scoped `Repository<TenantJobRuntimeConfig>` and
 * `Repository<TenantJobRuntimeAudit>`. `CredentialVersionService` is
 * provided locally rather than imported via a separate module — it lives
 * in `@ever-works/agent/tasks` and needs the same forFeature
 * registration to resolve its own `@InjectRepository(TenantJobRuntimeConfig)`.
 * Co-providing it here keeps the DI graph flat; if another module ever
 * needs the same service, hoist it into a dedicated providers module
 * and import.
 */
@Module({
    imports: [
        DatabaseModule,
        TypeOrmModule.forFeature([TenantJobRuntimeConfig, TenantJobRuntimeAudit]),
    ],
    providers: [TenantJobRuntimeService, CredentialVersionService],
    controllers: [TenantJobRuntimeController],
})
export class TenantJobRuntimeModule {}
