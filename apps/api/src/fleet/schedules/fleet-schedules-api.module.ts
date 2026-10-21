import { Global, Module } from '@nestjs/common';
import { DistributedTaskLockService } from '@ever-works/agent/cache';
import { DatabaseModule } from '@ever-works/agent/database';
import {
    FLEET_SCHEDULE_NODE_PORT,
    FleetScheduleService,
    FleetSchedulesModule,
} from '@ever-works/agent/fleet';
import { NODE_SCHEDULE_PORT } from '@ever-works/agent/schedules';
import { FleetScheduleLinkAdapter, FleetScheduleLinkListener } from './fleet-schedule-link.adapter';
import { FleetScheduleReconcileCronService } from './fleet-schedule-reconcile-cron.service';

/**
 * Schedules on computers (FL-13) — the API half:
 *
 *   - `FleetScheduleLinkAdapter` — binds the agent package's
 *     `FLEET_SCHEDULE_NODE_PORT` to the node link (FL-02): one short-lived
 *     `schedule` channel per request;
 *   - `NODE_SCHEDULE_PORT` → `FleetScheduleService` — the unified Schedules
 *     view's `node_schedule` source and its Run now / Pause / Resume;
 *   - `FleetScheduleLinkListener` — a link that opens gets its set and is
 *     asked for its runs;
 *   - `FleetScheduleReconcileCronService` — the five-minute pass.
 *
 * The routes are FL-12's (`/api/fleet/commands` with a cadence, `PATCH` /
 * `DELETE /commands/:id`, `/commands/:id/runs`): `FleetCommandsController`
 * reaches `FleetScheduleService` through this module's global export.
 *
 * `@Global()` for the reason `FleetSessionsApiModule` documents: the
 * agent-side modules consume both tokens `@Optional()` and must not import
 * the API. The adapter needs `FleetLinkService` and the listener
 * `FleetLinkRegistry`, both exported by the global `FleetLinkApiModule`;
 * nothing they inject needs the schedule service back, so there is no cycle.
 */
@Global()
@Module({
    imports: [FleetSchedulesModule, DatabaseModule],
    providers: [
        FleetScheduleLinkAdapter,
        { provide: FLEET_SCHEDULE_NODE_PORT, useExisting: FleetScheduleLinkAdapter },
        { provide: NODE_SCHEDULE_PORT, useExisting: FleetScheduleService },
        FleetScheduleLinkListener,
        FleetScheduleReconcileCronService,
        DistributedTaskLockService,
    ],
    exports: [FLEET_SCHEDULE_NODE_PORT, NODE_SCHEDULE_PORT, FleetSchedulesModule],
})
export class FleetSchedulesApiModule {}
