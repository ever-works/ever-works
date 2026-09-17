import { Module } from '@nestjs/common';
import { ActivityLogModule } from '../activity-log/activity-log.module';
import { AgentsModule } from '../agents/agents.module';
import { MissionsModule } from '../missions/missions.module';
import { TasksDomainModule } from '../tasks-domain/tasks.module';
import { InboundTriggersModule } from '../triggers/inbound-triggers.module';
import { ScheduleControlService } from './schedule-control.service';
import { ScheduleHealthService } from './schedule-health.service';
import { SchedulesModule } from './schedules.module';

/**
 * Schedules workspace — the controls half.
 *
 * Kept apart from the read-only `SchedulesModule` so that importing the
 * projection (Home, the Activity tab) never drags the Task, Agent, Mission
 * and Trigger domain graphs in with it. The control service writes nothing
 * itself; it delegates to the services these modules export. The heartbeat
 * run-now binding (`AGENT_HEARTBEAT_TRIGGER`) is provided by the API's
 * global Agents module and injected @Optional().
 */
@Module({
    imports: [
        SchedulesModule,
        TasksDomainModule,
        AgentsModule,
        MissionsModule,
        InboundTriggersModule,
        ActivityLogModule,
    ],
    providers: [ScheduleControlService, ScheduleHealthService],
    exports: [ScheduleControlService, ScheduleHealthService],
})
export class ScheduleControlsModule {}
