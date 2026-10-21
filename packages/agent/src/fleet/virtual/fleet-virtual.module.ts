import { Injectable, Module } from '@nestjs/common';
import { config } from '../../config';
import { FleetModule } from '../fleet.module';
import { FleetSessionsModule } from '../sessions/fleet-sessions.module';
import { FleetVirtualService } from './fleet-virtual.service';

/**
 * Virtual computers (FL-16) — the reconcile sweep's one-member facade.
 *
 * The `fleet-virtual-reconcile` cron reaches the API over the internal worker
 * RPC, whose allow-list is derived from a service's prototype. Exposing
 * `FleetVirtualService` itself would publish create / destroy / the token mint
 * to the worker; this facade publishes exactly `reconcile()` (the FL-14
 * `FleetCheckoutReconcileService` shape).
 */
@Injectable()
export class FleetVirtualReconcileService {
    constructor(private readonly virtual: FleetVirtualService) {}

    /** Does nothing while `FLEET_VIRTUAL_ENABLED` is off (the flag is read per call). */
    async reconcile(): Promise<{ hosts: number; changed: number }> {
        if (!config.fleet.isVirtualEnabled()) return { hosts: 0, changed: 0 };
        return this.virtual.reconcile();
    }
}

/**
 * Virtual computers (FL-16) — the agent-side module: `FleetVirtualService`
 * (every surface calls it) and the reconcile facade. No entity of its own: a
 * child is a `FleetNode` (README §1) and its jobs are `FleetJob`s, both owned
 * by `FleetModule`. The node link (`FLEET_MACHINE_NODE_PORT`) is the API's
 * global binding, consumed `@Optional()`.
 */
@Module({
    imports: [FleetModule, FleetSessionsModule],
    providers: [FleetVirtualService, FleetVirtualReconcileService],
    exports: [FleetVirtualService, FleetVirtualReconcileService],
})
export class FleetVirtualModule {}
