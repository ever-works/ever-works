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

    @TimestampColumn()
    currentPeriodEnd?: Date | null;

    @Column({ type: 'boolean', default: false })
    cancelAtPeriodEnd: boolean;

    @Column({ type: 'json', nullable: true })
    paymentMethodMeta?: Record<string, any> | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
