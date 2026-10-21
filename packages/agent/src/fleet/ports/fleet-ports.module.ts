import { Module } from '@nestjs/common';
import { FleetModule } from '../fleet.module';
import { FleetPortsService } from './fleet-ports.service';

/**
 * Servers and ports (FL-10) — the agent-side module: `FleetPortsService`
 * (list, open). The node transport is the `FLEET_PORTS_NODE_PORT` the API
 * binds (`@Optional()`: without it every machine reads unreachable). Phase 2
 * adds the tunnel row and its service here.
 */
@Module({
    imports: [FleetModule],
    providers: [FleetPortsService],
    exports: [FleetPortsService],
})
export class FleetPortsModule {}
