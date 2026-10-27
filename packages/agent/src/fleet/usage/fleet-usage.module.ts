import { Injectable, Module } from '@nestjs/common';
import { config } from '../../config';
import { DatabaseModule } from '../../database/database.module';
import { UsageModule } from '../../usage/usage.module';
import { FleetModule } from '../fleet.module';
import { FleetUsageReconcilerService } from './fleet-usage-reconciler.service';
import { FleetUsageScanService } from './fleet-usage-scan.service';
import { FleetUsageViewService } from './fleet-usage-view.service';

/**
 * Usage & cost on the fleet (FL-20) — the dispatcher's one-member facade.
 *
 * The `fleet-usage-scan-dispatcher` pass may reach the API over the internal
 * worker RPC, whose allow-list is derived from a service's prototype.
 * Exposing `FleetUsageScanService` itself would publish `rescan` to the
 * worker; this facade publishes exactly `dispatch()` (the FL-14
 * `FleetCheckoutReconcileService` shape).
 */
@Injectable()
export class FleetUsageDispatchService {
    constructor(private readonly scans: FleetUsageScanService) {}

    /** Does nothing while `FLEET_USAGE_SCAN_ENABLED` is off (the flag is read per call). */
    async dispatch(): Promise<{ nodes: number; enqueued: number }> {
        if (!config.fleet.isUsageScanEnabled()) return { nodes: 0, enqueued: 0 };
        return this.scans.dispatchDue();
    }
}

/**
 * Usage & cost on the fleet (FL-20) — the agent-side module:
 *
 *  - `FleetUsageReconcilerService` — every completed `usage-scan` job's report
 *    into `fleet_usage_samples`, Session usage, Run cost and the Agent's
 *    Budget (a listener on `fleet.job.completed`);
 *  - `FleetUsageScanService` — the 15-minute dispatcher and the owner's
 *    rescan; `FleetUsageDispatchService` its cron facade;
 *  - `FleetUsageViewService` — the one Usage object every surface renders.
 *
 * Entities come from `DatabaseModule` (`FleetUsageSample` is registered in
 * `database/_entities-inventory.ts`); `MODEL_LIST_PRICES` and
 * `PluginUsageService` from `UsageModule`.
 */
@Module({
    imports: [DatabaseModule, UsageModule, FleetModule],
    providers: [
        FleetUsageReconcilerService,
        FleetUsageScanService,
        FleetUsageViewService,
        FleetUsageDispatchService,
    ],
    exports: [
        FleetUsageReconcilerService,
        FleetUsageScanService,
        FleetUsageViewService,
        FleetUsageDispatchService,
    ],
})
export class FleetUsageModule {}
