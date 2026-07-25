import { Module } from '@nestjs/common';
import { EventIngestModule } from '@ever-works/agent/ingest';
import { IngestController } from './ingest.controller';

/**
 * Event-ingest spine (Wave 6) — thin API module exposing
 * `POST /api/ingest/events` over the agent-side `EventIngestModule`
 * (dedupe-insert + processor fan-out live there).
 */
@Module({
    imports: [EventIngestModule],
    controllers: [IngestController],
    exports: [EventIngestModule],
})
export class IngestModule {}
