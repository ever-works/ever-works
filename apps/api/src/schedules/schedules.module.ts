import { Module } from '@nestjs/common';
import { SchedulesModule as AgentSchedulesModule } from '@ever-works/agent/schedules';
import { SchedulesController } from './schedules.controller';

/**
 * Schedules ("Cadence") — API module (spec §9).
 *
 * Thin HTTP surface over the agent-side `SchedulesService`. Read-only, so
 * no repositories or write providers here. `ScopeContextService` is
 * provided globally by `ScopeModule`, so it needs no import.
 */
@Module({
    imports: [AgentSchedulesModule],
    controllers: [SchedulesController],
})
export class SchedulesModule {}
