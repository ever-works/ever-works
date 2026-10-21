import { Global, Module } from '@nestjs/common';
import { DistributedTaskLockService } from '@ever-works/agent/cache';
import { DatabaseModule } from '@ever-works/agent/database';
import { FleetCloudModule, FleetModule } from '@ever-works/agent/fleet';
import { FleetEnabledGuard } from '../guards/fleet-enabled.guard';
import { FleetCloudController } from './fleet-cloud.controller';
import { FleetCloudEnabledGuard } from './fleet-cloud-enabled.guard';
import { FleetCloudSweepCronService } from './fleet-cloud-sweep-cron.service';

/**
 * Cloud computers (FL-17) — the API half: the owner-facing routes under
 * `/api/fleet/providers` and `/api/fleet/cloud`, and the sweep fallbacks
 * (reconcile, bootstrap watch). Dark unless `FLEET_CLOUD_ENABLED`.
 *
 * `@Global()` for the reason `FleetVirtualApiModule` is: the internal trigger
 * controller resolves `FleetCloudSweepService` `@Optional()` for the worker's
 * `fleet-cloud-*` RPCs, and the Agent tools resolve `FleetCloudService`,
 * without importing this module.
 */
@Global()
@Module({
    imports: [FleetCloudModule, FleetModule, DatabaseModule],
    controllers: [FleetCloudController],
    providers: [
        FleetCloudSweepCronService,
        DistributedTaskLockService,
        // Guards are ordinary providers so Nest can inject them.
        FleetEnabledGuard,
        FleetCloudEnabledGuard,
    ],
    exports: [FleetCloudModule],
})
export class FleetCloudApiModule {}
