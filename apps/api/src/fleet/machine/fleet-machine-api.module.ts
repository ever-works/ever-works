import { Global, Module } from '@nestjs/common';
import { FLEET_MACHINE_NODE_PORT, FleetMachineModule, FleetModule } from '@ever-works/agent/fleet';
import { FleetEnabledGuard } from '../guards/fleet-enabled.guard';
import { FleetDockerController } from './fleet-docker.controller';
import { FleetMachineFactsEnabledGuard } from './fleet-machine-facts-enabled.guard';
import { FleetMachineLinkAdapter } from './fleet-machine-link.adapter';
import { FleetProcessesController } from './fleet-processes.controller';
import { FleetServicesController } from './fleet-services.controller';

/**
 * Machine actions (FL-09) — the API half of Services and Processes (P1),
 * Docker (P2) and Compose (P3):
 *
 *   - the controllers under `/api/fleet/nodes/:id/{services,processes,docker}` (dark
 *     unless `FLEET_MACHINE_FACTS_ENABLED`);
 *   - `FleetMachineLinkAdapter` — binds the agent package's
 *     `FLEET_MACHINE_NODE_PORT` to the node link (FL-02).
 *
 * `@Global()` for the reason `FleetSessionsApiModule` documents: the
 * agent-side `FleetMachineActionsService` consumes the port `@Optional()`
 * and must not import the API, so the binding is reached through the global
 * scope (the Agent tools resolve the same service). The adapter needs
 * `FleetLinkService`, which the global `FleetLinkApiModule` exports, and
 * `FleetNodeRepository` from the agent `FleetModule`; nothing it injects
 * needs this module back.
 */
@Global()
@Module({
    imports: [FleetMachineModule, FleetModule],
    controllers: [FleetServicesController, FleetProcessesController, FleetDockerController],
    providers: [
        FleetMachineLinkAdapter,
        { provide: FLEET_MACHINE_NODE_PORT, useExisting: FleetMachineLinkAdapter },
        // Guards are ordinary providers so Nest can inject them.
        FleetEnabledGuard,
        FleetMachineFactsEnabledGuard,
    ],
    exports: [FLEET_MACHINE_NODE_PORT, FleetMachineModule],
})
export class FleetMachineApiModule {}
