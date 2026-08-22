import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    CreateDateColumn,
    UpdateDateColumn,
    OneToMany,
    Index,
} from 'typeorm';
import type {
    ClassToObject,
    WorkScheduleCadence,
    SubscriptionPlanCode,
    SubscriptionPlanHosting,
} from './types';
import { UserSubscription } from './user-subscription.entity';

@Index(['code'], { unique: true })
@Index(['active'])
@Entity({ name: 'subscription_plans' })
export class SubscriptionPlan {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'varchar', unique: true })
    code: SubscriptionPlanCode;

    @Column({ type: 'varchar' })
    displayName: string;

    @Column({ type: 'int', default: 1 })
    maxWorks: number;

    @Column({ type: 'simple-json', nullable: false })
    allowedCadences: WorkScheduleCadence[];

    @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
    monthlyPrice: string;

    @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
    overagePricePerRun: string;

    @Column({ type: 'varchar', default: 'usd' })
    currency: string;

    /* ---------------------------------------------------------------------- *
     *  Added 2026-08-22 — hosting, annual/one-time pricing, seats, credits.
     *
     *  Every column below is nullable or defaulted, so the migration needs no
     *  backfill and a pre-existing row keeps behaving exactly as it did: cloud
     *  hosting, no annual price, no seat metering, no credit allowance.
     * ---------------------------------------------------------------------- */

    /**
     * `cloud` or `selfhosted`. Together with the marketing tier this derives the plan's Stripe
     * `lookup_key` in the shared account — see
     * `packages/agent/src/subscriptions/billing/stripe-catalog.ts`.
     */
    // 🛑 `length` must match the migration's `varchar(32)`. Without it TypeORM `synchronize`
    // renders an unbounded `character varying` on dev and stage, while prod — the only environment
    // that executes migration files — gets `varchar(32)`. The two would then run different schemas,
    // which is precisely what makes "it worked on stage" worthless for anything schema-shaped.
    @Column({ type: 'varchar', length: 32, default: 'cloud' })
    hosting: SubscriptionPlanHosting;

    /**
     * Charged once per YEAR, in the plan currency. The marketing site quotes annual per month; this
     * is the yearly figure. Cloud Pro displays "$17/mo" and stores 204.00.
     *
     * `0` means the plan has no annual option.
     */
    @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
    annualPrice: string;

    /**
     * One-time perpetual commercial licence, in the plan currency, lifting the buyer's AGPLv3
     * obligations. NULL on every plan that is not sold this way — which is all of them except the
     * self-hosted Pro Edition.
     *
     * 🛑 A row with a `lifetimePrice` is bought in Stripe `mode: payment`, never `subscription`.
     * Never infer that from a marketing toggle position — read it from this column.
     */
    @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
    lifetimePrice: string | null;

    /**
     * Seats — employees OR agents, interchangeably — included before per-seat billing starts.
     * NULL means UNBOUNDED (the Community Edition, and Enterprise "Option 1": one organization with
     * unlimited employees and agents). An unbounded plan never emits a seat line item.
     */
    @Column({ type: 'int', nullable: true })
    seatsIncluded: number | null;

    /**
     * Price per ADDITIONAL seat per month, in the plan currency. NULL where seats are unbounded or
     * the plan is free. The annual rate is exactly 12x this — additional seats carry no annual
     * discount, matching Ever Gauzy's flat "$5 per month" wording.
     */
    @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
    seatMonthlyPrice: string | null;

    /**
     * Platform-billed AI credits granted per month on this plan, on top of the universal daily free
     * grant. Credits are a SEPARATE axis from seats and apply on every hosting mode: self-hosting
     * is free, but a self-hosted deployment using Ever-hosted AI still spends credits. Runs on the
     * customer's own model keys spend nothing, on any plan.
     */
    @Column({ type: 'int', default: 0 })
    monthlyCredits: number;

    @Column({ type: 'boolean', default: true })
    active: boolean;

    @OneToMany(() => UserSubscription, (subscription) => subscription.plan)
    subscriptions?: ClassToObject<UserSubscription>[];

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
