import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * One recorded fire of an inbound trigger against a specific event —
 * the idempotency ledger for the ingest-spine firing path.
 *
 * `eventId` is the `ingested_events` row uuid the trigger fired for
 * (varchar, NOT a FK: the event row may be pruned independently, and
 * the ledger must outlive it to keep dedupe working across retries).
 * The UNIQUE `(triggerId, eventId)` index is the guarantee: the ingest
 * drain retries a batch after a partial failure, and a trigger claims
 * each event exactly once no matter how many times it is offered.
 *
 * Raw uuid reference columns (no @ManyToOne — EW-654 cycle avoidance);
 * the `triggerId` FK (CASCADE) lives in migration
 * `1786600000000-ExtendInboundTriggersForEvents`.
 *
 * NOTE: also registered in `database/_entities-inventory.ts` — this
 * repo has no `autoLoadEntities`; a forFeature'd-but-unregistered
 * entity throws EntityMetadataNotFoundError on first query.
 */
@Entity({ name: 'inbound_trigger_fires' })
@Index('idx_inbound_trigger_fires_dedupe', ['triggerId', 'eventId'], { unique: true })
@Index('idx_inbound_trigger_fires_trigger', ['triggerId'])
export class InboundTriggerFire {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /** Owning trigger (raw uuid — CASCADE FK in the migration). */
    @Column({ type: 'uuid' })
    triggerId: string;

    /** `ingested_events.id` the trigger fired for (identity, not a FK). */
    @Column({ type: 'varchar', length: 80 })
    eventId: string;

    /** Task the fire spawned; null while the claim is in flight (or if creation failed). */
    @Column({ type: 'uuid', nullable: true })
    taskId: string | null;

    @CreateDateColumn()
    firedAt: Date;
}
