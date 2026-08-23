import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { PortableDateColumn } from './_types';

/**
 * Credits ledger (pricing Wave 9 M1) — one append-only balance movement.
 *
 * Credits are the platform's usage currency layered on top of the
 * existing `costCents` metering (`plugin_usage_events`): 1 credit = 1
 * cent of platform-billed usage at the default conversion
 * (`CREDITS_PER_DOLLAR`, default 100). Rows are written ONLY through
 * `CreditLedgerRepository.recordAtomic()` so `balanceAfter` is computed
 * inside the same transaction as the insert; the SUM of `amountCredits`
 * per user is the authoritative balance and `balanceAfter` is the
 * point-in-time materialization for ledger display.
 *
 * Idempotency: `idempotencyKey` (UNIQUE, nullable) makes writers safe to
 * re-run — the daily free-grant cron uses `daily:{userId}:{date}`, run
 * consumption uses `run:{runId}`. Re-delivery returns the existing row.
 *
 * Correlation: `refType`/`refId` link a movement back to the thing that
 * caused it (`agent-run`, `generation`, `task`, …) and `costCentsRef`
 * carries the metered cost the debit was derived from, so the ledger
 * and the `plugin_usage_events` pipeline reconcile without ever
 * double-counting.
 *
 * Buckets + expiry (billing spec §3.2, 2026-08): every POSITIVE row is a
 * bucket. `remainingCredits` is the part of it not yet consumed and
 * `expiresAt` (nullable) is when the unconsumed part lapses. Debits are
 * allocated against buckets soonest-expiring first, then non-expiring
 * in creation order, inside the same transaction as the debit — so a
 * user never loses purchased credits to expiry while allowance credits
 * sat unused. The sweep writes an `expiry` row of `-remainingCredits`
 * for every due bucket and zeroes it. The SUM of `amountCredits` stays
 * the ledger balance; the AVAILABLE balance additionally subtracts
 * `remainingCredits` of due-but-not-yet-swept buckets
 * (`CreditLedgerRepository.getBalance`).
 *
 * Scope columns are raw uuid references (no @ManyToOne) per the EW-654
 * cycle-avoidance rule; the userId FK lives in the migration
 * (`1783400000000-CreateCreditsLedgerAndEntitlements`).
 *
 * NOTE: also registered in `database/_entities-inventory.ts` — this
 * repo has no `autoLoadEntities`; a forFeature'd-but-unregistered
 * entity throws EntityMetadataNotFoundError on first query.
 */
export enum CreditLedgerKind {
    /** Top-up / auto-recharge confirmed by the billing provider (+). */
    PURCHASE = 'purchase',
    /** Plan-included or promotional/admin grant (+). */
    GRANT = 'grant',
    /** Small daily free credits granted by the scheduled job (+). */
    DAILY_FREE = 'daily-free',
    /** Debit from metered usage, rolled up per run/task (−). */
    CONSUMPTION = 'consumption',
    /** Admin/platform credit or correction (±). */
    ADJUSTMENT = 'adjustment',
    /** Unconsumed part of an expired bucket — plan allowance month end, promotional grants (−). */
    EXPIRY = 'expiry',
}

/** Ledger kinds that are positive buckets a debit can be allocated against. */
export const CREDIT_BUCKET_KINDS: readonly CreditLedgerKind[] = [
    CreditLedgerKind.PURCHASE,
    CreditLedgerKind.GRANT,
    CreditLedgerKind.DAILY_FREE,
    CreditLedgerKind.ADJUSTMENT,
];

@Entity({ name: 'credit_ledger_entries' })
@Index('idx_credit_ledger_user_created', ['userId', 'createdAt'])
@Index('idx_credit_ledger_user_kind', ['userId', 'kind'])
@Index('idx_credit_ledger_idempotency', ['idempotencyKey'], { unique: true })
@Index('idx_credit_ledger_user_expires', ['userId', 'expiresAt'])
export class CreditLedgerEntry {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /** Owner of the balance this movement applies to. */
    @Column({ type: 'uuid' })
    userId: string;

    // Tenant + Organization scope columns (Tier C denormalization
    // pattern). Raw uuid references — no @ManyToOne, cycle avoidance
    // per the EW-654 rule in user.entity.ts.
    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    tenantId?: string | null;

    @Column({ type: 'varchar', length: 16 })
    kind: CreditLedgerKind;

    /** Signed movement: positive = credit, negative = debit. */
    @Column({ type: 'int' })
    amountCredits: number;

    /** The metered `costCents` this movement was derived from, if any. */
    @Column({ type: 'int', nullable: true })
    costCentsRef?: number | null;

    /** Correlation target type: 'agent-run' | 'generation' | 'task' | … */
    @Column({ type: 'varchar', length: 32, nullable: true })
    refType?: string | null;

    /**
     * Id of the correlated run / generation / task / PAYMENT.
     *
     * varchar, not uuid: the settled-purchase and refund-reversal paths
     * write the provider payment id here (`billing.service.ts` records
     * `refId: event.paymentId`, a Stripe `pi_...` string), and
     * `findLatestByRef` reads it back to size a refund. Declared `uuid` by
     * the creating migration, it made the first real credit-pack purchase
     * fail with 22P02 on Postgres while the sqlite test suite stayed green.
     * Widened by migration 1787500000000.
     */
    @Column({ type: 'varchar', length: 128, nullable: true })
    refId?: string | null;

    /** Balance materialized at write time (display; SUM is authoritative). */
    @Column({ type: 'int' })
    balanceAfter: number;

    @Column({ type: 'varchar', length: 256, nullable: true })
    description?: string | null;

    /** UNIQUE (nullable) — re-running a writer with the same key is a no-op. */
    @Column({ type: 'varchar', length: 128, nullable: true })
    idempotencyKey?: string | null;

    /**
     * Bucket accounting (positive rows only): how much of this credit is
     * still unconsumed. NULL on debits. Maintained by
     * `CreditLedgerRepository.recordAtomic` (allocation) and
     * `expireDueBuckets` (zeroed on expiry).
     */
    @Column({ type: 'int', nullable: true })
    remainingCredits?: number | null;

    /**
     * When the unconsumed part of this bucket lapses. NULL = never
     * (purchases, refund adjustments, daily-free top-ups). Plan allowance
     * grants carry the end of their allowance month.
     */
    @PortableDateColumn({ nullable: true })
    expiresAt?: Date | null;

    @CreateDateColumn()
    createdAt: Date;
}
