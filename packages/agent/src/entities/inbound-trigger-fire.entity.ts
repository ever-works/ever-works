import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** How the fire was delivered. */
export type InboundTriggerFireOrigin = 'webhook' | 'event' | 'manual' | 'test';

/**
 * Terminal state of one fire:
 *  - `'running'` — Task created AND dispatched to an agent run.
 *  - `'done'`    — Task created, no run dispatched (no target agent, or
 *                  `autoStart: 'manual'`).
 *  - `'failed'`  — the fire started but Task creation blew up.
 *  - `'refused'` — the fire was rejected before doing anything (missing
 *                  required variable, template mode with no slug); the
 *                  human-readable cause is in `reason`.
 */
export type InboundTriggerFireStatus = 'running' | 'done' | 'failed' | 'refused';

/**
 * One recorded fire of an inbound trigger — BOTH the idempotency ledger
 * of the delivery paths and the "recent fires" log rendered on the
 * trigger detail page.
 *
 * `dedupeKey` is the delivery identity a fire claims, scoped to the
 * trigger by the UNIQUE `(triggerId, dedupeKey)` index:
 *   - event path   → the `ingested_events` row id (permanent claim: the
 *     ingest drain retries batches after partial failures, so the same
 *     event is offered repeatedly and must fire exactly once);
 *   - webhook path → `wh:<delivery id>` (the `x-everworks-delivery`
 *     header when the sender supplies one, else the request signature),
 *     re-claimable once the trigger's `replayWindowSec` has elapsed —
 *     a genuine later re-delivery is a new fire, a retry inside the
 *     window is a duplicate;
 *   - manual/test  → a random key, so a rehearsal never collides.
 *
 * It is deliberately NOT a FK to `ingested_events`: the ledger must
 * outlive event-row pruning or dedupe silently breaks. Raw uuid
 * reference columns (no @ManyToOne — EW-654 cycle avoidance); the
 * `triggerId` FK (CASCADE) lives in migration
 * `1786600000000-ExtendInboundTriggersForEvents`.
 *
 * NOTE: also registered in `database/_entities-inventory.ts` — this
 * repo has no `autoLoadEntities`; a forFeature'd-but-unregistered
 * entity throws EntityMetadataNotFoundError on first query.
 */
@Entity({ name: 'inbound_trigger_fires' })
@Index('idx_inbound_trigger_fires_dedupe', ['triggerId', 'dedupeKey'], { unique: true })
@Index('idx_inbound_trigger_fires_trigger', ['triggerId'])
export class InboundTriggerFire {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /** Owning trigger (raw uuid — CASCADE FK in the migration). */
    @Column({ type: 'uuid' })
    triggerId: string;

    /** Delivery identity this fire claimed — see the class doc. */
    @Column({ type: 'varchar', length: 120 })
    dedupeKey: string;

    /** Which delivery path produced the fire. */
    @Column({ type: 'varchar', length: 16, default: 'event' })
    origin: InboundTriggerFireOrigin;

    /** Outcome — see {@link InboundTriggerFireStatus}. */
    @Column({ type: 'varchar', length: 16, default: 'running' })
    status: InboundTriggerFireStatus;

    /**
     * Why a `'refused'`/`'failed'` fire did not produce work. Free text
     * built by the service — never carries payload values, so it is safe
     * to render in the UI.
     */
    @Column({ type: 'text', nullable: true })
    reason: string | null;

    /** Task the fire spawned; null while the claim is in flight (or if creation failed). */
    @Column({ type: 'uuid', nullable: true })
    taskId: string | null;

    @CreateDateColumn()
    firedAt: Date;
}
