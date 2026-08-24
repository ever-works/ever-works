import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { PortableDateColumn } from './_types';

/**
 * Pay-as-you-go meter events (billing spec §3.5, FR-18) — the platform's
 * own record of every credit reported to the Stripe Billing Meter.
 *
 * One row per run whose cost overflowed the prepaid balance while the
 * owner had pay-as-you-go enabled. The row is written FIRST, in the same
 * settlement pass as the ledger debit; the Stripe meter event is sent
 * second and can fail — `status` tracks that, and the
 * `credits-meter-flush` cron retries `pending` rows. Failed rows require
 * manual reconciliation. Stripe is
 * the billing source of truth (it rates and invoices the meter); this
 * table is what lets the platform enforce the monthly cap in real time,
 * show "this cycle" usage on the Billing page, and reconcile.
 *
 * `identifier` doubles as our idempotency key and Stripe's meter-event
 * `identifier` (`run:{runId}`), so a retried settlement and a retried
 * send both collapse to one event.
 *
 * Scope columns are raw uuid references (no @ManyToOne) per the EW-654
 * cycle-avoidance rule; the userId FK lives in the migration.
 *
 * NOTE: also registered in `database/_entities-inventory.ts`.
 */
export enum CreditMeterEventStatus {
    /** Row written; the Stripe meter event has not been accepted yet. */
    PENDING = 'pending',
    /** Stripe accepted the meter event. */
    SENT = 'sent',
    /** Gave up (older than Stripe's backdating window, or a terminal provider error). */
    FAILED = 'failed',
}

@Entity({ name: 'credit_meter_events' })
@Index('idx_credit_meter_events_identifier', ['identifier'], { unique: true })
@Index('idx_credit_meter_events_user_period', ['userId', 'periodStart'])
@Index('idx_credit_meter_events_status_created', ['status', 'createdAt'])
export class CreditMeterEvent {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /** Owner whose pay-as-you-go subscription this usage is billed to. */
    @Column({ type: 'uuid' })
    userId: string;

    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    tenantId?: string | null;

    /** The run whose cost overflowed the prepaid balance. */
    @Column({ type: 'uuid' })
    runId: string;

    /** `run:{runId}` — our idempotency key AND Stripe's meter-event identifier. */
    @Column({ type: 'varchar', length: 128 })
    identifier: string;

    /** Credits reported to the meter (≤ the remainder after the prepaid debit, ≤ cap headroom). */
    @Column({ type: 'int' })
    credits: number;

    /** Part of the remainder beyond the cap that was NOT billed (the platform absorbs it). */
    @Column({ type: 'int', default: 0 })
    writtenOffCredits: number;

    /** Metered provider cost the remainder derives from, for reconciliation. */
    @Column({ type: 'int', nullable: true })
    costCentsRef?: number | null;

    /** The PAYG cycle (Stripe period) the event belongs to, as known at write time. */
    @PortableDateColumn()
    periodStart: Date;

    @PortableDateColumn()
    periodEnd: Date;

    @Column({ type: 'varchar', length: 16, default: CreditMeterEventStatus.PENDING })
    status: CreditMeterEventStatus;

    @Column({ type: 'int', default: 0 })
    attempts: number;

    /** Short provider error code/message — never the full object. */
    @Column({ type: 'varchar', length: 256, nullable: true })
    lastError?: string | null;

    @PortableDateColumn({ nullable: true })
    sentAt?: Date | null;

    @CreateDateColumn()
    createdAt: Date;
}
