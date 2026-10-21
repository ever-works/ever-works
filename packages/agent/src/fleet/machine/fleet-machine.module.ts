import { Module } from '@nestjs/common';
import { FleetModule } from '../fleet.module';
import { FleetMachineActionsService } from './fleet-machine-actions.service';

/**
 * Machine actions (FL-09) — the agent-side module of Services, Processes,
 * Docker and Compose: `FleetMachineActionsService`, which every surface (the
 * API controllers, the Agent tools) calls. The node transport is the
 * `FLEET_MACHINE_NODE_PORT` the API binds (`@Optional()`: without it every
 * machine reads `unreachable`). No entity: services, containers and
 * processes are read from the Node and never stored (README §1); the only
 * write is `fleet_audit`, through `FleetModule`'s `FleetAuditService`.
 */
@Module({
    imports: [FleetModule],
    providers: [FleetMachineActionsService],
    exports: [FleetMachineActionsService],
})
export class FleetMachineModule {}
