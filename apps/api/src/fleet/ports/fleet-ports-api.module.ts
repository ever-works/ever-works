import { Global, Module } from '@nestjs/common';
import { DistributedTaskLockService } from '@ever-works/agent/cache';
import { DatabaseModule } from '@ever-works/agent/database';
import {
    FLEET_PORT_TUNNEL_LINK_PORT,
    FLEET_PORTS_NODE_PORT,
    FleetModule,
    FleetPortsModule,
} from '@ever-works/agent/fleet';
import { FleetEnabledGuard } from '../guards/fleet-enabled.guard';
import { FleetMachineFactsEnabledGuard } from '../machine/fleet-machine-facts-enabled.guard';
import { FleetPortTunnelBridge } from './fleet-port-tunnel.bridge';
import { FleetPortTunnelEnabledGuard } from './fleet-port-tunnel-enabled.guard';
import { FleetPortTunnelSweepCronService } from './fleet-port-tunnel-sweep-cron.service';
import { FleetPortTunnelTokens } from './fleet-port-tunnel-tokens';
import { FleetPortTunnelsController } from './fleet-port-tunnels.controller';
import { FleetPortsController } from './fleet-ports.controller';
import { FleetPortsLinkAdapter } from './fleet-ports-link.adapter';
import { FleetPreviewHostHandler } from './preview-host.handler';

/**
 * Servers and ports (FL-10) — the API half:
 *
 *   - `FleetPortsController` — `/api/fleet/nodes/:id/ports`,
 *     `/api/fleet/nodes/:id/ports/:port/open` (dark unless
 *     `FLEET_MACHINE_FACTS_ENABLED`);
 *   - `FleetPortsLinkAdapter` — binds the agent package's
 *     `FLEET_PORTS_NODE_PORT` to the node link (FL-02) and FL-02's viewer
 *     minter for the preview picture;
 *   - phase 2 (dark unless `FLEET_PORT_TUNNEL_ENABLED` and `FLEET_PREVIEW_HOST`):
 *     `FleetPortTunnelsController` (`/api/fleet/nodes/:id/ports/:port/preview`),
 *     `FleetPortTunnelBridge` (binds `FLEET_PORT_TUNNEL_LINK_PORT`; each
 *     replica's `tunnel` channels), `FleetPreviewHostHandler` (the preview host,
 *     mounted by `main.ts` before the router), `FleetPortTunnelTokens` (the
 *     hand-off and the tunnel cookie) and the sweeper cron.
 *
 * `@Global()` for the reason `FleetSessionsApiModule` documents: the
 * agent-side services consume the two ports `@Optional()` and must not import
 * the API, and the agent tool sources reach `FleetPortsService` /
 * `FleetPortTunnelService` (re-exported with `FleetPortsModule`) without
 * importing this module. The adapter and the bridge need `FleetLinkService`
 * (+ `FleetLinkAttachService`, `FleetOperationsService`), which the global
 * `FleetLinkApiModule` exports.
 */
@Global()
@Module({
    imports: [FleetModule, FleetPortsModule, DatabaseModule],
    controllers: [FleetPortsController, FleetPortTunnelsController],
    providers: [
        FleetPortsLinkAdapter,
        { provide: FLEET_PORTS_NODE_PORT, useExisting: FleetPortsLinkAdapter },
        FleetPortTunnelBridge,
        { provide: FLEET_PORT_TUNNEL_LINK_PORT, useExisting: FleetPortTunnelBridge },
        FleetPortTunnelTokens,
        FleetPreviewHostHandler,
        FleetPortTunnelSweepCronService,
        DistributedTaskLockService,
        FleetEnabledGuard,
        FleetMachineFactsEnabledGuard,
        FleetPortTunnelEnabledGuard,
    ],
    exports: [FLEET_PORTS_NODE_PORT, FLEET_PORT_TUNNEL_LINK_PORT, FleetPortsModule, FleetPreviewHostHandler],
})
export class FleetPortsApiModule {}
