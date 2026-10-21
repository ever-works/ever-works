import { Global, Module } from '@nestjs/common';
import { FLEET_PORTS_NODE_PORT, FleetPortsModule } from '@ever-works/agent/fleet';
import { FleetEnabledGuard } from '../guards/fleet-enabled.guard';
import { FleetMachineFactsEnabledGuard } from '../machine/fleet-machine-facts-enabled.guard';
import { FleetPortsController } from './fleet-ports.controller';
import { FleetPortsLinkAdapter } from './fleet-ports-link.adapter';

/**
 * Servers and ports (FL-10) — the API half:
 *
 *   - `FleetPortsController` — `/api/fleet/nodes/:id/ports`,
 *     `/api/fleet/nodes/:id/ports/:port/open` (dark unless
 *     `FLEET_MACHINE_FACTS_ENABLED`);
 *   - `FleetPortsLinkAdapter` — binds the agent package's
 *     `FLEET_PORTS_NODE_PORT` to the node link (FL-02) and FL-02's viewer
 *     minter for the preview picture.
 *
 * `@Global()` for the reason `FleetSessionsApiModule` documents: the
 * agent-side `FleetPortsService` consumes `FLEET_PORTS_NODE_PORT`
 * `@Optional()` and must not import the API, and the agent tool sources reach
 * `FleetPortsService` (re-exported with `FleetPortsModule`) without importing
 * this module. The adapter needs `FleetLinkService` and
 * `FleetLinkAttachService`, which the global `FleetLinkApiModule` exports.
 */
@Global()
@Module({
    imports: [FleetPortsModule],
    controllers: [FleetPortsController],
    providers: [
        FleetPortsLinkAdapter,
        { provide: FLEET_PORTS_NODE_PORT, useExisting: FleetPortsLinkAdapter },
        FleetEnabledGuard,
        FleetMachineFactsEnabledGuard,
    ],
    exports: [FLEET_PORTS_NODE_PORT, FleetPortsModule],
})
export class FleetPortsApiModule {}
