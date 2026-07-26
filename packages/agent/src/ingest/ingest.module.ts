import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IngestedEvent } from '../entities/ingested-event.entity';
import { IngestCursor } from '../entities/ingest-cursor.entity';
import { Work } from '../entities/work.entity';
import { IngestInstallBinding } from '../entities/ingest-install-binding.entity';
import { ActivityLogModule } from '../activity-log/activity-log.module';
import { FacadesModule } from '../facades/facades.module';
import { WorkRepository } from '../database/repositories/work.repository';
import { IngestedEventRepository } from './ingested-event.repository';
import { EventIngestService } from './event-ingest.service';
import { IngestCursorRepository } from './ingest-cursor.repository';
import { EventSourcePullService } from './event-source-pull.service';
import { WorkHintResolverService } from './work-hint-resolver.service';
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
        // `Work` backs the `workHint` → `workId` resolver. It MUST also
        // be present in the DataSource ENTITIES array (it already is) —
        // a forFeature'd-but-unregistered entity throws
        // EntityMetadataNotFoundError on first query.
        TypeOrmModule.forFeature([IngestedEvent, IngestCursor, Work]),
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
        WorkRepository,
        WorkHintResolverService,
        IngestInstallBindingRepository,
    ],
    exports: [
        IngestedEventRepository,
        EventIngestService,
        IngestCursorRepository,
        EventSourcePullService,
        WorkRepository,
        WorkHintResolverService,
        IngestInstallBindingRepository,
    ],
})
export class EventIngestModule {}
