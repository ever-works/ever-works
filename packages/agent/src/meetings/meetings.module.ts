import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Meeting } from '../entities/meeting.entity';
import { EventIngestModule } from '../ingest/ingest.module';
import { FacadesModule } from '../facades/facades.module';
import { MeetingRepository } from './meeting.repository';
import { MeetingsService } from './meetings.service';

/**
 * Meetings v1 (Wave 8, feature a) — agent-side module owning the
 * `meetings` surface: owner-scoped CRUD, the transcript pipeline
 * (store → best-effort AI summary → best-effort Memory observation →
 * `meeting.transcript` envelope into the ingest spine, whose drain
 * writes the Activity entry), and the `zoom.recording`
 * envelope→Meeting kind processor `MeetingsService` registers on the
 * spine at boot.
 *
 * `Meeting` MUST also stay registered in the DataSource ENTITIES array
 * (`database/_entities-inventory.ts`) — this repo has no
 * `autoLoadEntities`, so a forFeature'd-but-unregistered entity throws
 * EntityMetadataNotFoundError on first query.
 */
@Module({
    imports: [
        TypeOrmModule.forFeature([Meeting]),
        // EventIngestService — transcript envelopes + the kind-processor
        // registration hook the recordings processor rides.
        EventIngestModule,
        // AiFacadeService (best-effort summaries) +
        // AgentMemoryFacadeService (best-effort observations).
        FacadesModule,
    ],
    providers: [MeetingRepository, MeetingsService],
    exports: [MeetingRepository, MeetingsService],
})
export class MeetingsModule {}
