import { Module } from '@nestjs/common';
import { MeetingsModule as AgentMeetingsModule } from '@ever-works/agent/meetings';
import { MeetingsController } from './meetings.controller';

/**
 * Meetings v1 (Wave 8, feature a) — thin API module exposing the
 * `/api/meetings` CRUD + transcript surface over the agent-side
 * `MeetingsModule` (entity, repository, transcript pipeline and the
 * `zoom.recording` envelope→Meeting processor all live there).
 *
 * Importing the agent module here (in the API process) is also what
 * boots `MeetingsService.onModuleInit`, which registers the
 * recordings processor on the SINGLETON `EventIngestService` — the
 * same instance the `event-ingest-tick` cron drains over the
 * trigger-internal RPC channel, so pulled recordings become Meeting
 * rows with zero extra cron wiring.
 */
@Module({
    imports: [AgentMeetingsModule],
    controllers: [MeetingsController],
    exports: [AgentMeetingsModule],
})
export class MeetingsApiModule {}
