import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IngestedEvent } from '../entities/ingested-event.entity';
import { ActivityLogModule } from '../activity-log/activity-log.module';
import { FacadesModule } from '../facades/facades.module';
import { IngestedEventRepository } from './ingested-event.repository';
import { EventIngestService } from './event-ingest.service';

/**
 * Event-ingest spine (Wave 6) — agent-side module owning the
 * `ingested_events` surface: dedupe-insert (`ingest`) + the processor
 * fan-out to Activity log and agent Memory (`processBatch`, driven by
 * the `event-ingest-tick` cron over the trigger-internal RPC channel).
 *
 * `IngestedEvent` MUST also stay registered in the DataSource ENTITIES
 * array (`database/_entities-inventory.ts`) — this repo has no
 * `autoLoadEntities`, so a forFeature'd-but-unregistered entity throws
 * EntityMetadataNotFoundError on first query.
 */
@Module({
    imports: [
        TypeOrmModule.forFeature([IngestedEvent]),
        // Processor 1 — Activity-log rows with sourceUrl provenance.
        ActivityLogModule,
        // Processor 2 — best-effort Memory observations via
        // AgentMemoryFacadeService (exported by FacadesModule).
        FacadesModule,
    ],
    providers: [IngestedEventRepository, EventIngestService],
    exports: [IngestedEventRepository, EventIngestService],
})
export class EventIngestModule {}
