import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

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
    /** Expiring promotional/daily grants, when configured (−). */
    EXPIRY = 'expiry',
}

@Entity({ name: 'credit_ledger_entries' })
@Index('idx_credit_ledger_user_created', ['userId', 'createdAt'])
@Index('idx_credit_ledger_user_kind', ['userId', 'kind'])
@Index('idx_credit_ledger_idempotency', ['idempotencyKey'], { unique: true })
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

    /** UUID of the correlated run/generation/task. */
    @Column({ type: 'uuid', nullable: true })
    refId?: string | null;

    /** Balance materialized at write time (display; SUM is authoritative). */
    @Column({ type: 'int' })
    balanceAfter: number;

    @Column({ type: 'varchar', length: 256, nullable: true })
    description?: string | null;

    /** UNIQUE (nullable) — re-running a writer with the same key is a no-op. */
    @Column({ type: 'varchar', length: 128, nullable: true })
    idempotencyKey?: string | null;

    @CreateDateColumn()
    createdAt: Date;
}
