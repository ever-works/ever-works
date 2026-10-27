import { Global, Module } from '@nestjs/common';
import { DistributedTaskLockService } from '@ever-works/agent/cache';
import {
    ComputerModule as AgentComputerModule,
    DESKTOP_RECORDING_STORAGE,
    DesktopRecordingService,
} from '@ever-works/agent/computer';
import { DatabaseModule } from '@ever-works/agent/database';
import { FLEET_DESKTOP_READER, FleetModule as AgentFleetModule } from '@ever-works/agent/fleet';
import { FleetEnabledGuard } from '../guards/fleet-enabled.guard';
import { FleetDesktopController } from './fleet-desktop.controller';
import { FleetDesktopEnabledGuard } from './fleet-desktop-enabled.guard';
import { FleetDesktopService } from './fleet-desktop.service';
import { FleetDesktopRecordingGcCronService } from './fleet-desktop-recording-gc-cron.service';
import { getActiveStorageBackend } from '../../uploads/storage-backend.factory';

/**
 * Desktop view & control (FL-07) — the API half of the Desktop source:
 *
 *   - `FleetDesktopController` — `/api/fleet/nodes/:id/desktop/{availability,
 *     displays,views,screenshot}` (dark unless `FLEET_DESKTOP_ENABLED`);
 *   - `FleetDesktopService` — the gates, the caps, the views, the audit, and
 *     the viewer gateway's observer for the `desktop` family.
 *
 * Imports (NestJS DI, the boot gate): the agent-side `FleetModule` for
 * `FleetNodeRepository`, `FleetAccessService`, `FleetKillSwitchService` and
 * `FleetAuditService`; the agent-side `ComputerModule` for
 * `ComputerSessionRepository` (the browser views the caps count too).
 * `FleetLinkService`, `FleetLinkAttachService` and
 * `FleetLinkViewerGatewayService` come from the global `FleetLinkApiModule`.
 *
 * `@Global()` for the reason `FleetLogsApiModule` gives: the api-side
 * `AgentsModule` reaches {@link FLEET_DESKTOP_READER} (the Agent's
 * `fleet_desktop_displays` read) without importing this module.
 */
@Global()
@Module({
    imports: [AgentFleetModule, AgentComputerModule, DatabaseModule],
    controllers: [FleetDesktopController],
    providers: [
        FleetDesktopService,
        { provide: FLEET_DESKTOP_READER, useExisting: FleetDesktopService },
        // P2.C — recordings: the writer / reader / sweep (in the agent package, so the
        // `computer-recording-gc` Trigger task can reach it over the internal RPC), the
        // configured storage plugin it writes through, and the sweep when Trigger is not the runtime.
        DesktopRecordingService,
        { provide: DESKTOP_RECORDING_STORAGE, useFactory: () => getActiveStorageBackend() },
        FleetDesktopRecordingGcCronService,
        DistributedTaskLockService,
        // Guards are ordinary providers so Nest can inject them.
        FleetEnabledGuard,
        FleetDesktopEnabledGuard,
    ],
    exports: [FleetDesktopService, FLEET_DESKTOP_READER, DesktopRecordingService],
})
export class FleetDesktopApiModule {}
