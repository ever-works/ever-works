import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FleetPortTunnel } from '../../entities/fleet-port-tunnel.entity';
import { FleetModule } from '../fleet.module';
import { FleetPortTunnelRepository } from './fleet-port-tunnel.repository';
import { FleetPortTunnelService } from './fleet-port-tunnel.service';
import { FleetPortsService } from './fleet-ports.service';

/**
 * Servers and ports (FL-10) — the agent-side module: `FleetPortsService`
 * (list, open — P1) and, for phase 2, the preview tunnel's repository and
 * `FleetPortTunnelService` (the one writer of `fleet_port_tunnels`). The node
 * transports are the `FLEET_PORTS_NODE_PORT` and `FLEET_PORT_TUNNEL_LINK_PORT`
 * the API binds (`@Optional()`: without them every machine reads unreachable).
 *
 * `FleetPortTunnel` is also registered in `database/_entities-inventory.ts` —
 * this repo has no `autoLoadEntities`.
 */
@Module({
    imports: [FleetModule, TypeOrmModule.forFeature([FleetPortTunnel])],
    providers: [FleetPortsService, FleetPortTunnelRepository, FleetPortTunnelService],
    exports: [FleetPortsService, FleetPortTunnelRepository, FleetPortTunnelService],
})
export class FleetPortsModule {}
