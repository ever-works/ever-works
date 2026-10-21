import { Module } from '@nestjs/common';
import { FLEET_FILES_READER, FleetModule as AgentFleetModule } from '@ever-works/agent/fleet';
import { FleetEnabledGuard } from '../guards/fleet-enabled.guard';
import { FleetMachineFactsEnabledGuard } from '../machine/fleet-machine-facts-enabled.guard';
import { FleetFilesTransferService } from './fleet-files-transfer.service';
import { FleetFilesController } from './fleet-files.controller';
import { FleetFilesService } from './fleet-files.service';

/**
 * Files on computers (FL-11) — the API half:
 *
 *   - `FleetFilesController` — `/api/fleet/nodes/:id/files/*` (dark unless
 *     `FLEET_MACHINE_FACTS_ENABLED`);
 *   - `FleetFilesService` — roots, list, stat, conflicts, delete, the list
 *     audit — and, under {@link FLEET_FILES_READER}, the port the Agent file
 *     tools read through (FL-19 assembles them);
 *   - `FleetFilesTransferService` — download (raw or zip), upload, the
 *     transfers the Operations strip reads, cancel.
 *
 * `FleetLinkService` and `FleetOperationsService` come from the global
 * `FleetLinkApiModule`; `FleetService`, `FleetNodeRepository` and
 * `FleetAuditService` from the agent-side `FleetModule`.
 */
@Module({
    imports: [AgentFleetModule],
    controllers: [FleetFilesController],
    providers: [
        FleetFilesService,
        FleetFilesTransferService,
        { provide: FLEET_FILES_READER, useExisting: FleetFilesService },
        // Guards are ordinary providers so Nest can inject them.
        FleetEnabledGuard,
        FleetMachineFactsEnabledGuard,
    ],
    exports: [FleetFilesService, FleetFilesTransferService, FLEET_FILES_READER],
})
export class FleetFilesApiModule {}
