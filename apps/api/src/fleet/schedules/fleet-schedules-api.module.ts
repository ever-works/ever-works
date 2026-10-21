import { Global, Module } from '@nestjs/common';
import { DistributedTaskLockService } from '@ever-works/agent/cache';
import { DatabaseModule } from '@ever-works/agent/database';
import {
    FLEET_SCHEDULE_NODE_PORT,
    FLEET_SCHEDULE_TASKS_PORT,
    FleetScheduleService,
    FleetSchedulesModule,
    FleetSessionsModule,
} from '@ever-works/agent/fleet';
import { TASK_SESSION_SCHEDULE_DISPATCHER, TasksDomainModule } from '@ever-works/agent/tasks-domain';
import { NODE_SCHEDULE_PORT } from '@ever-works/agent/schedules';
import { FleetScheduleLinkAdapter, FleetScheduleLinkListener } from './fleet-schedule-link.adapter';
import { FleetScheduleReconcileCronService } from './fleet-schedule-reconcile-cron.service';
import { FleetScheduleTasksAdapter, FleetSessionScheduleDispatcher } from './fleet-session-schedule.adapters';
import { FleetNodeSchedulesController, FleetSchedulesController } from './fleet-schedules.controller';
import { FleetEnabledGuard } from '../guards/fleet-enabled.guard';
import { FleetCommandsEnabledGuard } from '../commands/fleet-commands-enabled.guard';

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
    // P2: Agent-session schedules file a recurring Task (TasksDomainModule) and
    // start each fire as an Agent session (FleetSessionsModule).
    imports: [FleetSchedulesModule, FleetSessionsModule, TasksDomainModule, DatabaseModule],
    // P2: the resource routes the FL-19 catalogue names, and the breaker.
    controllers: [FleetSchedulesController, FleetNodeSchedulesController],
    providers: [
        // Guards are ordinary providers so Nest can inject them.
        FleetEnabledGuard,
        FleetCommandsEnabledGuard,
        FleetScheduleLinkAdapter,
        { provide: FLEET_SCHEDULE_NODE_PORT, useExisting: FleetScheduleLinkAdapter },
        { provide: NODE_SCHEDULE_PORT, useExisting: FleetScheduleService },
        FleetScheduleLinkListener,
        FleetScheduleReconcileCronService,
        DistributedTaskLockService,
        // P2: an Agent-session schedule's Task, and how each of its fires starts.
        FleetScheduleTasksAdapter,
        { provide: FLEET_SCHEDULE_TASKS_PORT, useExisting: FleetScheduleTasksAdapter },
        FleetSessionScheduleDispatcher,
        { provide: TASK_SESSION_SCHEDULE_DISPATCHER, useExisting: FleetSessionScheduleDispatcher },
    ],
    exports: [
        FLEET_SCHEDULE_NODE_PORT,
        NODE_SCHEDULE_PORT,
        FLEET_SCHEDULE_TASKS_PORT,
        TASK_SESSION_SCHEDULE_DISPATCHER,
        FleetSchedulesModule,
    ],
})
export class FleetSchedulesApiModule {}
