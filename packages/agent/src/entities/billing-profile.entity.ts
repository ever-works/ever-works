import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';

/**
 * Billing profile (billing PRD §4.2 / §5.3(3)) — the per-owner bridge
 * between a platform user and the external payment provider.
 *
 * Carries exactly three things and nothing else:
 *
 *   1. **Customer mapping** — `provider` + `providerCustomerId`, so a
 *      returning buyer reuses the same provider customer instead of
 *      minting a new one per checkout.
 *   2. **Default payment-method SUMMARY** — brand / last4 / expiry plus
 *      an opaque provider token ref. **Never a PAN, CVC, or any other
 *      cardholder datum**: capture happens entirely on the provider's
 *      hosted, tokenized surface (PRD §3.3), so no PCI data ever reaches
 *      this table.
 *   3. **Auto-recharge state** — enabled flag, threshold, the server-side
 *      pack to buy, and the in-flight guard.
 *
 * ## Why auto-recharge state lives HERE
 *
 * The PRD originally put `autoRecharge*` on a `credit_accounts` entity
 * (§5.3(1)). That entity was deliberately designed away in Wave 9 M1: the
 * balance is `SUM(amountCredits)` over `credit_ledger_entries` with
 * `balanceAfter` materialized inside the insert transaction, so there is
 * no per-owner "account" row to hang settings on. Rather than resurrect a
 * table whose only remaining purpose would be four settings columns, the
 * state lands on `billing_profiles`, which is the correct home anyway:
 *
 *   - Auto-recharge is **inoperable without a billing profile** — it
 *     needs `providerCustomerId` + `defaultPaymentMethodRef` to place an
 *     off-session charge. Co-locating them makes the precondition a row
 *     read instead of a join.
 *   - The row is created lazily on first checkout, exactly when
 *     auto-recharge first becomes possible.
 *   - Nothing in the ledger's hot path has to change; the ledger stays
 *     append-only and settings-free.
 *
 * Scope columns are raw uuid references (no @ManyToOne) per the EW-654
 * cycle-avoidance rule; the userId FK lives in the migration
 * (`1784300000000-CreateBillingProfilesAndInvoices`).
 *
 * NOTE: also registered in `database/_entities-inventory.ts` — this repo
 * has no `autoLoadEntities`; a forFeature'd-but-unregistered entity
 * throws EntityMetadataNotFoundError on first query.
 */
@Entity({ name: 'billing_profiles' })
@Index('idx_billing_profiles_user', ['userId'], { unique: true })
@Index('idx_billing_profiles_customer', ['provider', 'providerCustomerId'])
export class BillingProfile {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /** Owner of the profile. UNIQUE — one profile per platform user. */
    @Column({ type: 'uuid' })
    userId: string;

    // Tenant + Organization scope columns (Tier C denormalization
    // pattern). Raw uuid references — no @ManyToOne, EW-654 cycle rule.
    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    tenantId?: string | null;

    /** Payment provider id this profile belongs to (e.g. `stripe`). */
    @Column({ type: 'varchar', length: 32 })
    provider: string;

    /** The provider's customer identifier. Opaque; never a secret key. */
    @Column({ type: 'varchar', length: 128 })
    providerCustomerId: string;

    // ── Default payment method (DISPLAY METADATA ONLY) ──────────────
    /** Opaque provider payment-method token reference. Never a PAN. */
    @Column({ type: 'varchar', length: 128, nullable: true })
    defaultPaymentMethodRef?: string | null;

    /** Card network label for display, e.g. `visa`. */
    @Column({ type: 'varchar', length: 32, nullable: true })
    paymentMethodBrand?: string | null;

    /** Last four digits — the only card digits we are ever given. */
    @Column({ type: 'varchar', length: 4, nullable: true })
    paymentMethodLast4?: string | null;

    @Column({ type: 'int', nullable: true })
    paymentMethodExpMonth?: number | null;

    @Column({ type: 'int', nullable: true })
    paymentMethodExpYear?: number | null;

    // ── Auto-recharge (PRD §3.4) ────────────────────────────────────
    @Column({ type: 'boolean', default: false })
    autoRechargeEnabled: boolean;

    /** Recharge when the credits balance falls below this level. */
    @Column({ type: 'int', nullable: true })
    autoRechargeThresholdCredits?: number | null;

    /** Server-side pack id to purchase — never a client-supplied price. */
    @Column({ type: 'varchar', length: 64, nullable: true })
    autoRechargePackId?: string | null;

    /**
     * Idempotency guard: at most ONE auto-recharge may be in flight per
     * profile. Set (compare-and-set) before the off-session charge,
     * cleared by the webhook that credits the ledger or by the failure
     * path. A non-null value means "a charge is already on its way" and
     * a second threshold crossing must not fire.
     */
    @Column({ type: 'varchar', length: 128, nullable: true })
    autoRechargeInFlightKey?: string | null;

    @Column({ type: 'timestamp', nullable: true })
    autoRechargeInFlightAt?: Date | null;

    /** Consecutive failures — drives the PAST_DUE-style banner. */
    @Column({ type: 'int', default: 0 })
    autoRechargeFailureCount: number;

    @Column({ type: 'timestamp', nullable: true })
    autoRechargeLastFailureAt?: Date | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
