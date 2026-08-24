import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    CreateDateColumn,
    UpdateDateColumn,
    ManyToOne,
    JoinColumn,
    Index,
} from 'typeorm';
import type { ClassToObject, SubscriptionPlanCode } from './types';
import { User } from './user.entity';
import { SubscriptionPlan } from './subscription-plan.entity';
import { TimestampColumn } from './_types';

export enum SubscriptionStatus {
    ACTIVE = 'active',
    CANCELED = 'canceled',
    PAST_DUE = 'past_due',
    TRIALING = 'trialing',
}

export enum SubscriptionBillingProvider {
    STRIPE = 'stripe',
    MANUAL = 'manual',
}

@Index(['userId', 'status'])
@Index(['planCode'])
@Entity({ name: 'user_subscriptions' })
export class UserSubscription {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    userId: string;

    @ManyToOne(() => User, (user) => user.subscriptions, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'userId' })
    user: ClassToObject<User>;

    @Column({ type: 'varchar' })
    planCode: SubscriptionPlanCode;

    @ManyToOne(() => SubscriptionPlan, (plan) => plan.subscriptions, {
        nullable: false,
        eager: true,
    })
    @JoinColumn({ name: 'planId' })
    plan: ClassToObject<SubscriptionPlan>;

    @Column({ nullable: true })
    planId: string | null;

    @Column({ type: 'varchar', default: SubscriptionStatus.ACTIVE })
    status: SubscriptionStatus;

    @Column({ type: 'varchar', default: SubscriptionBillingProvider.STRIPE })
    billingProvider: SubscriptionBillingProvider;

    /**
     * Provider subscription id (audit B24 — plan checkout). Opaque
     * reference, NEVER a secret: it is what lets a later
     * `customer.subscription.*` delivery update or revoke exactly the row
     * the hosted checkout created, and what a future manage/cancel
     * surface would address. NULL on manually-granted rows.
     */
    @Column({ type: 'varchar', length: 128, nullable: true })
    providerSubscriptionId?: string | null;

    /**
     * Additional seats the provider subscription bills for, beyond the
     * plan's included allowance (billing spec §3.6 / FR-26). Reconciled from
     * the subscription's per-seat items on every
     * `subscription.*` delivery, so it is the provider's truth rather than
     * a local guess.
     *
     * NULL means "unknown / not applicable": a manually-granted row, a
     * plan with unbounded seats, or a subscription created before this
     * column existed. Readers treat NULL as "fall back to the plan's
     * `seatsIncluded`", never as zero.
     */
    @Column({ type: 'int', nullable: true })
    seats?: number | null;

    /**
     * The provider subscription ITEM carrying the per-additional-seat
     * price, when any. NULL until the first extra seat is bought — that is
     * what tells the seat-quantity update whether to create the item or
     * update it.
     */
    @Column({ type: 'varchar', length: 128, nullable: true })
    providerSeatItemId?: string | null;

    @TimestampColumn()
    currentPeriodEnd?: Date | null;

    @Column({ type: 'boolean', default: false })
    cancelAtPeriodEnd: boolean;

    @Column({ type: 'json', nullable: true })
    paymentMethodMeta?: Record<string, any> | null;

    // EW-655 (Tenants & Organizations Phase 3) — Tier A scope FKs.
    // Both NULL until the owning user creates their first Organization
    // (Phase 6 lazy backfill). FK + index enforced at DB level by
    // migration 1779991006000-AddTenantIdAndOrganizationIdToTierA.
    // No @ManyToOne to avoid the entities import cycle that bit Phase 2 —
    // see user.entity.ts EW-654 comment.
    @Column({ type: 'uuid', nullable: true })
    tenantId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
