import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    OneToOne,
    ManyToOne,
    OneToMany,
    CreateDateColumn,
    UpdateDateColumn,
    JoinColumn,
    Index,
} from 'typeorm';
import type { ClassToObject, WorkScheduleCadence, ProvidersDto } from './types';
import { Work } from './work.entity';
import { User } from './user.entity';
import { WorkScheduleBillingMode, WorkScheduleStatus, GenerateStatusType } from './types';
import { TimestampColumn } from './_types';
import { UsageLedgerEntry } from './usage-ledger-entry.entity';

@Index(['status', 'nextRunAt'])
@Index(['userId', 'status'])
@Index(['workId'], { unique: true })
@Entity({ name: 'work_schedules' })
export class WorkSchedule {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ unique: true })
    workId: string;

    @OneToOne(() => Work, (work) => work.schedule, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'workId' })
    work: ClassToObject<Work>;

    @Column()
    userId: string;

    @ManyToOne(() => User, (user) => user.workSchedules, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'userId' })
    user: ClassToObject<User>;

    @Column({ type: 'varchar', nullable: true })
    cadence?: WorkScheduleCadence | null;

    @Column({ type: 'varchar', default: WorkScheduleStatus.DISABLED })
    status: WorkScheduleStatus;

    @Column({ type: 'varchar', default: WorkScheduleBillingMode.SUBSCRIPTION })
    billingMode: WorkScheduleBillingMode;

    @TimestampColumn({ nullable: true })
    nextRunAt?: Date | null;

    @TimestampColumn({ nullable: true })
    lastRunAt?: Date | null;

    @Column({ type: 'varchar', nullable: true })
    lastRunStatus?: GenerateStatusType | null;

    @Column({ type: 'int', default: 0 })
    failureCount: number;

    @Column({ type: 'int', default: 3 })
    maxFailureBeforePause: number;

    @Column({ type: 'boolean', default: false })
    alwaysCreatePullRequest: boolean;

    @TimestampColumn({ nullable: true })
    scheduledFor?: Date | null;

    @Column({ type: 'simple-json', nullable: true })
    providerOverrides?: ProvidersDto | null;

    @OneToMany(() => UsageLedgerEntry, (entry) => entry.schedule)
    ledgerEntries?: ClassToObject<UsageLedgerEntry>[] | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
