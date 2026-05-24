import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    ManyToOne,
    JoinColumn,
    CreateDateColumn,
    UpdateDateColumn,
    Index,
} from 'typeorm';
import { WorkScheduleBillingMode, type ClassToObject } from './types';
import { User } from './user.entity';
import { Work } from './work.entity';
import { WorkSchedule } from './work-schedule.entity';
import { WorkGenerationHistory } from './work-generation-history.entity';
// Import from the leaf-types file (NOT from work-budget.entity) — see
// `_types.ts` for the cycle-break rationale.
import { BudgetOwnerType } from './_types';

export enum UsageLedgerTriggerType {
    MANUAL = 'manual',
    SCHEDULED = 'scheduled',
}

export enum UsageLedgerStatus {
    PENDING = 'pending',
    QUEUED_FOR_SETTLEMENT = 'queued_for_settlement',
    PAID = 'paid',
    CANCELED = 'canceled',
}

@Index(['userId', 'status'])
@Index(['workId'])
@Index(['createdAt'])
@Index(['scheduleId'])
@Index('idx_usage_ledger_entries_owner', ['ownerType', 'ownerId'])
@Entity({ name: 'usage_ledger_entries' })
export class UsageLedgerEntry {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    userId: string;

    @ManyToOne(() => User, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'userId' })
    user: ClassToObject<User>;

    @Column()
    workId: string;

    @ManyToOne(() => Work, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'workId' })
    work: ClassToObject<Work>;

    @Column({ nullable: true })
    scheduleId?: string | null;

    @ManyToOne(() => WorkSchedule, (schedule) => schedule.ledgerEntries, {
        nullable: true,
        onDelete: 'SET NULL',
    })
    @JoinColumn({ name: 'scheduleId' })
    schedule?: ClassToObject<WorkSchedule> | null;

    @Column({ type: 'varchar', default: UsageLedgerTriggerType.MANUAL })
    triggerType: UsageLedgerTriggerType;

    @Column({ type: 'varchar', default: WorkScheduleBillingMode.USAGE })
    billingMode: WorkScheduleBillingMode;

    @Column({ type: 'int', default: 1 })
    units: number;

    @Column({ type: 'int', default: 0 })
    amountCents: number;

    @Column({ type: 'varchar', default: 'usd' })
    currency: string;

    @Column({ type: 'varchar', default: UsageLedgerStatus.PENDING })
    status: UsageLedgerStatus;

    @Column({ nullable: true })
    generationHistoryId?: string | null;

    @ManyToOne(() => WorkGenerationHistory, { nullable: true })
    @JoinColumn({ name: 'generationHistoryId' })
    generationHistory?: ClassToObject<WorkGenerationHistory> | null;

    @Column({ type: 'json', nullable: true })
    metadata?: Record<string, any> | null;

    /**
     * Polymorphic-owner discriminator (Missions/Ideas/Works spec §8.2).
     * Backfilled to `'work'` by Phase 0 PR 0.3 for existing rows.
     */
    @Column({ type: 'varchar', length: 16, default: BudgetOwnerType.WORK })
    ownerType: BudgetOwnerType;

    /**
     * UUID of the owning Work / Idea / Mission. Backfilled to
     * `workId` for existing rows. See `WorkBudget.ownerId` for
     * full rationale.
     */
    @Column({ type: 'uuid', nullable: true })
    ownerId?: string | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
