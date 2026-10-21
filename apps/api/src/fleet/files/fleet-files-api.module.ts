import { Module } from '@nestjs/common';
import { ComputerModule as AgentComputerModule } from '@ever-works/agent/computer';
import { FLEET_FILES_READER, FleetModule as AgentFleetModule } from '@ever-works/agent/fleet';
import { FleetEnabledGuard } from '../guards/fleet-enabled.guard';
import { FleetMachineFactsEnabledGuard } from '../machine/fleet-machine-facts-enabled.guard';
import { FleetClipController } from './fleet-clip.controller';
import { FleetClipService } from './fleet-clip.service';
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
 *   - `FleetFilesTransferService` — download (raw or zip), upload, copy
 *     between computers (P2), the transfers the Operations strip reads, cancel;
 *   - `FleetClipController` / `FleetClipService` (P2) — paste into a live view
 *     (`/api/fleet/nodes/:id/desktop/paste`, the per-view switch).
 *
 * `FleetLinkService` and `FleetOperationsService` come from the global
 * `FleetLinkApiModule`; `FleetService`, `FleetNodeRepository` and
 * `FleetAuditService` from the agent-side `FleetModule`.
 */
@Module({
    // The control arbiter (who holds control of a live view) for paste (P2).
    imports: [AgentFleetModule, AgentComputerModule],
    controllers: [FleetFilesController, FleetClipController],
    providers: [
        FleetFilesService,
        FleetFilesTransferService,
        FleetClipService,
        { provide: FLEET_FILES_READER, useExisting: FleetFilesService },
        // Guards are ordinary providers so Nest can inject them.
        FleetEnabledGuard,
        FleetMachineFactsEnabledGuard,
    ],
    exports: [FleetFilesService, FleetFilesTransferService, FLEET_FILES_READER],
})
export class FleetFilesApiModule {}
