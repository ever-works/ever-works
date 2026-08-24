import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';
import { PortableDateColumn } from './_types';

export enum LicencePurchaseStatus {
    ACTIVE = 'active',
    REFUNDED = 'refunded',
}

/**
 * Durable ownership record for one paid self-hosted commercial licence.
 *
 * A licence is not a hosted subscription and must never be written to
 * `user_subscriptions`. This separate, provider-correlated record lets the
 * owner-scoped API show that the licence is already held, prevents another
 * checkout, and gives a later refund/chargeback path an exact record to revoke.
 */
@Entity({ name: 'licence_purchases' })
@Index('idx_licence_purchases_user_plan', ['userId', 'planCode'])
@Index('idx_licence_purchases_provider_payment', ['provider', 'providerPaymentId'], {
    unique: true,
})
export class LicencePurchase {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'uuid' })
    userId: string;

    @Column({ type: 'varchar', length: 64 })
    planCode: string;

    @Column({ type: 'varchar', length: 32 })
    provider: string;

    /** Opaque provider payment reference, never a secret. */
    @Column({ type: 'varchar', length: 128 })
    providerPaymentId: string;

    @Column({ type: 'int' })
    amountCents: number;

    @Column({ type: 'varchar', length: 8 })
    currency: string;

    @Column({ type: 'varchar', length: 16, default: LicencePurchaseStatus.ACTIVE })
    status: LicencePurchaseStatus;

    @PortableDateColumn({ nullable: true })
    refundedAt?: Date | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
