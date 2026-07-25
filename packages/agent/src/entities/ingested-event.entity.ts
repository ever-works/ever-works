import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Event-ingest spine (Wave 6) — one normalized external event, landed.
 *
 * Rows are written by `EventIngestService.ingest()` from
 * `IngestedEventEnvelope`s (pull-model event-source plugins, the
 * `POST /api/ingest/events` push surface, and later per-connector
 * webhooks + backfill) and drained by `processBatch()` into the
 * Activity log + agent Memory, each carrying `sourceUrl` provenance
 * back to the origin.
 *
 * Dedupe: `dedupeKey` is a sha256 over `(userId, source,
 * sourceEventId)` — the envelope identity `(source, sourceEventId)`
 * scoped per owner so one user's delivery can never swallow (or leak)
 * another user's row. UNIQUE index makes re-delivery a no-op.
 *
 * Scope columns are raw uuid references (no @ManyToOne) per the EW-654
 * cycle-avoidance rule; FKs live in the migration
 * (`1783200000000-CreateIngestedEvents`).
 *
 * NOTE: also registered in `database/_entities-inventory.ts` — this
 * repo has no `autoLoadEntities`, a forFeature'd-but-unregistered
 * entity throws EntityMetadataNotFoundError on first query.
 */
@Entity({ name: 'ingested_events' })
@Index('idx_ingested_events_dedupe', ['dedupeKey'], { unique: true })
@Index('idx_ingested_events_user_created', ['userId', 'createdAt'])
@Index('idx_ingested_events_unprocessed', ['processedAt'])
export class IngestedEvent {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /** Owner the event was ingested for (scopes reads + processing). */
    @Column({ type: 'uuid' })
    userId: string;

    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    /** Work the connector routed the event to, when known. */
    @Column({ type: 'uuid', nullable: true })
    workId?: string | null;

    /** Producing plugin id, e.g. `slack-connector`. */
    @Column({ type: 'varchar', length: 100 })
    source: string;

    /** The event's stable id in the source system. */
    @Column({ type: 'varchar', length: 200 })
    sourceEventId: string;

    /** Source-namespaced kind, e.g. `slack.message`. */
    @Column({ type: 'varchar', length: 100 })
    kind: string;

    /** When the event happened at the source. */
    @Column({ type: 'timestamp' })
    occurredAt: Date;

    @Column({ type: 'varchar', length: 200, nullable: true })
    actorName?: string | null;

    @Column({ type: 'varchar', length: 100, nullable: true })
    subjectType?: string | null;

    @Column({ type: 'varchar', length: 200, nullable: true })
    subjectExternalId?: string | null;

    @Column({ type: 'varchar', length: 500, nullable: true })
    title?: string | null;

    /** Deep link back to the original message / PR / page / commit. */
    @Column({ type: 'varchar', length: 2048, nullable: true })
    sourceUrl?: string | null;

    /** Source-specific details (serialized ≤ 32 KB, capped upstream). */
    @Column({ type: 'simple-json' })
    payload: Record<string, unknown>;

    /** Set when the processor fan-out (Activity + Memory) has run. */
    @Column({ type: 'timestamp', nullable: true })
    processedAt?: Date | null;

    /** sha256 hex over (userId, source, sourceEventId). */
    @Column({ type: 'varchar', length: 64 })
    dedupeKey: string;

    @CreateDateColumn()
    createdAt: Date;
}
