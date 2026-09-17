import { Module } from '@nestjs/common';
import {
    ScheduleControlsModule,
    SchedulesModule as AgentSchedulesModule,
} from '@ever-works/agent/schedules';
import { SchedulesController } from './schedules.controller';

/**
 * Schedules ("Cadence") — API module (spec §9).
 *
 * Thin HTTP surface over the agent-side `SchedulesService`, plus the
 * Schedules workspace controls (`ScheduleControlsModule`), which delegate
 * every write to the Task, Agent, Mission and inbound-Trigger domain
 * services. `ScopeContextService` is provided globally by `ScopeModule`, so
 * it needs no import.
 */
@Module({
    imports: [AgentSchedulesModule, ScheduleControlsModule],
    controllers: [SchedulesController],
})
export class SchedulesModule {}
