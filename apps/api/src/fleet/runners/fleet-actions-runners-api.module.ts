import { Global, Module } from '@nestjs/common';
import { DistributedTaskLockService } from '@ever-works/agent/cache';
import { DatabaseModule } from '@ever-works/agent/database';
import { FleetActionsRunnersModule, FleetModule } from '@ever-works/agent/fleet';
import { FleetEnabledGuard } from '../guards/fleet-enabled.guard';
import { FleetNodeAuthGuard } from '../guards/fleet-node-auth.guard';
import { FleetActionsRunnersController } from './fleet-actions-runners.controller';
import { FleetActionsRunnersEnabledGuard } from './fleet-actions-runners-enabled.guard';
import { FleetActionsRunnersNodeController } from './fleet-actions-runners-node.controller';
import { FleetActionsRunnersPollCronService } from './fleet-actions-runners-poll-cron.service';

/**
 * Actions runners on computers (FL-18) — the API half: the owner-facing routes
 * under `/api/fleet/nodes/:id/runners` and `/api/fleet/runners`, the
 * node-facing `/api/internal/fleet/runners` (token, progress), and the poll
 * fallback cron. Dark unless `FLEET_ACTIONS_RUNNERS_ENABLED`.
 *
 * The agent-side `FleetActionsRunnersService` reads the machine through the
 * global `FLEET_MACHINE_NODE_PORT` binding `FleetMachineApiModule` provides
 * (`runner.list`); nothing here needs it directly.
 *
 * `@Global()` for the reason `FleetVirtualApiModule` is: the internal trigger
 * controller resolves `FleetActionsRunnersPollService` `@Optional()` for the
 * worker's `fleet-runners-poll` RPC, and the Agent tools resolve
 * `FleetActionsRunnersService`, without importing this module.
 */
@Global()
@Module({
    imports: [FleetActionsRunnersModule, FleetModule, DatabaseModule],
    controllers: [FleetActionsRunnersController, FleetActionsRunnersNodeController],
    providers: [
        FleetActionsRunnersPollCronService,
        DistributedTaskLockService,
        // Guards are ordinary providers so Nest can inject them.
        FleetEnabledGuard,
        FleetActionsRunnersEnabledGuard,
        FleetNodeAuthGuard,
    ],
    exports: [FleetActionsRunnersModule],
})
export class FleetActionsRunnersApiModule {}
