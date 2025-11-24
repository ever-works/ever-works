import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    ManyToOne,
    JoinColumn,
    CreateDateColumn,
    UpdateDateColumn,
} from 'typeorm';
import { DirectoryScheduleBillingMode, type ClassToObject } from './types';
import { User } from './user.entity';
import { Directory } from './directory.entity';
import { DirectorySchedule } from './directory-schedule.entity';
import { DirectoryGenerationHistory } from './directory-generation-history.entity';

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
    directoryId: string;

    @ManyToOne(() => Directory, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'directoryId' })
    directory: ClassToObject<Directory>;

    @Column({ nullable: true })
    scheduleId?: string | null;

    @ManyToOne(() => DirectorySchedule, (schedule) => schedule.ledgerEntries, {
        nullable: true,
        onDelete: 'SET NULL',
    })
    @JoinColumn({ name: 'scheduleId' })
    schedule?: ClassToObject<DirectorySchedule> | null;

    @Column({ type: 'varchar', default: UsageLedgerTriggerType.MANUAL })
    triggerType: UsageLedgerTriggerType;

    @Column({ type: 'varchar', default: DirectoryScheduleBillingMode.USAGE })
    billingMode: DirectoryScheduleBillingMode;

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

    @ManyToOne(() => DirectoryGenerationHistory, { nullable: true })
    @JoinColumn({ name: 'generationHistoryId' })
    generationHistory?: ClassToObject<DirectoryGenerationHistory> | null;

    @Column({ type: 'json', nullable: true })
    metadata?: Record<string, any> | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
