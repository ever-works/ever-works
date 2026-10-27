import { Global, Module } from '@nestjs/common';
import { DistributedTaskLockService } from '@ever-works/agent/cache';
import { DatabaseModule } from '@ever-works/agent/database';
import { RUN_RECEIPT_FLEET_USAGE_READER } from '@ever-works/agent/agents';
import { DIGEST_FLEET_USAGE_READER } from '@ever-works/agent/digest';
import { FleetModule, FleetUsageModule, FleetUsageViewService } from '@ever-works/agent/fleet';
import { FleetEnabledGuard } from '../guards/fleet-enabled.guard';
import { FleetUsageController } from './fleet-usage.controller';
import { FleetUsageEnabledGuard } from './fleet-usage-enabled.guard';
import { FleetUsageScanCronService } from './fleet-usage-scan-cron.service';

/**
 * Usage & cost on the fleet (FL-20) — the API half:
 *
 *  - `FleetUsageController` — `/api/fleet/usage`, `/usage/rescan`,
 *    `/usage/prices` (dark unless `FLEET_USAGE_SCAN_ENABLED`);
 *  - `FleetUsageScanCronService` — the 15-minute dispatcher.
 *
 * The report itself needs no route: a node completes its `usage-scan` job
 * through the existing `POST /api/fleet/jobs/:id/complete`, and the agent-side
 * `FleetUsageReconcilerService` (a `fleet.job.completed` listener in
 * `FleetUsageModule`) ingests it.
 *
 * `@Global()` and re-exporting `FleetUsageModule`, so the Agent tool sources
 * (`AgentsModule`, optional token `FleetUsageViewService`) resolve the view
 * service without importing this module — the FL-14 / FL-16 shape.
 */
@Global()
@Module({
    // DatabaseModule: `DistributedTaskLockService` injects the `CacheEntry` repository.
    imports: [FleetUsageModule, FleetModule, DatabaseModule],
    controllers: [FleetUsageController],
    providers: [
        FleetUsageScanCronService,
        DistributedTaskLockService,
        // Guards are ordinary providers so Nest can inject them.
        FleetEnabledGuard,
        FleetUsageEnabledGuard,
        // The Run receipt's fleet line (FR-11): `RunReceiptService` (AW-09) reads it
        // through this optional port; exported from this @Global module so it resolves.
        { provide: RUN_RECEIPT_FLEET_USAGE_READER, useExisting: FleetUsageViewService },
        // The digest's fleet line (P3): `DigestService` reads it through this optional port.
        { provide: DIGEST_FLEET_USAGE_READER, useExisting: FleetUsageViewService },
    ],
    exports: [FleetUsageModule, RUN_RECEIPT_FLEET_USAGE_READER, DIGEST_FLEET_USAGE_READER],
})
export class FleetUsageApiModule {}
