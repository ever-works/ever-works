import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    CreateDateColumn,
    UpdateDateColumn,
    OneToMany,
    Index,
} from 'typeorm';
import type { ClassToObject, DirectoryScheduleCadence, SubscriptionPlanCode } from './types';
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
    maxDirectories: number;

    @Column({ type: 'simple-json', nullable: false })
    allowedCadences: DirectoryScheduleCadence[];

    @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
    monthlyPrice: string;

    @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
    overagePricePerRun: string;

    @Column({ type: 'varchar', default: 'usd' })
    currency: string;

    @Column({ type: 'boolean', default: true })
    active: boolean;

    @OneToMany(() => UserSubscription, (subscription) => subscription.plan)
    subscriptions?: ClassToObject<UserSubscription>[];

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
