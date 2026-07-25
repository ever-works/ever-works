import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IngestedEvent } from '../entities/ingested-event.entity';
import { IngestCursor } from '../entities/ingest-cursor.entity';
import { IngestInstallBinding } from '../entities/ingest-install-binding.entity';
import { ActivityLogModule } from '../activity-log/activity-log.module';
import { FacadesModule } from '../facades/facades.module';
import { IngestedEventRepository } from './ingested-event.repository';
import { EventIngestService } from './event-ingest.service';
import { IngestCursorRepository } from './ingest-cursor.repository';
import { EventSourcePullService } from './event-source-pull.service';
import { IngestInstallBindingRepository } from './ingest-install-binding.repository';

/**
 * Event-ingest spine (Wave 6, pull path Wave 8) — agent-side module
 * owning the `ingested_events` surface: dedupe-insert (`ingest`) + the
 * processor fan-out to Activity log and agent Memory (`processBatch`,
 * driven by the `event-ingest-tick` cron over the trigger-internal RPC
 * channel), plus the PULL half of the same cron
 * (`EventSourcePullService.pullSources()` — iterates enabled
 * event-source plugins per user with persisted `ingest_cursors`
 * watermarks/continuation cursors). The plugin-system services the
 * pull path needs (registry / settings / user-plugin rows) are
 * `@Global` providers in the API process and injected `@Optional()`.
 *
 * Also owns `IngestInstallBindingRepository` — the external
 * workspace/installation → platform user binding the INBOUND receivers
 * (Slack events, GitHub webhooks) resolve deliveries through, so an
 * event is attributed to the account that actually owns the workspace
 * instead of "the oldest enabled install platform-wide".
 *
 * `IngestedEvent` + `IngestCursor` + `IngestInstallBinding` MUST also
 * stay registered in the DataSource ENTITIES array
 * (`database/_entities-inventory.ts`) — this repo has no
 * `autoLoadEntities`, so a forFeature'd-but-unregistered entity throws
 * EntityMetadataNotFoundError on first query.
 */
@Module({
    imports: [
        TypeOrmModule.forFeature([IngestedEvent, IngestCursor, IngestInstallBinding]),
        // Processor 1 — Activity-log rows with sourceUrl provenance.
        ActivityLogModule,
        // Processor 2 — best-effort Memory observations via
        // AgentMemoryFacadeService (exported by FacadesModule).
        FacadesModule,
    ],
    providers: [
        IngestedEventRepository,
        EventIngestService,
        IngestCursorRepository,
        EventSourcePullService,
        IngestInstallBindingRepository,
    ],
    exports: [
        IngestedEventRepository,
        EventIngestService,
        IngestCursorRepository,
        EventSourcePullService,
        IngestInstallBindingRepository,
    ],
})
export class EventIngestModule {}
