import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';

/**
 * Event-ingest spine (Wave 8) — per-(user, plugin) pull state for the
 * `event-ingest-tick` cron's event-source pull path.
 *
 * One row per enabled event-source plugin per user. `watermark` is the
 * completed-sweep high-water mark handed to `pullEvents` as `since`;
 * `cursor` is the plugin's opaque continuation cursor when a sweep ran
 * out of its per-tick page budget mid-flight; `sweepStartedAt` pins
 * when that in-flight sweep began so the watermark can advance to it
 * (not to "now") on completion — nothing that happened during a long
 * sweep is ever skipped. Overlap is safe: the ingest pipeline dedupes
 * on `(source, sourceEventId)`.
 *
 * Scope columns are raw uuid references (no @ManyToOne) per the EW-654
 * cycle-avoidance rule; FKs live in the migration
 * (`1783500000000-CreateIngestCursors`).
 *
 * NOTE: also registered in `database/_entities-inventory.ts` — this
 * repo has no `autoLoadEntities`, a forFeature'd-but-unregistered
 * entity throws EntityMetadataNotFoundError on first query.
 */
@Entity({ name: 'ingest_cursors' })
@Index('idx_ingest_cursors_user_plugin', ['userId', 'pluginId'], { unique: true })
export class IngestCursor {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /** Owner the events are pulled for (scopes settings + envelopes). */
    @Column({ type: 'uuid' })
    userId: string;

    /** Producing event-source plugin id, e.g. `linear-connector`. */
    @Column({ type: 'varchar', length: 100 })
    pluginId: string;

    /** Opaque plugin continuation cursor of an in-flight sweep. */
    @Column({ type: 'text', nullable: true })
    cursor?: string | null;

    /** Completed-sweep high-water mark (passed as `since`). */
    @Column({ type: 'timestamp', nullable: true })
    watermark?: Date | null;

    /** When the in-flight sweep began (null when no sweep is running). */
    @Column({ type: 'timestamp', nullable: true })
    sweepStartedAt?: Date | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
