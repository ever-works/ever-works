// Public surface of the event-ingest spine (Wave 6): normalized
// external events landing as `ingested_events` rows and fanning out to
// Activity log + agent Memory, with `sourceUrl` provenance throughout.
export * from './ingest.module';
export * from './event-ingest.service';
export * from './ingested-event.repository';
export * from './event-source-pull.service';
export * from './ingest-cursor.repository';
export * from './work-hint-resolver.service';
export * from './ingest-install-binding.repository';
export * from './agent-ingest-tools';
export { IngestedEvent } from '../entities/ingested-event.entity';
export { IngestCursor } from '../entities/ingest-cursor.entity';
export {
    IngestInstallBinding,
    type IngestInstallProvider,
} from '../entities/ingest-install-binding.entity';
