import { Global, Module } from '@nestjs/common';
import { FLEET_LOGS_READER, FleetModule as AgentFleetModule } from '@ever-works/agent/fleet';
import { FleetEnabledGuard } from '../guards/fleet-enabled.guard';
import { FleetMachineFactsEnabledGuard } from '../machine/fleet-machine-facts-enabled.guard';
import { FleetLogsController } from './fleet-logs.controller';
import { FleetLogsService } from './fleet-logs.service';

/**
 * Logs on computers (FL-08) — the API half:
 *
 *   - `FleetLogsController` — `/api/fleet/nodes/:id/logs/{sources,attach-token,read}`
 *     (dark unless `FLEET_MACHINE_FACTS_ENABLED`);
 *   - `FleetLogsService` — the `logs.sources` request, the viewer token, the
 *     one-shot read, the `logs` family's viewer observer (the 8-channel cap
 *     and the audit counts) — and, under {@link FLEET_LOGS_READER}, the port
 *     the Agent log tools read through (FL-19 assembles them).
 *
 * `FleetLinkService`, `FleetLinkAttachService` and
 * `FleetLinkViewerGatewayService` come from the global `FleetLinkApiModule`;
 * `FleetService`, `FleetNodeRepository` and `FleetAuditService` from the
 * agent-side `FleetModule`.
 */
// FL-19: `@Global()` so the api-side `AgentsModule` reaches `FLEET_LOGS_READER` and binds the
// Agent log tools (`fleet_logs_sources`, `fleet_logs_read`) without importing this module.
@Global()
@Module({
    imports: [AgentFleetModule],
    controllers: [FleetLogsController],
    providers: [
        FleetLogsService,
        { provide: FLEET_LOGS_READER, useExisting: FleetLogsService },
        // Guards are ordinary providers so Nest can inject them.
        FleetEnabledGuard,
        FleetMachineFactsEnabledGuard,
    ],
    exports: [FleetLogsService, FLEET_LOGS_READER],
})
export class FleetLogsApiModule {}
