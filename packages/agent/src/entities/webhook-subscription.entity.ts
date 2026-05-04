import {
    Entity,
    Column,
    PrimaryGeneratedColumn,
    Index,
    CreateDateColumn,
    UpdateDateColumn,
} from 'typeorm';

export type WebhookSubscriptionStatus = 'active' | 'paused' | 'failed';

@Entity({ name: 'webhook_subscriptions' })
@Index(['accountId'])
@Index(['workId'])
export class WebhookSubscription {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'uuid' })
    accountId: string;

    @Column({ type: 'uuid', nullable: true })
    workId: string | null;

    @Column({ type: 'varchar', length: 2048 })
    url: string;

    /**
     * HMAC-SHA256 signing secret, encrypted at rest.
     * x-secret: true — never log or echo this column.
     */
    @Column({ type: 'text' })
    secretEncrypted: string;

    @Column({ type: 'varchar', length: 32, default: 'active' })
    status: WebhookSubscriptionStatus;

    @Column({ type: 'int', default: 0 })
    consecutiveFailures: number;

    @Column({ type: 'timestamp with time zone', nullable: true })
    lastDeliveryAt: Date | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
