import { Global, Module } from '@nestjs/common';
import { DistributedTaskLockService } from '@ever-works/agent/cache';
import { DatabaseModule } from '@ever-works/agent/database';
import { FleetModule, FleetVirtualModule } from '@ever-works/agent/fleet';
import { FleetEnabledGuard } from '../guards/fleet-enabled.guard';
import { FleetNodeAuthGuard } from '../guards/fleet-node-auth.guard';
import { FleetVirtualController } from './fleet-virtual.controller';
import { FleetVirtualEnabledGuard } from './fleet-virtual-enabled.guard';
import { FleetVirtualNodeController } from './fleet-virtual-node.controller';
import { FleetVirtualReconcileCronService } from './fleet-virtual-reconcile-cron.service';

/**
 * Virtual computers (FL-16) — the API half: the owner-facing routes under
 * `/api/fleet/nodes/:id/virtual`, the host-facing `/api/internal/fleet/virtual`
 * (token mint, progress), and the reconcile fallback cron. Dark unless
 * `FLEET_VIRTUAL_ENABLED`.
 *
 * The agent-side `FleetVirtualService` reads the machine through the global
 * `FLEET_MACHINE_NODE_PORT` binding `FleetMachineApiModule` provides (the
 * reconcile's `vm.list`); nothing here needs it directly.
 *
 * `@Global()` for the reason `FleetCheckoutsApiModule` is: the internal
 * trigger controller resolves `FleetVirtualReconcileService` `@Optional()` for
 * the worker's `fleet-virtual-reconcile` RPC, and the Agent tools resolve
 * `FleetVirtualService`, without importing this module.
 */
@Global()
@Module({
    imports: [FleetVirtualModule, FleetModule, DatabaseModule],
    controllers: [FleetVirtualController, FleetVirtualNodeController],
    providers: [
        FleetVirtualReconcileCronService,
        DistributedTaskLockService,
        // Guards are ordinary providers so Nest can inject them.
        FleetEnabledGuard,
        FleetVirtualEnabledGuard,
        FleetNodeAuthGuard,
    ],
    exports: [FleetVirtualModule],
})
export class FleetVirtualApiModule {}
